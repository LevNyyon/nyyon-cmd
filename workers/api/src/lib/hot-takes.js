// Hot Takes — the editorial "publication package" pool. ONE shared place where
// the SQL for hot_take_packages + hot_take_posts lives, so both the
// /api/hot-takes routes AND the hottake_* tools delegate here and every mutation
// logs to the activity bus once. This lib does DB + orchestration only; NEW
// reasoning (draft-a-take, brief, review scan, social drafting) lives in the
// tool layer via the `llm` gateway. The one deliberate exception is the heavy
// article write, which REUSES the existing composeAndSavePost pipeline
// (lib/aeo-writer.js) — the article body lands in blog_posts and is linked back
// here by blog_slug, inheriting figures, cover, publish + edge-render for free.
//
// Distribution safety: LinkedIn legs (postLeg, and the hourly due-scan firing
// them) are gated on the `hottakes.live` feature flag. false → DRY RUN; absent
// → live exactly when a social webhook is configured (see hotTakesLive)
// (log + preview, no side effects). Flip it via PUT
// /api/feature-flags/hottakes.live {value:true} when ready. The WEBSITE leg is
// deliberately NOT gated: publishing to nyyon.com is the same trust level as the
// Blog page's Approve button (also ungated), so a scheduled publication really
// goes live at its date — that is the whole point of scheduling it.

import { now, uid, safeJSON } from './util.js';
import {
  logEvent, readKnowledge, writeKnowledge, flagsAsObject,
  readBlogPost, patchBlogPost, upsertCalendarEvent,
} from './db.js';
import { topHotTopics, topSignals, listHeartbeatSources } from './heartbeat.js';
import { listDigestItems } from './digest.js';
import { beginSend, markSent, markFailed } from './outbox.js';
import { callGateway } from '../gateways/index.js';

const genId = (prefix) => `${prefix}_${uid().replace(/-/g, '').slice(0, 12)}`;

// One definition of the public article URL — used by scheduling, publishing,
// the calendar mirror, and the social-draft prompt (no scattered copies).
// Based on the operator's own site (WEBSITE_BASE_URL, else this install's
// origin) — never a hardcoded domain.
import { siteBase } from './self-origin.js';
export const blogUrl = (env, slug) => `${siteBase(env)}/blog/${slug}/`;

// ── live/dry-run gate ───────────────────────────────────────────────────────
// Explicit flag wins both ways. With NO flag set, configuring the social
// webhook IS the go-live act: on a webhook-only build, a wired webhook that
// silently dry-runs is the trap, not the safety. (Set hottakes.live=false to
// force dry-run while a webhook is connected.)
export async function hotTakesLive(env) {
  try {
    const flags = await flagsAsObject(env);
    if (flags['hottakes.live'] === true) return true;
    if (flags['hottakes.live'] === false) return false;
    const { loadWebhooks } = await import('./webhooks.js');
    return !!(await loadWebhooks(env)).social_url;
  } catch {
    return false;
  }
}

// The release channels a Hot Take is distributed on. DERIVED from the social
// gateway's connection registry (the single source of truth), narrowed to the
// LinkedIn networks — no separate copy of the channel list lives here. The
// literal below is only the fallback used when the gateway can't be read.
const RELEASE_CHANNELS_FALLBACK = ['linkedin-company', 'linkedin-personal'];
export function releaseChannels(env) {
  try {
    const li = listConnections(env).filter((c) => c.network === 'linkedin').map((c) => c.connection);
    return li.length ? li : RELEASE_CHANNELS_FALLBACK;
  } catch {
    return RELEASE_CHANNELS_FALLBACK;
  }
}

// ── row normalizers ─────────────────────────────────────────────────────────
function rowToPackage(row) {
  if (!row) return null;
  const { multi_source_json, brief_json, review_json, ...rest } = row;
  return {
    ...rest,
    pinned: !!row.pinned,
    multi_source: safeJSON(multi_source_json) || [],
    brief: safeJSON(brief_json) || null,
    review: safeJSON(review_json) || null,
  };
}

// ── package CRUD ────────────────────────────────────────────────────────────
export async function listPackages(env, { statuses = null, pinned = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (Array.isArray(statuses) && statuses.length) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  } else {
    where.push(`status != 'dismissed'`);
  }
  if (pinned === true) where.push('pinned = 1');
  const lim = Math.min(Math.max(1, Number(limit) || 200), 500);
  const sql = `SELECT * FROM hot_take_packages WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`;
  args.push(lim);
  const r = await env.DB.prepare(sql).bind(...args).all();
  return (r.results || []).map(rowToPackage);
}

export async function readPackage(env, id) {
  const row = await env.DB.prepare('SELECT * FROM hot_take_packages WHERE id = ?').bind(id).first();
  return rowToPackage(row);
}

export async function findPackageByOrigin(env, originRef) {
  if (originRef == null || originRef === '') return null;
  const row = await env.DB.prepare(
    `SELECT * FROM hot_take_packages WHERE origin_ref = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 1`,
  ).bind(String(originRef)).first();
  return rowToPackage(row);
}

