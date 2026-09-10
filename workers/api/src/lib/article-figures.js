// Article figures — generate 3-5 editorial diagrams per blog post, embed in body,
// set featured image. Orchestrator that wraps FIGURE_TEMPLATES with LLM spec
// generation, resvg rendering, R2 storage, and D1 updates. Works for new or
// existing posts; called from AEO writer after draft exists, and from batch
// backfill operations.

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '../../node_modules/@resvg/resvg-wasm/index_bg.wasm';

import interRegular from '../assets/fonts/Inter-Regular.ttf';
import interSemiBold from '../assets/fonts/Inter-SemiBold.ttf';
import interBold from '../assets/fonts/Inter-Bold.ttf';
import monoMedium from '../assets/fonts/JetBrainsMono-Medium.ttf';
import monoBold from '../assets/fonts/JetBrainsMono-Bold.ttf';

import { FIGURE_TEMPLATES, FIGURE_TEMPLATE_NAMES, FEATURED_TEMPLATE } from './article-figures-templates.js';
import { storeImageBytes } from './image-gateway.js';
import { readBlogPost, logEvent, logWorkflowRun, stripDashes, readKnowledge, writeKnowledge } from './db.js';
import { callOpenAIText, parseJsonLoose } from './openai.js';
import { now } from './util.js';

let wasmReady = null;

async function renderPng(svg, width) {
  if (!wasmReady) wasmReady = initWasm(resvgWasm);
  await wasmReady;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 2 },  // 2x for crisp
    font: {
      fontBuffers: [
        new Uint8Array(interRegular),
        new Uint8Array(interSemiBold),
        new Uint8Array(interBold),
        new Uint8Array(monoMedium),
        new Uint8Array(monoBold),
      ],
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  return resvg.render().asPng();
}

