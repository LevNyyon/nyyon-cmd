// LinkedIn — proxy from the Cloudflare worker to the local LinkedinGateway
// daemon (~/LinkedinGateway/, port 2786 by default). Mirrors the wa-gateway
// pattern in whatsapp.js: probe, ensureReady, then a small set of high-level
// helpers (profile, feed, messages, send DM, post text).
//
// The gateway is hybrid — voyager API for fast reads + DMs, headless
// Chromium (Playwright) for posts + reactions. Nyyon doesn't care which side
// handles a request; it just calls the gateway's REST surface.
//
// Recovery + session etiquette lives in the `linkedin-endpoints` knowledge
// doc. Tooling clients should call probeLinkedIn() before any real work so
// the operator sees clear "needs cookies" errors instead of HTTP 500s.

import { beginSend, markSent, markFailed } from './outbox.js';

function baseUrl(env) {
  return (env.LI_BASE_URL || 'http://127.0.0.1:2786').replace(/\/+$/, '');
}

function headers(env) {
  return {
    'X-API-Key':    env.LI_API_KEY || 'dev-admin-key',
    'Content-Type': 'application/json',
  };
}

// Low-level: GET with consistent error shape, ms-level timing tag for the
// activity feed.
async function call(env, method, path, body = null, { timeoutMs = 20000 } = {}) {
  const url = baseUrl(env) + path;
  // Bounded timeout so a wedged gateway (esp. the Playwright posting path) can
  // never hang the caller — it ALWAYS resolves to a result Nyo can act on.
  const init = { method, headers: headers(env), signal: AbortSignal.timeout(timeoutMs) };
  if (body !== null) init.body = JSON.stringify(body);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /abort|timeout/i.test(String(e?.message || ''));
    return {
      ok: false, http: 0, timedOut,
      error: timedOut ? `gateway timeout after ${timeoutMs}ms (Playwright path can wedge)` : `gateway unreachable: ${String(e?.message || e)}`,
      ms: Date.now() - started,
    };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON, keep raw */ }
  if (!res.ok) {
    const errMsg = json?.detail?.error || json?.error || text?.slice(0, 300) || res.statusText;
    return { ok: false, http: res.status, error: errMsg, ms };
  }
  return { ok: true, http: res.status, data: json, ms };
}


// ─── cookie mode: direct Voyager, no daemon ──────────────────────
// A fresh install has no tunneled gateway daemon. If the operator pastes
// their LinkedIn `li_at` cookie (Settings/Setup → linkedin), the worker
// talks to Voyager directly for the small read set Watch needs: profile
// headline (job_change), company lookup and open roles (open_role).
// Everything else still needs the daemon and says so.
// The daemon, when LI_BASE_URL is set, always wins — cookie mode is the
// no-daemon fallback, never a replacement.
// ponytail: Voyager endpoints + LinkedIn's tolerance of datacenter IPs can
// drift; if cookie mode starts 403/999-ing, the fix is the daemon path.

const LI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function liAtCookie(env) {
  try {
    const { resolveCredential } = await import('./gateway-config.js');
    return (await resolveCredential(env, 'LI_AT_COOKIE')) || null;
  } catch { return null; }
}

async function liCookieMode(env) {
  return !env.LI_BASE_URL && !!(await liAtCookie(env));
}

// JSESSIONID doubles as Voyager's csrf token. Minted from li_at via the
// authenticate endpoint, cached in sync_state, re-minted once on 401/403.
async function voyagerSession(env, liAt, { fresh = false } = {}) {
  if (!fresh) {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'li_jsessionid'").first().catch(() => null);
    if (row?.value) return row.value;
  }
  const r = await fetch('https://www.linkedin.com/uas/authenticate', {
    headers: { cookie: `li_at=${liAt}`, 'user-agent': LI_UA },
    signal: AbortSignal.timeout(15000),
  });
  const m = (r.headers.get('set-cookie') || '').match(/JSESSIONID="?(ajax:[^";]+)"?/);
  if (!m) throw new Error(`could not open a LinkedIn session from the li_at cookie (HTTP ${r.status}) — the cookie is likely expired. Grab a fresh li_at from linkedin.com and paste it again.`);
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('li_jsessionid', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(m[1], Date.now()).run().catch(() => {});
  return m[1];
}