export async function createPackage(env, data = {}) {
  const t = now();
  const id = data.id || genId('ht');
  const p = {
    id,
    status: data.status || 'topic',
    title: data.title ?? null,
    summary: data.summary ?? null,
    why_it_matters: data.why_it_matters ?? null,
    source_name: data.source_name ?? null,
    source_url: data.source_url ?? null,
    published_at: data.published_at ?? null,
    origin: data.origin || 'manual',
    origin_ref: data.origin_ref != null ? String(data.origin_ref) : null,
    multi_source_json: data.multi_source ? JSON.stringify(data.multi_source) : (data.multi_source_json ?? null),
    pinned: data.pinned ? 1 : 0,
    take: data.take ?? null,
    believe: data.believe ?? null,
    misunderstood: data.misunderstood ?? null,
    who_cares: data.who_cares ?? null,
    reader_action: data.reader_action ?? null,
    brief_json: data.brief ? JSON.stringify(data.brief) : (data.brief_json ?? null),
    blog_slug: data.blog_slug ?? null,
    headline: data.headline ?? null,
    intro: data.intro ?? null,
    review_json: data.review ? JSON.stringify(data.review) : (data.review_json ?? null),
    company_notes: data.company_notes ?? null,
    author_notes: data.author_notes ?? null,
    website_status: data.website_status || 'not_planned',
    website_url: data.website_url ?? null,
    scheduled_at: data.scheduled_at ?? null,
    actor: data.actor || 'hot-takes',
  };
  await env.DB.prepare(
    `INSERT INTO hot_take_packages
      (id,status,title,summary,why_it_matters,source_name,source_url,published_at,origin,origin_ref,multi_source_json,pinned,
       take,believe,misunderstood,who_cares,reader_action,brief_json,blog_slug,headline,intro,review_json,company_notes,author_notes,
       website_status,website_url,scheduled_at,actor,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    p.id, p.status, p.title, p.summary, p.why_it_matters, p.source_name, p.source_url, p.published_at, p.origin, p.origin_ref, p.multi_source_json, p.pinned,
    p.take, p.believe, p.misunderstood, p.who_cares, p.reader_action, p.brief_json, p.blog_slug, p.headline, p.intro, p.review_json, p.company_notes, p.author_notes,
    p.website_status, p.website_url, p.scheduled_at, p.actor, t, t,
  ).run();
  await logEvent(env, { kind: 'hottake_topic_added', actor: p.actor, payload: { id, origin: p.origin, title: p.title } });
  return readPackage(env, id);
}

// Whitelisted shallow patch. Scalar columns + three JSON-encoded object fields
// (multi_source→multi_source_json, brief→brief_json, review→review_json).
const PATCHABLE = [
  'status', 'title', 'summary', 'why_it_matters', 'source_name', 'source_url', 'published_at', 'origin', 'origin_ref', 'pinned',
  'take', 'believe', 'misunderstood', 'who_cares', 'reader_action', 'blog_slug', 'headline', 'intro', 'company_notes', 'author_notes',
  'website_status', 'website_url', 'scheduled_at',
];

export async function patchPackage(env, id, patch = {}, actor = 'hot-takes') {
  const existing = await readPackage(env, id);
  if (!existing) throw new Error(`hot take ${id} not found`);
  const fields = [];
  const args = [];
  for (const k of PATCHABLE) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      args.push(k === 'pinned' ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if (patch.multi_source !== undefined) { fields.push('multi_source_json = ?'); args.push(patch.multi_source ? JSON.stringify(patch.multi_source) : null); }
  if (patch.brief !== undefined) { fields.push('brief_json = ?'); args.push(patch.brief ? JSON.stringify(patch.brief) : null); }
  if (patch.review !== undefined) { fields.push('review_json = ?'); args.push(patch.review ? JSON.stringify(patch.review) : null); }
  if (!fields.length) return existing;
  fields.push('updated_at = ?');
  args.push(now());
  args.push(id);
  await env.DB.prepare(`UPDATE hot_take_packages SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  await logEvent(env, { kind: 'hottake_updated', actor, payload: { id, keys: Object.keys(patch) } });
  return readPackage(env, id);
}

export async function dismissPackage(env, id, actor = 'hot-takes') {
  await env.DB.prepare('UPDATE hot_take_packages SET status = ?, updated_at = ? WHERE id = ?')
    .bind('dismissed', now(), id).run();
  await logEvent(env, { kind: 'hottake_dismissed', actor, payload: { id } });
  return readPackage(env, id);
}

// Pin a topic from the live feed into a durable package (idempotent by origin_ref
// so pinning the same card twice does not create duplicates).
export async function pinTopic(env, data = {}, actor = 'operator') {
  const existing = await findPackageByOrigin(env, data.origin_ref);
  if (existing) {
    if (!existing.pinned) return patchPackage(env, existing.id, { pinned: true }, actor);
    return existing;
  }
  return createPackage(env, { ...data, pinned: 1, status: 'topic', actor });
}

// Manually remove a live-feed topic the operator judged not good enough. The feed
// (topicsOfTheDay) is a live read with nothing of its own to delete, so removal is
// persisted in the package store: an existing package for this card is dismissed;
// otherwise a stub package is created already-dismissed. Either way topicsOfTheDay
// hides any origin_ref carrying a dismissed package, so the card leaves the feed
// and stays gone across refreshes. Idempotent by origin_ref.
export async function dismissTopicCard(env, card = {}, actor = 'operator') {
  const existing = await findPackageByOrigin(env, card.origin_ref);
  if (existing) return dismissPackage(env, existing.id, actor);
  const pkg = await createPackage(env, { ...card, pinned: 0, status: 'dismissed', actor });
  await logEvent(env, { kind: 'hottake_topic_removed', actor, payload: { origin_ref: card.origin_ref ?? null, title: card.title ?? null } });
  return pkg;
}

// Adopt a blog draft into the release pipeline. Publications written straight
// into blog_posts (Nyo, the digest writer) have no package; scheduling or social
// drafting needs one, so this finds the package already linked to the slug or
// creates a lightweight one (origin 'blog', status 'ready' — the editorial spine
// is already done, the article exists). Everything downstream (scheduleRelease,
// the hourly due-scan, social legs, the calendar mirror) then runs through the
// ONE package machinery — no second scheduler for plain blog drafts.
export async function findPackageBySlug(env, slug) {
  if (!slug) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM hot_take_packages WHERE blog_slug = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 1`,
  ).bind(String(slug)).first();
  return rowToPackage(row);
}

export async function ensurePackageForSlug(env, slug, actor = 'operator') {
  if (!slug) throw new Error('ensurePackageForSlug: slug required');
  const existing = await findPackageBySlug(env, slug);
  if (existing) return existing;
  const post = await readBlogPost(env, slug);
  if (!post) throw new Error(`blog post ${slug} not found`);
  // An already-live article adopts as 'published' (website leg done) so its
  // social legs are immediately schedulable — the due-scan only fires legs of
  // packages whose website is settled.
  const isLive = !!post.published;
  const pkg = await createPackage(env, {
    origin: 'blog', origin_ref: `blog:${slug}`,
    blog_slug: slug,
    title: post.title, headline: post.title, intro: post.excerpt || null,
    status: isLive ? 'published' : 'ready',
    website_status: isLive ? 'published' : 'not_planned',
    website_url: isLive ? blogUrl(env, slug) : null,
    pinned: 0, actor,
  });
  // Adoption is its own transition (distinct from a topic being added) — make
  // the activity bus say what actually happened.
  await logEvent(env, { kind: 'hottake_draft_adopted', actor, payload: { id: pkg.id, slug, already_live: isLive } });
  return pkg;
}

// ── posts (per-leg social distribution) ─────────────────────────────────────
export async function listPosts(env, packageId) {
  const r = await env.DB.prepare('SELECT * FROM hot_take_posts WHERE package_id = ? ORDER BY channel ASC')
    .bind(packageId).all();
  return r.results || [];
}

export async function readPost(env, id) {
  return env.DB.prepare('SELECT * FROM hot_take_posts WHERE id = ?').bind(id).first();
}

// One row per (package, channel) — create or update in place.
export async function upsertPost(env, { package_id, channel, body, notes, image_url, status, scheduled_at, actor = 'hot-takes' } = {}) {
  if (!package_id || !channel) throw new Error('upsertPost: package_id + channel required');
  const t = now();
  const existing = await env.DB.prepare(
    'SELECT * FROM hot_take_posts WHERE package_id = ? AND channel = ?',
  ).bind(package_id, channel).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE hot_take_posts SET
         body = COALESCE(?, body), notes = COALESCE(?, notes), image_url = COALESCE(?, image_url),
         status = COALESCE(?, status), scheduled_at = COALESCE(?, scheduled_at), actor = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(body ?? null, notes ?? null, image_url ?? null, status ?? null, scheduled_at ?? null, actor, t, existing.id).run();
    await logEvent(env, { kind: 'hottake_post_updated', actor, payload: { id: existing.id, package_id, channel } });
    return readPost(env, existing.id);
  }
  const id = genId('htp');
  await env.DB.prepare(
    `INSERT INTO hot_take_posts (id, package_id, channel, body, notes, image_url, status, scheduled_at, actor, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, package_id, channel, body ?? null, notes ?? null, image_url ?? null, status || 'draft', scheduled_at ?? null, actor, t, t).run();
  await logEvent(env, { kind: 'hottake_post_updated', actor, payload: { id, package_id, channel, created: true } });
  return readPost(env, id);
}

const POST_PATCHABLE = ['body', 'notes', 'image_url', 'status', 'scheduled_at'];
export async function patchPost(env, id, patch = {}, actor = 'operator') {
  const existing = await readPost(env, id);
  if (!existing) throw new Error(`hot take post ${id} not found`);
  const fields = [];
  const args = [];
  for (const k of POST_PATCHABLE) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); args.push(patch[k]); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?');
  args.push(now());
  args.push(id);
  await env.DB.prepare(`UPDATE hot_take_posts SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  await logEvent(env, { kind: 'hottake_post_updated', actor, payload: { id, keys: Object.keys(patch) } });
  return readPost(env, id);
}

async function listPostsForPackages(env, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT * FROM hot_take_posts WHERE package_id IN (${placeholders})`,
  ).bind(...ids).all();
  const map = new Map();
  for (const row of r.results || []) {
    if (!map.has(row.package_id)) map.set(row.package_id, []);
    map.get(row.package_id).push(row);
  }
  return map;
}