// LLM spec drafter — reads the article and designs a SET of figures that tell
// its story: each figure picks the template matching the SHAPE of one idea, is
// anchored to the exact sentence it illustrates, and the set uses varied shapes.
// Figure/cover copy follows the operator's editable brand voice, like every
// other drafting path; inline text stays as the fallback frame.
async function withVoice(env, base) {
  try {
    const row = await env.DB.prepare("SELECT body FROM knowledge_docs WHERE slug = 'nyyon-brand-voice'").first();
    if (row?.body) return `${base}\n\nBrand voice (operator-editable):\n${String(row.body).slice(0, 1200)}`;
  } catch { /* fallback */ }
  return base;
}
const DRAFTER_SYSTEM = `You are a technical figure designer for nyyon, a white-glove AI-native marketing agency. You turn an article into a SET of editorial diagrams that TELL THE ARTICLE'S STORY — each diagram placed at the exact point it illustrates.

You receive the article (title, excerpt, body text) and a menu of templates in two families: DIAGRAMS (story shapes) and DATA CHARTS (chart_*, real numbers on real scales — the selection guide below says which to use when). Pick what matches the shape of the idea, not habit. The diagram shapes:

- contrast: TWO things compared side by side — old vs new, A vs B, the wrong way vs the right way.
- layers: a STACKED architecture or a boundary between planes — tiers, build-plane over operate-plane, a trust boundary.
- cycle: a LOOP or repeating process — a feedback loop, stages that circle a central goal, learn-and-adapt.
- fanout: ONE thing branching into MANY — one event → many outcomes, one input → many states, one capability used by many teams.
- columns: a CATEGORIZED breakdown into 3-4 parallel groups — tiers, pillars, model types, job categories.
- grid: a CONTROL ROOM of 4 panels — dashboards, four named views/jobs each with a list of rows.
- funnel: a NARROWING sequence — a demand/conversion funnel, stages that shrink (impressions → clicks → pipeline → won).
- timeline: events along TIME — phases, a rollout, a week-by-week or before→after sequence on a horizontal axis.
- quadrant: a 2x2 POSITIONING MATRIX with two named axes — where to be vs not be, plotted on two dimensions.
- pyramid: a HIERARCHY of tiers, wide base to narrow apex — a maturity model, a hierarchy of needs/value.
- venn: an INTERSECTION of two things — where human + AI overlap, the shared zone between two domains.
- table: a CRITERIA × OPTIONS comparison — rows of attributes scored across 2-3 options (yes/no, short cells).
- pipeline: a LINEAR left→right process — a production line of stages, each with one job (NOT a loop; use cycle for loops).
- radial: a CENTRAL hub with radiating members — an ecosystem, a data spine every tool plugs into, dependencies around a core.
- bigstat: 2-4 OVERSIZED NUMBERS — headline metrics or a stark quantified claim (cost, speed, percentage).
- progression: ASCENDING steps — growth/escalation/maturity stages rising left to right (headcount → leverage).

RULES — follow all of them:
1. Design 3-4 figures (5 only for very long articles).
2. USE A WIDE VARIETY OF SHAPES from the FULL menu — diagrams AND charts (a chart ONLY where the article carries real numbers). A strong set uses 3-4 DIFFERENT templates and reaches beyond the obvious contrast+columns — if the article has a number worth enlarging use bigstat, a process use pipeline/cycle, a maturity arc use pyramid/progression, two dimensions use quadrant, a shared zone use venn, a sequence in time use timeline, a hub use radial. Do NOT repeat a template in one set unless the article genuinely contains two separate instances of that exact shape.
3. Map the article's KEY MOVES to templates: the central comparison, the mechanism/architecture, the process or loop, the breakdown of parts, the headline number, the maturity arc. Build one figure per real move — pick the shape that fits that move best.
4. For EACH figure, set "anchor": copy a SHORT EXACT phrase (6-12 words) from the article body, VERBATIM (same words, same order), marking the sentence that figure illustrates. The figure is placed right after that sentence. Choose anchors SPREAD ACROSS the article — intro, middle, and later sections — NEVER all near the top. Two figures must not share an anchor.
5. Mark exactly ONE figure "featured": true — the one that best captures the article's central idea (usually the main mechanism or the core comparison).
6. Set "alt": one plain-English sentence describing the figure, for accessibility.
7. Fill every slot the template needs. Respect character limits. Use CAPS where a slot says caps. Keep labels terse and concrete — nyyon voice: declarative, zero hype.
8. Also design the "cover" — the article's hero/featured image. Provide: "kicker" (a short topic label in caps, <=26 chars, e.g. "AI-NATIVE MARKETING" or "FIELD NOTE"); "highlight" (ONE word or short phrase copied EXACTLY from the article title that carries the idea — it prints in the accent colour, <=24 chars); "sub" (a one-line standfirst, <=84 chars — usually a sharpened version of the excerpt). The title itself is supplied separately; do not repeat it.

Output ONLY valid JSON, no markdown:
{ "figures": [ { "template": "<name>", "anchor": "<exact phrase from body>", "featured": false, "alt": "<one sentence>", "slots": { ... } } ], "cover": { "kicker": "...", "highlight": "...", "sub": "..." } }`;


