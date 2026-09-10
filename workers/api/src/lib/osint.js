// OSINT scrapers — port of inrepute's review-hub-osint/tools/sources, adapted
// for Cloudflare Workers (Web Crypto, no process.env, fetch is global).
// Six public sources, no auth required (github optional token).
//
// Public surface:
//   - scrapeTarget(env, targetId, opts)  → { source, count, error? }[]
//   - listMentions(env, { target_id?, source?, limit? })
//   - <CRUD via db.js>
//
// Each source returns an array of normalized mention objects (makeMention).
// Insertion is idempotent on the deterministic `id` hash so re-scraping
// doesn't duplicate.

import { now, uid, safeJSON } from './util.js';
import { logEvent } from './db.js';
import { fetchText as webFetchText, head as webHead } from './web-gateway.js';

const UA = 'nyyon-cmd/0.1 (self-hosted command center)';

// ─── helpers ────────────────────────────────────────────────
async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function mentionId(source, sourceUrl, text = '') {
  const h = await sha1Hex(`${source}\0${sourceUrl || ''}\0${(text || '').slice(0, 500)}`);
  return h.slice(0, 16);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Throttle {
  constructor(minIntervalMs) { this.gap = minIntervalMs; this.last = 0; }
  async wait() {
    const since = Date.now() - this.last;
    if (since < this.gap) await sleep(this.gap - since);
    this.last = Date.now();
  }
}

async function getJson(env, url, { headers = {}, throttle, timeoutMs = 15000 } = {}) {
  if (throttle) await throttle.wait();
  const res = await webFetchText(env, {
    url, timeout_ms: timeoutMs, max_bytes: Infinity,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.status_text} @ ${url}`);
  return JSON.parse(res.text);
}
async function getText(env, url, { headers = {}, throttle, timeoutMs = 15000 } = {}) {
  if (throttle) await throttle.wait();
  const res = await webFetchText(env, {
    url, timeout_ms: timeoutMs, max_bytes: Infinity,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.status_text} @ ${url}`);
  return res.text;
}

function isoToMs(input) {
  if (input == null) return null;
  if (typeof input === 'number') return input < 1e12 ? input * 1000 : input;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// Confidence score 0..1 — 1.0 if domain hit, 0.6 name+product cue nearby,
// 0.4 plain whole-word name, 0 otherwise.
const CUES = /\b(app|tool|tools|software|product|saas|platform|company|team|teams|startup|service|integration|api|review|reviews|customer|customers|used|use|tried|using|alternative|vs)\b/i;
function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function scoreMention(text, { name, domain }) {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (domain && t.includes(domain.toLowerCase())) return 1.0;
  if (!name) return 0;
  const wb = new RegExp(`\\b${escape(name)}\\b`, 'i');
  if (!wb.test(text)) return 0;
  const idx = t.indexOf(name.toLowerCase());
  const window = text.slice(Math.max(0, idx - 100), idx + name.length + 100);
  return CUES.test(window) ? 0.6 : 0.4;
}

function makeMention({ id, target_id, source, source_url, reviewer = null, rating = null, text = '', posted_at = null, confidence = null, raw = null }) {
  return {
    id, target_id, source,
    source_url: source_url || null,
    reviewer,
    rating: rating == null ? null : Number(rating),
    text: (text || '').slice(0, 2000),
    posted_at: isoToMs(posted_at),
    confidence: confidence == null ? null : Number(confidence.toFixed(2)),
    kind: rating != null ? 'review' : 'mention',
    raw: raw || null,
  };
}

// ─── sources ────────────────────────────────────────────────
// Hacker News — Algolia search API
async function fetchHN({ target_id, name, domain }, env) {
  const throttle = new Throttle(800);
  const out = [];
  const terms = [name, domain].filter(Boolean);
  for (const term of terms) {
    try {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}&tags=(story,comment)&hitsPerPage=50`;
      const data = await getJson(env, url, { throttle });
      for (const hit of (data.hits || [])) {
        const text = [hit.title, hit.story_text, hit.comment_text].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        const sourceUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        out.push(makeMention({
          id: await mentionId('hn', sourceUrl, text),
          target_id, source: 'hn',
          source_url: sourceUrl,
          reviewer: hit.author || null,
          text,
          posted_at: hit.created_at,
          confidence: conf,
          raw: { objectID: hit.objectID, points: hit.points, num_comments: hit.num_comments },
        }));
      }
    } catch (e) { /* swallow per-source errors */ }
  }
  return out;
}

// Reddit search public JSON
async function fetchReddit({ target_id, name, domain }, env) {
  const throttle = new Throttle(2200);
  const out = [];
  const terms = [name, domain].filter(Boolean);
  for (const term of terms) {
    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(`"${term}"`)}&limit=50&sort=relevance&type=link&t=year`;
      const data = await getJson(env, url, { throttle });
      for (const post of (data?.data?.children || [])) {
        const p = post.data;
        const text = [p.title, p.selftext].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        const sourceUrl = `https://www.reddit.com${p.permalink}`;
        out.push(makeMention({
          id: await mentionId('reddit', sourceUrl, text),
          target_id, source: 'reddit',
          source_url: sourceUrl,
          reviewer: p.author || null,
          text,
          posted_at: p.created_utc,
          confidence: conf,
          raw: { subreddit: p.subreddit, score: p.score, ups: p.ups, num_comments: p.num_comments },
        }));
      }
    } catch (e) { /* swallow */ }
  }
  return out;
}

// StackExchange — search/excerpts on stackoverflow site
async function fetchStackOverflow({ target_id, name, domain }, env) {
  const throttle = new Throttle(800);
  const out = [];
  const terms = [name, domain].filter(Boolean);
  for (const term of terms) {
    try {
      const url = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=activity&q=${encodeURIComponent(term)}&site=stackoverflow&filter=default&pagesize=50`;
      const data = await getJson(env, url, { throttle });
      for (const item of (data.items || [])) {
        const text = [item.title, item.excerpt].filter(Boolean).join('\n\n').replace(/<[^>]+>/g, ' ').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        const sourceUrl = `https://stackoverflow.com/q/${item.question_id || ''}`;
        out.push(makeMention({
          id: await mentionId('stackoverflow', sourceUrl, text),
          target_id, source: 'stackoverflow',
          source_url: sourceUrl,
          reviewer: item.owner?.display_name || null,
          text,
          posted_at: item.last_activity_date,
          confidence: conf,
          raw: { score: item.score, answer_count: item.answer_count, tags: item.tags },
        }));
      }
    } catch (e) { /* swallow */ }
  }
  return out;
}

