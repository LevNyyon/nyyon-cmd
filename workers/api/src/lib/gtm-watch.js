// GTM Watch (nyyon-lite) — LinkedIn signal monitoring over operator-flagged
// gtm_leads. The operator marks leads he personally believes fit; an hourly
// bounded tick checks each watched lead's LinkedIn for two signals:
//
//   open_role   — the lead's company is hiring for a role matching the
//                 gtm-watch doc's role_patterns (via the cached company-jobs
//                 read the Enrich tab already uses)
//   job_change  — the lead's profile headline changed since the last check
//                 (first read only snapshots a baseline, never fires)
//
// A NEW signal gets a drafted WhatsApp response in the operator's voice and
// pings the OPERATOR — a Digest item and, if configured, a message to his own
// WhatsApp with a wa.me deep link that opens the lead's chat pre-filled
// (works whether or not the lead is a contact yet). NOTHING here ever
// messages a lead; the operator sends by hand. Signal ids are deterministic
// (lead|kind|finding), so re-detection is an INSERT OR IGNORE no-op and the
// same signal can never ping twice.

import { logEvent, readKnowledge, writeKnowledge } from './db.js';
import { callGateway } from '../gateways/index.js';
import { getLead, updateLead, gtmLLM } from './gtm.js';
import { gtmDoc, readYou, openRolesForLead } from './gtm-context.js';
import { insertDigestItem } from './digest.js';
import { loadModelConfig } from './model-config.js';

const now = () => Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

// ── knowledge: watch config ──────────────────────────────────────
export const WATCH_SLUG = 'gtm-watch';
const WATCH_DEFAULTS = Object.freeze({
  leads_per_tick: 6,
  check_interval_hours: 24,
  role_patterns: [
    'marketing\\s*(operations|ops)', 'revenue\\s*operations',
    'growth\\s*(operations|analyst)', 'demand\\s*gen',
    'marketing\\s*(automation|analyst)', 'business\\s*operations',
  ],
  ping_digest: true,
});

function watchSeedBody(cfg) {
  return `# GTM Watch — signal monitor config

Which LinkedIn signals arm the operator, and how hard the watcher may work.
\`role_patterns\` are case-insensitive regexes matched against the watched
lead's company job titles — a match is the "they're hiring for what Lev
replaces" signal. \`check_interval_hours\` is the per-lead re-check cadence;
\`leads_per_tick\` bounds LinkedIn reads per hourly tick. Pings land in the
Digest, each carrying a pre-filled wa.me link you send yourself.
Nothing the watcher does ever messages a lead.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`

Edit the fence — the watcher reads this doc live, no deploy needed.`;
}

const num = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

function sanitizeWatch(src) {
  const s = src && typeof src === 'object' ? src : {};
  return {
    leads_per_tick: num(s.leads_per_tick, 1, 20, WATCH_DEFAULTS.leads_per_tick),
    check_interval_hours: num(s.check_interval_hours, 1, 24 * 14, WATCH_DEFAULTS.check_interval_hours),
    role_patterns: Array.isArray(s.role_patterns) && s.role_patterns.length
      ? s.role_patterns.map((p) => String(p)).filter(Boolean)
      : [...WATCH_DEFAULTS.role_patterns],
    ping_digest: s.ping_digest !== false,
  };
}

export async function loadWatchConfig(env) {
  try {
    const doc = await readKnowledge(env, WATCH_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: WATCH_SLUG, title: 'GTM · watch config',
        body: watchSeedBody(WATCH_DEFAULTS), parent_slug: 'module-gtm',
      }).catch(() => {});
      return { ...WATCH_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizeWatch(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch { return { ...WATCH_DEFAULTS, source: 'defaults' }; }
}

function rolePatternRegexes(cfg) {
  return (cfg.role_patterns || [])
    .map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } })
    .filter(Boolean);
}

// ── signal identity: deterministic, so re-detection can't re-fire ─
function sigId(leadId, kind, key) {
  const s = `${leadId}|${kind}|${key}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `sig_${h.toString(36)}_${s.length.toString(36)}`;
}

const liSlug = (url) => (String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1] || null;

