// LLM credit circuit-breaker.
//
// "Our LM" = the primary reasoning provider (Anthropic — Nyo mid/high, the
// digest, GTM angles, AEO). When it runs OUT OF CREDIT (HTTP 400 "credit balance
// is too low" / 402) or REJECTS THE KEY (401/403), we OPEN a circuit:
//   • the operator is alerted once — the sidebar health dot + a Nyo message;
//   • chat + LIGHT jobs (digest extraction, OSINT/ICP scoring, company lookups)
//     fall back to the local Qwen so work continues;
//   • HEAVY writers (AEO articles, GTM outreach angles) PAUSE — a 3B model would
//     produce weak output — with a clear reason instead of a raw error.
// Every real call re-probes Anthropic; the circuit CLOSES (with a recovery
// message) the moment it answers again. Rate-limit (429) and 5xx are transient
// (already retried upstream) and never open the circuit.

import { logEvent, queueNyoMessage } from './db.js';

const PROBE_AFTER_MS = 3 * 60 * 1000; // when down, skip Anthropic for this long, then re-probe

export class LlmDownError extends Error {
  constructor(msg) {
    super(msg || 'The main model is out of credit — heavy generation is paused until it is topped up.');
    this.name = 'LlmDownError';
    this.llmDown = true;
  }
}

// Classify an Anthropic/OpenAI HTTP failure → what opens the circuit.
// Only a genuine credit-out / key-rejection counts; 429 rate-limits and 5xx are
// transient (fetchLLM retries them) and return null.
export function classifyLlmError(status, bodyText = '') {
  const t = String(bodyText || '').toLowerCase();
  if (status === 402) return 'credit';
  if (status === 400 && /credit balance is too low|billing|insufficient|payment/.test(t)) return 'credit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 && /credit|billing|hard limit|monthly limit/.test(t)) return 'credit';
  return null;
}

export async function getLlmHealth(env) {
  try {
    const r = await env.DB.prepare('SELECT status, reason, since, last_error, last_check FROM llm_health WHERE id = ?').bind('primary').first();
    return r || { status: 'ok', reason: null, since: null, last_error: null, last_check: null };
  } catch {
    return { status: 'ok', reason: null, since: null, last_error: null, last_check: null };
  }
}

async function write(env, { status, reason, since, last_error }) {
  const t = Date.now();
  await env.DB.prepare(
    `INSERT INTO llm_health (id, status, reason, since, last_error, last_check, updated_at)
     VALUES ('primary', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, reason=excluded.reason, since=excluded.since,
       last_error=excluded.last_error, last_check=excluded.last_check, updated_at=excluded.updated_at`,
  ).bind(status, reason ?? null, since ?? null, last_error ?? null, t, t).run();
}

// Record a credit/auth failure. Opens the circuit + alerts the operator ONCE on
// the ok→down transition (Nyo message + event). Safe to call on every failure.
export async function noteLlmDown(env, reason, lastError) {
  const cur = await getLlmHealth(env);
  const firstTime = cur.status !== 'down';
  await write(env, { status: 'down', reason, since: firstTime ? Date.now() : cur.since, last_error: String(lastError || '').slice(0, 300) });
  if (firstTime) {
    try {
      await logEvent(env, { kind: 'llm_down', actor: 'system', payload: { reason, last_error: String(lastError || '').slice(0, 200) } });
      await queueNyoMessage(env, {
        kind: 'llm_down',
        content: `⚠️ **The main model (Anthropic) is ${reason === 'credit' ? 'out of credit' : 'rejecting the API key'}.**\n\n`
          + `**Chat and light jobs are paused** until it's fixed.\n\n`
          + (env.HF_TOKEN
              ? `The **heavy writers** (AEO articles, GTM outreach, digest synthesis) are running on the **Hugging Face fallback writer** — prose quality stays close, tool-heavy work does not run there.\n\n`
              : `The **heavy writers are paused**: AEO articles and GTM outreach won't run until it's back (a 3B model would write poorly there).\n\n`)
          + (reason === 'credit' ? `Top up the Anthropic credit` : `Fix the ANTHROPIC_API_KEY`) + ` and I'll switch back automatically — I'll tell you when.`,
        payload: { reason },
      });
    } catch { /* alerting is best-effort; never block the fallback */ }
  }
}