async function voyagerGet(env, path, { retried = false } = {}) {
  const liAt = await liAtCookie(env);
  if (!liAt) throw new Error('no LinkedIn access — paste your li_at cookie in Settings');
  const js = await voyagerSession(env, liAt, { fresh: retried });
  const r = await fetch('https://www.linkedin.com/voyager/api' + path, {
    headers: {
      cookie: `li_at=${liAt}; JSESSIONID="${js}"`,
      'csrf-token': js,
      'user-agent': LI_UA,
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
    },
    signal: AbortSignal.timeout(20000),
  });
  if ((r.status === 401 || r.status === 403) && !retried) return voyagerGet(env, path, { retried: true });
  if (!r.ok) {
    const blocked = r.status === 999 || r.status === 403;
    throw new Error(`LinkedIn voyager HTTP ${r.status}${blocked ? ' — LinkedIn is refusing this network or the li_at cookie expired; paste a fresh cookie in Settings' : ''}`);
  }
  return r.json();
}

// Pure parsers, exported for the self-check.
export function parseDashProfile(json, public_id) {
  const inc = Array.isArray(json?.included) ? json.included : [];
  const prof = inc.find((e) => e?.publicIdentifier && e?.headline !== undefined)
    || inc.find((e) => e?.headline !== undefined) || null;
  if (!prof) return { ok: false, error: 'profile not in response' };
  return {
    ok: true,
    public_id: prof.publicIdentifier || public_id,
    name: [prof.firstName, prof.lastName].filter(Boolean).join(' ') || null,
    headline: prof.headline || null,
    urn_id: (String(prof.entityUrn || '').match(/urn:li:fsd_profile:([^,)]+)/) || [])[1] || null,
  };
}

export function parseDashCompany(json, universal_name) {
  const inc = Array.isArray(json?.included) ? json.included : [];
  const org = inc.find((e) => String(e?.entityUrn || '').includes('company') && (e?.name || e?.universalName)) || null;
  if (!org) return null;
  const id = (String(org.entityUrn || '').match(/company:(\d+)/) || [])[1] || null;
  return { company_id: id, name: org.name || null, universal_name: org.universalName || universal_name, staff_count: org.staffCount ?? null };
}

export function parseJobCards(json, company_id) {
  const inc = Array.isArray(json?.included) ? json.included : [];
  const positions = [];
  for (const e of inc) {
    if (!String(e?.entityUrn || '').includes('jobPosting:') || !e?.title) continue;
    const id = (String(e.entityUrn).match(/jobPosting:(\d+)/) || [])[1] || null;
    positions.push({
      title: typeof e.title === 'string' ? e.title : (e.title?.text || null),
      location: e.formattedLocation || e.secondaryDescription?.text || null,
      url: id ? `https://www.linkedin.com/jobs/view/${id}/` : null,
      posted_at: e.listedAt ? new Date(e.listedAt).toISOString() : null,
    });
  }
  return { positions, count: positions.length, company_id };
}

async function cookieProfileLookup(env, public_id) {
  const j = await voyagerGet(env, `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(public_id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16`);
  const out = parseDashProfile(j, public_id);
  if (!out.ok) throw new Error(out.error || 'profile lookup failed');
  return out;
}

async function cookieCompany(env, universalName) {
  const j = await voyagerGet(env, `/organization/companies?q=universalName&universalName=${encodeURIComponent(universalName)}`);
  const out = parseDashCompany(j, universalName);
  if (!out) throw new Error(`company "${universalName}" not found`);
  return out;
}

async function cookieCompanyJobs(env, companyId) {
  const q = `(origin:JOB_SEARCH_PAGE_QUERY_EXPANSION,locationUnion:(geoId:92000000),selectedFilters:(company:List(${encodeURIComponent(companyId)})),spellCorrectionEnabled:true)`;
  const j = await voyagerGet(env, `/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-174&count=25&q=jobSearch&query=${q}&start=0`);
  return parseJobCards(j, companyId);
}

async function cookieProbe(env) {
  const liAt = await liAtCookie(env);
  if (!liAt) return { mode: 'cookie', reachable: false, ready: false, cookies_loaded: false, error: 'no li_at cookie configured' };
  try {
    await voyagerSession(env, liAt, { fresh: true });
    return { mode: 'cookie', reachable: true, ready: true, cookies_loaded: true, error: null };
  } catch (e) {
    return { mode: 'cookie', reachable: true, ready: false, cookies_loaded: true, error: String(e?.message || e) };
  }
}

// ─── probe + session prime ───────────────────────────────────────