const waDigits = (phone) => String(phone || '').replace(/\D/g, '');
export function waMeLink(phone, text) {
  const d = waDigits(phone);
  if (!d) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

// ── detection ────────────────────────────────────────────────────
// Returns the NEW signals it inserted (already persisted, status 'new').
async function detectForLead(env, lead, cfg) {
  const found = [];

  // job_change: headline diff. First successful read only sets the baseline.
  const slug = liSlug(lead.linkedin);
  if (slug) {
    try {
      const prof = await callGateway(env, 'linkedin', 'profile_lookup', { public_id: slug });
      const headline = String(prof?.headline || '').trim();
      if (headline) {
        const prev = String(lead.headline_snapshot || '').trim();
        if (prev && prev !== headline) {
          found.push({
            kind: 'job_change', key: `${prev}→${headline}`,
            title: `changed role: "${headline}"`,
            detail: { old: prev, new: headline, profile: lead.linkedin },
          });
        }
        if (prev !== headline) await updateLead(env, lead.id, { headline_snapshot: headline });
      }
    } catch { /* daemon busy/cookies — next tick retries */ }
  }

  // open_role: company jobs matched against the doc's role patterns.
  // openRolesForLead already resolves + caches the LinkedIn company and
  // persists open_positions on the lead — same read the Enrich tab uses.
  if (lead.company) {
    try {
      const r = await openRolesForLead(env, lead.id);
      const pats = rolePatternRegexes(cfg);
      for (const p of r.positions || []) {
        const title = String(p?.title || '').trim();
        if (!title || !pats.some((re) => re.test(title))) continue;
        found.push({
          kind: 'open_role', key: String(p.url || `${title}|${p.location || ''}`),
          title: `hiring: ${title}`,
          detail: { role: title, url: p.url || null, location: p.location || null, posted_at: p.posted_at || null, company: lead.company },
        });
      }
    } catch { /* resolve/jobs failure — next tick retries */ }
  }

  // Persist. INSERT OR IGNORE on the deterministic id — only rows that
  // actually landed count as new.
  const fresh = [];
  const t = now();
  for (const f of found) {
    const id = sigId(lead.id, f.kind, f.key);
    try {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO gtm_signals (id, lead_id, kind, title, detail, status, detected_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?)`,
      ).bind(id, lead.id, f.kind, f.title, JSON.stringify(f.detail), t).run();
      if (res?.meta?.changes > 0) {
        fresh.push({ id, lead_id: lead.id, ...f, detected_at: t });
        await logEvent(env, { kind: 'gtm_signal_detected', actor: 'system', payload: { signal_id: id, lead_id: lead.id, kind: f.kind, title: f.title } });
      }
    } catch { /* one bad row never kills the tick */ }
  }
  await updateLead(env, lead.id, { watch_checked_at: now() });
  return fresh;
}

// ── draft: the suggested response, in the operator's voice ───────
// Grounded ONLY in the signal (RULE ZERO — invent nothing beyond it). Fails
// soft: a ping with no draft still beats a missed signal.
async function draftSignalResponse(env, lead, signal) {
  const [you, positioning, rules, mc] = await Promise.all([
    readYou(env), gtmDoc(env, 'operator-positioning'), gtmDoc(env, 'gtm-outreach'), loadModelConfig(env),
  ]);
  const system = `You draft ONE WhatsApp message ${you.name || 'the operator'} will personally send to a prospect he already believes is a good fit. The message opens (or reopens) the conversation off a real, current SIGNAL — that signal is the entire reason for reaching out now, so lead with it plainly.

HARD RULES:
- Ground every claim in the signal below. Invent NOTHING about the person or company beyond it.
- No flattery, no "I hope this finds you well", no compliments about their journey.
- One message, under 400 characters, one concrete low-pressure ask (a short call to show real deliverables).
- Write in the language this person most likely writes WhatsApp in (Hebrew for Israelis unless their name suggests otherwise). Match WhatsApp register — direct, human, no corporate tone.

Operator positioning (what he sells):
${String(positioning || '').slice(0, 1500)}

Voice and writing rules:
${String(rules || '').slice(0, 1500)}

Return STRICT JSON: {"message":"<the WhatsApp message>","angle":"<=10 words on why this works"}`;
  const prompt = `Prospect: ${lead.name || 'unknown'} — ${lead.position || '?'} at ${lead.company || '?'}
Relationship: he has their number; they may not have talked on WhatsApp yet.
SIGNAL (${signal.kind}): ${signal.title}
Detail: ${JSON.stringify(signal.detail)}`;
  try {
    // writer tier from the llm-models doc — the guardrail home for model choices
    const raw = await gtmLLM(env, { system, prompt, model: mc.writer || null, maxTokens: 600, heavy: true });
    const s = String(raw || '');
    const parsed = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    const msg = String(parsed?.message || '').trim();
    return msg ? msg.slice(0, 600) : null;
  } catch { return null; }
}

// Draft once, persist immediately — a delivery retry must never re-burn the
// writer model on a signal that already has its message.
async function ensureDraft(env, lead, sig) {
  if (sig.draft) return sig.draft;
  sig.draft = await draftSignalResponse(env, lead, sig);
  if (sig.draft) {
    await env.DB.prepare(`UPDATE gtm_signals SET draft=? WHERE id=?`).bind(sig.draft, sig.id).run().catch(() => {});
  }
  return sig.draft;
}

// ── ping: arm the operator, never the lead ───────────────────────
async function pingOperator(env, lead, signal, cfg) {
  const channels = [];
  const draft = signal.draft || null;
  const wa = draft ? waMeLink(lead.normalized_phone || lead.phone, draft) : waMeLink(lead.normalized_phone || lead.phone, '');
  const detail = signal.detail || {};

  if (cfg.ping_digest !== false) {
    try {
      await insertDigestItem(env, {
        id: `dig_${signal.id}`, kind: 'opportunity', ref_kind: 'gtm_lead', ref_id: lead.id,
        title: `${lead.name || lead.phone}: ${signal.title}`,
        summary: [
          `${lead.position || ''}${lead.position && lead.company ? ' at ' : ''}${lead.company || ''}`.trim(),
          draft ? `Draft ready:\n${draft}` : 'Draft unavailable — write one from the signal.',
        ].filter(Boolean).join('\n\n'),
        source_label: 'GTM Watch', source_url: detail.url || lead.linkedin || null,
        urgency: 1, actionable: 1,
        suggested_action: wa ? `Open ${wa} — the message is pre-filled, review and send.` : 'Send the draft on WhatsApp.',
        meta: { lead_id: lead.id, signal_id: signal.id, kind: signal.kind, wa_link: wa },
      });
      channels.push('digest');
    } catch { /* digest down ≠ signal lost; row stays 'new' for the UI */ }
  }

  // 'pinged' ONLY when a channel actually landed — a signal nobody received
  // stays 'new' and the tick retries delivery next hour (the deterministic id
  // blocks re-detection, so this status is the only delivery memory).
  if (channels.length) {
    await env.DB.prepare(
      `UPDATE gtm_signals SET status='pinged', pinged_at=? WHERE id=? AND status='new'`,
    ).bind(now(), signal.id).run().catch(() => {});
    await logEvent(env, { kind: 'gtm_signal_pinged', actor: 'system', payload: { signal_id: signal.id, lead_id: lead.id, kind: signal.kind, channels } });
  }
  return channels;
}

// ── the tick: bounded, resumable, fail-soft per lead ─────────────
export async function runWatchTick(env, { force = false } = {}) {
  const cfg = await loadWatchConfig(env);
  const cutoff = force ? now() + 1 : now() - cfg.check_interval_hours * 3600 * 1000;
  // Watchable only: every enriched lead is watch-flagged by default, but a
  // lead with neither a LinkedIn profile nor a company has nothing to check —
  // it must not burn a tick slot. It joins the rotation the moment
  // enrichment finds either.
  const due = (await env.DB.prepare(
    `SELECT * FROM gtm_leads WHERE watch = 1
       AND ((linkedin IS NOT NULL AND linkedin != '') OR (company IS NOT NULL AND company != ''))
       AND (watch_checked_at IS NULL OR watch_checked_at < ?)
     ORDER BY COALESCE(watch_checked_at, 0) ASC LIMIT ?`,
  ).bind(cutoff, cfg.leads_per_tick).all()).results || [];
  let signals = 0, pinged = 0;
  const errors = [];
  const handled = new Set();
  for (const lead of due) {
    try {
      const fresh = await detectForLead(env, lead, cfg);
      signals += fresh.length;
      for (const sig of fresh) {
        handled.add(sig.id);
        await ensureDraft(env, lead, sig);
        const ch = await pingOperator(env, lead, sig, cfg);
        if (ch.length) pinged++;
      }
    } catch (e) { errors.push({ lead_id: lead.id, error: String(e?.message || e) }); }
  }

  // Delivery retry: signals still 'new' never reached the operator (digest
  // down, WA failed/capped on a previous tick). Drafts are persisted, so a
  // retry costs only the delivery attempt. Bounded; skips this tick's rows.
  const undelivered = (await env.DB.prepare(
    `SELECT * FROM gtm_signals WHERE status='new' ORDER BY detected_at ASC LIMIT 10`,
  ).all().catch(() => ({ results: [] }))).results || [];
  for (const row of undelivered) {
    if (handled.has(row.id)) continue;
    try {
      const lead = await getLead(env, row.lead_id);
      if (!lead) continue;
      const sig = { ...row, detail: (() => { try { return JSON.parse(row.detail); } catch { return null; } })() };
      await ensureDraft(env, lead, sig);
      const ch = await pingOperator(env, lead, sig, cfg);
      if (ch.length) pinged++;
    } catch (e) { errors.push({ signal_id: row.id, error: String(e?.message || e) }); }
  }
  return { checked: due.length, signals, pinged, retried: undelivered.length || undefined, errors: errors.length ? errors : undefined };
}

// ── operator surface ─────────────────────────────────────────────
export async function setWatch(env, leadId, on) {
  if (!leadId) return { error: 'id or ids[] required' };
  const lead = await getLead(env, leadId);
  if (!lead) return { error: 'no such lead' };
  // No watchable guard: any lead may be flagged — the tick itself skips leads
  // with nothing to check, and they enter rotation once enrichment delivers.
  await updateLead(env, leadId, on
    ? { watch: 1, watch_started_at: now() }
    : { watch: 0 });
  await logEvent(env, { kind: 'gtm_watch_set', actor: 'operator', payload: { id: leadId, on: !!on, name: lead.name || null } });
  return { id: leadId, watch: !!on };
}

// Bulk flag/unflag — curation is remove-many, never add-one-by-one.
export async function setWatchMany(env, ids, on) {
  const clean = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!clean.length) return { updated: 0 };
  const t = now();
  const ph = clean.map(() => '?').join(',');
  const r = on
    ? await env.DB.prepare(`UPDATE gtm_leads SET watch=1, watch_started_at=?, updated_at=? WHERE id IN (${ph})`).bind(t, t, ...clean).run()
    : await env.DB.prepare(`UPDATE gtm_leads SET watch=0, updated_at=? WHERE id IN (${ph})`).bind(t, ...clean).run();
  const updated = r?.meta?.changes ?? 0;
  await logEvent(env, { kind: 'gtm_watch_set', actor: 'operator', payload: { bulk: true, on: !!on, n: updated, ids: clean.slice(0, 50) } });
  return { updated };
}

export async function checkLeadNow(env, leadId) {
  const lead = await getLead(env, leadId);
  if (!lead) return { error: 'no such lead' };
  const cfg = await loadWatchConfig(env);
  const fresh = await detectForLead(env, lead, cfg);
  let pinged = 0;
  for (const sig of fresh) {
    await ensureDraft(env, lead, sig);
    const ch = await pingOperator(env, lead, sig, cfg);
    if (ch.length) pinged++;
  }
  return { checked: 1, signals: fresh.length, pinged };
}

export async function markSignal(env, id, status) {
  if (!['responded', 'dismissed', 'new'].includes(status)) return { error: 'status must be responded | dismissed | new' };
  const r = await env.DB.prepare(
    `UPDATE gtm_signals SET status=?, resolved_at=? WHERE id=?`,
  ).bind(status, status === 'new' ? null : now(), id).run();
  if (!r?.meta?.changes) return { error: 'no such signal' };
  await logEvent(env, { kind: 'gtm_signal_marked', actor: 'operator', payload: { signal_id: id, status } });
  return { id, status };
}

export async function listWatchState(env) {
  const cfg = await loadWatchConfig(env);
  const leads = (await env.DB.prepare(
    `SELECT id, name, phone, normalized_phone, company, position, linkedin,
            headline_snapshot, watch_started_at, watch_checked_at, icp_fit
     FROM gtm_leads WHERE watch = 1 ORDER BY COALESCE(watch_checked_at, 0) DESC`,
  ).all()).results || [];
  const signals = ((await env.DB.prepare(
    `SELECT s.*, l.name AS lead_name, l.company AS lead_company,
            l.normalized_phone AS lead_phone
     FROM gtm_signals s LEFT JOIN gtm_leads l ON l.id = s.lead_id
     ORDER BY s.detected_at DESC LIMIT 200`,
  ).all()).results || []).map((s) => {
    let detail = null;
    try { detail = JSON.parse(s.detail); } catch { /* raw */ }
    return { ...s, detail, wa_link: s.draft ? waMeLink(s.lead_phone, s.draft) : waMeLink(s.lead_phone, '') };
  });
  return { config: cfg, leads, signals };
}