// GitHub Issues search — optional GITHUB_TOKEN for higher rate
async function fetchGitHub({ target_id, name, domain }, env) {
  const throttle = new Throttle(7000);
  const out = [];
  const terms = [name, domain].filter(Boolean);
  const headers = env?.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
  for (const term of terms) {
    try {
      const q = `"${term}"+in:title,body+is:issue`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=30`;
      const data = await getJson(env, url, { headers, throttle });
      for (const item of (data.items || [])) {
        const text = [item.title, item.body].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        out.push(makeMention({
          id: await mentionId('github', item.html_url, text),
          target_id, source: 'github',
          source_url: item.html_url,
          reviewer: item.user?.login || null,
          text,
          posted_at: item.created_at,
          confidence: conf,
          raw: { state: item.state, comments: item.comments, repo: item.repository_url },
        }));
      }
    } catch (e) { /* swallow */ }
  }
  return out;
}

// Apple App Store — customer reviews RSS (JSON variant). Needs app_id.
async function fetchAppStore({ target_id, app_id }, env) {
  if (!app_id) return [];
  const throttle = new Throttle(700);
  const COUNTRIES = ['us', 'gb', 'ca', 'au'];
  const out = [];
  for (const cc of COUNTRIES) {
    for (let page = 1; page <= 5; page++) {
      try {
        const url = `https://itunes.apple.com/${cc}/rss/customerreviews/page=${page}/id=${app_id}/sortby=mostrecent/json`;
        const data = await getJson(env, url, { throttle });
        const entries = data?.feed?.entry;
        if (!Array.isArray(entries)) break;
        for (const e of entries) {
          if (!e['im:rating']) continue;
          const rating = parseInt(e['im:rating'].label, 10);
          const text = [e.title?.label, e.content?.label].filter(Boolean).join('\n\n');
          const author = e.author?.name?.label || null;
          const sourceUrl = e?.author?.uri?.label || null;
          out.push(makeMention({
            id: await mentionId('appstore', sourceUrl || `${app_id}|${cc}|${e.id?.label || ''}`, text),
            target_id, source: 'appstore',
            source_url: sourceUrl,
            reviewer: author,
            rating,
            text,
            posted_at: e.updated?.label,
            confidence: 1.0,
            raw: { country: cc, version: e['im:version']?.label || null },
          }));
        }
      } catch (e) { /* swallow */ }
    }
  }
  return out;
}