export async function probeLinkedIn(env) {
  if (await liCookieMode(env)) return cookieProbe(env);
  const url = baseUrl(env);
  const key = !!env.LI_API_KEY;
  const health = await call(env, 'GET', '/api/health');
  if (!health.ok) {
    return { url, api_key_configured: key, reachable: false, http: health.http, ready: false, cookies_loaded: false, profile: null, error: health.error };
  }
  const sess = await call(env, 'GET', '/api/session');
  return {
    url,
    api_key_configured: key,
    reachable: true,
    http: sess.http,
    cookies_loaded: !!sess.data?.cookies_loaded,
    cookie_age_seconds: sess.data?.cookie_age_seconds ?? null,
    ready: !!sess.data?.ready,
    profile: sess.data?.profile || null,
    error: sess.ok ? null : sess.error,
  };
}

export async function setLinkedInCookies(env, { li_at, JSESSIONID, user_agent = null }) {
  if (!li_at || !JSESSIONID) throw new Error('li_at + JSESSIONID required');
  const r = await call(env, 'POST', '/api/session/cookies', { li_at, JSESSIONID, user_agent });
  if (!r.ok) throw new Error(r.error || `gateway ${r.http}`);
  return r.data;
}

// If the gateway has cookies but
// reports `ready=false`, surface that to the caller cleanly. Nothing to
// auto-fix here — the operator must re-capture cookies.
async function ensureReady(env) {
  const p = await probeLinkedIn(env);
  if (!p.reachable) throw new Error(`linkedin gateway unreachable at ${p.url}: ${p.error || ''}`);
  if (!p.cookies_loaded) throw new Error('no linkedin cookies — POST /api/li/cookies first (see linkedin-endpoints doc)');
  if (!p.ready) throw new Error(`linkedin session not ready: ${p.error || 'voyager rejected cookies — likely expired'}`);
  return p;
}

// ─── voyager reads ────────────────────────────────────────────────