// ─── knowledge: chart selection ──────────────────────────────────────────────
// Which chart to use when — the Datawrapper method, mapped to our chart_*
// templates. Lives in the figure-chart-selection knowledge doc (seeded below,
// editable live, no deploy); this constant is only the seed + fallback.
const CHART_GUIDE_SLUG = 'figure-chart-selection';
export const CHART_GUIDE_DEFAULT = `DATA CHARTS — when an idea is backed by REAL NUMBERS, draw the numbers, not a metaphor. Pick by GOAL (the chart's main statement is the compass; once you know the goal, most chart types can simply be ignored):

CHANGE OVER TIME
- chart_line: the default for a value moving across months/years, up to 5 series. More than ~5 overlapping lines is spaghetti — use chart_multiples.
- chart_multiples: many series, one mini panel each, ONE shared scale.
- chart_area: how a total's internal breakdown shifted over time (mode "share" for a 100% view). Composition is the story, not precise values.
- chart_column: just a FEW points in time (five years of incidents). Many periods → chart_line.
- chart_slope: only the first and last point across categories — when the wiggles between are not the story.
- chart_arrow: compact before→after for many categories; a bit less mainstream to read.

SHARES OF A WHOLE
- chart_bar: percentages compare better as bars than pie slices — a 3-point gap is visible in a bar, invisible in a pie. The DEFAULT for shares.
- chart_pie: only a simple, obvious split (2-4 slices, one dominant); donut mode carries a center stat.
- chart_parliament: seats and votes.
- chart_waffle: an illustrative of-100 share; trades precision for warmth.
- chart_treemap: proportions across MANY categories (to ~12).
- chart_marimekko: shares AND absolute size at once (column width = size).
- chart_bar_stacked mode "share": survey / Likert rows.

AMOUNTS
- chart_bar: the workhorse — sorted, direct-labeled.
- chart_bar_grouped: 2-3 values compared within each category.
- chart_bar_stacked mode "absolute": totals split into parts.
- chart_bar_split: two components mirrored (in/out, male/female — population pyramids).
- chart_dot: several values per category in little space.
- chart_prop_area: 2-4 magnitudes as area-true shapes — impact over precision.
- bigstat (diagram): when ONE number IS the story, print it huge instead of charting it.

RELATIONSHIPS
- chart_scatter: does X relate to Y? Label only points worth naming; hot:true accents them; size makes it a bubble chart (area-true).
- chart_heatmap: a matrix of intensity (day × time, category × stage); also the fix for an unreadable dot cloud.

FLOWS
- chart_sankey: volume flowing source → destination (money, leads, energy).

CHART RULES (the renderer enforces the hard ones):
- Bars, columns, areas and waffles always start at zero; lines may zoom.
- Direct labels beat legends — the templates label line ends and bar ends themselves.
- NEVER invent numbers. Chart templates are ONLY for real figures present in the article or supplied by the operator. If the text gestures at magnitude without numbers, use a diagram (story shape) instead.
- Familiar beats fancy for a mainstream audience; one less-common shape (slope, arrow, marimekko) can wake up a chart-heavy piece.
- Small screens: prefer bars (grow down) over columns (grow right).
- GEO MAPS (choropleth/symbol/locator) are NOT renderable here (no shape data): use chart_bar or chart_heatmap by region instead.`;

// doc > coded default; seeds the doc on first read so it shows in Knowledge.
async function withChartGuide(env, base) {
  try {
    const doc = await readKnowledge(env, CHART_GUIDE_SLUG);
    if (!doc) {
      await writeKnowledge(env, { slug: CHART_GUIDE_SLUG, title: 'Figures · which chart to use when', body: CHART_GUIDE_DEFAULT }).catch(() => {});
      return `${base}\n\n${CHART_GUIDE_DEFAULT}`;
    }
    return `${base}\n\n${String(doc.body || CHART_GUIDE_DEFAULT)}`;
  } catch { return `${base}\n\n${CHART_GUIDE_DEFAULT}`; }
}

async function draftFigureSpecs(env, { title, excerpt, body_text }) {
  const menu = FIGURE_TEMPLATE_NAMES
    .map((name) => {
      const tpl = FIGURE_TEMPLATES[name];
      return `${name}: ${tpl.slots}`;
    })
    .join('\n\n');

  const prompt = [
    `Article title: ${title}`,
    `Excerpt: ${excerpt || '(none)'}`,
    '',
    'Article body (text only — copy anchors verbatim from this):',
    body_text.replace(/<[^>]+>/g, '').slice(0, 6000),  // strip HTML, cap
    '',
    'Templates and their slots:',
    menu,
    '',
    'Design 3-4 figures with varied shapes, each anchored to the sentence it illustrates, spread across the article.',
  ].join('\n');

  const raw = await callOpenAIText(env, {
    system: await withChartGuide(env, await withVoice(env, DRAFTER_SYSTEM)),
    prompt,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = parseJsonLoose(raw);
    const figures = (parsed.figures || []).slice(0, 5);
    for (const fig of figures) {
      if (!FIGURE_TEMPLATES[fig.template]) fig.template = 'contrast';  // fallback
    }
    return { figures, cover: parsed.cover || null };
  } catch (e) {
    throw new Error(`article-figures: draft parse error: ${e.message}`);
  }
}

// ─── placement ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Tag-stripped, whitespace-collapsed view of the body with an index map back to
// original offsets — lets us locate an anchor sentence even across inline tags.
function buildPlainMap(html) {
  let plain = '', inTag = false, prevSpace = false;
  const map = [];
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') { inTag = true; continue; }
    if (ch === '>') { inTag = false; continue; }
    if (inTag) continue;
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      plain += ' '; map.push(i); prevSpace = true;
    } else {
      plain += ch.toLowerCase(); map.push(i); prevSpace = false;
    }
  }
  return { plain, map };
}

