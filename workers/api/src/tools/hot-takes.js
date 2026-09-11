// Hot Takes — Nyo/operator tools. Each is { def, run } returning plain JSON,
// assembled into the shared pool via tools/index.js. Tools hold the REASONING
// (via the `llm` gateway) and orchestration; all DB work delegates to
// lib/hot-takes.js (logged there), and external services are reached ONLY through
// gateways. A tool never calls another tool and never touches a DB driver or
// makes a raw network request (nyyon-lite guardrails, enforced by scripts/validate.mjs).
//
// The heavy article write is the one deliberate reuse of an existing reasoning
// lib (composeAndSavePost via lib writeArticleFromBrief) — Hot Takes never
// re-implements the house-style writer. Its OWN prompts (take/brief/review/
// social) are seeded knowledge notes read at runtime, not literals.

import { callGateway } from '../gateways/index.js';
import { queueNyoMessage, logEvent, readKnowledge } from '../lib/db.js';
import {
  listPackages, readPackage, createPackage, patchPackage, dismissPackage,
  pinTopic, listPosts, computeNextAction, topicsOfTheDay,
  releaseChannels, loadLinkExtractPrompt, ensurePackageForSlug, findPackageBySlug,
  writeArticleFromBrief, articleView, upsertPost, patchPost,
  scheduleRelease, cancelSchedule, publishWebsite, postLeg, loadTimingDefaults,
  loadPovLibrary, loadPatterns, loadQualityRules, loadPlaybook, blogUrl,
  loadHotTakesDoc,
 } from '../lib/hot-takes.js';

// Several tools take a package by id OR adopt a plain blog draft by slug —
// publications written straight into blog_posts (Nyo/digest) have no package
// until the operator schedules or social-drafts them.
async function resolvePackageId(env, input) {
  if (input?.id) return input.id;
  if (input?.slug) return (await ensurePackageForSlug(env, input.slug, input.actor || 'operator')).id;
  return null;
}

// Crude tag-strip so the pasted page text is cheap + safe to hand the model.
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicContext(pkg) {
  return [
    `TOPIC: ${pkg.title || 'Untitled'}`,
    pkg.summary ? `What happened: ${pkg.summary}` : '',
    pkg.why_it_matters ? `Why it may matter: ${pkg.why_it_matters}` : '',
    pkg.source_name || pkg.source_url ? `Source: ${pkg.source_name || ''} ${pkg.source_url || ''}`.trim() : '',
    pkg.company_notes ? `Company notes: ${pkg.company_notes}` : '',
    pkg.author_notes ? `Author notes: ${pkg.author_notes}` : '',
  ].filter(Boolean).join('\n');
}

// The angle core: the operator's OWN editorial knowledge, absent from angle
// crafting until 2026-08-18 (takes and briefs ran on generic hot-takes
// scaffolding alone, which is why angles read like slop). Editable live.

async function loadAngleCore(env) {
  const craft = await loadHotTakesDoc(env, 'hottakes-angle-craft', {
    title: 'Hot Takes — angle craft (the quality bar)',
    body: `What separates a real angle from slop. An angle must be:\n- A SPECIFIC claim only Lev can defend from his own work: name the cost, the number, the client situation.\n- Falsifiable: someone reasonable could disagree. If nobody would argue, it is a summary, not an angle.\n- Priced: what does believing this save or cost the reader, concretely.\n- Actionable tomorrow: the reader does something differently this week, not "rethinks their paradigm".\n- Contrarian ONLY when true. Never manufacture disagreement; never "X is dead".\n- In Lev's stance: builder-first, dugri, allergic to strategy-deck language.\n\nKill an angle that is: a restatement of the news, a "lessons from X" listicle frame, a pattern-label with no claim, or anything Lev could not defend on a call with a skeptical CTO.`,
  });
  const [taste, positioning, personalVoice, styleRules] = await Promise.all([
    import('../lib/aeo-taste.js').then((m) => m.readTasteProfile(env)).catch(() => null),
    readKnowledge(env, 'operator-positioning').catch(() => null),
    readKnowledge(env, 'operator-voice').catch(() => null),
    readKnowledge(env, 'writing-style-rules').catch(() => null),
  ]);
  // The operator's material DOMINATES: his full voice doc (a 1500-char slice
  // once fed the drafter 15% of it, whatever sat at the top, and the angles
  // read off-voice), his style rules, positioning and learned taste. The
  // generic craft bar comes last.
  return [
    personalVoice?.body ? `## THE OPERATOR'S VOICE AND STANCES (the angle must sound like this person)\n${String(personalVoice.body).slice(0, 8000)}` : '',
    styleRules?.body ? `## HIS WRITING RULES (hard bans bind the angle wording too)\n${String(styleRules.body).slice(0, 4000)}` : '',
    positioning?.body ? `## What the company argues (stay inside this)\n${String(positioning.body).slice(0, 2500)}` : '',
    taste ? `## His learned editorial taste (from his gradings)\n${String(taste).slice(0, 2000)}` : '',
    `## Angle craft (the quality bar, hard requirements)\n${craft.body}`,
  ].filter(Boolean).join('\n\n');
}