// ── "next action, not just status" ──────────────────────────────────────────
export function computeNextAction(pkg, posts = [], channels = RELEASE_CHANNELS_FALLBACK) {
  if (!pkg) return '';
  switch (pkg.status) {
    case 'topic':   return 'Draft a take';
    case 'take':    return 'Approve the brief';
    case 'brief':   return 'Write the article';
    case 'article': return 'Review the article';
    case 'review': {
      const r = pkg.review || {};
      const openClaims = (r.claims || []).filter((c) => c.status === 'needs_confirmation').length;
      const openFlags = (r.quality_flags || []).filter((f) => !f.resolved).length;
      if (openClaims) return `Confirm ${openClaims} claim${openClaims === 1 ? '' : 's'}`;
      if (openFlags) return `Resolve ${openFlags} issue${openFlags === 1 ? '' : 's'}`;
      return 'Mark ready';
    }
    case 'ready': {
      const withBody = channels.filter((ch) => posts.some((p) => p.channel === ch && p.status !== 'not_planned' && (p.body || '').trim()));
      if (withBody.length < channels.length) {
        const missing = channels.filter((ch) => !withBody.includes(ch) && !posts.some((p) => p.channel === ch && p.status === 'not_planned'));
        if (!missing.length) return 'Schedule the release';
        if (missing.length === channels.length) return 'Prepare social posts';
        return missing[0] === 'linkedin-personal' ? 'Personal post missing' : 'Company post missing';
      }
      return 'Schedule the release';
    }
    case 'scheduled': return 'Awaiting publication';
    case 'published': {
      const legs = posts.filter((p) => p.status !== 'not_planned' && p.status !== 'skipped');
      const done = legs.filter((p) => p.status === 'posted').length;
      if (pkg.website_status !== 'published') return 'Publish the website';
      if (done < legs.length) return `Complete ${legs.length - done} post${legs.length - done === 1 ? '' : 's'}`;
      return 'Complete';
    }
    case 'complete': return 'Complete';
    default: return '';
  }
}

// ── the pipeline view (Publications tab) ────────────────────────────────────
export async function pipelineView(env) {
  const channels = releaseChannels(env);
  const all = await listPackages(env, { limit: 300 });
  const posts = await listPostsForPackages(env, all.map((p) => p.id));
  const decorate = (p) => ({ ...p, posts: posts.get(p.id) || [], next_action: computeNextAction(p, posts.get(p.id) || [], channels) });
  const groups = { in_flight: [], needs_review: [], ready: [], scheduled: [], published: [] };
  for (const p of all) {
    const d = decorate(p);
    if (['topic', 'take', 'brief'].includes(p.status)) groups.in_flight.push(d);
    else if (['article', 'review'].includes(p.status)) groups.needs_review.push(d);
    else if (p.status === 'ready') groups.ready.push(d);
    else if (p.status === 'scheduled') groups.scheduled.push(d);
    else if (['published', 'complete'].includes(p.status)) groups.published.push(d);
  }
  return groups;
}

// ── Topics of the Day — a LIVE read (not stored) merging the synthesized hot
// Feed sizing. Not editorial policy (that lives in the heartbeat-priorities
// note) — these bound how much work one feed read does.
const MAX_FEED_PAGE = 200;   // largest window the UI can grow to in one request
const MAX_FEED_POOL = 400;   // candidates pulled per origin before ranking
const ALL_TIME_DAYS = 3650;  // "no date floor", expressed in the helpers' unit

