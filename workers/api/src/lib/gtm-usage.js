// GTM enrichment API usage tracking — PDL / SerpApi / Twilio limits, visible
// in cmd with a warning before a cap is hit.
//
// Three signal sources, merged best-first:
//   1. provider truth  — PDL reports remaining credits in response headers on
//                        every call (captured + cached); SerpApi has a free
//                        /account endpoint (checked live when the usage view is
//                        read); Twilio is pay-per-use, so its "limit" is the
//                        account balance (checked live).
//   2. our own count   — every billable call bumps gtm_api_usage for the
//                        current renewal period. Always works, even offline.
//   3. operator config — the gtm-api-limits knowledge doc holds each plan's
//                        monthly cap, renewal day, and warn threshold (editable
//                        like every other control surface).
//
// Crossing the warn threshold queues ONE Nyo message per provider per period
// (warned_at latch) — the operator hears about it without watching the meter.

import { readKnowledge, writeKnowledge, logEvent, queueNyoMessage } from './db.js';

const now = () => Date.now();
const DOC_SLUG = 'gtm-api-limits';

export const LIMITS_DEFAULTS = {
  pdl:     { monthly_limit: 100, renewal_day: 1, warn_at_pct: 80 },
  serpapi: { monthly_limit: 250, renewal_day: 1, warn_at_pct: 80 },
  twilio:  { balance_warn_usd: 5 },
};