export const tools = {
  hottake_list_packages: {
    def: {
      name: 'hottake_list_packages',
      description: 'List Hot Takes publication packages (the editorial pipeline). Optionally filter by one or more statuses (topic, take, brief, article, review, ready, scheduled, published, complete). Each package carries its topic, take, article link, review, and distribution state.',
      input_schema: {
        type: 'object',
        properties: {
          statuses: { type: 'array', items: { type: 'string' }, description: 'filter to these statuses' },
          limit: { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ packages: await listPackages(env, input || {}) }),
  },

  hottake_read_package: {
    def: {
      name: 'hottake_read_package',
      description: 'Read one Hot Takes package by id — its full topic/take/brief/article/review state plus its social posts and the single next action the operator should take.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { found: false };
      const posts = await listPosts(env, input.id);
      return { found: true, package: pkg, posts, next_action: computeNextAction(pkg, posts, releaseChannels(env)) };
    },
  },

  hottake_topics_of_the_day: {
    def: {
      name: 'hottake_topics_of_the_day',
      description: 'The prioritized live feed of topics worth a company response — the synthesized hot topics + scored industry signals + the actionable digest, deduped and ranked. Read-only; pin one (hottake_pin_topic) to start a publication package.',
      input_schema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    },
    run: async (env, input) => topicsOfTheDay(env, input || {}),
  },

  hottake_add_topic: {
    def: {
      name: 'hottake_add_topic',
      description: 'Manually add a topic to Selected Topics (creates a publication package at status "topic"). Use for an idea the operator raises that is not already in the feed.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string', description: 'plain-language what it is' },
          why_it_matters: { type: 'string' },
          note: { type: 'string', description: 'a quick operator note (stored as company_notes)' },
        },
        required: ['title'],
      },
    },
    run: async (env, input) => ({
      package: await createPackage(env, {
        origin: 'manual', pinned: 1, status: 'topic',
        title: input.title, summary: input.summary, why_it_matters: input.why_it_matters,
        company_notes: input.note, actor: input.actor || 'operator',
      }),
    }),
  },

  hottake_add_link: {
    def: {
      name: 'hottake_add_link',
      description: 'Turn a pasted article URL into a standard topic card — fetches the page, extracts title/source/summary/date with the LLM, and adds it to Selected Topics. No manual form needed.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    run: async (env, input) => {
      const url = String(input.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };

      let text = '';
      try {
        const r = await callGateway(env, 'web', 'text', { url, max_bytes: 160000 });
        if (r && r.ok === false) return { error: `fetch failed (${r.status})` };
        text = stripHtml(r?.text).slice(0, 8000);
      } catch (e) {
        return { error: `fetch failed: ${e.message}` };
      }

      let meta = {};
      try {
        const system = await loadLinkExtractPrompt(env);
        meta = await callGateway(env, 'llm', 'json', {
          system,
          prompt: `URL: ${url}\n\nPAGE TEXT:\n${text}`,
          max_tokens: 700,
        });
      } catch {
        meta = {};
      }

      let host = url;
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep url */ }
      const publishedAt = meta.published_at_iso ? (Date.parse(meta.published_at_iso) || null) : null;

      const pkg = await pinTopic(env, {
        origin: 'link', origin_ref: url, source_url: url,
        title: meta.title || host, summary: meta.summary || null, why_it_matters: meta.why_it_matters || null,
        source_name: meta.source_name || host, published_at: publishedAt,
      }, input.actor || 'operator');
      return { package: pkg };
    },
  },

  hottake_pin_topic: {
    def: {
      name: 'hottake_pin_topic',
      description: 'Pin a Topic-of-the-Day card into Selected Topics as a publication package. Pass the card fields (origin, origin_ref, title, summary, source_name, source_url). Idempotent by origin_ref.',
      input_schema: {
        type: 'object',
        properties: {
          origin: { type: 'string' }, origin_ref: { type: 'string' },
          title: { type: 'string' }, summary: { type: 'string' }, why_it_matters: { type: 'string' },
          source_name: { type: 'string' }, source_url: { type: 'string' },
          published_at: { type: 'number' }, multi_source: { type: 'array' },
        },
        required: ['title'],
      },
    },
    run: async (env, input) => ({ package: await pinTopic(env, input || {}, input.actor || 'operator') }),
  },

  hottake_dismiss_topic: {
    def: {
      name: 'hottake_dismiss_topic',
      description: 'Dismiss a Hot Takes package (mark it not relevant). Reversible by patching its status back. Use when a topic is not worth a company response.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => ({ package: await dismissPackage(env, input.id, input.actor || 'operator') }),
  },

  hottake_patch_package: {
    def: {
      name: 'hottake_patch_package',
      description: 'Edit fields on a Hot Takes package (title, summary, take + its four inputs, headline, notes, status, pinned). Pass only the keys to change. Use to refine a topic, record the operator\'s take, or move the status (e.g. mark ready).',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' }, summary: { type: 'string' }, why_it_matters: { type: 'string' },
          take: { type: 'string' }, believe: { type: 'string' }, misunderstood: { type: 'string' },
          who_cares: { type: 'string' }, reader_action: { type: 'string' }, headline: { type: 'string' },
          company_notes: { type: 'string' }, author_notes: { type: 'string' },
          status: { type: 'string' }, pinned: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const { id, ...patch } = input || {};
      return { package: await patchPackage(env, id, patch, input.actor || 'operator') };
    },
  },

  // ── the editorial spine ──────────────────────────────────────────────────
  hottake_draft_take: {
    def: {
      name: 'hottake_draft_take',
      description: 'Propose the company\'s take on a topic: a specific, defensible point of view (never a neutral summary) plus the four take inputs — what the company believes, what is commonly misunderstood, who should care, what the reader should do differently. Grounded in the Point-of-View Library and prior published takes. The operator confirms or rewrites it.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      const [pov, playbook, prior, angleCore] = await Promise.all([
        loadPovLibrary(env), loadPlaybook(env),
        listPackages(env, { statuses: ['published', 'complete'], limit: 6 }),
        loadAngleCore(env),
      ]);
      const priorTakes = prior.filter((p) => p.take).map((p) => `- ${p.title}: ${p.take}`).join('\n');
      const out = await callGateway(env, 'llm', 'json', {
        system: `${angleCore}\n\n${playbook.body}\n\nReturn ONLY JSON: {"take","believe","misunderstood","who_cares","reader_action"}. take = the proposed argument, 1-3 sentences, specific and opinionated. The other four are one sentence each.`,
        prompt: `## Point-of-View Library\n${pov.body}\n\n${priorTakes ? `## Prior published takes (stay consistent, don't repeat)\n${priorTakes}\n\n` : ''}## The topic\n${topicContext(pkg)}`,
        max_tokens: 900,
        heavy: true,
      });
      if (!out?.take) return { error: 'drafter returned no take' };
      const updated = await patchPackage(env, input.id, {
        take: out.take, believe: out.believe || null, misunderstood: out.misunderstood || null,
        who_cares: out.who_cares || null, reader_action: out.reader_action || null,
        status: 'take',
      }, input.actor || 'hot-takes');
      return { package: updated };
    },
  },

  hottake_build_brief: {
    def: {
      name: 'hottake_build_brief',
      description: 'Build the short editorial brief from the approved take: argument, audience, why-now, 3-5 supporting points, evidence available, likely objections, recommended conclusion, and the publication pattern that fits. The operator approves or adjusts it BEFORE the long article is written.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      if (!pkg.take) return { error: 'no take yet — run hottake_draft_take first' };
      const [playbook, patterns, angleCore] = await Promise.all([loadPlaybook(env), loadPatterns(env), loadAngleCore(env)]);
      const out = await callGateway(env, 'llm', 'json', {
        system: `${angleCore}\n\n${playbook.body}\n\nReturn ONLY JSON: {"argument","audience","why_now","points":[3-5 strings],"evidence":[strings],"objections":[strings],"conclusion","pattern"}. pattern = which publication pattern fits (name it). Points must each ADVANCE the argument, not restate it.`,
        prompt: `## Publication patterns\n${patterns.body}\n\n## The approved take\n${pkg.take}\nBelieve: ${pkg.believe || ''}\nMisunderstood: ${pkg.misunderstood || ''}\nWho cares: ${pkg.who_cares || ''}\nReader action: ${pkg.reader_action || ''}\n\n## The topic\n${topicContext(pkg)}`,
        max_tokens: 1200,
        heavy: true,
      });
      if (!out?.argument || !Array.isArray(out.points)) return { error: 'brief builder returned no argument/points' };
      // A rebuilt brief must never erase the operator's accumulated directives.
      const updated = await patchPackage(env, input.id, { brief: { ...out, directions: pkg.brief?.directions || [] }, status: 'brief' }, input.actor || 'hot-takes');
      // The interview: what only the operator can add. This is the mechanism
      // that makes the Nyo/AEO articles good — human substance in the input.
      // Non-blocking: the article can be written without answers; answered
      // notes land in author_notes and the seed treats them as the soul.
      try {
        // The interview questions are a bonus: their LLM call failing must
        // NEVER stop the angle from reaching chat, because the write gate
        // tells Nyo the angle was sent. Angle first, questions best-effort.
        let questions = '';
        try {
          const q = await callGateway(env, 'llm', 'json', {
            system: 'You prepare 3 interview questions for the author of an upcoming opinion article. Each question must dig for what ONLY he can supply: a first-hand story, a real number from his work, a place he disagrees with the source, a cost he has personally paid. Never ask what a search could answer. Return ONLY JSON {"questions":["...","...","..."]}.',
            prompt: `Take: ${pkg.take}\nArgument: ${out.argument}\nPoints: ${(out.points || []).join(' | ')}`,
            max_tokens: 300, heavy: false,
          });
          if (Array.isArray(q?.questions) && q.questions.length) {
            questions = `\n\nAnd ${q.questions.length === 1 ? 'one question' : Math.min(3, q.questions.length) + ' questions'} that would make it genuinely yours:\n${q.questions.slice(0, 3).map((qq, i) => `${i + 1}. ${qq}`).join('\n')}`;
          }
        } catch { /* angle still ships without questions */ }
        const points = (out.points || []).slice(0, 5).map((p, i) => `  ${i + 1}. ${typeof p === 'string' ? p : p?.text || ''}`).join('\n');
        await queueNyoMessage(env, {
          content: `THE ANGLE I plan to write "${(updated.headline || updated.title || '').slice(0, 80)}" on:\n\n"${out.argument}"\n\nSupporting points:\n${points}\nConclusion: ${out.conclusion || '(open)'}${questions}\n\nEngage with the angle here: tell me to sharpen it, shift it, or kill it and I will update the brief (hottake_set_angle, id ${updated.id}). Answer the questions and I save them as your material (hottake_notes). The article will NOT be written until you say "write it".`,
          kind: 'alert', ref_kind: 'hot_take', ref_id: updated.id,
        });
      } catch { /* the interview is a bonus, never a blocker */ }
      return { package: updated };
    },
  },

  hottake_write_article: {
    def: {
      name: 'hottake_write_article',
      description: 'Write the full article (1,500+ words) from the approved brief through the shared house-style writer — lands as a blog draft (with figures + cover) linked to the package, status moves to review. Takes 1-3 minutes. voice: "lev" (default) or "house".',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          voice: { type: 'string', enum: ['personal', 'house'] },
          confirm: { type: 'boolean', description: 'REQUIRED true, together with operator_words.' },
          operator_words: { type: 'string', description: 'REQUIRED: the operator\'s VERBATIM message (from this conversation, after the angle was shown) telling you to write. Quote it exactly. If the operator has not said it, STOP and wait; fabricating this quote is lying to the operator and it is logged.' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      if (input.confirm !== true || !String(input.operator_words || '').trim()) {
        return { error: 'the angle gate is closed: the operator has not told you to write this article yet. The angle was sent to chat when the brief completed. WAIT for the operator to respond; do not call this again until they explicitly say to write, then pass confirm:true and quote their exact words in operator_words.' };
      }
      await logEvent(env, { kind: 'hottake_write_confirmed', actor: input.actor || 'operator', payload: { id: input.id, operator_words: String(input.operator_words).slice(0, 300) } });
      return writeArticleFromBrief(env, input.id, { voice: input.voice === 'lev' ? 'personal' : (input.voice || 'personal'), actor: input.actor || 'operator' });
    },
  },

  hottake_review_scan: {
    def: {
      name: 'hottake_review_scan',
      description: 'Scan the written article for review: extract the important factual claims (typed directly_supported / company_experience / opinion / unsupported, with needs-confirmation status) and flag quality weaknesses per the hottakes-quality-rules note. Results land on the package for the operator to confirm/resolve — this is decision support, never auto-approval.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const view = await articleView(env, input.id);
      if (!view?.article?.body) return { error: 'no article yet — write it first' };
      const rules = await loadQualityRules(env);
      const plain = stripHtml(view.article.body).slice(0, 16000);
      const out = await callGateway(env, 'llm', 'json', {
        system: `You are an editorial fact-and-quality reviewer. Apply these rules:\n${rules.body}\n\nReturn ONLY JSON: {"claims":[{"text","support":"directly_supported|company_experience|opinion|unsupported","source","status":"needs_confirmation|confirmed"}],"quality_flags":[{"kind","section","note","severity":"high|medium|low"}]}. claims = the 4-10 factual statements that MATTER to the argument (quote them short). status = needs_confirmation when support is unsupported or shaky, else confirmed. quality_flags = concrete weaknesses only; empty array if genuinely clean.`,
        prompt: `## Article: ${view.article.title}\n\n${plain}\n\n## The intended argument\n${view.package.take || ''}\n\n## Source under discussion\n${view.package.source_name || ''} ${view.package.source_url || ''}`,
        max_tokens: 1600,
        heavy: true,
      });
      const review = {
        claims: Array.isArray(out?.claims) ? out.claims : [],
        quality_flags: (Array.isArray(out?.quality_flags) ? out.quality_flags : []).map((f) => ({ ...f, resolved: false })),
        scanned_at: Date.now(),
      };
      const updated = await patchPackage(env, input.id, { review, status: 'review' }, input.actor || 'hot-takes');
      return { package: updated, open_claims: review.claims.filter((c) => c.status === 'needs_confirmation').length, flags: review.quality_flags.length };
    },
  },

  hottake_draft_social: {
    def: {
      name: 'hottake_draft_social',
      description: 'Draft the LinkedIn distribution posts for a publication — the company post (the organization\'s position) and the personal post (direct, experiential, first-person; NOT a copy). Both editable; the article\'s cover image is attached automatically. Pass the package id, OR a blog slug (a plain draft is adopted into the release pipeline automatically). Pass channel to redraft ONE leg only.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'package id' },
          slug: { type: 'string', description: 'blog post slug — used when there is no package yet' },
          channel: { type: 'string', enum: ['linkedin-company', 'linkedin-personal'], description: 'redraft only this leg (omit to draft both)' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const pkgId = await resolvePackageId(env, input);
      if (!pkgId) return { error: 'pass id or slug' };
      const view = await articleView(env, pkgId);
      if (!view) return { error: 'package not found' };
      if (!view.article) return { error: 'no article yet — write it first' };
      // Draft each leg with the Social module's fine-tuned instructions AS IS
      // (operator decision 2026-07-24) — the same hard style-rules constraints,
      // voice docs and channel rules the blog fan-out uses, via the one exported
      // entry point. The hottakes-playbook no longer steers these posts, and
      // company_notes/author_notes stay stored/editable but don't feed the
      // initial draft (the shared prompt has no notes slot — "as is").
      const { draftSocialPostText } = await import('../lib/social-posts.js');
      const articleInput = {
        title: view.article.title,
        excerpt: view.article.excerpt,
        tags: view.article.tags,
        url: blogUrl(env, view.article.slug),
        bodyHtml: view.article.body,
      };
      // `channel` narrows to a single-leg redraft (the unit's Redraft button);
      // omitted = both legs, the original draft-everything behavior.
      const channels = input.channel
        ? [input.channel].filter((ch) => ['linkedin-company', 'linkedin-personal'].includes(ch))
        : ['linkedin-company', 'linkedin-personal'];
      if (!channels.length) return { error: 'unknown channel' };
      let texts;
      try {
        texts = await Promise.all(channels.map((ch) => draftSocialPostText(env, ch, articleInput)));
      } catch (e) {
        return { error: `social drafter failed: ${String(e?.message || e).slice(0, 200)}` };
      }
      const image = view.article.featured_image_url || null;
      const posts = [];
      for (let i = 0; i < channels.length; i++) {
        posts.push(await upsertPost(env, { package_id: pkgId, channel: channels[i], body: texts[i], image_url: image, status: 'draft', actor: input.actor || 'hot-takes' }));
      }
      return { posts, package_id: pkgId };
    },
  },

  // ── distribution ─────────────────────────────────────────────────────────
  hottake_schedule_release: {
    def: {
      name: 'hottake_schedule_release',
      description: 'Schedule a publication in one action: the website publish plus both LinkedIn posts. Pass the package id, OR a blog slug (a plain draft is adopted into the release pipeline automatically). Times are ms epochs; anything omitted gets the recommended timing from the hottakes-timing note (website first, company post ~45min later, personal ~2h later). The hourly scheduler publishes the website FOR REAL when due; LinkedIn legs are dry-run unless the hottakes.live flag is on.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'package id' },
          slug: { type: 'string', description: 'blog post slug — used when there is no package yet' },
          website_at: { type: 'number', description: 'ms epoch for the website publish' },
          company_at: { type: 'number' },
          personal_at: { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const pkgId = await resolvePackageId(env, input);
      if (!pkgId) return { error: 'pass id or slug' };
      return scheduleRelease(env, pkgId, input || {}, input.actor || 'operator');
    },
  },

  hottake_cancel_schedule: {
    def: {
      name: 'hottake_cancel_schedule',
      description: 'Cancel a scheduled publication: the package returns to ready (unscheduled), queued LinkedIn legs go back to ready/draft, and the calendar entry is marked cancelled. Nothing is deleted. Pass the package id or the blog slug.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'package id' },
          slug: { type: 'string', description: 'blog post slug' },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      // Lookup only — cancelling must never CREATE a package for the slug.
      const pkg = input.id ? await readPackage(env, input.id) : await findPackageBySlug(env, input.slug);
      if (!pkg) return { error: 'no package found — nothing is scheduled for this publication' };
      return cancelSchedule(env, pkg.id, input.actor || 'operator');
    },
  },

  hottake_publish_website: {
    def: {
      name: 'hottake_publish_website',
      description: 'Publish the package\'s article NOW through the website webhook (edge-rendered, live in ~60s). REAL regardless of the hottakes.live flag — same trust level as the Blog page\'s Approve button. Only the LinkedIn legs are flag-gated.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => publishWebsite(env, input.id, { actor: input.actor || 'operator' }),
  },

  hottake_post_leg: {
    def: {
      name: 'hottake_post_leg',
      description: 'Send one social leg (a hot_take_posts row) now through the shared social gateway, logged to the outbox. DRY-RUN unless the hottakes.live feature flag is true.',
      input_schema: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'] },
    },
    run: async (env, input) => postLeg(env, input.post_id, { actor: input.actor || 'operator' }),
  },

  hottake_patch_post: {
    def: {
      name: 'hottake_patch_post',
      description: 'Edit one social leg: the final post text (body), notes, image_url, scheduled_at, or status (draft/ready/scheduled/skipped/not_planned — use not_planned to mark a channel intentionally unused so the release can still complete).',
      input_schema: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          body: { type: 'string' }, notes: { type: 'string' }, image_url: { type: 'string' },
          status: { type: 'string' }, scheduled_at: { type: 'number' },
        },
        required: ['post_id'],
      },
    },
    run: async (env, input) => {
      const { post_id, ...patch } = input || {};
      return { post: await patchPost(env, post_id, patch, input.actor || 'operator') };
    },
  },

  hottake_timing_defaults: {
    def: {
      name: 'hottake_timing_defaults',
      description: 'Read the recommended release timing (default publish hour + per-leg offsets) from the editable hottakes-timing note.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => loadTimingDefaults(env),
  },
  hottake_notes: {
    def: {
      name: 'hottake_notes',
      description: 'Save the operator\'s own material onto a hot take: author_notes (his stories, numbers, opinions — the interview answers; the article writer treats these as the piece\'s soul) and/or company_notes (context). Appends to what is already stored. Use whenever the operator answers the brief interview questions or adds substance in chat.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'hot take id (ht_...)' },
          author_notes: { type: 'string', description: 'the operator\'s material, in his words' },
          company_notes: { type: 'string', description: 'company/context notes' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      const patch = {};
      if (input.author_notes) patch.author_notes = [pkg.author_notes, input.author_notes].filter(Boolean).join('\n\n');
      if (input.company_notes) patch.company_notes = [pkg.company_notes, input.company_notes].filter(Boolean).join('\n\n');
      if (!Object.keys(patch).length) return { error: 'pass author_notes and/or company_notes' };
      const updated = await patchPackage(env, input.id, patch, input.actor || 'operator');
      return { id: updated.id, author_notes: updated.author_notes, company_notes: updated.company_notes };
    },
  },
  hottake_set_angle: {
    def: {
      name: 'hottake_set_angle',
      description: 'Reshape the ANGLE of a hot take from the operator\'s pushback, before the article is written: updates argument, supporting points, conclusion, or pattern inside the stored brief. Use this whenever the operator engages with the proposed angle in chat (sharpen it, shift the argument, replace points). The article writer builds from whatever this leaves in the brief.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'hot take id (ht_...)' },
          argument: { type: 'string', description: 'the reshaped core argument, in full' },
          points: { type: 'array', items: { type: 'string' }, description: 'replacement supporting points (3-5)' },
          conclusion: { type: 'string' },
          pattern: { type: 'string', description: 'publication pattern name if the operator changed it' },
        },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      if (!pkg.brief) return { error: 'no brief yet, run hottake_build_brief first' };
      const brief = { ...pkg.brief };
      let changed = [];
      for (const k of ['argument', 'conclusion', 'pattern']) {
        if (input[k]) { brief[k] = String(input[k]); changed.push(k); }
      }
      if (Array.isArray(input.points) && input.points.length) {
        // accept string or {title,text} points; never String() an object into "[object Object]"
        brief.points = input.points.map((p) => (typeof p === 'string' ? p : { title: String(p?.title || ''), text: String(p?.text || '') }));
        changed.push('points');
      }
      if (!changed.length) return { error: 'pass at least one of argument, points, conclusion, pattern' };
      const updated = await patchPackage(env, input.id, { brief }, input.actor || 'operator');
      await logEvent(env, { kind: 'hottake_angle_updated', actor: input.actor || 'operator', payload: { id: input.id, changed } });
      return { id: updated.id, brief: updated.brief, changed };
    },
  },
  hottake_refine: {
    def: {
      name: 'hottake_refine',
      description: 'Regenerate the take or the brief WITH the operator\'s explicit direction, the control lever where his input matters most. His direction is the binding instruction: the model reshapes the take (or the brief\'s angle: argument, points, conclusion) to honor it, keeping what he did not ask to change. Use whenever the operator says how the angle should shift ("sharpen toward the migration cost", "drop the privacy frame, argue ownership").',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'hot take id (ht_...)' },
          stage: { type: 'string', enum: ['take', 'brief'], description: 'which artifact to refine' },
          direction: { type: 'string', description: 'the operator\'s direction, verbatim' },
        },
        required: ['id', 'stage', 'direction'],
      },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      const direction = String(input.direction || '').trim();
      if (!direction) return { error: 'direction required, that is the whole point of this tool' };
      const angleCore = await loadAngleCore(env);
      // A direction is editorial state, not just audit: it must survive to the
      // article writer, which reads the package, never the conversation.
      // Capped at the newest 12 so brief_json cannot grow without bound; a
      // wizard session rarely exceeds a handful, so nothing real is dropped.
      const directions = [...(Array.isArray(pkg.brief?.directions) ? pkg.brief.directions : []), direction].slice(-12);
      // Earlier directives ride along in every refine so a new direction can
      // never silently undo what the operator already asked for (the
      // "back to square one" failure of 2026-08-19).
      const priorDirectives = directions.slice(0, -1);
      const priorBlock = priorDirectives.length
        ? `\n\nEARLIER DIRECTIVES, already applied and still binding (the revision must keep honoring ALL of them; if the new direction contradicts an earlier one, the NEW direction wins on that point):\n${priorDirectives.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
        : '';
      if (input.stage === 'take') {
        if (!pkg.take) return { error: 'no take yet' };
        const out = await callGateway(env, 'llm', 'json', {
          system: `${angleCore}\n\nYou revise a hot-take POV under the OPERATOR'S DIRECTION, which is binding. Keep everything he did not ask to change. Return ONLY JSON {"take","believe","misunderstood","who_cares","reader_action"}.`,
          prompt: `CURRENT take: ${pkg.take}\nBelieve: ${pkg.believe || ''}\nMisunderstood: ${pkg.misunderstood || ''}\nWho cares: ${pkg.who_cares || ''}\nReader action: ${pkg.reader_action || ''}\n\nTHE OPERATOR'S DIRECTION (binding): ${direction}${priorBlock}\n\nTopic: ${topicContext(pkg)}`,
          max_tokens: 900, heavy: true,
        });
        if (!out?.take) return { error: 'refiner returned no take' };
        const updated = await patchPackage(env, input.id, { take: out.take, believe: out.believe || pkg.believe, misunderstood: out.misunderstood || pkg.misunderstood, who_cares: out.who_cares || pkg.who_cares, reader_action: out.reader_action || pkg.reader_action, brief: { ...(pkg.brief || {}), directions } }, input.actor || 'operator');
        await logEvent(env, { kind: 'hottake_refined', actor: input.actor || 'operator', payload: { id: input.id, stage: 'take', direction: direction.slice(0, 200) } });
        return { package: updated };
      }
      if (!pkg.brief) return { error: 'no brief yet' };
      const out = await callGateway(env, 'llm', 'json', {
        system: `${angleCore}\n\nYou revise an article brief's ANGLE under the OPERATOR'S DIRECTION, which is binding. Keep brief keys he did not ask to change. argument and points MUST follow the "Section format" rules in the angle craft doc above. Return ONLY JSON {"argument","points":[{"title","text"} x 3-5],"conclusion"}.`,
        prompt: `CURRENT angle: ${pkg.brief.argument}\nCurrent sections:\n${(pkg.brief.points || []).map((p, i) => `${i + 1}. ${typeof p === 'string' ? p : [p?.title, p?.text].filter(Boolean).join(': ')}`).join('\n')}\nConclusion: ${pkg.brief.conclusion || ''}\nThe current take (context only — wherever the direction conflicts with it, the DIRECTION wins, including re-centering the whole angle): ${pkg.take}\n\nTHE OPERATOR'S DIRECTION (binding): ${direction}${priorBlock}`,
        max_tokens: 1400, heavy: true,
      });
      if (!out?.argument) return { error: 'refiner returned no argument' };
      // normalize to the drafter's {title, text} shape so the titled story-arc
      // structure survives every refine round instead of flattening to strings
      const points = Array.isArray(out.points) && out.points.length
        ? out.points.map((p) => (typeof p === 'string' ? { title: '', text: p } : { title: String(p.title || ''), text: String(p.text || '') }))
        : pkg.brief.points;
      const brief = { ...pkg.brief, argument: out.argument, points, conclusion: out.conclusion || pkg.brief.conclusion, directions };
      // the angle IS the take now: keep them mirrored so the article seed
      // (which quotes the take verbatim) never diverges from the approved angle
      const updated = await patchPackage(env, input.id, { brief, take: out.argument }, input.actor || 'operator');
      await logEvent(env, { kind: 'hottake_refined', actor: input.actor || 'operator', payload: { id: input.id, stage: 'brief', direction: direction.slice(0, 200) } });
      return { package: updated };
    },
  },
  hottake_abandon_draft: {
    def: {
      name: 'hottake_abandon_draft',
      description: 'The operator X-ed out of drafting: return the topic to the topic pool, clean. Resets a package in take or brief stage back to status topic and clears the editorial fields (take inputs + brief); topic metadata, source and notes survive. Refuses once an article exists (that is real work, closing the editor never destroys it).',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      if (!['take', 'brief'].includes(pkg.status)) {
        return { error: `nothing to abandon: status is ${pkg.status}; only take/brief drafts return to the pool` };
      }
      const updated = await patchPackage(env, input.id, {
        status: 'topic', take: null, believe: null, misunderstood: null,
        who_cares: null, reader_action: null, brief: null,
      }, input.actor || 'operator');
      await logEvent(env, { kind: 'hottake_draft_abandoned', actor: input.actor || 'operator', payload: { id: input.id, from_status: pkg.status, title: (pkg.title || '').slice(0, 80) } });
      return { package: updated };
    },
  },
  hottake_draft_angle: {
    def: {
      name: 'hottake_draft_angle',
      description: 'Draft the whole ANGLE DOCUMENT in one pass: the argument (the take), 3-5 supporting points, the objections to answer, and the reader action. Replaces the old take-then-brief two-step; the operator refines this single document conversationally and approves it once. Leaves the package at status brief with take and brief populated.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const pkg = await readPackage(env, input.id);
      if (!pkg) return { error: 'package not found' };
      const [pov, playbook, patterns, angleCore, prior] = await Promise.all([
        loadPovLibrary(env), loadPlaybook(env), loadPatterns(env), loadAngleCore(env),
        listPackages(env, { statuses: ['published', 'complete'], limit: 6 }),
      ]);
      const priorTakes = prior.filter((p) => p.take).map((p) => `- ${p.title}: ${p.take}`).join('\n');
      const out = await callGateway(env, 'llm', 'json', {
        system: `${angleCore}\n\n${playbook.body}\n\nYou draft the complete ANGLE DOCUMENT for an opinion article in ONE pass. Return ONLY JSON: {"argument","points":[{"title","text"} x 3-5],"objections":[1-3 strings],"reader_action","believe","misunderstood","who_cares","pattern"}. argument = the specific, defensible claim, 1-3 sentences, opinionated. argument and points MUST follow the "Section format" rules in the angle craft doc above. objections = the strongest real pushback and how honesty survives it.`,
        prompt: `## Point-of-View Library\n${pov.body}\n\n## Publication patterns\n${patterns.body}\n\n${priorTakes ? `## Prior published takes (stay consistent, do not repeat)\n${priorTakes}\n\n` : ''}## The topic\n${topicContext(pkg)}`,
        max_tokens: 2500,
        heavy: true,
      });
      if (!out?.argument || !Array.isArray(out.points) || !out.points.length) return { error: 'angle drafter returned no argument/points' };
      const updated = await patchPackage(env, input.id, {
        take: out.argument, believe: out.believe || null, misunderstood: out.misunderstood || null,
        who_cares: out.who_cares || null, reader_action: out.reader_action || null,
        brief: {
          argument: out.argument,
          points: out.points.map((p) => (typeof p === 'string' ? p : { title: String(p.title || ''), text: String(p.text || '') })),
          objections: (out.objections || []).map(String), evidence: [],
          conclusion: out.reader_action || '', audience: out.who_cares || '', pattern: out.pattern || '',
          // regenerating the angle must never erase the operator's directives
          directions: pkg.brief?.directions || [],
        },
        status: 'brief',
      }, input.actor || 'operator');
      await logEvent(env, { kind: 'hottake_angle_drafted', actor: input.actor || 'operator', payload: { id: input.id, title: (pkg.title || '').slice(0, 80) } });
      return { package: updated };
    },
  },
};