// Owned-site testimonial / reviews path probe — fetch common URLs on a domain
// and extract blockquote/<q> text. Best-effort.
async function fetchWebsite({ target_id, name, domain }, env) {
  if (!domain) return [];
  const throttle = new Throttle(900);
  const PATHS = ['/reviews', '/testimonials', '/customers', '/case-studies', '/stories', '/social-proof', '/love'];
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const out = [];
  for (const path of PATHS) {
    const url = `https://${cleanDomain}${path}`;
    try {
      const html = await getText(env, url, { throttle });
      // Extract <blockquote>, <q>, and elements with class containing "quote"|"testimonial".
      const blocks = [];
      const blockquoteRe = /<blockquote[\s\S]*?<\/blockquote>/gi;
      const qRe          = /<q[\s\S]*?<\/q>/gi;
      const testRe       = /<[a-z][^>]*class="[^"]*(quote|testimonial)[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/gi;
      for (const re of [blockquoteRe, qRe, testRe]) {
        let m;
        while ((m = re.exec(html))) blocks.push(m[0]);
      }
      for (const raw of blocks) {
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length < 30) continue;
        // No domain/name filter — owned-site testimonials are about them.
        out.push(makeMention({
          id: await mentionId('website', url, text),
          target_id, source: 'website',
          source_url: url,
          reviewer: null,
          text,
          posted_at: null,
          confidence: 1.0,
          raw: { path },
        }));
      }
    } catch (e) { /* path probably 404, swallow */ }
  }
  return out;
}