// Insert each figure after the block (</p>, </h2>, …) containing its anchor
// sentence. Unanchored / not-found figures are spread evenly across remaining
// block boundaries. Returns { body, placed }.
function embedFigures(body, figures) {
  const figHtml = (f) =>
    `<figure><img src="${f.url}" alt="${esc(f.alt || f.fig_label || 'Editorial diagram')}" loading="lazy" /></figure>`;

  const blockRe = /<\/(?:p|h2|h3|ul|ol|blockquote)>/gi;
  const ends = [];
  let bm;
  while ((bm = blockRe.exec(body))) ends.push(bm.index + bm[0].length);
  if (ends.length === 0) return { body: body + figures.map(figHtml).join(''), placed: figures.length };

  const { plain, map } = buildPlainMap(body);
  const used = new Set();
  const placements = [];
  const unplaced = [];

  const blockEndAfter = (origIdx) => {
    for (const e of ends) if (e > origIdx && !used.has(e)) return e;
    return null;
  };

  for (const fig of figures) {
    let origIdx = -1;
    if (fig.anchor) {
      const a = String(fig.anchor).toLowerCase().replace(/\s+/g, ' ').trim();
      const raw = body.toLowerCase().indexOf(a);
      if (raw >= 0) origIdx = raw;
      else {
        const pi = plain.indexOf(a);
        if (pi >= 0) origIdx = map[pi];
        else if (a.length > 24) {
          const pi2 = plain.indexOf(a.slice(0, 24));   // prefix fallback
          if (pi2 >= 0) origIdx = map[pi2];
        }
      }
    }
    if (origIdx >= 0) {
      const e = blockEndAfter(origIdx);
      if (e != null) { placements.push({ offset: e, html: figHtml(fig) }); used.add(e); continue; }
    }
    unplaced.push(figHtml(fig));
  }

  // spread unplaced figures across the remaining block boundaries
  const free = ends.filter((e) => !used.has(e));
  if (unplaced.length && free.length) {
    const step = Math.max(1, Math.floor(free.length / (unplaced.length + 1)));
    let fi = step;
    for (const html of unplaced) {
      const e = free[Math.min(fi, free.length - 1)];
      if (!used.has(e)) { placements.push({ offset: e, html }); used.add(e); }
      fi += step;
    }
  }

  placements.sort((x, y) => y.offset - x.offset);   // splice from end to start
  let out = body;
  for (const pl of placements) out = out.slice(0, pl.offset) + pl.html + out.slice(pl.offset);
  return { body: out, placed: placements.length };
}

/**
 * Generate article figures for a blog post.
 *
 * Reads the post, picks templates via LLM, renders PNGs, uploads to R2,
 * embeds into body, sets featured_image_url. Returns { figures, body_with_figs, featured_url }.
 */
// Strip en/em dashes from every string in a figure/cover slot tree before it is
// rendered into a PNG. The body strip can't fix text baked into an image, so the
// no-dash rule has to be enforced here too (deep walk: strings, arrays, objects).

// The operator's brand for rendered cards: company name from the social
// identities doc, else the company profile, else blank. The site stamp is
// this install's own site host. Never a hardcoded brand.
async function operatorBrand(env) {
  let name = '';
  try {
    const { readKnowledge } = await import('./db.js');
    const ids = await readKnowledge(env, 'hottakes-social-identities');
    const m = String(ids?.body || '').match(/```json\s*([\s\S]*?)```/);
    const co = m ? (JSON.parse(m[1])['linkedin-company'] || {}) : {};
    if (co.name && !/your company/i.test(co.name)) name = String(co.name);
    if (!name) {
      const about = await readKnowledge(env, 'about');
      const am = String(about?.body || '').match(/Company name\*?\*?\s*[—:-]\s*(.+)/);
      if (am) name = am[1].trim();
    }
  } catch { /* blank brand beats a wrong brand */ }
  let site = '';
  try {
    const { siteBase } = await import('./self-origin.js');
    const b = siteBase(env);
    if (b) site = new URL(b).host.toUpperCase();
  } catch { /* no site stamp */ }
  return { name, site };
}

function stripSlots(v) {
  if (v == null) return v;
  if (typeof v === 'string') return stripDashes(v);
  if (Array.isArray(v)) return v.map(stripSlots);
  if (typeof v === 'object') { const o = {}; for (const k in v) o[k] = stripSlots(v[k]); return o; }
  return v;
}