// topics + scored signals + the actionable digest feed, deduped by url/title and
// ranked. Pinning one (pinTopic) is what persists a package. Reuses the existing
// heartbeat + digest read paths — never scrapes or mutates them.
//
// BROWSING/SEARCH READS HISTORY WE ALREADY KEEP. osint_topics and osint_signals
// have no pruner, so "older topics" is a wider WHERE, not an archive: nothing is
// snapshotted or duplicated. The default view (no history flag, no query) keeps
// the original tight 5/7-day windows, so the daily feed is exactly what it was.
//
// WHY `history` GROWS THE WINDOW INSTEAD OF PAGING BY OFFSET. The list is
// recomputed per request, and the default view draws from a deliberately small
// candidate pool (8 topics + 10 signals) that differs from the browse pool — a
// fixed offset would index into a list that shifted under it. Asking for a
// bigger `limit` with `history: true` re-derives one consistent list every time
// instead (and with the LIFO ordering over the fixed browse pool, the visible
// prefix is stable across growth by construction). `offset` is still honoured
// for API callers, but the UI grows the window.
//
// Digest-origin cards are the exception to "we keep everything" — digest_items is
// hard-deleted after ~14d, so deep views carry fewer of those. That gap is accepted.
export async function topicsOfTheDay(env, { limit = 12, offset = 0, q = '', history = false } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 12), MAX_FEED_PAGE);
  const from = Math.max(0, Number(offset) || 0);
  const term = String(q || '').trim();
  const browsing = from > 0 || !!term || !!history;

  // In browse/search mode the pool is FIXED at the cap, deliberately: growing
  // `limit` (or advancing `offset`) then extends ONE stable list instead of
  // re-deriving a different candidate set per request. (Under the old
  // fresh×strong ranking a size-scaled pool measurably reshuffled the visible
  // prefix on every Load more; with today's LIFO ordering the fixed pool keeps
  // it stable by construction.) The default view keeps the small cheap pool.
  const pool = browsing ? MAX_FEED_POOL : Math.min((from + size) * 3 + 20, MAX_FEED_POOL);
  const topicDays = browsing ? ALL_TIME_DAYS : 5;
  const signalDays = browsing ? ALL_TIME_DAYS : 7;

  const out = [];
  const seen = new Set();
  const keyOf = (title, url) => (String(url || '').replace(/[#?].*$/, '').toLowerCase() || String(title || '').toLowerCase().trim());
  const push = (card) => {
    const k = keyOf(card.title, card.source_url);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(card);
  };

  // 1) synthesized hot takes (osint_topics) — strongest, lead with these
  try {
    const topics = await topHotTopics(env, { limit: browsing ? pool : 8, days: topicDays, q: term });
    for (const t of topics) {
      const srcs = Array.isArray(t.sources) ? t.sources : [];
      push({
        origin: 'osint_topic', origin_ref: String(t.id),
        title: t.title, summary: t.thesis || '', why_it_matters: t.why_now || '',
        source_name: (srcs[0] && srcs[0].title) || 'Industry pulse',
        source_url: (srcs[0] && srcs[0].url) || null,
        published_at: t.created_at || null, heat: t.heat ?? null,
        multi_source: srcs.length, kind: 'hot_topic',
      });
    }
  } catch { /* topics table may be empty on a fresh db */ }

  // 2) scored industry signals (osint_signals)
  try {
    const signals = await topSignals(env, { days: signalDays, minContent: 60, limit: browsing ? pool : 10, q: term });
    for (const s of signals) {
      push({
        origin: 'osint_signal', origin_ref: String(s.id),
        title: s.title, summary: s.summary || '', why_it_matters: s.suggested_angle || '',
        source_name: s.source_name || s.theme || 'Source', source_url: s.url || null,
        published_at: s.published_at || s.created_at || null, heat: s.content_score ?? null,
        multi_source: 0, kind: 'signal',
      });
    }
  } catch { /* */ }

  // 3) the actionable digest feed (insight / content / opportunity items)
  try {
    const items = await listDigestItems(env, { limit: browsing ? MAX_FEED_POOL : 40 });
    const needle = term.toLowerCase();
    for (const it of items) {
      if (!['osint_insight', 'content_opportunity', 'osint_mention', 'opportunity'].includes(it.kind)) continue;
      // listDigestItems has no `q` param, so this origin is filtered in JS. It is
      // the small, capped, already-expiring one, so a scan is cheaper than
      // widening a shared query every other caller depends on.
      if (needle && !`${it.title || ''} ${it.summary || ''} ${it.suggested_action || ''}`.toLowerCase().includes(needle)) continue;
      push({
        origin: 'digest', origin_ref: String(it.id),
        title: it.title, summary: it.summary || '', why_it_matters: it.suggested_action || '',
        source_name: it.source_label || 'Digest', source_url: it.source_url || null,
        published_at: it.created_at || null, heat: it.urgency ? (4 - it.urgency) * 25 : null,
        multi_source: 0, kind: it.kind,
      });
    }
  } catch { /* */ }

  // Classify each card's origin_ref against the package store. Both classes are
  // then EXCLUDED below: a non-dismissed package is already in the pipeline, and
  // a dismissed one was manually removed by the operator (dismissTopicCard writes
  // a dismissed package for exactly this purpose).
  //
  // Read the package store WHOLE rather than IN(...)-ing one placeholder per
  // candidate. The old form was fine at ~12 candidates but a deep/searched page
  // can carry hundreds, which would blow SQLite's bound-variable limit. This
  // table holds only the operator's own selections (12 rows today), so reading
  // it all and classifying in memory is both cheaper and unbounded-safe.
  const selected = new Set();
  const removed = new Set();
  {
    const r = await env.DB.prepare(
      `SELECT origin_ref, status FROM hot_take_packages WHERE origin_ref IS NOT NULL`,
    ).all();
    for (const row of r.results || []) {
      if (row.status === 'dismissed') removed.add(String(row.origin_ref));
      else selected.add(String(row.origin_ref));
    }
  }

  // LIFO — newest first, full stop (operator decision 2026-07-24, replacing the
  // earlier fresh×strong hybrid score). Quality still GATES what reaches this
  // feed upstream (heartbeat.js scoring); this only ORDERS what already cleared
  // that bar. Undated cards sink to the bottom. A timestamp sort over the fixed
  // browse pool is also inherently prefix-stable for Load more.
  const nowMs = now();
  // Drop the operator-removed cards AND the ones already pulled into the
  // pipeline. Excluding selected ones SERVER-side is what keeps each page dense:
  // the client hid them anyway, but filtering after the slice would turn a page
  // of 12 into a page of 3 and read like a broken Load more.
  const ranked = out
    .filter((c) => !removed.has(c.origin_ref) && !selected.has(c.origin_ref))
    .map((c) => ({ ...c, already_selected: false }))
    .sort((a, b) => (b.published_at || 0) - (a.published_at || 0));

  return {
    topics: ranked.slice(from, from + size),
    generated_at: nowMs,
    offset: from,
    limit: size,
    has_more: ranked.length > from + size,
  };
}

// ── article: write via the shared blog pipeline, edit in place ──────────────
// The prose seed is assembled from the approved take + brief; composeAndSavePost
// (the existing house-style writer) turns it into a full blog_posts DRAFT with
// figures + cover. Hot Takes never re-implements the writer.
export async function writeArticleFromBrief(env, id, { voice = 'lev', actor = 'operator' } = {}) {
  const pkg = await readPackage(env, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  if (!pkg.take) throw new Error('no take yet — draft and approve the take first');
  const b = pkg.brief || {};

  // The Nyo/blog path writes better articles for one reason: the composer
  // receives SUBSTANCE there (a real hand-draft), while this path used to
  // send an outline of an outline. So: fetch the actual source text at write
  // time (fail-soft), carry the take verbatim, and treat the operator's
  // notes as the article's soul, not an afterthought.
  let sourceText = '';
  if (pkg.source_url) {
    try {
      const w = await callGateway(env, 'web', 'text', { url: pkg.source_url });
      // fetchText returns { ok, status, text } with RAW html — a 404/paywall
      // page must never be injected as "source material", and markup must be
      // stripped before it reaches the writer.
      if (w && w.ok !== false && w.text) {
        sourceText = String(w.text)
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2800);
      }
    } catch { /* the seed still carries the summary */ }
  }
  const multi = (() => { try { return JSON.parse(pkg.multi_source_json || '[]'); } catch { return []; } })();

  const seed = [
    `# ${pkg.headline || pkg.title || 'Untitled'}`,
    '',
    `THE ARGUMENT (this is the article's spine — keep it sharp and specific): ${b.argument || pkg.take}`,
    '',
    `THE TAKE, VERBATIM (the article must sound like the person who wrote this):\n${pkg.take}`,
    '',
    (Array.isArray(b.directions) && b.directions.filter(Boolean).length)
      ? `THE OPERATOR'S STANDING DIRECTIVES (binding. He gave these while shaping this angle and they OVERRIDE the playbook, the brand docs, and the source's own framing on emphasis, tone, and structure. If a directive says to celebrate someone or downplay something, every section obeys it, including the headline):\n${b.directions.filter(Boolean).map((d, i) => `${i + 1}. ${d}`).join('\n')}\n`
      : '',
    pkg.author_notes ? `THE OPERATOR'S OWN MATERIAL (the article's soul — stories, numbers, opinions in his words; use the substance, keep his stance):\n${pkg.author_notes}` : '',
    pkg.company_notes ? `COMPANY CONTEXT NOTES:\n${pkg.company_notes}` : '',
    '',
    sourceText ? `SOURCE MATERIAL (the piece under discussion — quote and reference CONCRETE facts from this, never invent beyond it):\n${sourceText}` : '',
    multi.length ? `Additional coverage: ${multi.map((m) => `${m.title || ''} ${m.url || ''}`.trim()).join(' · ')}` : '',
    '',
    `Audience: ${b.audience || pkg.who_cares || 'founders and operators'}`,
    `Why now: ${b.why_now || pkg.why_it_matters || ''}`,
    '',
    'Supporting points to develop (3-5 sections, each advancing the argument):',
    ...(Array.isArray(b.points) ? b.points.map((p, i) => `${i + 1}. ${typeof p === 'string' ? p : [p?.title, p?.text].filter(Boolean).join(': ') || ''}`) : []),
    '',
    b.evidence?.length ? `Evidence available: ${(b.evidence || []).map((e) => (typeof e === 'string' ? e : e?.text || '')).join(' · ')}` : '',
    b.objections?.length ? `Objections to address honestly: ${(b.objections || []).map((o) => (typeof o === 'string' ? o : o?.text || '')).join(' · ')}` : '',
    '',
    `What the company believes: ${pkg.believe || ''}`,
    `What is commonly misunderstood: ${pkg.misunderstood || ''}`,
    `What the reader should do differently: ${pkg.reader_action || b.conclusion || ''}`,
    '',
    pkg.source_url ? `Source: ${pkg.source_name || ''} — ${pkg.source_url} — ${pkg.summary || ''}` : (pkg.summary || ''),
    '',
    await loadArticleInstruction(env),
  ].filter((l) => l !== null && l !== undefined).join('\n');

  const { composeAndSavePost } = await import('./aeo-writer.js');
  const res = await composeAndSavePost(env, {
    title: pkg.headline || pkg.title,
    body: seed,
    voice,
    published: false,
    actor: `hottake:${actor}`,
  });
  if (!res?.slug) throw new Error('article write returned no slug');

  await patchPackage(env, id, {
    blog_slug: res.slug,
    headline: res.title || pkg.headline || pkg.title,
    intro: res.post?.excerpt || null,
    status: 'review',
  }, actor);
  await logEvent(env, { kind: 'hottake_article_written', actor, payload: { id, slug: res.slug, voice } });
  return { ok: true, id, slug: res.slug, title: res.title, featured_image: res.featured_image || null };
}

export async function articleView(env, id) {
  const pkg = await readPackage(env, id);
  if (!pkg) return null;
  const posts = await listPosts(env, id);
  let article = null;
  if (pkg.blog_slug) {
    const row = await readBlogPost(env, pkg.blog_slug);
    if (row) {
      article = {
        slug: row.slug, title: row.title, excerpt: row.excerpt, body: row.body,
        tags: safeJSON(row.tags) || [], featured_image_url: row.featured_image_url || null,
        published: !!row.published, published_at: row.published_at || null,
      };
    }
  }
  return { package: pkg, posts, article, next_action: computeNextAction(pkg, posts, releaseChannels(env)) };
}

export async function saveArticleEdit(env, id, { title, excerpt, body } = {}, actor = 'operator') {
  const pkg = await readPackage(env, id);
  if (!pkg?.blog_slug) throw new Error('no article yet for this package');
  await patchBlogPost(env, pkg.blog_slug, {
    ...(title !== undefined ? { title } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(body !== undefined ? { body } : {}),
    updated_by: `hottake:${actor}`,
  });
  if (title !== undefined && title !== pkg.headline) await patchPackage(env, id, { headline: title }, actor);
  await logEvent(env, { kind: 'hottake_article_edited', actor, payload: { id, slug: pkg.blog_slug, keys: Object.keys({ title, excerpt, body }).filter((k) => ({ title, excerpt, body })[k] !== undefined) } });
  return articleView(env, id);
}

// ── schedule + release ──────────────────────────────────────────────────────
export async function scheduleRelease(env, id, { website_at, company_at, personal_at } = {}, actor = 'operator') {
  const pkg = await readPackage(env, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  const timing = await loadTimingDefaults(env);
  const oldBase = Number(pkg.scheduled_at) || null; // pre-reschedule anchor, for offset preservation
  let base = Number(website_at) || null;
  if (!base) {
    // No explicit time → the next occurrence of the note's default publish hour.
    const d = new Date();
    d.setUTCHours(timing.default_hour_utc ?? 13, 0, 0, 0);
    if (d.getTime() <= now()) d.setUTCDate(d.getUTCDate() + 1);
    base = d.getTime();
  }
  // Three tiers per leg, in order: an EXPLICIT time wins; otherwise a reschedule
  // PRESERVES the leg's current offset from the old base (the operator's chosen
  // "how long after publication" survives a date change instead of being reset);
  // a leg with no time yet falls back to the timing-note defaults.
  const explicitTimes = {
    'linkedin-company': Number(company_at) || null,
    'linkedin-personal': Number(personal_at) || null,
  };
  const defaultTimes = {
    'linkedin-company': base + (timing.company_offset_min ?? 120) * 60000,
    'linkedin-personal': base + (timing.personal_offset_min ?? 3) * 60000,
  };

  await patchPackage(env, id, {
    scheduled_at: base,
    website_status: 'scheduled',
    status: 'scheduled',
  }, actor);

  const posts = await listPosts(env, id);
  const legTimes = {};
  for (const ch of releaseChannels(env)) {
    const existing = posts.find((p) => p.channel === ch);
    if (existing?.status === 'not_planned' || existing?.status === 'skipped') continue;
    const prevAt = Number(existing?.scheduled_at) || null;
    const preserved = oldBase && prevAt ? base + (prevAt - oldBase) : null;
    legTimes[ch] = explicitTimes[ch] || preserved || defaultTimes[ch] || base;
    // Times are booked here; APPROVAL is not. No status is passed, so an
    // existing leg keeps its state and a new placeholder starts 'draft' — a leg
    // only becomes 'scheduled' (the state the due-scan fires) by an explicit
    // per-post approval: the editor's Approve button or the Social tab's
    // Schedule button. Scheduling the website used to auto-promote text-bearing
    // legs; that made per-post approval meaningless.
    await upsertPost(env, {
      package_id: id, channel: ch,
      scheduled_at: legTimes[ch],
      actor,
    });
  }

  // Calendar mirror for the website leg (idempotent on source+source_ref).
  try {
    await upsertCalendarEvent(env, {
      kind: 'blog_publish',
      title: pkg.headline || pkg.title || pkg.blog_slug || id,
      starts_at: base,
      all_day: false,
      status: 'confirmed',
      source: 'hottake',
      source_ref: id,
      link_url: pkg.blog_slug ? blogUrl(env, pkg.blog_slug) : null,
      created_by: 'system',
    });
  } catch { /* best-effort */ }

  await logEvent(env, { kind: 'hottake_scheduled', actor, payload: { id, website_at: base, legs: legTimes } });
  return articleView(env, id);
}

// Undo a schedule. The package returns to 'ready' (unscheduled), the website
// leg to not_planned, and any leg the scheduler queued goes back to
// ready (has text) / draft (empty). The calendar mirror flips to cancelled.
export async function cancelSchedule(env, id, actor = 'operator') {
  const pkg = await readPackage(env, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  if (pkg.status !== 'scheduled') return articleView(env, id); // nothing scheduled — no-op
  await patchPackage(env, id, { status: 'ready', website_status: 'not_planned', scheduled_at: null }, actor);
  const posts = await listPosts(env, id);
  for (const p of posts) {
    // Clear the timing on every leg that hasn't actually gone out — a stale
    // scheduled_at on a cancelled release would keep showing as a planned slot.
    if (!['draft', 'ready', 'scheduled'].includes(p.status) || p.scheduled_at == null) continue;
    await patchPost(env, p.id, {
      ...(p.status === 'scheduled' ? { status: (p.body || '').trim() ? 'ready' : 'draft' } : {}),
      scheduled_at: null,
    }, actor);
  }
  try {
    await upsertCalendarEvent(env, {
      kind: 'blog_publish',
      title: pkg.headline || pkg.title || pkg.blog_slug || id,
      starts_at: pkg.scheduled_at || now(),
      all_day: false,
      status: 'cancelled',
      source: 'hottake',
      source_ref: id,
      link_url: pkg.blog_slug ? blogUrl(env, pkg.blog_slug) : null,
      created_by: 'system',
    });
  } catch { /* best-effort */ }
  await logEvent(env, { kind: 'hottake_schedule_cancelled', actor, payload: { id } });
  return articleView(env, id);
}

// Publish the website leg through the SHARED blog pipeline. social:false —
// Hot Takes owns its own two posts; the Social module's auto-fan-out would
// double-draft into the other queue.
// NOT gated on hottakes.live: publishing to nyyon.com is the same trust level as
// the Blog page's ungated Approve button, and a scheduled publication must
// actually go live at its date. Only the LinkedIn legs respect the flag.
export async function publishWebsite(env, id, { actor = 'operator', ctx = null } = {}) {
  const pkg = await readPackage(env, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  if (!pkg.blog_slug) throw new Error('no article to publish — write it first');
  if (pkg.website_status === 'published') return { ok: true, already: true, url: pkg.website_url };

  // Webhook-first: when Settings has a website webhook, the article payload
  // POSTs there and delivery is the receiver's job. Legacy blog-edge publish
  // only runs when no webhook is configured.
  const { loadWebhooks, sendWebhook } = await import('./webhooks.js');
  const hooks = await loadWebhooks(env);
  let r;
  if (hooks.website_url) {
    const post = await (await import('./db.js')).readBlogPost(env, pkg.blog_slug);
    const wr = await sendWebhook(env, 'website', {
      type: 'article.publish',
      slug: pkg.blog_slug, title: post?.title || pkg.headline || pkg.title,
      excerpt: post?.excerpt || null, body_html: post?.body_html || post?.body || null,
      tags: post?.tags || [], featured_image_url: post?.featured_image_url || null,
      package_id: id, published_at: now(),
    }, { source: 'hottake', source_ref: id });
    r = { ok: wr.ok, url: pkg.website_url || null, webhook: true, http: wr.http, outbox_id: wr.outbox_id };
  } else {
    throw new Error('no website webhook configured — set it in Settings → Outbound webhooks before publishing');
  }
  if (r?.ok) {
    await patchPackage(env, id, { website_status: 'published', website_url: r.url, status: 'published' }, actor);
    try {
      await upsertCalendarEvent(env, {
        kind: 'blog_publish', title: pkg.headline || pkg.title || pkg.blog_slug,
        starts_at: now(), all_day: false, status: 'done',
        source: 'hottake', source_ref: id, link_url: r.url, created_by: 'system',
      });
    } catch { /* best-effort */ }
    await logEvent(env, { kind: 'hottake_website_published', actor, payload: { id, slug: pkg.blog_slug, url: r.url } });
    await maybeComplete(env, id, actor);
  }
  return { ok: !!r?.ok, ...r };
}

// Post one social leg through the SHARED social gateway (Make webhooks), logged
// to the outbox first — mirrors lib/social-posts.js approveAndPush semantics.
export async function postLeg(env, postId, { actor = 'operator' } = {}) {
  const post = await readPost(env, postId);
  if (!post) throw new Error(`hot take post ${postId} not found`);
  if (post.status === 'posted') return { ok: true, already: true, id: postId };
  if (!(post.body || '').trim()) throw new Error('post has no text yet');
  const pkg = await readPackage(env, post.package_id);

  // Prefer the article's CURRENT cover (it may have been generated after the
  // draft) — the gateway hard-requires an image.
  const blog = pkg?.blog_slug ? await readBlogPost(env, pkg.blog_slug).catch(() => null) : null;
  const imageUrl = blog?.featured_image_url || post.image_url || '';
  const imageTitle = blog?.title || pkg?.headline || pkg?.title || '';

  const live = await hotTakesLive(env);
  if (!live) {
    await logEvent(env, { kind: 'hottake_dryrun', actor, payload: { action: 'post_leg', id: postId, channel: post.channel, chars: (post.body || '').length, has_image: !!imageUrl } });
    return { ok: true, dry_run: true, would: { action: 'post', channel: post.channel, chars: (post.body || '').length, image_url: imageUrl || null } };
  }

  const log = await beginSend(env, {
    channel: 'social', kind: post.channel, to_id: post.channel,
    body: post.body,
    payload: { package_id: post.package_id, blog_slug: pkg?.blog_slug || null, image_url: imageUrl || null },
    source: 'hottake', source_ref: post.id,
  });
  try {
    const { loadWebhooks, sendWebhook } = await import('./webhooks.js');
    const hooks = await loadWebhooks(env);
    let res;
    if (hooks.social_url) {
      // sendWebhook writes its own outbox row; this path reuses the leg's row
      // instead — post directly and record on it.
      const r2 = await fetch(hooks.social_url, {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', 'X-Nyyon-Event': 'social.post' },
        body: JSON.stringify({
          type: 'social.post', channel: post.channel, content: post.body,
          image_url: imageUrl || null, article_slug: pkg?.blog_slug || null, package_id: post.package_id,
        }),
      });
      if (!r2.ok) throw new Error(`social webhook → HTTP ${r2.status}: ${(await r2.text().catch(() => '')).slice(0, 200)}`);
      res = { http: r2.status };
    } else {
      throw new Error('no social webhook configured — set it in Settings → Outbound webhooks');
    }
    await markSent(env, log.id, { message_id: res?.http ? String(res.http) : null });
    const t = now();
    await env.DB.prepare(`UPDATE hot_take_posts SET status='posted', posted_at=?, outbox_id=?, error=NULL, updated_at=? WHERE id=?`)
      .bind(t, log.id, t, postId).run();
    await logEvent(env, { kind: 'hottake_post_published', actor, payload: { id: postId, channel: post.channel, package_id: post.package_id } });
    try {
      await upsertCalendarEvent(env, {
        kind: 'social_post',
        title: `${post.channel}: ${imageTitle || post.package_id}`,
        starts_at: t, all_day: false, status: 'done',
        source: 'hottake', source_ref: postId,
        link_url: pkg?.website_url || (pkg?.blog_slug ? blogUrl(env, pkg.blog_slug) : null),
        platform: 'linkedin', body: post.body, created_by: 'system',
      });
    } catch { /* best-effort */ }
    await maybeComplete(env, post.package_id, actor);
    return { ok: true, id: postId, channel: post.channel, outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    const t = now();
    await env.DB.prepare(`UPDATE hot_take_posts SET status='failed', error=?, outbox_id=?, updated_at=? WHERE id=?`)
      .bind(String(e?.message || e).slice(0, 2000), log.id, t, postId).run();
    await logEvent(env, { kind: 'hottake_post_failed', actor, payload: { id: postId, channel: post.channel, error: String(e?.message || e).slice(0, 300) } });
    return { ok: false, id: postId, channel: post.channel, error: String(e?.message || e), outbox_id: log.id };
  }
}

// Flip the package complete once the website + every planned leg is done.
async function maybeComplete(env, packageId, actor = 'system') {
  const pkg = await readPackage(env, packageId);
  if (!pkg || pkg.website_status !== 'published') return;
  const posts = await listPosts(env, packageId);
  const planned = posts.filter((p) => !['not_planned', 'skipped'].includes(p.status));
  const allDone = planned.length > 0 && planned.every((p) => p.status === 'posted');
  const noLegs = planned.length === 0 && posts.length > 0; // everything intentionally skipped
  if ((allDone || noLegs) && pkg.status !== 'complete') {
    await patchPackage(env, packageId, { status: 'complete' }, actor);
    await logEvent(env, { kind: 'hottake_complete', actor, payload: { id: packageId } });
  }
}

// ── the hourly due-scan (cron :00 leg) ──────────────────────────────────────
// Due website publishes fire FOR REAL (publishWebsite is ungated); due LinkedIn
// legs still respect the hottakes.live flag (dry-run when off).
export async function runDueReleases(env, { ctx = null } = {}) {
  const t = now();
  const live = await hotTakesLive(env);
  const out = { live, posts_dry_run: !live, website_published: [], posts_sent: [], errors: [] };

  const duePkgs = await env.DB.prepare(
    `SELECT id FROM hot_take_packages WHERE status = 'scheduled' AND website_status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
  ).bind(t).all();
  for (const row of duePkgs.results || []) {
    try {
      const r = await publishWebsite(env, row.id, { actor: 'hottake-cron', ctx });
      if (r?.dry_run) out.website_published.push({ id: row.id, dry_run: true });
      else if (r?.ok) out.website_published.push({ id: row.id, url: r.url });
      else out.errors.push({ id: row.id, error: r?.error || 'publish failed' });
    } catch (e) {
      out.errors.push({ id: row.id, error: String(e?.message || e) });
    }
  }

  const duePosts = await env.DB.prepare(
    `SELECT p.id, p.package_id FROM hot_take_posts p
       JOIN hot_take_packages k ON k.id = p.package_id
      WHERE p.status = 'scheduled' AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= ?
        AND k.status IN ('scheduled','published','complete')
        AND (k.website_status = 'published' OR k.website_status = 'not_planned')`,
  ).bind(t).all();
  for (const row of duePosts.results || []) {
    try {
      const r = await postLeg(env, row.id, { actor: 'hottake-cron' });
      if (r?.dry_run) out.posts_sent.push({ id: row.id, dry_run: true });
      else if (r?.ok) out.posts_sent.push({ id: row.id });
      else out.errors.push({ id: row.id, error: r?.error || 'post failed' });
    } catch (e) {
      out.errors.push({ id: row.id, error: String(e?.message || e) });
    }
  }
  return out;
}

// ── the Schedule view (30-day grid + attention strip) ───────────────────────
function legState(post, pkgLive, t) {
  if (!post) return { state: 'missing', at: null };
  if (post.status === 'not_planned') return { state: 'not_planned', at: null };
  if (post.status === 'skipped') return { state: 'not_planned', at: null };
  if (post.status === 'posted') return { state: 'done', at: post.posted_at };
  if (post.status === 'failed') return { state: 'overdue', at: post.scheduled_at, error: post.error };
  if (post.scheduled_at) {
    if (post.scheduled_at <= t) return { state: pkgLive ? 'overdue' : 'scheduled', at: post.scheduled_at };
    return { state: 'scheduled', at: post.scheduled_at };
  }
  return { state: (post.body || '').trim() ? 'ready' : 'missing', at: null };
}

export async function scheduleView(env, { days = 30 } = {}) {
  const t = now();
  const channels = releaseChannels(env);
  const pkgs = await listPackages(env, { statuses: ['ready', 'scheduled', 'published', 'complete'], limit: 300 });
  const postsMap = await listPostsForPackages(env, pkgs.map((p) => p.id));

  const releases = pkgs.map((pkg) => {
    const posts = postsMap.get(pkg.id) || [];
    const website = (() => {
      if (pkg.website_status === 'published') return { state: 'done', at: null, url: pkg.website_url };
      if (pkg.website_status === 'scheduled') {
        return { state: pkg.scheduled_at && pkg.scheduled_at <= t ? 'overdue' : 'scheduled', at: pkg.scheduled_at };
      }
      if (pkg.website_status === 'not_planned' && ['published', 'complete'].includes(pkg.status)) return { state: 'not_planned', at: null };
      return { state: pkg.blog_slug ? 'ready' : 'missing', at: pkg.scheduled_at };
    })();
    const markers = { website };
    for (const ch of channels) {
      markers[ch] = legState(posts.find((p) => p.channel === ch), ['scheduled', 'published', 'complete'].includes(pkg.status), t);
    }
    const legStates = channels.map((ch) => markers[ch].state);
    const anyOverdue = website.state === 'overdue' || legStates.includes('overdue');
    const planned = legStates.filter((s) => s !== 'not_planned');
    const allDone = website.state !== 'overdue' && (website.state === 'done' || website.state === 'not_planned') && planned.every((s) => s === 'done');
    const overall =
      pkg.status === 'complete' || allDone ? 'complete'
      : anyOverdue ? 'overdue'
      : website.state === 'done' ? 'published_incomplete'
      : pkg.status === 'scheduled' ? 'scheduled'
      : 'unscheduled';
    return {
      id: pkg.id, title: pkg.headline || pkg.title, blog_slug: pkg.blog_slug, status: pkg.status,
      scheduled_at: pkg.scheduled_at, website_url: pkg.website_url,
      markers, overall, posts,
      next_action: computeNextAction(pkg, posts, channels),
    };
  });

  // Attention strip: overdue → published-but-incomplete → awaiting review → ready-unscheduled.
  const reviewPkgs = await listPackages(env, { statuses: ['article', 'review'], limit: 50 });
  const attention = [
    ...releases.filter((r) => r.overall === 'overdue').map((r) => ({ kind: 'overdue', id: r.id, title: r.title, note: 'A planned action was not completed on time' })),
    ...releases.filter((r) => r.overall === 'published_incomplete').map((r) => ({ kind: 'incomplete', id: r.id, title: r.title, note: 'Article is live but distribution is missing' })),
    ...reviewPkgs.map((p) => ({ kind: 'review', id: p.id, title: p.headline || p.title, note: 'Waiting for review' })),
    ...releases.filter((r) => r.overall === 'unscheduled').map((r) => ({ kind: 'unscheduled', id: r.id, title: r.title, note: 'Ready — pick a publication date' })),
  ];

  return { releases, attention, live: await hotTakesLive(env), channels, window_days: days, now: t };
}

// ── Approved Sources (shared osint_sources + contribution readout) ──────────
export async function listApprovedSources(env) {
  const sources = await listHeartbeatSources(env);
  const t14 = now() - 14 * 86400000;
  let stats = new Map();
  try {
    const r = await env.DB.prepare(
      `SELECT source_id,
              MAX(created_at) AS last_signal_at,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS signals_14d,
              SUM(CASE WHEN created_at > ? AND content_score >= 60 THEN 1 ELSE 0 END) AS useful_14d
         FROM osint_signals WHERE source_id IS NOT NULL GROUP BY source_id`,
    ).bind(t14, t14).all();
    stats = new Map((r.results || []).map((row) => [row.source_id, row]));
  } catch { /* signals table may be empty */ }
  const dec = (s) => {
    const st = stats.get(s.id) || {};
    return {
      ...s,
      last_signal_at: st.last_signal_at || null,
      signals_14d: st.signals_14d || 0,
      useful_14d: st.useful_14d || 0,
    };
  };
  return {
    channels: sources.filter((s) => s.kind === 'rss').map(dec),
    topics: sources.filter((s) => s.kind !== 'rss').map(dec),
  };
}

// ── search (packages + posts + the editable notes) ──────────────────────────
export async function searchHotTakes(env, { q = '', limit = 30 } = {}) {
  const term = String(q || '').trim();
  if (!term) return { query: '', packages: [], posts: [], notes: [] };
  const like = `%${term.toLowerCase()}%`;
  const lim = Math.min(Math.max(1, Number(limit) || 30), 100);
  const pk = await env.DB.prepare(
    `SELECT id, title, headline, status, summary FROM hot_take_packages
      WHERE status != 'dismissed' AND (
        LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(headline,'')) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ?
        OR LOWER(COALESCE(take,'')) LIKE ? OR LOWER(COALESCE(company_notes,'')) LIKE ? OR LOWER(COALESCE(author_notes,'')) LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`,
  ).bind(like, like, like, like, like, like, lim).all();
  const po = await env.DB.prepare(
    `SELECT p.id, p.package_id, p.channel, p.status, SUBSTR(COALESCE(p.body,''),1,140) AS snippet
       FROM hot_take_posts p WHERE LOWER(COALESCE(p.body,'')) LIKE ? OR LOWER(COALESCE(p.notes,'')) LIKE ?
      ORDER BY p.updated_at DESC LIMIT ?`,
  ).bind(like, like, lim).all();
  const notes = [];
  for (const slug of [POV_LIBRARY_SLUG, PATTERNS_SLUG]) {
    try {
      const doc = await readKnowledge(env, slug);
      if (doc?.body && doc.body.toLowerCase().includes(term.toLowerCase())) notes.push({ slug, title: doc.title });
    } catch { /* */ }
  }
  return { query: term, packages: (pk.results || []), posts: (po.results || []), notes };
}

// ── knowledge notes (editable rules — seeded on first read) ─────────────────
export async function loadHotTakesDoc(env, slug, fallback = { title: slug, body: '' }) {
  try {
    const doc = await readKnowledge(env, slug);
    if (doc && doc.body) return doc;
  } catch { /* fall through to seed */ }
  try {
    await writeKnowledge(env, {
      slug, title: fallback.title, body: fallback.body,
      scope: 'module', module: 'hot-takes', parent_slug: null,
    });
    return await readKnowledge(env, slug);
  } catch {
    return { slug, title: fallback.title, body: fallback.body };
  }
}

// The add-link metadata-extraction prompt lives in an editable knowledge note
// (seeded on first read), not as a literal in the tool — change the note, not code.
const LINK_EXTRACT_DEFAULT = `You extract article metadata. Return ONLY JSON: {"title","source_name","summary","why_it_matters","published_at_iso"}. summary = 1-2 plain sentences on what happened. why_it_matters = one sentence on why an AI-native marketing company might care. published_at_iso = ISO 8601 date if determinable, else null. Be faithful to the text; never invent facts.`;
export async function loadLinkExtractPrompt(env) {
  const doc = await loadHotTakesDoc(env, 'hottakes-link-extract', {
    title: 'Hot Takes — link extraction prompt',
    body: LINK_EXTRACT_DEFAULT,
  });
  return (doc && doc.body) || LINK_EXTRACT_DEFAULT;
}

export const POV_LIBRARY_SLUG = 'hottakes-pov-library';
const POV_LIBRARY_DEFAULT = `# Point-of-View Library

Reusable company positions the take-drafter grounds every Hot Take in. Edit freely — the drafter reads this live.

## Positions
- AI-native beats AI-assisted: bolting AI onto old workflows loses to rebuilding the workflow around the model.
- Distribution is the moat now; production cost is collapsing toward zero.
- Small senior teams that ship beat big teams that coordinate.

## Beliefs
- Opinions earn attention; summaries don't.
- Specific beats comprehensive. One sharp claim per piece.

## Terminology
- "AI-native" — built assuming the model does the work, humans supply judgment.

## Approved statements
- "Nyyon builds AI-native marketing systems: agents, funnels, and content engines that ship."
`;
export const loadPovLibrary = (env) => loadHotTakesDoc(env, POV_LIBRARY_SLUG, { title: 'Hot Takes — Point-of-View Library', body: POV_LIBRARY_DEFAULT });

export const PATTERNS_SLUG = 'hottakes-article-patterns';
const PATTERNS_DEFAULT = `# Reusable publication patterns

Structures the brief-builder may propose. Guidance, not a straitjacket — never force every article into the same shape.

1. **Event → implication → company view → recommended action.** For industry news.
2. **Common belief → why it is wrong → evidence → better approach.** For contrarian takes.
3. **New development → who it affects → what changes → what to do next.** For product/model launches.
`;
export const loadPatterns = (env) => loadHotTakesDoc(env, PATTERNS_SLUG, { title: 'Hot Takes — publication patterns', body: PATTERNS_DEFAULT });

export const QUALITY_RULES_SLUG = 'hottakes-quality-rules';
const QUALITY_RULES_DEFAULT = `# Article quality rules

The review scan flags these weaknesses. The goal is not to "hide AI" — it is an article that is specific, original, sourced, and recognizably written from the company's perspective.

- Generic introductions (throat-clearing, "in today's fast-paced world").
- Repeated ideas across sections.
- Unsupported claims stated as fact.
- Overly broad statements with no named subject.
- Unclear audience — who exactly should care?
- Excessive industry jargon.
- Sections that do not advance the central argument.
- Language that sounds unlike previously approved company writing.

Claim taxonomy: directly_supported (a cited source backs it) · company_experience (we know this from our own work) · opinion (clearly framed as a stance) · unsupported (needs confirmation or removal).
`;
export const loadQualityRules = (env) => loadHotTakesDoc(env, QUALITY_RULES_SLUG, { title: 'Hot Takes — quality rules', body: QUALITY_RULES_DEFAULT });

export const PLAYBOOK_SLUG = 'hottakes-playbook';
const PLAYBOOK_DEFAULT = `# Hot Takes playbook

How the take-drafter and brief-builder behave. Edit to change their behavior — no deploy.

## Draft a take
Propose a SPECIFIC, defensible company opinion on the topic — not a neutral summary. Ground it in the Point-of-View Library. Answer four things: what the company believes; what is commonly misunderstood; who should care; what the reader should do differently. One clear argument, no hedging.

## Editorial brief
Before a long article is written: proposed argument, intended audience, why the topic matters now, 3-5 supporting points, evidence available, possible objections, recommended conclusion. Pick the publication pattern that fits (see hottakes-article-patterns). The brief exists so no one polishes an article built around the wrong argument.

## Social posts
Company post = the organization's position: composed, confident, no first person singular. Personal post = direct, experiential, first person, one concrete observation — NOT a copy of the company post. Both end with a reason to read the full article. 900-1,300 characters each, no hashtag walls (max 3), no em-dashes.

## Article
Write this as an in-depth opinion piece (1,500+ words): open with the claim, argue it with the points above, use the evidence concretely, address the objections, close with the recommended action. This is a POINT OF VIEW, not a news summary.
`;
export const loadPlaybook = (env) => loadHotTakesDoc(env, PLAYBOOK_SLUG, { title: 'Hot Takes — playbook', body: PLAYBOOK_DEFAULT });

// The article-write instruction appended to the prose seed — the "## Article"
// section of the playbook note (editable), with the seeded default as fallback
// for docs written before the section existed.
const ARTICLE_INSTRUCTION_FALLBACK = 'Write this as an in-depth opinion piece (1,500+ words): open with the claim, argue it with the points above, use the evidence concretely, address the objections, close with the recommended action. This is a POINT OF VIEW, not a news summary.';
async function loadArticleInstruction(env) {
  try {
    const doc = await loadPlaybook(env);
    const m = String(doc.body || '').match(/## Article\s*\n([\s\S]*?)(?=\n## |\s*$)/);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* fall through */ }
  return ARTICLE_INSTRUCTION_FALLBACK;
}

export const TIMING_SLUG = 'hottakes-timing';
const TIMING_DEFAULT = `# Release timing defaults

Suggested schedule when the operator picks only a date. Offsets are minutes after the website publish. Edit the JSON block — it is parsed live.

\`\`\`json
{ "default_hour_utc": 13, "company_offset_min": 120, "personal_offset_min": 3 }
\`\`\`
`;
export async function loadTimingDefaults(env) {
  const doc = await loadHotTakesDoc(env, TIMING_SLUG, { title: 'Hot Takes — release timing', body: TIMING_DEFAULT });
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    if (m) return { default_hour_utc: 13, company_offset_min: 120, personal_offset_min: 3, ...JSON.parse(m[1]) };
  } catch { /* fall through */ }
  return { default_hour_utc: 13, company_offset_min: 120, personal_offset_min: 3 };
}

// Seed every Hot Takes knowledge note (called from the notes route so the
// editors always have something to open).
// ── social identities (who appears as the poster in the LinkedIn previews) ──
// Editable note, not code: rename the company, change the personal headline, or
// point avatar_url at a real photo without touching a file. Keyed by channel so
// future platforms slot in beside the two LinkedIn legs.
export const IDENTITIES_SLUG = 'hottakes-social-identities';
const IDENTITIES_FALLBACK = {
  'linkedin-company': { name: 'Your company', headline: 'set me in hottakes-social-identities', avatar_url: null },
  'linkedin-personal': { name: 'You', headline: 'set me in hottakes-social-identities', avatar_url: null },
};
const IDENTITIES_DEFAULT = `# Hot Takes — social identities

Who appears as the poster in each channel's post preview (the editor's Social
page). Edit the JSON block — it is parsed live. \`avatar_url\` may be any image
URL; when null the preview renders initials.

\`\`\`json
${JSON.stringify(IDENTITIES_FALLBACK, null, 2)}
\`\`\`
`;
export async function loadSocialIdentities(env) {
  const doc = await loadHotTakesDoc(env, IDENTITIES_SLUG, { title: 'Hot Takes — social identities', body: IDENTITIES_DEFAULT });
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    if (m) {
      const parsed = JSON.parse(m[1]);
      const out = {};
      for (const [ch, dflt] of Object.entries(IDENTITIES_FALLBACK)) {
        const v = parsed[ch] || {};
        out[ch] = {
          name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : dflt.name,
          headline: typeof v.headline === 'string' ? v.headline : dflt.headline,
          avatar_url: typeof v.avatar_url === 'string' && v.avatar_url.trim() ? v.avatar_url.trim() : null,
        };
      }
      return out;
    }
  } catch { /* fall through to defaults */ }
  return { ...IDENTITIES_FALLBACK };
}

export async function loadAllHotTakesNotes(env) {
  const [pov, patterns, quality, playbook, timing, identities] = await Promise.all([
    loadPovLibrary(env), loadPatterns(env), loadQualityRules(env), loadPlaybook(env),
    loadHotTakesDoc(env, TIMING_SLUG, { title: 'Hot Takes — release timing', body: TIMING_DEFAULT }),
    loadHotTakesDoc(env, IDENTITIES_SLUG, { title: 'Hot Takes — social identities', body: IDENTITIES_DEFAULT }),
  ]);
  return { pov, patterns, quality, playbook, timing, identities };
}