// DuckDuckGo HTML search — keyless, scrapes the lite/html endpoint for
// title + snippet for results that mention the brand. Web-wide reach.
// Throttle hard (3.5s) — DDG rate-limits aggressively.
function ddgStripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
function ddgUnwrap(u) {
  try {
    if (u.startsWith('//duckduckgo.com/l/') || u.startsWith('/l/') || u.includes('duckduckgo.com/l/?')) {
      const m = u.match(/[?&]uddg=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    if (u.startsWith('//')) return 'https:' + u;
    return u;
  } catch { return u; }
}
function ddgParseResults(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = ddgUnwrap(m[1]);
    const title = ddgStripHtml(m[2]);
    const snippet = ddgStripHtml(m[4]);
    if (!url || !title) continue;
    out.push({ url, title, snippet });
  }
  return out;
}
async function fetchDuckDuckGo({ target_id, name, domain }, env) {
  const throttle = new Throttle(3500);
  const out = [];
  const terms = [name, domain].filter(Boolean);
  if (!terms.length) return out;
  const QUERY_TEMPLATES = [(t) => `"${t}" review`, (t) => `"${t}" experience OR opinion`];
  for (const term of terms) {
    for (const tpl of QUERY_TEMPLATES) {
      const query = tpl(term);
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const html = await getText(env, url, { throttle, headers: { 'Accept': 'text/html' } });
        for (const r of ddgParseResults(html)) {
          const text = [r.title, r.snippet].filter(Boolean).join(' — ');
          if (!text) continue;
          const conf = scoreMention(text, { name, domain });
          if (conf < 0.4) continue;
          out.push(makeMention({
            id: await mentionId('duckduckgo', r.url, text),
            target_id, source: 'duckduckgo',
            source_url: r.url,
            text,
            confidence: conf,
            raw: { query, host: (() => { try { return new URL(r.url).host; } catch { return null; } })() },
          }));
        }
      } catch (e) { /* DDG rate-limit / 403 — non-fatal */ }
    }
  }
  // Dedupe within one run (same URL across queries).
  const seen = new Set();
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// RSS/Atom feed of the target's own site — watch a site directly for new
// posts. Discovers the feed from the target's `domain` (homepage <link
// rel=alternate>, then conventional /feed, /rss.xml, …). confidence 1.0
// since every item is straight from the source.
function feedHtmlDecode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
function feedTag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? feedHtmlDecode(m[1]) : null;
}
async function fetchFeed({ target_id, domain }, env) {
  if (!domain) return [];
  const throttle = new Throttle(500);
  const site = /^https?:\/\//.test(domain) ? domain : `https://${domain.replace(/\/.*$/, '')}`;
  let feedUrl = null;
  try {
    const html = await getText(env, site, { throttle });
    const m = html.match(/<link[^>]+(?:type="application\/(?:rss|atom)\+xml"[^>]+href="([^"]+)"|href="([^"]+)"[^>]+type="application\/(?:rss|atom)\+xml")/i);
    if (m && (m[1] || m[2])) feedUrl = new URL(m[1] || m[2], site).href;
  } catch { /* */ }
  if (!feedUrl) {
    for (const p of ['/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml']) {
      try { const u = new URL(p, site).href; const r = await webHead(env, { url: u }); if (r.ok) { feedUrl = u; break; } } catch { /* */ }
    }
  }
  if (!feedUrl) return [];
  let xml;
  try { xml = await getText(env, feedUrl, { throttle }); } catch { return []; }
  const out = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = (xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, 25);
  for (const b of blocks) {
    const title = feedTag(b, 'title');
    const link = isAtom ? (b.match(/<link[^>]+href="([^"]+)"/i)?.[1] || feedUrl) : (feedTag(b, 'link') || feedUrl);
    const date = feedTag(b, 'pubDate') || feedTag(b, 'published') || feedTag(b, 'updated') || feedTag(b, 'dc:date');
    const body = feedTag(b, 'description') || feedTag(b, 'summary') || feedTag(b, 'content');
    const text = [title, body].filter(Boolean).join(' — ');
    if (!text) continue;
    out.push(makeMention({
      id: await mentionId('feed', link, text),
      target_id, source: 'feed', source_url: link, text,
      posted_at: date, confidence: 1.0, raw: { feed: feedUrl },
    }));
  }
  return out;
}

const SOURCES = {
  hn:            fetchHN,
  reddit:        fetchReddit,
  stackoverflow: fetchStackOverflow,
  github:        fetchGitHub,
  appstore:      fetchAppStore,
  website:       fetchWebsite,
  duckduckgo:    fetchDuckDuckGo,
  feed:          fetchFeed,
};

// ─── orchestration ──────────────────────────────────────────
// Run requested sources sequentially. Per-source errors are caught so one
// flaky API doesn't kill the run. Returns per-source counts.
export async function scrapeTarget(env, targetId, opts = {}) {
  const t = await env.DB.prepare('SELECT * FROM osint_targets WHERE id = ?').bind(targetId).first();
  if (!t) throw new Error(`target ${targetId} not found`);
  // Default = run only ENABLED listeners. Explicit opts.sources bypasses the
  // enable gate so the operator can do a one-off scrape from a disabled
  // engine without flipping it on permanently.
  const enabled = await enabledListeners(env);
  const sources = opts.sources && opts.sources.length
    ? opts.sources.filter((s) => SOURCES[s])
    : enabled.filter((s) => SOURCES[s]);

  const results = [];
  let total = 0;
  for (const sourceKey of sources) {
    const fn = SOURCES[sourceKey];
    let count = 0, error = null;
    try {
      const mentions = await fn(
        { target_id: targetId, name: t.name, domain: t.domain, app_id: t.app_id },
        env,
      );
      // Bulk insert with IGNORE so re-scrapes don't dup.
      for (const m of mentions) {
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO osint_mentions
             (id, target_id, source, source_url, reviewer, rating, text, posted_at, confidence, kind, raw_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            m.id, m.target_id, m.source, m.source_url, m.reviewer, m.rating,
            m.text, m.posted_at, m.confidence, m.kind,
            m.raw ? JSON.stringify(m.raw) : null,
            now(),
          ).run();
          count++;
        } catch (e) { /* duplicate or constraint, skip */ }
      }
    } catch (e) {
      error = String(e?.message || e);
    }
    results.push({ source: sourceKey, count, error });
    total += count;
    // Record per-listener stats (even on partial fails).
    try { await recordListenerRun(env, sourceKey, { ok: !error, added: count, error }); } catch {}
  }

  await env.DB.prepare('UPDATE osint_targets SET updated_at = ? WHERE id = ?').bind(now(), targetId).run();
  await logEvent(env, {
    kind: 'osint_scrape',
    actor: 'osint',
    payload: { target_id: targetId, target_name: t.name, total, results },
  });
  return { target_id: targetId, total, results };
}