export async function generateArticleFigures(env, opts = {}) {
  const startedAt = now();

  if (!opts.slug) throw new Error('article-figures: slug required');

  let post = null;
  try {
    post = await readBlogPost(env, opts.slug);
    if (!post) throw new Error(`blog post not found: ${opts.slug}`);
  } catch (e) {
    await logEvent(env, {
      kind: 'article_figures_failed',
      actor: opts.actor || 'system',
      payload: { slug: opts.slug, error: `read: ${String(e.message).slice(0, 200)}` },
    });
    throw e;
  }

  try {
    // Work on a copy of the body. In replace mode strip any figures already
    // embedded (a prior run) so we can regenerate cleanly; otherwise skip if
    // figures are present.
    let workBody = post.body || '';
    if (opts.replace) {
      workBody = workBody.replace(
        /<figure>\s*<img[^>]*blog-figures\/[^>]*>\s*<\/figure>/gi, '',
      );
    } else if (workBody.includes('blog-figures/')) {
      return { ok: false, reason: 'figures_already_embedded', slug: opts.slug };
    }

    // Draft figure specs + cover via LLM (varied templates, anchored to sentences)
    const { figures: figureSpecs, cover } = await draftFigureSpecs(env, {
      title: post.title,
      excerpt: post.excerpt,
      body_text: workBody,
    });

    if (!figureSpecs || figureSpecs.length === 0) {
      throw new Error('no figure specs generated');
    }

    // Render each figure to PNG, carrying the spec's anchor/featured/alt through
    const figures = [];
    for (const spec of figureSpecs) {
      const tpl = FIGURE_TEMPLATES[spec.template];
      if (!tpl) continue;

      try {
        const svg = tpl.build(stripSlots(spec.slots));
        const png = await renderPng(svg, tpl.width);
        const key = `blog-figures/${post.slug}-fig-${figures.length + 1}.png`;
        const url = await storeImageBytes(env, key, png, {
          kind: 'article_figure',
          template: spec.template,
          slug: post.slug,
          generated_at: String(startedAt),
        });
        figures.push({
          template:  spec.template,
          url,
          key,
          size_bytes: png.length,
          slots:     spec.slots,
          anchor:    spec.anchor || null,
          featured:  !!spec.featured,
          alt:       spec.alt || null,
          fig_label: spec.slots?.fig_label || null,
        });
      } catch (renderErr) {
        console.error(`[article-figures] render ${spec.template} failed:`, renderErr);
        await logEvent(env, { kind: 'article_figures_error', actor: 'system', payload: {
          op: 'render_figure', slug: post.slug, template: spec.template,
          error: String(renderErr?.stack || renderErr?.message || renderErr).slice(0, 800),
        } }).catch(() => {});
      }
    }

    if (figures.length === 0) {
      throw new Error('no figures rendered successfully');
    }

    // Embed figures at their anchor sentences (story-placed, spread out)
    const { body: enrichedBody, placed } = embedFigures(workBody, figures);

    // Render the dedicated FEATURED COVER (1200x630 hero) and use it as the
    // featured image. Falls back to the LLM-flagged in-body figure if the cover
    // can't be drafted/rendered for any reason.
    let featuredUrl = (figures.find((f) => f.featured) || figures[0]).url;
    let coverUrl = null;
    try {
      const brand = await operatorBrand(env);
      const coverSvg = FEATURED_TEMPLATE.build(stripSlots({
        kicker:    cover?.kicker || (Array.isArray(post.tags) ? post.tags[0] : null) || brand.name || 'BRIEF',
        title:     post.title,
        highlight: cover?.highlight || '',
        sub:       cover?.sub || post.excerpt || '',
        site:      brand.site,
      }));
      const coverPng = await renderPng(coverSvg, FEATURED_TEMPLATE.width);
      const coverKey = `blog-figures/${post.slug}-cover.png`;
      coverUrl = await storeImageBytes(env, coverKey, coverPng, {
        kind: 'article_cover', slug: post.slug, generated_at: String(startedAt),
      });
      featuredUrl = coverUrl;
    } catch (coverErr) {
      console.error(`[article-figures] cover render failed for ${post.slug}:`, coverErr?.message || coverErr);
      await logEvent(env, { kind: 'article_figures_error', actor: 'system', payload: {
        op: 'render_cover', slug: post.slug,
        error: String(coverErr?.stack || coverErr?.message || coverErr).slice(0, 800),
      } }).catch(() => {});
    }

    await env.DB.prepare(
      `UPDATE blog_posts SET body=?, featured_image_url=?, featured_image_model=?, featured_image_generated_at=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(stripDashes(enrichedBody), featuredUrl, 'article-cover', startedAt, now(), opts.actor || 'system', post.slug).run();

    await logEvent(env, {
      kind: 'article_figures_generated',
      actor: opts.actor || 'system',
      payload: { slug: post.slug, count: figures.length, featured_url: featuredUrl },
    });

    await logWorkflowRun(env, {
      workflow_slug: 'article-figures',
      status: 'succeeded',
      trigger_kind: opts.trigger_kind || 'manual',
      trigger_payload: { slug: post.slug, title: post.title },
      output: { count: figures.length, placed, featured_url: featuredUrl, templates: figures.map((f) => f.template), figures: figures.map((f) => ({ template: f.template, url: f.url, anchor: f.anchor })) },
      started_at: startedAt,
    });

    return {
      ok: true,
      slug: post.slug,
      title: post.title,
      count: figures.length,
      placed,
      templates: figures.map((f) => f.template),
      figures,
      featured_url: featuredUrl,
      started_at: startedAt,
    };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await logEvent(env, {
      kind: 'article_figures_failed',
      actor: opts.actor || 'system',
      payload: { slug: opts.slug, error: msg },
    });
    await logWorkflowRun(env, {
      workflow_slug: 'article-figures',
      status: 'failed',
      trigger_kind: opts.trigger_kind || 'manual',
      trigger_payload: { slug: opts.slug, title: post?.title },
      error: msg,
      started_at: startedAt,
    });
    throw e;
  }
}

// Lightweight cover-slot drafter: derives just the three hero slots from the
// title + excerpt. Far cheaper than draftFigureSpecs (no body, no template
// menu, tiny max_tokens) so a full-catalogue cover backfill won't exhaust the
// LLM's per-minute token budget the way the heavy drafter does.
const COVER_SYSTEM = `You design the hero cover for an editorial blog by Nyyon, a white-glove AI-native marketing agency. Given an article title and excerpt, return ONLY raw JSON with the three requested fields. Always spell the brand "Nyyon" with a capital N.`;

async function draftCoverSlots(env, { title, excerpt }) {
  const prompt = [
    `Title: ${title}`,
    `Excerpt: ${excerpt || ''}`,
    '',
    'Return JSON: {',
    '  "kicker": "<short topic label in CAPS, <=26 chars, e.g. AI-NATIVE MARKETING>",',
    '  "highlight": "<ONE word or short phrase copied EXACTLY from the Title, <=24 chars, the idea-carrying part that prints in the accent colour>",',
    '  "sub": "<one-line standfirst, <=84 chars, a sharpened version of the excerpt>"',
    '}',
  ].join('\n');
  const raw = await callOpenAIText(env, {
    system: await withVoice(env, COVER_SYSTEM),
    prompt,
    response_format: { type: 'json_object' },
    max_tokens: 400,
  });
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return { kicker: parsed.kicker || null, highlight: parsed.highlight || '', sub: parsed.sub || null };
}

// Re-render ONLY the featured cover for an existing post and overwrite it in
// place. No LLM, no body change — used to refresh branding (e.g. the wordmark)
// on covers that were generated by an older engine. Deterministic slots come
// straight from the stored post; the kicker is the post's first tag (falls back
// to NYYON). Writes to the same R2 key, so the live image URL updates in place.
export async function regenerateCover(env, opts = {}) {
  const startedAt = now();
  if (!opts.slug) throw new Error('regenerate-cover: slug required');

  const post = await readBlogPost(env, opts.slug);
  if (!post) throw new Error(`blog post not found: ${opts.slug}`);

  let firstTag = null;
  try {
    const t = JSON.parse(post.tags || '[]');
    if (Array.isArray(t) && t.length && typeof t[0] === 'string') firstTag = t[0];
  } catch { /* tags may be a plain string or null — fall back to NYYON */ }

  // Deterministic slots: used as-is, or as the fallback when LLM polish fails.
  let slots = {
    kicker:    firstTag || 'NYYON',
    title:     post.title,
    highlight: '',
    sub:       post.excerpt || '',
  };
  let model = 'article-cover';

  // Polish: re-draft the cover's kicker/highlight/standfirst via the same LLM
  // drafter the original generator uses, so the refreshed cover keeps the
  // accent highlight word and custom standfirst. Only the cover slots are used;
  // the figure specs it returns are ignored (the body is never touched here).
  if (opts.polish) {
    try {
      const cover = await draftCoverSlots(env, { title: post.title, excerpt: post.excerpt });
      if (cover) {
        slots = {
          kicker:    cover.kicker || slots.kicker,
          title:     post.title,
          highlight: cover.highlight || '',
          sub:       cover.sub || slots.sub,
        };
        model = 'article-cover-llm';
      }
    } catch (e) {
      console.error(`[regenerate-cover] LLM draft failed for ${post.slug}, using deterministic slots:`, e?.message || e);
      await logEvent(env, { kind: 'article_figures_error', actor: 'system', payload: {
        op: 'cover_llm_draft_fallback', slug: post.slug, degraded: 'deterministic slots used',
        error: String(e?.stack || e?.message || e).slice(0, 800),
      } }).catch(() => {});
    }
  }

  const coverSvg = FEATURED_TEMPLATE.build(stripSlots(slots));
  const coverPng = await renderPng(coverSvg, FEATURED_TEMPLATE.width);
  // Versioned key: a same-key overwrite of `${slug}-cover.png` is served stale
  // by the r2.dev CDN cache (observed), so a regenerated cover would never show
  // up live. A fresh path is a guaranteed cache miss. The old object is left as
  // a harmless orphan (still referenced by already-prerendered og:image tags
  // until the public site is redeployed).
  const coverKey = `blog-figures/${post.slug}-cover-${startedAt}.png`;
  const coverUrl = await storeImageBytes(env, coverKey, coverPng, {
    kind: 'article_cover', slug: post.slug, generated_at: String(startedAt),
  });

  await env.DB.prepare(
    `UPDATE blog_posts SET featured_image_url=?, featured_image_model=?, featured_image_generated_at=?, updated_at=?, updated_by=? WHERE slug=?`,
  ).bind(coverUrl, model, startedAt, now(), opts.actor || 'system', post.slug).run();

  await logEvent(env, {
    kind: 'article_cover_regenerated',
    actor: opts.actor || 'system',
    payload: { slug: post.slug, featured_url: coverUrl, model },
  });

  return { ok: true, slug: post.slug, featured_url: coverUrl, model, started_at: startedAt };
}

// ─── single-figure regenerate ────────────────────────────────────────────────
// Redesign ONE in-article chart, optionally steered by operator instructions —
// the editor's per-chart "Change" button. Unlike generateArticleFigures this
// never touches the rest of the body: it finds the one <figure> block, drafts a
// single replacement spec (the operator's instructions lead the prompt when
// given), renders it, and splices it in place.
const SINGLE_DRAFTER_SYSTEM = `You are a technical figure designer for nyyon, a white-glove AI-native marketing agency. You redesign ONE editorial diagram inside an existing article.

You receive the article's title/excerpt, the text surrounding the figure being replaced (marked [THE FIGURE SITS HERE]), the current figure's description, optional OPERATOR INSTRUCTIONS, and a menu of diagram templates (each is a STORY SHAPE — pick the one matching the shape of the idea at that point in the article).

RULES:
1. Design exactly ONE figure. It must illustrate the point made in the surrounding text.
2. If OPERATOR INSTRUCTIONS are present they OVERRIDE everything else — follow them literally (template choice, content, framing).
3. Without instructions, produce a genuinely different, better take than the current figure — a sharper shape or sharper labels, not a cosmetic reshuffle.
4. Fill every slot the chosen template needs. Respect character limits. Use CAPS where a slot says caps. Terse, concrete labels — nyyon voice: declarative, zero hype.
5. Set "alt": one plain-English sentence describing the figure.

Output ONLY valid JSON, no markdown:
{ "template": "<name>", "alt": "<one sentence>", "slots": { ... } }`;

export async function regenerateOneFigure(env, opts = {}) {
  const startedAt = now();
  const { slug, src, instructions } = opts;
  if (!slug) throw new Error('regenerate-figure: slug required');
  if (!src) throw new Error('regenerate-figure: src required');

  const post = await readBlogPost(env, slug);
  if (!post) throw new Error(`blog post not found: ${slug}`);
  const body = post.body || '';

  // Identify the figure by the stable blog-figures/... path segment of its img
  // src — identical in dev-rewritten and public URLs, so the client can send
  // whichever it is displaying.
  const pathMatch = String(src).match(/blog-figures\/[^"'?\s]+/);
  if (!pathMatch) throw new Error('regenerate-figure: src is not an article figure');
  const pathKey = pathMatch[0];

  const figRe = /<figure\b[^>]*>[\s\S]*?<\/figure>/gi;
  let block = null;
  let blockStart = -1;
  let fm;
  while ((fm = figRe.exec(body))) {
    if (fm[0].includes(pathKey)) { block = fm[0]; blockStart = fm.index; break; }
  }
  if (!block) throw new Error('regenerate-figure: figure not found in article body');

  const currentAlt = (block.match(/alt="([^"]*)"/i) || [])[1] || '';

  // Plain-text context around the figure, so the replacement illustrates the
  // same point in the article's story.
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const before = strip(body.slice(0, blockStart));
  const after = strip(body.slice(blockStart + block.length));
  const context = `${before.slice(-700)}\n[THE FIGURE SITS HERE]\n${after.slice(0, 400)}`;

  const menu = FIGURE_TEMPLATE_NAMES
    .map((name) => `${name}: ${FIGURE_TEMPLATES[name].slots}`)
    .join('\n\n');

  const prompt = [
    `Article title: ${post.title}`,
    `Excerpt: ${post.excerpt || '(none)'}`,
    '',
    'Text surrounding the figure being replaced:',
    context,
    '',
    `Current figure's description (alt): ${currentAlt || '(none)'}`,
    instructions ? `\nOPERATOR INSTRUCTIONS — follow these above all else:\n${String(instructions).slice(0, 1000)}` : '',
    '',
    'Templates and their slots:',
    menu,
    '',
    'Design the ONE replacement figure now. Return the JSON.',
  ].filter((l) => l !== null).join('\n');

  try {
    const raw = await callOpenAIText(env, {
      system: await withChartGuide(env, await withVoice(env, SINGLE_DRAFTER_SYSTEM)),
      prompt,
      response_format: { type: 'json_object' },
    });
    const spec = parseJsonLoose(raw);
    if (!spec || typeof spec !== 'object' || !spec.slots) throw new Error('drafter returned no figure spec');
    if (!FIGURE_TEMPLATES[spec.template]) spec.template = 'contrast'; // fallback, same as the batch drafter

    const tpl = FIGURE_TEMPLATES[spec.template];
    const svg = tpl.build(stripSlots(spec.slots));
    const png = await renderPng(svg, tpl.width);
    // Versioned key — a same-key overwrite is served stale by the r2.dev CDN
    // (the regenerateCover lesson), so a fresh path guarantees a cache miss.
    const key = `blog-figures/${post.slug}-fig-r${startedAt}.png`;
    const url = await storeImageBytes(env, key, png, {
      kind: 'article_figure',
      template: spec.template,
      slug: post.slug,
      generated_at: String(startedAt),
    });

    const alt = spec.alt || currentAlt || 'Editorial diagram';
    const figureHtml = `<figure><img src="${url}" alt="${esc(alt)}" loading="lazy" /></figure>`;
    const nextBody = body.slice(0, blockStart) + figureHtml + body.slice(blockStart + block.length);

    await env.DB.prepare(
      `UPDATE blog_posts SET body=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(stripDashes(nextBody), now(), opts.actor || 'operator', post.slug).run();

    await logEvent(env, {
      kind: 'article_figure_regenerated',
      actor: opts.actor || 'operator',
      payload: { slug: post.slug, replaced: pathKey, url, template: spec.template, instructed: !!instructions },
    });

    return { ok: true, slug: post.slug, url, alt, template: spec.template, figure_html: figureHtml };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await logEvent(env, {
      kind: 'article_figure_regenerate_failed',
      actor: opts.actor || 'operator',
      payload: { slug, replaced: pathKey, error: msg },
    });
    throw e;
  }
}
