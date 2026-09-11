// social-posts.js — auto-drafted social posts from published blog articles.
//
// Flow:
//   1. A blog post goes live → publish.js calls generateSocialPostsForBlog().
//      We draft ONE post per channel (company LinkedIn + company Facebook in
//      brand voice, personal LinkedIn in the operator's teaser voice) and save them as
//      `draft` rows. Idempotent — re-publishing never duplicates.
//   2. Operator reviews/edits in the Social module and approves.
//   3. approveAndPush() POSTs through the Make-webhook gateway
//      (lib/social-gateway.js), logs the send to the Outbox + activity feed,
//      and flips the row to `posted` (or `failed`).

import { uid, now } from './util.js';
import { logEvent, readBlogPost, readKnowledge, stripDashes, upsertCalendarEvent } from './db.js';
import { beginSend, markSent, markFailed } from './outbox.js';
// The Make social gateway is gone — the social webhook (Settings → Outbound
// webhooks) is the only door out. These shims keep legacy queue paths honest.
async function postToConnection(env, channel, { content, imageUrl } = {}) {
  const { sendWebhook } = await import('./webhooks.js');
  return sendWebhook(env, 'social', { type: 'social.post', channel, content, image_url: imageUrl || null }, { source: 'social-posts' });
}
function listConnections() { return []; }
import { callOpenAIJson } from './openai.js';

// The three channels every published article fans out to. `voice` picks which
// guide doc drives the draft; `label` is shown in the UI + outbox.
export const CHANNELS = [
  { key: 'linkedin-company',  network: 'LinkedIn', voice: 'brand', label: 'Company LinkedIn page' },
  { key: 'facebook-company',  network: 'Facebook', voice: 'brand', label: 'Company Facebook page' },
  { key: 'linkedin-personal', network: 'LinkedIn', voice: 'personal', label: 'Personal LinkedIn' },
];

import { siteBase } from './self-origin.js';

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── drafting ─────────────────────────────────────────────────
// `sourceKind`: 'blog' (default) — promotes a published Nyyon article.
//               'news' — reacts to an industry item with Nyyon's POV (no
//               article of ours exists yet; used for Digest-sourced drafts).
async function draftOne(env, channel, article, voiceBody, { sourceKind = 'blog', styleRules = '' } = {}) {
  const isPersonal = channel.voice === 'personal';
  const limit = isPersonal ? 1300 : 1200;
  const system = [
    sourceKind === 'news'
      ? `You write a single ${channel.network} post reacting to an industry news item with Nyyon's point of view.`
      : `You write a single ${channel.network} post that promotes a new Nyyon blog article.`,
    `Nyyon is a white-glove, AI-native marketing agency.`,
    ``,
    // Hard constraints FIRST and last — the banned-phrase list the operator
    // maintains. A draft that uses any banned phrase (or a variant of the same
    // reveal-tease construction) is INVALID; these override the voice guide.
    styleRules ? `HARD CONSTRAINTS — highest priority, override everything below. A draft that violates ANY of these is invalid and must be rewritten before you return it:\n${String(styleRules).slice(0, 2000)}\n` : '',
    `VOICE GUIDE (write IN this voice — its personality, wit, and rhythm, not just its rules):`,
    (voiceBody || '(no voice doc found — write plainly, concretely, no hype)').slice(0, 2600),
    ``,
    `RULES:`,
    `- Output ONE post as plain text. No markdown, no headings, no hashtags spam.`,
    isPersonal
      ? `- First person, as Lev. TEASE one or two conclusions from the article, do NOT summarize the whole thing. Humble close.`
      : `- Company voice. Confident and concrete, one clear idea, no hype words.`,
    `- Under ${limit} characters total.`,
    `- No exclamation marks. No em-dashes or en-dashes (use commas or plain hyphens).`,
    sourceKind === 'news'
      ? `- End by citing the source, and put the URL on its own final line.`
      : `- End by pointing to the article, and put the URL on its own final line.`,
    ``,
    `Return JSON: { "post": "the full post text, including the URL on its own last line" }`,
  ].join('\n');

  const prompt = [
    `Article title: ${article.title}`,
    `One-line answer / excerpt: ${article.excerpt || '(none)'}`,
    `Tags: ${article.tags || '(none)'}`,
    `Article URL: ${article.url}`,
    ``,
    `Article body (plain text, for context only — do not copy verbatim):`,
    article.snippet,
  ].join('\n');

  const out = await callOpenAIJson(env, { system, prompt });
  const text = stripDashes(String(out?.post || '').trim());
  if (!text) throw new Error('LLM returned an empty post');
  return text;
}