// Record a success. Closes the circuit + a recovery message ONCE on down→ok.
export async function noteLlmOk(env) {
  const cur = await getLlmHealth(env);
  if (cur.status === 'ok') return; // already healthy — no write, no spam
  await write(env, { status: 'ok', reason: null, since: null, last_error: null });
  try {
    await logEvent(env, { kind: 'llm_recovered', actor: 'system', payload: { down_since: cur.since } });
    await queueNyoMessage(env, {
      kind: 'llm_recovered',
      content: `✅ **The main model is back.** Chat + jobs are back on Anthropic, and the heavy writers (AEO, GTM outreach) are live again.`,
      payload: {},
    });
  } catch { /* best-effort */ }
}

// When the circuit is down and freshly probed, skip Anthropic entirely (don't
// hammer a dead endpoint on every call) — but re-probe after PROBE_AFTER_MS so
// recovery is automatic.
export async function skipPrimary(env) {
  const h = await getLlmHealth(env);
  if (h.status !== 'down') return false;
  return (Date.now() - (h.last_check || 0)) < PROBE_AFTER_MS;
}

// Preamble guard for a non-streaming Anthropic text caller. Returns
// { skip:true, text } when the HF writer covered a heavy job, throws
// LlmDownError when the circuit is down / no key, else { skip:false } to
// proceed with the real Anthropic call.
export async function guardLlm(env, { heavy = false, system, prompt, maxTokens = 2000 } = {}) {
  const noKey = !env.ANTHROPIC_API_KEY;
  if (noKey || (await skipPrimary(env))) {
    if (heavy) {
      // Heavy prose: try the HF writing fallback before pausing — an open
      // model picked for writing quality beats no article at all. Falls back
      // to the pause (LlmDownError) if HF is unconfigured or fails.
      const hf = await tryHfWriter(env, { system, prompt, maxTokens });
      if (hf != null) return { skip: true, text: hf };
    }
    // No local fallback any more (it rode a personal tunnel no install has):
    // light and heavy jobs alike pause honestly until the key/credit is fixed.
    throw new LlmDownError(noKey ? 'ANTHROPIC_API_KEY not set' : 'The main model is out of credit.');
  }
  return { skip: false };
}

// The HF writing fallback for HEAVY jobs while the circuit is open. Returns
// text, or null when unconfigured/failed (callers then pause as before).
async function tryHfWriter(env, { system, prompt, maxTokens }) {
  try {
    const { hfConfigured, hfComplete } = await import('./hf-gateway.js');
    if (!hfConfigured(env)) return null;
    return await hfComplete(env, { system, prompt, maxTokens: Math.max(maxTokens, 4000) });
  } catch (e) {
    console.error('HF writing fallback failed:', String(e?.message || e).slice(0, 200));
    return null;
  }
}

// Handle a non-ok Anthropic response for a non-streaming text caller. On a
// credit/auth error: opens the circuit, then RETURNS the local model's text
// (light) or THROWS LlmDownError (heavy). On a transient/other error: throws a
// plain Error (no circuit change) so the existing retry/surfacing still applies.
export async function handleLlmFailure(env, status, bodyText, { heavy = false, system, prompt, maxTokens = 2000 } = {}) {
  const cls = classifyLlmError(status, bodyText);
  if (cls) {
    await noteLlmDown(env, cls, `${status}: ${String(bodyText).slice(0, 200)}`);
    if (heavy) {
      const hf = await tryHfWriter(env, { system, prompt, maxTokens });
      if (hf != null) return hf;
      throw new LlmDownError(`The main model is ${cls === 'credit' ? 'out of credit' : 'rejecting the key'}.`);
    }
    return localComplete(env, { system, prompt, maxTokens });
  }
  throw new Error(`Anthropic ${status}: ${String(bodyText).slice(0, 400)}`);
}
