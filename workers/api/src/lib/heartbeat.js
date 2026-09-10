// heartbeat.js — OSINT v2, the Command Center's awareness layer.
//
// Senses the outside world from authoritative sources (company-blog RSS +
// Google News RSS topic queries), LLM-scores each item for relevance + content
// value, and maintains a standing "industry pulse" that Nyo can pull into any
// conversation and the Digest presents as situational awareness.
//
//   runHeartbeat(env)      → ingest all sources + score new signals
//   synthesizePulse(env)   → rebuild the `industry-pulse` knowledge doc
//   topSignals(env, opts)  → query scored signals (for Digest / Nyo / Brain)
//
// No API keys: RSS + Google News are open. Date/fetch are fine in the worker
// runtime (this is not a workflow script).

import { callOpenAIJson, callOpenAIText } from './openai.js';
import { readKnowledge, writeKnowledge, stripDashes, logEvent } from './db.js';
import { readTasteProfile } from './aeo-taste.js';
import { fetchText as webFetchText } from './web-gateway.js';
import { uid, now } from './util.js';

// ─── seed sources ───────────────────────────────────────────────────────────
// Company blogs (primary sources) + Google News topic queries (real outlets,
// aggregated, structured). Dead feeds just log last_status='error' and skip.
const GNEWS = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// Sources seed from the OPERATOR's watch topics, never from a shipped list.
// The voice interview writes heartbeat-priorities with a "## Watch topics"
// section (one plain search query per line); the first tick after that turns
// each topic into a Google News query source. An install that skipped the
// interview gets an empty feed rather than somebody else's industry — and the
// operator can add rss/gnews sources by hand any time (the sources API).
export function watchTopicsFrom(body) {
  const m = String(body || '').match(/##\s*Watch topics\s*\n([\s\S]*?)(?:\n##|$)/i);
  if (!m) return [];
  return m[1].split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('_'))
    .slice(0, 8);
}

export async function seedSourcesIfEmpty(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM osint_sources').first();
  if ((r?.n || 0) > 0) return { seeded: 0 };
  const doc = await readKnowledge(env, GATES_SLUG).catch(() => null);
  const topics = watchTopicsFrom(doc?.body);
  let n = 0;
  for (const t of topics) {
    await env.DB.prepare(
      `INSERT INTO osint_sources (id, kind, name, url, theme, enabled, created_at) VALUES (?, 'gnews', ?, ?, 'watch', 1, ?)`
    ).bind(uid(), `Topic · ${t.slice(0, 60)}`, GNEWS(`${t} when:7d`), now()).run();
    n++;
  }
  // No topics yet = the interview hasn't run. Stay empty and re-derive next
  // tick; seeding a stranger's industry here is the failure mode, not the fix.
  return { seeded: n, from: n ? 'watch-topics' : 'no-topics-yet' };
}

// ─── feed parsing (RSS + Atom, regex-based — workerd has no DOMParser) ──────
function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')                 // strip any inner HTML
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}
function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

export function parseFeed(xml) {
  if (!xml) return [];
  const out = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = decode(tag(b, 'title') || '');
    let link = null;
    if (isAtom) {
      // prefer rel="alternate" or first <link href="...">
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
               || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? alt[1] : null;
    } else {
      link = decode(tag(b, 'link') || '');
      // Google News wraps the real URL; the <link> text is the redirector — fine, still unique.
    }
    const summaryRaw = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || '';
    const summary = decode(summaryRaw).slice(0, 600);
    const dateStr = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || null;
    if (!title || !link) continue;
    out.push({ title, url: link.trim(), summary, published_at: parseDate(dateStr) });
  }
  return out;
}