export async function listMentions(env, { target_id = null, source = null, limit = 200 } = {}) {
  const where = [];
  const args  = [];
  if (target_id) { where.push('target_id = ?'); args.push(target_id); }
  if (source)    { where.push('source = ?');    args.push(source); }
  const sql = `
    SELECT m.*, t.name AS target_name
      FROM osint_mentions m
      LEFT JOIN osint_targets t ON t.id = m.target_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY COALESCE(m.posted_at, m.created_at) DESC
     LIMIT ?
  `;
  const r = await env.DB.prepare(sql).bind(...args, limit).all();
  return (r.results || []).map((m) => ({ ...m, raw: safeJSON(m.raw_json) }));
}

export const OSINT_SOURCES = Object.keys(SOURCES);

// ─── listeners (engines) ────────────────────────────────────
// Listeners are the scraper engines themselves. Enable/disable per source so
// the operator can spin up new ones gradually. Targets vs Listeners is the
// product split — listeners are the HOW, targets are the WHAT.
export async function listOsintListeners(env) {
  const r = await env.DB.prepare('SELECT * FROM osint_listeners ORDER BY enabled DESC, source ASC').all();
  return r.results || [];
}
export async function readOsintListener(env, source) {
  return env.DB.prepare('SELECT * FROM osint_listeners WHERE source = ?').bind(source).first();
}
export async function patchOsintListener(env, source, patch) {
  const existing = await readOsintListener(env, source);
  if (!existing) throw new Error(`unknown listener ${source}`);
  const t = now();
  await env.DB.prepare(`
    UPDATE osint_listeners
       SET enabled  = ?,
           cadence  = ?,
           notes    = ?,
           updated_at = ?
     WHERE source = ?
  `).bind(
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
    patch.cadence ?? existing.cadence,
    patch.notes   ?? existing.notes,
    t,
    source,
  ).run();
  await logEvent(env, { kind: 'osint_listener_updated', actor: 'operator', payload: { source, enabled: patch.enabled !== undefined ? !!patch.enabled : !!existing.enabled } });
  return readOsintListener(env, source);
}
async function recordListenerRun(env, source, { ok, added, error }) {
  const t = now();
  await env.DB.prepare(`
    UPDATE osint_listeners
       SET last_run_at = ?,
           last_status = ?,
           last_error  = ?,
           total_runs  = total_runs + 1,
           total_added = total_added + ?,
           updated_at  = ?
     WHERE source = ?
  `).bind(t, ok ? 'ok' : 'error', error || null, added || 0, t, source).run();
}
async function enabledListeners(env) {
  const r = await env.DB.prepare('SELECT source FROM osint_listeners WHERE enabled = 1').all();
  return (r.results || []).map((x) => x.source);
}