export async function getMyProfile(env) {
  await ensureReady(env);
  const r = await call(env, 'GET', '/api/me');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// All PENDING sent connection invitations. The funnel diffs our recorded
// invitation urns against this list — one of ours no longer pending means the
// invite was accepted (or withdrawn by hand). No per-profile lookups (dead).
export async function listSentInvitations(env) {
  await ensureReady(env);
  const r = await call(env, 'GET', '/api/invitations/sent');
  if (!r.ok) throw new Error(r.error);
  if (r.data && r.data.ok === false) throw new Error(r.data.error || 'invitation list failed');
  return r.data;
}

export async function getProfile(env, public_id) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/profile/${encodeURIComponent(public_id)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Profile by public slug via the daemon's MODERN dash lookup — the legacy
// /api/profile above is HTTP-410-dead underneath. Powers add-by-URL intake:
// /in/<slug>/ → { ok, urn_id, public_id, name, headline, distance }.
export async function getProfileDash(env, public_id) {
  if (await liCookieMode(env)) return cookieProfileLookup(env, public_id);
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/profile-dash/${encodeURIComponent(public_id)}`);
  if (!r.ok) throw new Error(r.error);
  if (r.data && r.data.ok === false) throw new Error(r.data.error || 'profile lookup failed');
  return r.data;
}

// A person's recent posts over time (daemon normalizes the voyager shapes).
// Pass the STORED urn id (ACoAA...) when you have one — a slug costs the
// daemon an extra dash lookup to resolve.
export async function getProfilePosts(env, id, count = 10) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/profile/${encodeURIComponent(id)}/posts?count=${Number(count) || 10}`);
  if (!r.ok) throw new Error(r.error);
  if (r.data && r.data.ok === false) throw new Error(r.data.error || 'posts fetch failed');
  return r.data;
}

export async function commentOnPost(env, urn, text) {
  await ensureReady(env);
  // The daemon's throttle gate SLEEPS to enforce its per-class interval, so a
  // queued comment can legitimately take longer than the 20s default before
  // the request is even sent. Give it room instead of surfacing a timeout.
  const r = await call(env, 'POST', '/api/posts/comment', { urn, text }, { timeoutMs: 60000 });
  if (!r.ok) throw new Error(r.error);
  if (r.data && r.data.ok === false) throw new Error(r.data.error || 'comment failed');
  return r.data;
}


export async function getFeed(env, { count = 20 } = {}) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/feed?count=${count}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Company profile + numeric LinkedIn id by universal name (slug). One throttled
// Voyager read — the GTM module caches the id on the lead so it never repeats.
export async function getLiCompany(env, universalName) {
  if (await liCookieMode(env)) return cookieCompany(env, universalName);
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/company/${encodeURIComponent(universalName)}`);
  if (!r.ok) throw new Error(r.error);
  return r.data; // { company_id, name, universal_name, staff_count, url }
}

// Open roles via the gateway's public guest-jobs passthrough (no session cookie;
// runs from the gateway's residential IP because datacenter IPs get blocked).
export async function getLiCompanyJobs(env, companyId) {
  if (await liCookieMode(env)) return cookieCompanyJobs(env, companyId);
  const r = await call(env, 'GET', `/api/company/${encodeURIComponent(companyId)}/jobs`);
  if (!r.ok) throw new Error(r.error);
  return r.data; // { positions: [{title,location,url,posted_at}], count, company_id }
}

// Confirm a freshly-published post is actually LIVE by reading it back from the
// feed via Voyager (the reliable API path). post_linkedin_text drives Playwright
// and can report success while silently failing — or error while actually
// having posted — so we never trust it blind; we verify against the feed.
async function verifyPostLive(env, body) {
  try {
    const feed = await call(env, 'GET', '/api/feed?count=25', null, { timeoutMs: 15000 });
    if (!feed.ok) return { found: false, url: null };
    const d = feed.data;
    const items = d?.items || d?.posts || d?.elements || (Array.isArray(d) ? d : []);
    const needle = String(body).trim().slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
    if (needle.length < 12) return { found: false, url: null };
    for (const it of (Array.isArray(items) ? items : [])) {
      const hay = JSON.stringify(it).toLowerCase().replace(/\s+/g, ' ');
      if (hay.includes(needle)) {
        return { found: true, url: it.url || it.permalink || it.post_url || it.share_url || null };
      }
    }
    return { found: false, url: null };
  } catch { return { found: false, url: null }; }
}

export async function listConversations(env, { limit = 25 } = {}) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/conversations?limit=${limit}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function getConversationMessages(env, conversation_urn, { limit = 25 } = {}) {
  await ensureReady(env);
  const r = await call(env, 'GET', `/api/conversations/${encodeURIComponent(conversation_urn)}/messages?limit=${limit}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Messages the operator SENT since since_ms (ms epoch) — the outreach-KPI feed
// for manual LinkedIn DMs the engine never recorded. Returns { ok, messages, count }.
export async function getSentMessages(env, { since_ms, max_convos = 20 } = {}) {
  await ensureReady(env);
  // Slow read: the daemon makes one LinkedIn round-trip per active conversation,
  // so give it generous headroom (well past the default 20s).
  const r = await call(env, 'GET', `/api/sent-messages?since_ms=${Number(since_ms) || 0}&max_convos=${max_convos}`, null, { timeoutMs: 120000 });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function searchPeople(env, { keywords, limit = 10 }) {
  if (!keywords) throw new Error('keywords required');
  await ensureReady(env);
  const r = await call(env, 'POST', '/api/search/people', { keywords, limit });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// ─── voyager writes ──────────────────────────────────────────────

export async function sendDirectMessage(env, { profile_urn_id, body, client_token = null }, opts = {}) {
  if (!profile_urn_id || !body) throw new Error('profile_urn_id + body required');
  const log = await beginSend(env, {
    channel: 'li', kind: 'text', to_id: profile_urn_id, body,
    payload: { profile_urn_id },
    source:     opts.source     || 'operator',
    source_ref: opts.source_ref || null,
    parent_id:  opts.parent_id  || null,
    attempt:    opts.attempt    || 1,
  });
  try {
    await ensureReady(env);
    // 60s, not the 20s default: the gateway's message throttle sleeps up to
    // ~21s (15s interval + jitter) for LinkedIn-safe spacing BEFORE the send.
    // A 20s client timeout aborted mid-spacing, and on a multi-bubble message
    // that stranded a partial send (some bubbles delivered, then a timeout).
    //
    // client_token (optional, e.g. the engine's prospect:step key) makes the
    // send idempotent at the gateway: a retry after an ambiguous timeout maps
    // to the same LinkedIn originToken and collapses into the first delivery
    // instead of double-messaging the person.
    const r = await call(env, 'POST', '/api/messages/send', { profile_urn_id, body, client_token }, { timeoutMs: 60000 });
    if (!r.ok) throw new Error(r.error);
    // HTTP 200 is NOT proof of delivery — Voyager returns { ok:false } when
    // LinkedIn rejected the send. Trusting only r.ok logged failed sends as
    // "sent" (caught live: a DM that never arrived showed sent). Treat a
    // business-level ok:false as a real failure so it logs failed + retries.
    // Propagate the gateway's REAL reason — the failure classifier keys off it
    // (e.g. "not connected" vs a hard rejection). A generic message here made
    // every business failure look identical downstream.
    if (r.data && r.data.ok === false) throw new Error(r.data.error || 'LinkedIn did not accept the message (gateway ok:false) — not delivered');
    await markSent(env, log.id, { message_id: r.data?.id || r.data?.urn || null });
    return { ...(r.data || {}), outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

// Alias used by outbox retry — keeps the public surface stable while we
// settle on a single name across channels.
export const sendLinkedInMessage = sendDirectMessage;

export async function sendConnectionRequest(env, { profile_urn_id, note = null, profile_urn = null }, opts = {}) {
  if (!profile_urn_id) throw new Error('profile_urn_id required');
  // Log to the Outbox like DMs do, so EVERY LinkedIn send (connect + message)
  // is in the unified audit trail with sent/failed + retry.
  const log = await beginSend(env, {
    channel: 'li', kind: 'connect', to_id: profile_urn_id, body: note || '(no note)',
    payload: { profile_urn_id, note },
    source: opts.source || 'operator', source_ref: opts.source_ref || null,
  });
  try {
    await ensureReady(env);
    // Forward profile_urn (the member urn from intake) so the gateway skips the
    // now-dead (HTTP 410) profile lookup that add_connection would otherwise do.
    const r = await call(env, 'POST', '/api/connections/request', { profile_urn_id, note, profile_urn });
    if (!r.ok) throw new Error(r.error);
    // Same guard as DMs: don't call a request "sent" if the gateway reports a
    // business-level failure. (The connect endpoint currently always returns
    // ok:true, so it can't yet detect a silently-rejected request — surfacing
    // that real result is a gateway-side follow-up.)
    // Propagate the gateway's REAL reason — the failure classifier keys off it
    // ("no invitation"/"already"/"CANT_RESEND" → already_invited, not a retry).
    if (r.data && r.data.ok === false) throw new Error(r.data.error || 'LinkedIn did not accept the connection request (gateway ok:false)');
    await markSent(env, log.id, { message_id: r.data?.id || r.data?.urn || null });
    return { ...(r.data || {}), outbox_id: log.id };
  } catch (e) {
    await markFailed(env, log.id, e);
    throw e;
  }
}

// ─── Playwright writes ──────────────────────────────────────────

export async function postText(env, { body, visibility = 'ANYONE' }, opts = {}) {
  if (!body || !body.trim()) throw new Error('body required');
  await ensureReady(env);

  // Log the attempt to the Outbox so "did it post?" is answerable from the
  // record, not from memory.
  const log = await beginSend(env, {
    channel: 'li', kind: 'post', to_id: 'feed', to_name: 'LinkedIn feed',
    body, payload: { visibility },
    source: opts.source || 'nyo', source_ref: opts.source_ref || null,
  });

  // Playwright path — slow + can wedge. Bounded at 60s so it always returns,
  // then CONFIRM via the reliable Voyager feed whether the post is actually live.
  const r = await call(env, 'POST', '/api/posts/text', { body, visibility }, { timeoutMs: 60000 });
  const verify = await verifyPostLive(env, body);

  const posted   = r.ok || verify.found;   // live if the gateway said ok OR we see it in the feed
  const verified = verify.found;           // we actually read it back
  const post_url = verify.url || r.data?.url || null;

  if (posted) {
    await markSent(env, log.id, { message_id: post_url || null });
    return {
      ok: true, posted: true, verified, post_url, outbox_id: log.id,
      note: verified
        ? 'Confirmed live — read back from the feed.'
        : (r.ok
            ? 'Gateway reported success but the post is NOT yet visible in the feed. Treat as PENDING — do not claim it is live until confirmed.'
            : 'Gateway errored but the post appears in the feed. Verify the link before relying on it.'),
    };
  }

  // Genuine failure: errored/timed out AND not visible in the feed.
  const errMsg = r.error || 'post failed';
  await markFailed(env, log.id, new Error(errMsg));
  return { ok: false, posted: false, verified: false, timedOut: !!r.timedOut, error: errMsg, outbox_id: log.id };
}

export async function reactToPost(env, { post_url, reaction = 'LIKE' }) {
  if (!post_url) throw new Error('post_url required');
  await ensureReady(env);
  // same throttle-sleep consideration as commentOnPost (react interval is 10s,
  // but a burst of likes queues behind it)
  const r = await call(env, 'POST', '/api/posts/react', { post_url, reaction }, { timeoutMs: 45000 });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