async function fetchSource(env, source) {
  // max_bytes: Infinity keeps the pre-gateway uncapped read; feeds are small.
  const r = await webFetchText(env, {
    url: source.url, timeout_ms: 12000, max_bytes: Infinity,
    headers: { 'user-agent': 'NyyonHeartbeat/1.0 (+nyyon.com)' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseFeed(r.text);
}

// ─── full article text (so Nyo reacts to content, not just titles) ──────────
// Fetch a URL, follow redirects (Google News links bounce to the publisher),
// strip to readable text, cap length. Crude but enough for the LLM to react to
// the actual argument. Returns '' on failure (caller falls back to summary).
export async function fetchArticleText(env, url, { maxChars = 8000 } = {}) {
  try {
    const r = await webFetchText(env, {
      url, timeout_ms: 12000, max_bytes: Infinity,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NyyonHeartbeat/1.0; +nyyon.com)' },
    });
    if (!r.ok) return '';
    const ct = r.content_type || '';
    if (!ct.includes('html') && !ct.includes('text')) return '';
    let html = r.text;
    // drop non-content blocks entirely
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
    // prefer <article> / <main> body if present
    const main = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
    const scope = main ? main[0] : html;
    const text = decode(scope);
    // if extraction is junky/tiny, treat as failure
    return text.length > 200 ? text.slice(0, maxChars) : '';
  } catch {
    return '';
  }
}

// ─── ingest ─────────────────────────────────────────────────────────────────
// Pull all enabled sources, insert new (unseen-URL) items as status='new'.
// ─── sources CRUD (the OSINT module's Sources tab + Nyo tools) ──────────────
export async function listHeartbeatSources(env) {
  const r = await env.DB.prepare('SELECT * FROM osint_sources ORDER BY kind, name').all();
  return r.results || [];
}

export async function writeHeartbeatSource(env, body = {}) {
  const id = body.id || uid();
  const existing = body.id
    ? await env.DB.prepare('SELECT * FROM osint_sources WHERE id = ?').bind(body.id).first()
    : null;
  const kind = body.kind ?? existing?.kind ?? 'rss';
  // gnews sources can be authored by plain query text — we build the feed URL.
  const url = body.url ?? (body.query && kind === 'gnews' ? GNEWS(String(body.query)) : existing?.url);
  const name = body.name ?? existing?.name;
  if (!name || !url) throw new Error('name and url (or a gnews query) required');
  if (!/^https?:\/\//i.test(String(url))) throw new Error('url must be http(s)');
  if (!['rss', 'gnews'].includes(kind)) throw new Error("kind must be 'rss' or 'gnews'");
  if (existing) {
    await env.DB.prepare(
      'UPDATE osint_sources SET kind=?, name=?, url=?, theme=?, enabled=? WHERE id=?',
    ).bind(kind, name, url, body.theme ?? existing.theme, body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled, id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO osint_sources (id, kind, name, url, theme, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, kind, name, url, body.theme || 'general', body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1, now()).run();
  }
  await logEvent(env, {
    kind: existing ? 'osint_source_updated' : 'osint_source_added',
    actor: 'operator', payload: { id, name, kind, enabled: body.enabled },
  });
  return env.DB.prepare('SELECT * FROM osint_sources WHERE id = ?').bind(id).first();
}

export async function deleteHeartbeatSource(env, id) {
  const row = await env.DB.prepare('SELECT name FROM osint_sources WHERE id = ?').bind(id).first();
  await env.DB.prepare('DELETE FROM osint_sources WHERE id = ?').bind(id).run();
  await logEvent(env, { kind: 'osint_source_deleted', actor: 'operator', payload: { id, name: row?.name || null } });
  return { ok: true, id };
}

// ─── score gates (knowledge-backed) ──────────────────────────────────────────
// The heartbeat-priorities doc claims "content_score>=70 reaches the digest" —
// these gates make that true: a fenced ```json block in the doc overrides the
// coded defaults, so editing the doc actually changes what flows through.
const GATE_DEFAULTS = Object.freeze({
  digest_min_content: 70,   // pullHeartbeat: signals entering the morning brief
  topics_min_content: 62,   // hot-topic synthesis input floor
  enrich_min_relevance: 60, // which signals get the full-article re-score
});
export const GATES_SLUG = 'heartbeat-priorities';
const GATES_BLOCK_RE = /```json\s*[\s\S]*?```/;

export async function heartbeatGates(env) {
  try {
    const doc = await readKnowledge(env, GATES_SLUG);
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const out = {};
    for (const [k, dflt] of Object.entries(GATE_DEFAULTS)) {
      const n = Number(src[k]);
      out[k] = Number.isFinite(n) && n >= 0 ? n : dflt;
    }
    return out;
  } catch { return { ...GATE_DEFAULTS }; }
}

// Edit the gates in place, from the UI, without touching code.
//
// The thresholds are NOT constants here — they live in the `heartbeat-priorities`
// note as a fenced ```json block that heartbeatGates() reads on every run. This
// rewrites ONLY that block and leaves the operator's surrounding prose intact,
// so the note stays a human document that happens to carry machine-readable
// numbers. If the block is missing it is appended rather than replacing the doc.
export async function patchHeartbeatGates(env, patch = {}) {
  const before = await heartbeatGates(env);
  const after = { ...before };
  for (const k of Object.keys(GATE_DEFAULTS)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`${k} must be a number between 0 and 100`);
    }
    after[k] = Math.round(n);
  }

  const doc = await readKnowledge(env, GATES_SLUG);
  const body = String(doc?.body || '');
  const block = '```json\n' + JSON.stringify(after, null, 2) + '\n```';
  const nextBody = GATES_BLOCK_RE.test(body)
    ? body.replace(GATES_BLOCK_RE, block)
    : (body.trim() ? `${body.trim()}\n\n${block}\n` : `${block}\n`);

  await writeKnowledge(env, {
    slug: GATES_SLUG,
    title: doc?.title || 'Heartbeat priorities',
    // Preserve placement — writeKnowledge defaults scope to 'global' and module
    // to null, which would silently relocate an existing doc.
    scope: doc?.scope || 'global',
    module: doc?.module ?? null,
    body: nextBody,
  });
  await logEvent(env, { kind: 'heartbeat_gates_updated', actor: 'operator', payload: { before, after } });
  return after;
}

export async function ingestHeartbeat(env) {
  await seedSourcesIfEmpty(env);
  const sources = (await env.DB.prepare('SELECT * FROM osint_sources WHERE enabled = 1').all()).results || [];
  let inserted = 0;
  const perSource = [];
  for (const s of sources) {
    try {
      const entries = await fetchSource(env, s);
      let added = 0;
      for (const e of entries.slice(0, 25)) {
        const exists = await env.DB.prepare('SELECT 1 FROM osint_signals WHERE url = ? LIMIT 1').bind(e.url).first();
        if (exists) continue;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO osint_signals (id, source_id, source_name, theme, title, url, summary, published_at, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
        ).bind(uid(), s.id, s.name, s.theme, e.title, e.url, e.summary, e.published_at, now()).run();
        added++; inserted++;
      }
      await env.DB.prepare(`UPDATE osint_sources SET last_fetched_at=?, last_status='ok', last_error=NULL WHERE id=?`)
        .bind(now(), s.id).run();
      perSource.push({ source: s.name, added });
    } catch (e) {
      await env.DB.prepare(`UPDATE osint_sources SET last_fetched_at=?, last_status='error', last_error=? WHERE id=?`)
        .bind(now(), String(e?.message || e).slice(0, 200), s.id).run();
      perSource.push({ source: s.name, error: String(e?.message || e) });
    }
  }
  return { inserted, perSource };
}

// ─── score (the noise killer) ───────────────────────────────────────────────
// The scoring RUBRIC (what counts as important) lives in an editable knowledge
// doc — `heartbeat-priorities` — NOT hardcoded here. The operator can read and
// change it any time; the scorer reads it on every run. This block is only the
// fallback used if that doc is ever missing.
const SCORE_RULES_FALLBACK = `Nyyon's world: AI model launches, answer engine optimization (AEO) / AI search, AI-native marketing operations, AI agents doing real work, marketing measurement in the AI era, agency economics, competitor moves, sharp industry debates. Noise (score low): generic listicles, off-topic news, vague PR, consumer gadgets. content_score>=70 reaches the digest. Be harsh.`;

function buildScoreSystem(rules) {
  return `You score industry signals for Nyyon — a premium AI-native marketing agency. Use the operator's prioritization rules below to decide what matters.

=== PRIORITIZATION RULES (operator-editable) ===
${rules}
=== END RULES ===

For each item, judge:
- relevance (0-100): does it matter to Nyyon's world per the rules above?
- content_score (0-100): could Nyyon turn it into a strong blog or social post? (timely + opinionated + on-brand = high)
- formats: which of "blog","social" it could become (array; can be both or empty)
- suggested_angle: one sentence — the angle Nyyon would take (empty if not content-worthy)
- why: one short line on the call

Return ONLY: { "scores": [ { "i": <index>, "relevance": N, "content_score": N, "formats": [..], "suggested_angle": "...", "why": "..." }, ... ] }`;
}

export async function scoreNewSignals(env, { limit = 30 } = {}) {
  // Read the editable rubric from knowledge each run (transparent + tunable).
  const rulesDoc = await readKnowledge(env, 'heartbeat-priorities').catch(() => null);
  const SCORE_SYSTEM = buildScoreSystem(rulesDoc?.body || SCORE_RULES_FALLBACK);
  const rows = (await env.DB.prepare(
    `SELECT id, title, summary, source_name, theme FROM osint_signals WHERE status='new' ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all()).results || [];
  if (!rows.length) return { scored: 0 };

  const list = rows.map((r, i) => `[${i}] (${r.source_name} · ${r.theme}) ${r.title}${r.summary ? ` — ${r.summary.slice(0, 180)}` : ''}`).join('\n');
  const out = await callOpenAIJson(env, {
    system: SCORE_SYSTEM,
    prompt: `Score these ${rows.length} items.\n\n${list}\n\nReturn the JSON.`,
  });
  const scores = Array.isArray(out?.scores) ? out.scores : [];
  let scored = 0;
  for (const s of scores) {
    const row = rows[s.i];
    if (!row) continue;
    await env.DB.prepare(
      `UPDATE osint_signals SET relevance=?, content_score=?, formats=?, suggested_angle=?, why=?, status='scored' WHERE id=?`
    ).bind(
      clampInt(s.relevance), clampInt(s.content_score),
      Array.isArray(s.formats) ? s.formats.join(',') : null,
      (s.suggested_angle || '').slice(0, 300) || null,
      (s.why || '').slice(0, 300) || null,
      row.id,
    ).run();
    scored++;
  }
  // Any rows the model skipped: mark scored with relevance 0 so we don't re-score forever.
  for (let i = 0; i < rows.length; i++) {
    if (!scores.find((s) => s.i === i)) {
      await env.DB.prepare(`UPDATE osint_signals SET status='scored', relevance=COALESCE(relevance,0) WHERE id=?`).bind(rows[i].id).run();
    }
  }
  return { scored };
}

function clampInt(n) { const v = parseInt(n, 10); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; }

// ─── enrich (read the actual article + re-score on real content) ────────────
// For signals that PASSED the title gate (relevance high) but haven't been read
// yet, fetch the full article, cache the text, and re-score content_score +
// suggested_angle from what the piece ACTUALLY says. Bounded per run.
// The enrich pass re-judges (and OVERWRITES) content_score/suggested_angle,
// so it must read the same operator-editable rubric the first-pass scorer
// uses — otherwise heartbeat-priorities edits get discarded at this stage.
async function buildEnrichSystem(env) {
  const rulesDoc = await readKnowledge(env, 'heartbeat-priorities').catch(() => null);
  return `${ENRICH_SYSTEM}

=== PRIORITIZATION RULES (operator-editable) ===
${rulesDoc?.body || SCORE_RULES_FALLBACK}
=== END RULES ===`;
}
const ENRICH_SYSTEM = `You are scoring an industry item for Nyyon (premium AI-native marketing agency) — but now you have the FULL article text, not just the title. Re-judge based on what the piece actually argues.

Return ONLY JSON:
{ "content_score": 0-100, "formats": ["blog"|"social"], "suggested_angle": "<the specific, content-grounded angle Nyyon would take — reference an actual point the article makes>", "takeaway": "<1-2 sentence summary of what the article actually says>" }`;

export async function enrichSignals(env, { limit = 12, minRelevance = null } = {}) {
  if (minRelevance == null) minRelevance = (await heartbeatGates(env)).enrich_min_relevance;
  // Google News links are redirector/consent-wrapped — they don't fetch to a
  // real article. Skip them for the content-read path; they keep their
  // title-level score. Direct publisher feeds (OpenAI, Verge, TechCrunch, …)
  // have real URLs and fetch cleanly — those are what we read.
  const rows = (await env.DB.prepare(
    `SELECT id, title, url, summary FROM osint_signals
      WHERE status='scored' AND content_fetched_at IS NULL AND relevance >= ?
        AND url NOT LIKE '%news.google.com%'
      ORDER BY relevance DESC, content_score DESC LIMIT ?`
  ).bind(minRelevance, limit).all()).results || [];
  let enriched = 0;
  for (const row of rows) {
    const text = await fetchArticleText(env, row.url);
    // mark fetched regardless (don't retry forever); store text if we got it
    if (!text) {
      await env.DB.prepare(`UPDATE osint_signals SET content_fetched_at=? WHERE id=?`).bind(now(), row.id).run();
      continue;
    }
    try {
      const out = await callOpenAIJson(env, {
        system: await buildEnrichSystem(env),
        prompt: `Title: ${row.title}\n\nFull article text:\n${text}\n\nRe-score from the real content. Return JSON.`,
      });
      await env.DB.prepare(
        `UPDATE osint_signals SET full_text=?, content_fetched_at=?, content_score=COALESCE(?,content_score),
           formats=COALESCE(?,formats), suggested_angle=COALESCE(?,suggested_angle), summary=COALESCE(?,summary) WHERE id=?`
      ).bind(
        text.slice(0, 8000), now(),
        clampInt(out?.content_score),
        Array.isArray(out?.formats) ? out.formats.join(',') : null,
        (out?.suggested_angle || '').slice(0, 400) || null,
        (out?.takeaway || '').slice(0, 400) || null,   // upgrade summary to a real takeaway
        row.id,
      ).run();
      enriched++;
    } catch {
      await env.DB.prepare(`UPDATE osint_signals SET full_text=?, content_fetched_at=? WHERE id=?`).bind(text.slice(0, 8000), now(), row.id).run();
    }
  }
  return { enriched, considered: rows.length };
}

// Read one signal's full article on demand (for Nyo in chat). Caches it.
export async function readSignalContent(env, signalId) {
  const sig = await env.DB.prepare('SELECT * FROM osint_signals WHERE id=?').bind(signalId).first();
  if (!sig) return null;
  if (sig.full_text) return sig;
  const text = await fetchArticleText(env, sig.url);
  if (text) {
    await env.DB.prepare(`UPDATE osint_signals SET full_text=?, content_fetched_at=? WHERE id=?`).bind(text.slice(0, 8000), now(), signalId).run();
    sig.full_text = text.slice(0, 8000);
  }
  return sig;
}

// ─── orchestration ──────────────────────────────────────────────────────────
export async function runHeartbeat(env, { actor = 'heartbeat-cron' } = {}) {
  const ingest = await ingestHeartbeat(env);
  // Score in a couple of batches so a big first run doesn't get truncated.
  let scoredTotal = 0;
  for (let i = 0; i < 3; i++) {
    const { scored } = await scoreNewSignals(env, { limit: 30 });
    scoredTotal += scored;
    if (!scored) break;
  }
  // Read the survivors and re-score on real content.
  let enriched = 0;
  try { enriched = (await enrichSignals(env, { limit: 12 })).enriched; } catch { /* best effort */ }
  let pulse = null;
  try { pulse = await synthesizePulse(env); } catch { /* best effort */ }
  // Cluster the strongest signals into digest-ready hot topics (the value layer).
  let topics = 0;
  try { topics = (await synthesizeHotTopics(env)).count || 0; } catch { /* best effort */ }
  return { ok: true, inserted: ingest.inserted, scored: scoredTotal, enriched, per_source: ingest.perSource, pulse_updated: !!pulse, topics };
}

// ─── query helpers ──────────────────────────────────────────────────────────
// Top recent scored signals — used by Digest, Nyo, Sunday Brain.
// Build a bound LIKE term for free-text search. Escapes the SQL wildcards so an
// operator typing "50%" or "a_b" searches for those literal characters instead
// of matching everything. The term is always BOUND, never interpolated.
//
// The escape character is '@', NOT the conventional backslash: D1 rejects
// `ESCAPE '\'` outright ("unrecognized token" — its parser will not take a lone
// backslash string literal), while `ESCAPE '@'` works and escapes correctly.
// Verified against the live D1. Keep this in sync with LIKE_ESC below.
const LIKE_ESC = "@";
function likeTerm(q) {
  return '%' + String(q).trim().replace(/[@%_]/g, (c) => LIKE_ESC + c) + '%';
}

export async function topSignals(env, { days = 7, minContent = 55, limit = 12, q = '' } = {}) {
  const since = now() - days * 86400000;
  const term = String(q || '').trim();
  const where = [
    `status IN ('scored','surfaced','actioned')`,
    `content_score >= ?`,
    `(published_at IS NULL OR published_at > ?)`,
    `created_at > ?`,
  ];
  const binds = [minContent, since, since];
  if (term) {
    where.push(`(title LIKE ? ESCAPE '@' OR summary LIKE ? ESCAPE '@' OR suggested_angle LIKE ? ESCAPE '@')`);
    const t = likeTerm(term);
    binds.push(t, t, t);
  }
  const r = await env.DB.prepare(
    `SELECT * FROM osint_signals
      WHERE ${where.join(' AND ')}
      ORDER BY content_score DESC, created_at DESC LIMIT ?`
  ).bind(...binds, limit).all();
  return r.results || [];
}

// ─── synthesis — the standing "industry pulse" Nyo queries ──────────────────
const PULSE_SYSTEM = `You maintain Nyyon's INDUSTRY PULSE — a tight situational-awareness brief on what's happening in AI + AI-marketing right now, for a premium AI-native marketing agency founder.

Given the top scored signals from the last week, write a concise markdown brief:

## The pulse (this week)
3-6 bullets — the genuinely important moves (model launches, AEO/AI-marketing shifts, competitor moves). Each bullet: what happened + why it matters to Nyyon, one line.

## Worth writing about
2-4 bullets — the strongest blog/social angles, each as "<angle> — <format>".

## Watch
0-3 bullets — slower-burning things to keep an eye on.

Be specific and opinionated. Skip noise. If signals are thin, say so honestly.`;

export async function synthesizePulse(env) {
  const signals = await topSignals(env, { days: 7, minContent: 45, limit: 20 });
  if (!signals.length) return null;
  const list = signals.map((s) => `- (${s.source_name} · score ${s.content_score}) ${s.title}${s.suggested_angle ? ` [angle: ${s.suggested_angle}]` : ''}`).join('\n');
  let pulseSystem = PULSE_SYSTEM;
  try {
    const doc = await readKnowledge(env, 'heartbeat-pulse-prompt');
    if (doc?.body && String(doc.body).trim().length > 80) pulseSystem = String(doc.body);
  } catch { /* coded frame */ }
  const md = await callOpenAIText(env, { system: pulseSystem, prompt: `Top signals this week:\n\n${list}\n\nWrite the pulse brief.`, model: 'gpt-4o-mini' });
  await writeKnowledge(env, {
    slug: 'industry-pulse',
    title: 'Industry Pulse — live awareness',
    body: `_Auto-refreshed by the heartbeat. What's happening in AI + AI-marketing right now, and what Nyyon could do about it._\n\n${md.trim()}`,
    scope: 'global', module: 'osint', parent_slug: 'module-osint',
  });
  return md.trim();
}

export async function readPulse(env) {
  const doc = await readKnowledge(env, 'industry-pulse').catch(() => null);
  return doc?.body || null;
}

// ─── hot topics — the value layer ────────────────────────────────────────────
// Scoring + enrichment grade individual signals. This CLUSTERS the strongest
// ones into a handful of sharp, opinionated "hot topics with a Nyyon angle" at
// blog-grade quality, stored as discrete rows so the Digest can quote each one.
// Runs on the STRONG model (omit model => opus) + the editorial voice/taste —
// that is what makes the angles land like the blog titles instead of generic
// per-article blurbs.
function topicsSystem(voice) {
  return `You are a sharp, fearless industry analyst surfacing HOT TAKES for an audience (an AI-native marketing studio and its founder) that has seen everything. From this week's signals, find the genuinely INTERESTING takes: the ones worth arguing about.

A HOT TAKE is a bold, specific, debatable OPINION that takes a side and makes a smart person stop and want to argue. It NAMES the thing (a company, a claim, a consensus). It says what most people will not. It is falsifiable or genuinely provocative.
KILL anything that: hedges ("it depends"), gives a tip or how-to, reads like agency thought-leadership, just restates the news, or could be published by any brand without risk. If it is safe, cut it. Do NOT turn every take into a pitch for "owning the system" or "building infrastructure" — that is the weak move.

Energy to match (NOT your subjects, just the spice level):
- "Most AI agents shipping today are cron jobs in a trench coat."
- "Perplexity raising 200M for a browser is a confession it cannot win search."
- "AEO is a rebrand for the consultants who fumbled SEO."

Work SEVERAL angles so the set is varied, not five versions of one idea:
- CONTRARIAN: argue the opposite of what everyone agrees on.
- PREDICTION: a falsifiable call on what happens next, and who specifically loses.
- EMPEROR: call out the hype or theater the industry pretends not to see.
- UNSAID: the uncomfortable truth insiders know but will not post.
- POWER MOVE: decode what a specific company's move REALLY reveals (fear, retreat, land-grab) versus its press-release framing.

Generate candidates across those angles, then keep ONLY the 5-6 spiciest and most DISTINCT. Each must take a clear side.
${voice ? `\nMatch this house WRITING style (the voice, not the safeness):\n${voice}\n` : ''}
Style: title is ONE sharp declarative sentence. No en-dashes or em-dashes; use commas, colons, plain hyphens. Banned words: revolutionary, game-changing, disruptive, next-gen, cutting-edge, world-class, leverage (verb), synergy, unlock, in today's world.

Return ONLY:
{ "topics": [ {
  "title": "the hot take, one sharp declarative sentence",
  "argument": "2-3 sentences making the case",
  "why_now": "the trigger, one line",
  "counter": "the strongest argument AGAINST it (a real hot take knows its opposition)",
  "format": "blog" | "social" | "both",
  "heat": 0-100,
  "sources": ["<exact signal title it draws on>"]
} ] }`;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function topicId(title) {
  // stable djb2 hash of the normalized title -> recurring topics dedupe across runs
  let h = 5381; const s = normTitle(title);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'otopic_' + h.toString(36);
}
let _topicsReady = false;
async function ensureTopicsTable(env) {
  if (_topicsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS osint_topics (
       id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT, why_now TEXT, angle TEXT,
       format TEXT, heat INTEGER, sources_json TEXT,
       status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_osint_topics_heat ON osint_topics(heat DESC)').run();
  _topicsReady = true;
}

// Cluster the top scored+enriched signals into digest-ready hot topics.
export async function synthesizeHotTopics(env, { days = 10, minContent = null, limit = 26 } = {}) {
  if (minContent == null) minContent = (await heartbeatGates(env)).topics_min_content;
  await ensureTopicsTable(env);
  const signals = await topSignals(env, { days, minContent, limit });
  if (signals.length < 3) return { ok: false, reason: 'not enough scored signals', count: 0, topics: [] };

  const brand = (await readKnowledge(env, 'nyyon-brand-voice').catch(() => null))?.body || '';
  const taste = await readTasteProfile(env).catch(() => null);
  const voice = [brand, taste && `## Operator's learned editorial taste\n${taste}`].filter(Boolean).join('\n\n');

  const list = signals.map((s) =>
    `- (${s.source_name} · ${s.theme} · heat ${s.content_score}) ${s.title}` +
    `${s.suggested_angle ? ` [angle: ${s.suggested_angle}]` : ''}` +
    `${s.summary ? ` — ${String(s.summary).slice(0, 200)}` : ''}`).join('\n');

  // Omit `model` => provider default (opus), NOT the cheap scorer model.
  const out = await callOpenAIJson(env, {
    system: topicsSystem(voice),
    prompt: `This week's strongest signals (${signals.length}):\n\n${list}\n\nSynthesize the hot topics now. Return the JSON.`,
  });
  const topics = Array.isArray(out?.topics) ? out.topics : [];
  const byTitle = new Map(signals.map((s) => [normTitle(s.title), { title: s.title, url: s.url }]));

  const saved = [];
  const ts = now();
  for (const t of topics) {
    if (!t?.title) continue;
    const title = stripDashes(String(t.title)).slice(0, 200);
    const id = topicId(title);
    const sources = (Array.isArray(t.sources) ? t.sources : [])
      .map((st) => byTitle.get(normTitle(st)) || { title: String(st).slice(0, 200), url: null }).slice(0, 5);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO osint_topics (id, title, thesis, why_now, angle, format, heat, sources_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT status FROM osint_topics WHERE id=?), 'new'), ?)`
    ).bind(
      id, title,
      stripDashes(t.argument || t.thesis || '').slice(0, 800) || null,   // thesis col holds the argument
      stripDashes(t.why_now || '').slice(0, 300) || null,
      stripDashes(t.counter || t.angle || '').slice(0, 600) || null,      // angle col holds the counter
      String(t.format || 'blog').slice(0, 12),
      clampInt(t.heat) ?? 70,
      JSON.stringify(sources), id, ts,
    ).run();
    saved.push({ id, title, argument: t.argument || t.thesis, why_now: t.why_now, counter: t.counter || t.angle, format: t.format, heat: clampInt(t.heat), sources });
  }
  try { await logEvent(env, { kind: 'osint_topics_synthesized', actor: 'osint', payload: { count: saved.length } }); } catch { /* */ }
  return { ok: true, count: saved.length, topics: saved };
}

// Latest hot topics for the Digest / Nyo. Newest synthesis, hottest first.
export async function topHotTopics(env, { limit = 6, days = 3, q = '' } = {}) {
  await ensureTopicsTable(env);
  const since = now() - days * 86400000;
  const term = String(q || '').trim();
  const where = [`status != 'dismissed'`, `created_at > ?`];
  const binds = [since];
  if (term) {
    where.push(`(title LIKE ? ESCAPE '@' OR thesis LIKE ? ESCAPE '@' OR why_now LIKE ? ESCAPE '@')`);
    const t = likeTerm(term);
    binds.push(t, t, t);
  }
  const r = await env.DB.prepare(
    `SELECT * FROM osint_topics WHERE ${where.join(' AND ')}
       ORDER BY heat DESC, created_at DESC LIMIT ?`
  ).bind(...binds, limit).all();
  return (r.results || []).map((t) => ({ ...t, sources: JSON.parse(t.sources_json || '[]') }));
}

// ─── signal actions (called by the signal_to_* tools) ───────────────────────

// Turn a heartbeat signal into a pending AEO question, seeded with the
// article's real content so the eventual write reacts to what the source
// actually says, not just its headline. Marks the signal actioned.
export async function signalToBlog(env, signalId) {
  const sig = await readSignalContent(env, signalId);   // fetches full article if not cached
  if (!sig) return { ok: false, error: 'signal not found' };
  const { writeAeoQuestion, readAeoQuestion } = await import('./db.js');
  let base = String(sig.title).toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
  let slug = base;
  for (let i = 2; await readAeoQuestion(env, slug); i++) slug = `${base}-${i}`;
  await writeAeoQuestion(env, {
    slug,
    question: sig.suggested_angle || sig.title,
    target_keyword: null,
    priority: 2,
    status: 'pending',
    notes: `From heartbeat signal (${sig.source_name}). Angle: ${sig.suggested_angle || '—'}. Source: ${sig.url}`,
  });
  if (sig.full_text) {
    const ctx = { from_signal: signalId, source: sig.source_name, source_url: sig.url,
      answers: `Source article ("${sig.title}", ${sig.source_name}):\n\n${sig.full_text.slice(0, 6000)}\n\nNyyon's angle on it: ${sig.suggested_angle || '(take a contrarian, on-brand stance)'}` };
    await env.DB.prepare(`UPDATE aeo_questions SET expert_context_json=? WHERE slug=?`).bind(JSON.stringify(ctx), slug).run();
  }
  await env.DB.prepare(`UPDATE osint_signals SET status='actioned' WHERE id=?`).bind(signalId).run();
  return { ok: true, slug, question: sig.suggested_angle || sig.title, read_full_article: !!sig.full_text, note: 'Created as an AEO question (priority 2), seeded with the article\'s real content. Run aeo_start_interview to add the operator\'s take, or write directly.' };
}

// Draft a social post reacting to a signal, in Nyyon's voice. Draft only —
// the operator reviews before anything is published.
export async function signalToSocialDraft(env, signalId) {
  const sig = await env.DB.prepare('SELECT * FROM osint_signals WHERE id = ?').bind(signalId).first();
  if (!sig) return { ok: false, error: 'signal not found' };
  const { callOpenAIText } = await import('./openai.js');
  const voice = await readKnowledge(env, 'nyyon-brand-voice').catch(() => null);
  const draft = await callOpenAIText(env, {
    system: `You write LinkedIn posts for Nyyon's founder — a premium AI-native marketing agency. Sharp, contrarian-but-earned, no hashtags spam, no "thrilled to announce". One strong idea, a clear take, ends on a line that lands. 80-150 words.\n\n${voice?.body ? 'Brand voice:\n' + voice.body.slice(0, 1500) : ''}`,
    prompt: `React to this industry item with a post that gives Nyyon's POV:\n\nTitle: ${sig.title}\nAngle: ${sig.suggested_angle || ''}\nSource: ${sig.url}\n\nWrite the post.`,
  });
  return { ok: true, draft, signal_title: sig.title, note: 'Draft only — operator reviews before posting. Use the LinkedIn post tool to publish if approved.' };
}