async function insertDraft(env, { blog_slug, blog_title, channel, content, image_url }) {
  const id = uid();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO social_posts (id, blog_slug, blog_title, channel, status, content, image_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  ).bind(id, blog_slug, blog_title || null, channel, content, image_url || null, t, t).run();
  return id;
}

// Draft ONE channel's post text with this module's fine-tuned instructions —
// the ONLY exported entry point for outside callers (Hot Takes' distribution
// legs use it), so the instruction assembly can never drift from the blog
// fan-out: same three notes, same hard style-rule constraints, same channel
// rules, same snippet construction, the untouched draftOne underneath.
export async function draftSocialPostText(env, channelKey, { title, excerpt = null, tags = null, url, bodyHtml = '' } = {}) {
  const ch = CHANNELS.find((c) => c.key === channelKey);
  if (!ch) throw new Error(`unknown social channel: ${channelKey}`);
  if (!title || !url) throw new Error('draftSocialPostText: title and url required');
  const article = {
    title,
    excerpt,
    tags: Array.isArray(tags) ? tags.join(', ') : (tags || ''),
    url,
    snippet: htmlToText(String(bodyHtml || '')).slice(0, 1600),
  };
  const [brandVoice, personalVoice, styleRules] = await Promise.all([
    readKnowledge(env, 'nyyon-brand-voice').catch(() => null),
    readKnowledge(env, 'operator-voice').catch(() => null),
    readKnowledge(env, 'writing-style-rules').catch(() => null),
  ]);
  return draftOne(env, ch, article, (ch.voice === 'personal' ? personalVoice : brandVoice)?.body || '', {
    styleRules: styleRules?.body || '',
  });
}

export const SOCIAL_CHANNELS = ['linkedin-company', 'linkedin-personal', 'facebook-company'];

// Add a STANDALONE social post — one the operator wrote with Nyo, not derived
// from a blog article. Lands as a 'draft' in the same review queue; the
// synthetic `standalone:` slug keeps it out of the per-article grouping.
export async function createSocialPost(env, { channel, content, title = null } = {}) {
  const ch = String(channel || '').trim();
  if (!SOCIAL_CHANNELS.includes(ch)) throw new Error(`channel must be one of: ${SOCIAL_CHANNELS.join(', ')}`);
  const body = stripDashes(String(content || '').trim());
  if (!body) throw new Error('content required');
  const id = await insertDraft(env, { blog_slug: `standalone:${uid()}`, blog_title: title || 'Standalone post', channel: ch, content: body, image_url: null });
  await logEvent(env, { kind: 'social_post_created', payload: { id, channel: ch, standalone: true } });
  return readSocialPost(env, id);
}

// Called by the blog publish hook. Drafts 3 posts for the given slug.
// Idempotent: if the slug already has social rows, does nothing (unless force).
export async function generateSocialPostsForBlog(env, slug, { source = 'blog-publish', force = false } = {}) {
  const post = await readBlogPost(env, slug);
  if (!post) return { ok: false, slug, reason: 'post not found' };

  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM social_posts WHERE blog_slug = ?').bind(slug).first();
  if ((existing?.n || 0) > 0 && !force) {
    return { ok: true, slug, skipped: true, reason: 'already has social posts' };
  }
  if (force) {
    // Clear only unposted rows so we never wipe an audit trail of what shipped.
    await env.DB.prepare(`DELETE FROM social_posts WHERE blog_slug = ? AND status IN ('draft','failed','skipped')`).bind(slug).run();
  }

  const article = {
    title:   post.title,
    excerpt: post.excerpt,
    tags:    Array.isArray(post.tags) ? post.tags.join(', ') : (post.tags || ''),
    url:     `${siteBase(env)}/blog/${slug}`,
    snippet: htmlToText(post.body).slice(0, 1600),
  };
  const image_url = post.featured_image_url || null;

  const brandVoice = (await readKnowledge(env, 'nyyon-brand-voice').catch(() => null))?.body || '';
  const personalVoice   = (await readKnowledge(env, 'operator-voice').catch(() => null))?.body || '';
  const styleRules = (await readKnowledge(env, 'writing-style-rules').catch(() => null))?.body || '';

  const results = await Promise.all(CHANNELS.map(async (ch) => {
    try {
      const content = await draftOne(env, ch, article, ch.voice === 'personal' ? personalVoice : brandVoice, { styleRules });
      const id = await insertDraft(env, { blog_slug: slug, blog_title: article.title, channel: ch.key, content, image_url });
      return { channel: ch.key, ok: true, id };
    } catch (e) {
      return { channel: ch.key, ok: false, error: String(e?.message || e) };
    }
  }));

  const made = results.filter((r) => r.ok).length;
  await logEvent(env, { kind: 'social_drafted', actor: 'system', payload: { slug, made, source } }).catch(() => {});
  return { ok: true, slug, drafted: made, results };
}