function limitsSeedBody(cfg) {
  return `GTM enrichment API limits — plan caps for the usage meters in the GTM module.

Set each provider's real plan numbers here; the module shows used/limit, days to
renewal, and warns Nyo once per period when usage crosses \`warn_at_pct\`.
\`renewal_day\` is the day of the month the plan resets (check the provider's
billing page). Twilio has no monthly cap — it is pay-per-use, so the meter shows
the account balance and warns below \`balance_warn_usd\`.

Where the provider reports its own numbers (PDL response headers, the SerpApi
account endpoint), those override the counted estimate automatically — this doc
mainly supplies the cap, the renewal day, and the warning line.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;
}

function sanitizeLimits(src) {
  const out = JSON.parse(JSON.stringify(LIMITS_DEFAULTS));
  if (!src || typeof src !== 'object') return out;
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : null);
  for (const p of ['pdl', 'serpapi']) {
    const s = src[p] || {};
    const lim = num(s.monthly_limit, 1, 1000000); if (lim !== null) out[p].monthly_limit = lim;
    const day = num(s.renewal_day, 1, 28);        if (day !== null) out[p].renewal_day = day;
    const pct = num(s.warn_at_pct, 1, 100);       if (pct !== null) out[p].warn_at_pct = pct;
  }
  const bw = num(src.twilio?.balance_warn_usd, 0, 10000);
  if (bw !== null) out.twilio.balance_warn_usd = bw;
  return out;
}

export async function loadLimits(env) {
  try {
    const doc = await readKnowledge(env, DOC_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: DOC_SLUG, title: 'GTM · enrichment API limits',
        body: limitsSeedBody(LIMITS_DEFAULTS), parent_slug: 'module-gtm',
      }).catch(() => {});
      return { ...LIMITS_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizeLimits(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...LIMITS_DEFAULTS, source: 'defaults' };
  }
}

export async function saveLimits(env, patch = {}) {
  const cur = await loadLimits(env);
  const merged = {
    pdl:     { ...cur.pdl,     ...(patch.pdl || {}) },
    serpapi: { ...cur.serpapi, ...(patch.serpapi || {}) },
    twilio:  { ...cur.twilio,  ...(patch.twilio || {}) },
  };
  const next = sanitizeLimits(merged);
  await writeKnowledge(env, {
    slug: DOC_SLUG, title: 'GTM · enrichment API limits',
    body: limitsSeedBody(next), parent_slug: 'module-gtm',
  });
  await logEvent(env, { kind: 'gtm_api_limits_updated', payload: next });
  return { ...next, source: 'doc' };
}

// ── period math (renewal-anchored, not calendar-month) ──────────────────────

function periodAnchor(renewalDay, at = new Date()) {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const anchor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), renewalDay));
  if (d.getUTCDate() < renewalDay) anchor.setUTCMonth(anchor.getUTCMonth() - 1);
  return anchor.toISOString().slice(0, 10);
}

function daysToRenewal(renewalDay, at = new Date()) {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), renewalDay));
  if (at.getUTCDate() >= renewalDay) next.setUTCMonth(next.getUTCMonth() + 1);
  return Math.max(0, Math.ceil((next.getTime() - at.getTime()) / 86400000));
}

// ── counting + provider-truth capture (called from the enrich clients) ──────

// Bump the billable-call counter for a provider, and fire the once-per-period
// Nyo warning when usage crosses the configured threshold. Never throws — a
// tracking failure must not fail an enrichment.
export async function bumpUsage(env, provider) {
  try {
    const limits = await loadLimits(env);
    const cfg = limits[provider];
    if (!cfg) return;
    const period = periodAnchor(cfg.renewal_day || 1);
    await env.DB.prepare(
      `INSERT INTO gtm_api_usage (provider, period, used, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(provider, period) DO UPDATE SET used = used + 1, updated_at = ?`,
    ).bind(provider, period, now(), now()).run();

    if (!cfg.monthly_limit || !cfg.warn_at_pct) return;
    const row = await env.DB.prepare(
      `SELECT used, warned_at FROM gtm_api_usage WHERE provider = ? AND period = ?`,
    ).bind(provider, period).first();
    const pct = Math.round(((row?.used || 0) / cfg.monthly_limit) * 100);
    if (pct >= cfg.warn_at_pct && !row?.warned_at) {
      await env.DB.prepare(`UPDATE gtm_api_usage SET warned_at = ? WHERE provider = ? AND period = ?`)
        .bind(now(), provider, period).run();
      const days = daysToRenewal(cfg.renewal_day || 1);
      await queueNyoMessage(env, {
        content: `⚠️ GTM: ${provider.toUpperCase()} is at ${row.used}/${cfg.monthly_limit} for this period (${pct}%) — renews in ${days} day${days === 1 ? '' : 's'}. Enrichment beyond the cap will fail or bill overage; consider pausing big imports until renewal or raising the plan.`,
        kind: 'alert', ref_kind: 'gtm_api_usage', ref_id: provider,
      }).catch(() => {});
      await logEvent(env, { kind: 'gtm_api_limit_warning', payload: { provider, used: row.used, limit: cfg.monthly_limit, pct } });
    }
  } catch { /* tracking must never break enrichment */ }
}

// Cache whatever quota numbers a provider reported (PDL headers, live checks).
export async function cacheQuota(env, provider, payload) {
  try {
    await env.DB.prepare(
      `INSERT INTO gtm_api_quota (provider, payload, captured_at) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET payload = ?, captured_at = ?`,
    ).bind(provider, JSON.stringify(payload), now(), JSON.stringify(payload), now()).run();
  } catch { /* best-effort */ }
}

// Pull PDL's credit headers off a response (X-TotalLimit-*, X-RateLimit-*,
// X-LifeTime-*) into a plain object; returns null when none present.
export function pdlQuotaFromHeaders(headers) {
  const out = {};
  try {
    for (const [k, v] of headers.entries()) {
      if (/^x-.*(limit|lifetime)/i.test(k)) out[k.toLowerCase()] = v;
    }
  } catch { return null; }
  return Object.keys(out).length ? out : null;
}

// ── the merged usage view (tool + module UI) ────────────────────────────────

export async function gtmApiUsage(env) {
  const limits = await loadLimits(env);
  const usageRows = (await env.DB.prepare(`SELECT * FROM gtm_api_usage`).all()).results || [];
  const quotaRows = (await env.DB.prepare(`SELECT * FROM gtm_api_quota`).all()).results || [];
  const quota = Object.fromEntries(quotaRows.map((r) => {
    try { return [r.provider, { ...JSON.parse(r.payload), captured_at: r.captured_at }]; } catch { return [r.provider, null]; }
  }));

  const counted = (provider, renewalDay) => {
    const period = periodAnchor(renewalDay || 1);
    return usageRows.find((r) => r.provider === provider && r.period === period)?.used || 0;
  };

  const providers = [];

  // PDL — counted + cached header truth (remaining credits when reported).
  {
    const cfg = limits.pdl;
    const used = counted('pdl', cfg.renewal_day);
    const q = quota.pdl || null;
    // PDL reports remaining purchased credits in x-totallimit-remaining (or the
    // -purchased- variant); when present it overrides the counted estimate.
    const reportedRemaining = q ? Number(q['x-totallimit-remaining'] ?? q['x-totallimit-purchased-remaining']) : NaN;
    const remaining = Number.isFinite(reportedRemaining) ? reportedRemaining : Math.max(0, cfg.monthly_limit - used);
    const effUsed = Number.isFinite(reportedRemaining) ? Math.max(0, cfg.monthly_limit - reportedRemaining) : used;
    const pct = Math.min(100, Math.round((effUsed / Math.max(1, cfg.monthly_limit)) * 100));
    providers.push({
      provider: 'pdl', configured: !!env.PDL_API_KEY, used: effUsed, limit: cfg.monthly_limit, remaining, pct,
      renews_in_days: daysToRenewal(cfg.renewal_day), warn_at_pct: cfg.warn_at_pct,
      warning: pct >= cfg.warn_at_pct,
      source: Number.isFinite(reportedRemaining) ? 'provider' : 'counted',
      detail: q,
    });
  }

  // SerpApi — live /account check (free), cached on success; counted fallback.
  {
    const cfg = limits.serpapi;
    let live = null;
    if (env.SERPAPI_KEY) {
      try {
        const r = await fetch(`https://serpapi.com/account?api_key=${env.SERPAPI_KEY}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const j = await r.json();
          live = {
            searches_per_month: j.searches_per_month,
            plan_searches_left: j.plan_searches_left,
            this_month_usage: j.this_month_usage,
            extra_credits: j.extra_credits,
          };
          await cacheQuota(env, 'serpapi', live);
        }
      } catch { /* fall back below */ }
    }
    const q = live || quota.serpapi || null;
    const limit = Number.isFinite(Number(q?.searches_per_month)) ? Number(q.searches_per_month) : cfg.monthly_limit;
    const reportedLeft = Number(q?.plan_searches_left);
    const used = Number.isFinite(Number(q?.this_month_usage)) ? Number(q.this_month_usage) : counted('serpapi', cfg.renewal_day);
    const remaining = Number.isFinite(reportedLeft) ? reportedLeft : Math.max(0, limit - used);
    const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
    providers.push({
      provider: 'serpapi', configured: !!env.SERPAPI_KEY, used, limit, remaining, pct,
      renews_in_days: daysToRenewal(cfg.renewal_day), warn_at_pct: cfg.warn_at_pct,
      warning: pct >= cfg.warn_at_pct,
      source: q ? (live ? 'provider' : 'provider-cached') : 'counted',
      detail: q,
    });
  }

  // Twilio — pay-per-use: the meter is the account balance.
  {
    const cfg = limits.twilio;
    let bal = null;
    if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      try {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Balance.json`, {
          headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          bal = { balance: Number(j.balance), currency: j.currency || 'USD' };
          await cacheQuota(env, 'twilio', bal);
        }
      } catch { /* fall back below */ }
    }
    const q = bal || quota.twilio || null;
    providers.push({
      provider: 'twilio', configured: !!env.TWILIO_ACCOUNT_SID, kind: 'balance',
      balance: q?.balance ?? null, currency: q?.currency || 'USD',
      used: counted('twilio', 1), // lookups made this calendar month (informational)
      balance_warn_usd: cfg.balance_warn_usd,
      warning: q ? Number(q.balance) < cfg.balance_warn_usd : false,
      source: q ? (bal ? 'provider' : 'provider-cached') : 'counted',
      detail: q,
    });
  }

  return { now: now(), providers, limits_source: limits.source };
}