// ─── cron runner ────────────────────────────────────────────
// Sweep every enabled OSINT target through every enabled listener (HN /
// Reddit / DuckDuckGo / etc.). Called from the Cloudflare scheduled
// handler in index.js. Wraps each target call so one failing target
// doesn't kill the whole pass — the per-target error gets recorded into
// recordListenerRun + the loop continues.
//
// `staleAfterMs` lets the cron skip targets that were scraped recently;
// the default of 22h means a daily 06:00 cron won't double-scrape if
// triggered twice on the same day (e.g. manual + automated).
export async function runOsintCron(env, { actor = 'osint-cron', staleAfterMs = 22 * 60 * 60 * 1000, maxTargets = Infinity } = {}) {
  const sources = await enabledListeners(env);
  if (sources.length === 0) {
    return { ok: true, ran: 0, skipped: 'no listeners enabled' };
  }
  const targets = await env.DB.prepare('SELECT id, name FROM osint_targets').all();
  const cutoff  = now() - staleAfterMs;
  const ran = [];
  const skipped = [];
  // Pass 1: staleness — collect candidates with their last-scrape time so the
  // per-tick cap can take the LONGEST-unscraped first (everything still cycles).
  const stale = [];
  for (const target of (targets.results || [])) {
    const last = await env.DB.prepare(
      'SELECT MAX(created_at) AS t FROM osint_mentions WHERE target_id = ?',
    ).bind(target.id).first();
    if (last?.t && last.t > cutoff) {
      skipped.push({ id: target.id, name: target.name, reason: 'scraped within window' });
      continue;
    }
    stale.push({ ...target, last: last?.t || 0 });
  }
  // Per-tick cap: one scrape fans out into ~10-15 subrequests (sources + D1
  // inserts), and the hourly invocation also runs heartbeat + digest — scraping
  // every stale target in one tick blows the Worker subrequest budget (seen
  // live: 12 scrapes -> heartbeat died on "Too many subrequests"). Overflow
  // defers to the next tick, oldest-first.
  stale.sort((a, b) => a.last - b.last);
  for (const target of stale.slice(Number.isFinite(maxTargets) ? maxTargets : stale.length)) {
    skipped.push({ id: target.id, name: target.name, reason: 'deferred (per-tick cap)' });
  }
  for (const target of stale.slice(0, Number.isFinite(maxTargets) ? maxTargets : stale.length)) {
    try {
      const r = await scrapeTarget(env, target.id);
      ran.push({ id: target.id, name: target.name, total: r.total, results: r.results });
    } catch (e) {
      ran.push({ id: target.id, name: target.name, error: String(e?.message || e) });
    }
  }
  return { ok: true, actor, sources, ran, skipped, target_count: (targets.results || []).length };
}

// ─── targets CRUD ───────────────────────────────────────────
export async function listOsintTargets(env) {
  const r = await env.DB.prepare(`
    SELECT t.*,
           (SELECT COUNT(*) FROM osint_mentions m WHERE m.target_id = t.id) AS mentions_count,
           (SELECT MAX(COALESCE(posted_at, created_at)) FROM osint_mentions m WHERE m.target_id = t.id) AS last_mention_at
      FROM osint_targets t
     ORDER BY t.updated_at DESC
  `).all();
  return r.results || [];
}

export async function readOsintTarget(env, id) {
  return env.DB.prepare('SELECT * FROM osint_targets WHERE id = ?').bind(id).first();
}

export async function writeOsintTarget(env, body) {
  const id = body.id || ('tgt_' + uid().slice(0, 10));
  const t = now();
  const existing = await readOsintTarget(env, id);
  if (existing) {
    await env.DB.prepare(`
      UPDATE osint_targets
         SET name = ?, domain = ?, app_id = ?, notes = ?, updated_at = ?, updated_by = ?
       WHERE id = ?
    `).bind(
      body.name ?? existing.name,
      body.domain ?? existing.domain,
      body.app_id ?? existing.app_id,
      body.notes ?? existing.notes,
      t,
      body.updated_by || 'operator',
      id,
    ).run();
  } else {
    if (!body.name) throw new Error('name required');
    await env.DB.prepare(`
      INSERT INTO osint_targets (id, name, domain, app_id, notes, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, body.name, body.domain || null, body.app_id || null, body.notes || null,
      t, t, body.created_by || 'operator', body.updated_by || 'operator',
    ).run();
  }
  await logEvent(env, {
    kind: existing ? 'osint_target_updated' : 'osint_target_added',
    actor: body.updated_by || 'operator',
    payload: { id, name: body.name ?? existing?.name },
  });
  return readOsintTarget(env, id);
}

export async function deleteOsintTarget(env, id) {
  const t = await readOsintTarget(env, id);
  await env.DB.prepare('DELETE FROM osint_targets WHERE id = ?').bind(id).run();
  // Mentions cascade via FK.
  await logEvent(env, { kind: 'osint_target_deleted', actor: 'operator', payload: { id, name: t?.name || null } });
}