// Draft reaction posts for a Digest item (industry news/signal/insight) —
// not tied to a Nyyon blog post. Reuses the exact same per-channel drafting
// and `draft` social_posts rows as generateSocialPostsForBlog, so the result
// shows up in the Social module's normal review/edit/approve/send queue.
// `blog_slug` is set to a synthetic `digest:<id>` key (the column is
// NOT NULL and the Social UI groups by it) — readBlogPost/approveAndPush
// already handle a slug with no matching post gracefully.
export async function generateSocialPostsForDigestItem(env, item, { force = false } = {}) {
  const slug = `digest:${item.id}`;

  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM social_posts WHERE blog_slug = ?').bind(slug).first();
  if ((existing?.n || 0) > 0 && !force) {
    return { ok: true, slug, skipped: true, reason: 'already drafted' };
  }
  if (force) {
    await env.DB.prepare(`DELETE FROM social_posts WHERE blog_slug = ? AND status IN ('draft','failed','skipped')`).bind(slug).run();
  }

  const article = {
    title:   item.title,
    excerpt: item.summary || '',
    tags:    '',
    url:     item.source_url || '',
    snippet: (item.summary || item.title || '').slice(0, 1600),
  };

  const brandVoice = (await readKnowledge(env, 'nyyon-brand-voice').catch(() => null))?.body || '';
  const personalVoice   = (await readKnowledge(env, 'operator-voice').catch(() => null))?.body || '';
  const styleRules = (await readKnowledge(env, 'writing-style-rules').catch(() => null))?.body || '';

  const results = await Promise.all(CHANNELS.map(async (ch) => {
    try {
      const content = await draftOne(env, ch, article, ch.voice === 'personal' ? personalVoice : brandVoice, { sourceKind: 'news', styleRules });
      const id = await insertDraft(env, { blog_slug: slug, blog_title: article.title, channel: ch.key, content, image_url: null });
      return { channel: ch.key, ok: true, id };
    } catch (e) {
      return { channel: ch.key, ok: false, error: String(e?.message || e) };
    }
  }));

  const made = results.filter((r) => r.ok).length;
  await logEvent(env, { kind: 'social_drafted', actor: 'system', payload: { slug, made, source: 'digest' } }).catch(() => {});
  return { ok: true, slug, drafted: made, results };
}

// ─── queue helpers (route layer) ──────────────────────────────
export async function listSocialPosts(env, { status = null, slug = null, limit = 300 } = {}) {
  const where = []; const args = [];
  if (status) { where.push('status = ?');    args.push(status); }
  if (slug)   { where.push('blog_slug = ?');  args.push(slug); }
  const sql = `SELECT * FROM social_posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000));
  const r = await env.DB.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function readSocialPost(env, id) {
  return env.DB.prepare('SELECT * FROM social_posts WHERE id = ?').bind(id).first();
}

export async function patchSocialPost(env, id, { content }) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content required');
  await env.DB.prepare('UPDATE social_posts SET content = ?, updated_at = ? WHERE id = ?')
    .bind(stripDashes(content.trim()), now(), id).run();
  return readSocialPost(env, id);
}

export async function skipSocialPost(env, id) {
  await env.DB.prepare(`UPDATE social_posts SET status = 'skipped', updated_at = ? WHERE id = ?`).bind(now(), id).run();
  return readSocialPost(env, id);
}

export async function deleteSocialPost(env, id) {
  await env.DB.prepare('DELETE FROM social_posts WHERE id = ?').bind(id).run();
  return { ok: true, id };
}

// Delete every social post for one article (the "topic"). The Outbox + activity
// + calendar keep the record of anything already posted.
export async function deleteSocialGroup(env, slug) {
  const r = await env.DB.prepare('DELETE FROM social_posts WHERE blog_slug = ?').bind(slug).run();
  return { ok: true, slug, deleted: r?.meta?.changes ?? null };
}

// ─── release: approve + push through the gateway ──────────────
// Mirrors publish.js: log the attempt to Outbox first, push, then mark
// sent/failed. On success also flips the social_posts row + writes an activity
// event. Never double-sends a row already `posted`.
export async function approveAndPush(env, id) {
  const row = await readSocialPost(env, id);
  if (!row) throw new Error('social post not found');
  if (row.status === 'posted') throw new Error(`already posted (${id})`);

  const ch = CHANNELS.find((c) => c.key === row.channel);
  const post = await readBlogPost(env, row.blog_slug).catch(() => null);
  const imageTitle = post?.title || '';
  // Prefer the post's CURRENT cover over whatever was on the row at draft
  // time. A draft created before the cover existed would otherwise carry a
  // stale null forever, even after a cover gets generated later (the
  // 2026-07-09 incident: the post had a cover by the time this was approved,
  // but the row still held the null captured at draft time).
  const imageUrl = post?.featured_image_url || row.image_url || '';

  const log = await beginSend(env, {
    channel:    'social',
    kind:       row.channel,                     // linkedin-company | ...
    to_id:      row.channel,
    to_name:    ch?.label || row.channel,
    body:       row.content,
    payload:    { blog_slug: row.blog_slug, image_url: imageUrl || null },
    source:     'social',
    source_ref: row.blog_slug,
  });

  try {
    const res = await postToConnection(env, row.channel, {
      content: row.content,
      imageUrl,
      imageTitle,
      altText:      imageTitle,
      imageCaption: imageTitle,
    });
    await markSent(env, log.id, { message_id: res?.http ? String(res.http) : null });
    const t = now();
    await env.DB.prepare(`UPDATE social_posts SET status='posted', posted_at=?, outbox_id=?, error=NULL, updated_at=? WHERE id=?`)
      .bind(t, log.id, t, id).run();
    await logEvent(env, { kind: 'social_posted', actor: 'operator', payload: { id, channel: row.channel, slug: row.blog_slug, http: res?.http } }).catch(() => {});
    // Mirror the release onto the calendar (one event per social post). Its own
    // try/catch so a calendar hiccup never flips a successful send to failed.
    try {
      await upsertCalendarEvent(env, {
        kind:        'social_post',
        title:       `${ch?.label || row.channel}: ${post?.title || row.blog_title || row.blog_slug}`,
        description: (row.content || '').slice(0, 200),
        starts_at:   t,
        all_day:     false,
        status:      'done',
        source:      'social',
        source_ref:  id,
        link_url:    `${siteBase(env)}/blog/${row.blog_slug}`,
        platform:    ch?.network || null,
        body:        row.content,
        created_by:  'system',
      });
    } catch { /* best-effort */ }
    return { ok: true, id, channel: row.channel, outbox_id: log.id, result: res };
  } catch (e) {
    await markFailed(env, log.id, e);
    const t = now();
    await env.DB.prepare(`UPDATE social_posts SET status='failed', error=?, outbox_id=?, updated_at=? WHERE id=?`)
      .bind(String(e?.message || e).slice(0, 2000), log.id, t, id).run();
    await logEvent(env, { kind: 'social_failed', actor: 'operator', payload: { id, channel: row.channel, slug: row.blog_slug, error: String(e?.message || e).slice(0, 300) } }).catch(() => {});
    return { ok: false, id, channel: row.channel, error: String(e?.message || e), outbox_id: log.id };
  }
}

// ─── settings tab: which gateways are connected ───────────────
export function socialSettings(env) {
  // Only the three Make-webhook connections this module posts through.
  const keys = new Set(CHANNELS.map((c) => c.key));
  return listConnections(env).filter((c) => keys.has(c.connection));
}
