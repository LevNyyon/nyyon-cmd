// ─── Signal priority: the reasoning layer over digest signals ────
// Every LI signal gets a 0-100 relevance score plus a stated reason, so the
// brief reads super-relevant first and general activity last. The rubric,
// the scoring prompt, and every threshold live in the `signal-priority`
// knowledge doc; the score maps onto the digest's existing urgency groups
// (high / mid / low) and the raw score + reason persist on the item's meta.
//
// Mechanical rules run BEFORE the LLM and cap the score:
// - a person with a message already queued or scheduled (wa_send_queue
//   approved/leased) is engaged: their new signals floor at scheduled_floor
// - a person messaged within recent_sent_days floors at recent_sent_floor
// The one-moment rule (digestWaSend archiving siblings) handles the moment
// itself; these floors handle every signal that arrives AFTER it.

import { logEvent, readKnowledge, writeKnowledge } from './db.js';
import { now } from './util.js';

const DOC_SLUG = 'signal-priority';

const DEFAULT_PROMPT = `You score ONE LinkedIn signal about a person for outreach relevance, 0-100, for a consultancy that builds internal AI systems for SaaS companies (the operator opens conversations off these signals).

Score bands:
- 70-100 super relevant: job change, promotion, new role, funding round, hiring for ops/marketing/sales/AI roles, an explicit pain point about internal processes, tooling, or AI adoption, or directly asking for help in the operator's domain.
- 40-69 relevant: original professional content they AUTHORED about their company, their stack, their processes, or their market; product launches; company news they announced.
- 0-39 general activity: liking or commenting on other people's posts, generic reshares, congratulation threads, anything that says "they were online" but gives no opening.

Judge the OPENING the signal creates, not the person's importance. Return STRICT JSON: {"score": <0-100>, "reason": "<one short sentence naming the opening or its absence>"}`;

const DEFAULT_FEEDBACK_PROMPT = 'You maintain a short list of durable TASTE rules describing how an operator wants LinkedIn signals prioritized for outreach. Given a signal, the scorer\'s verdict, and the operator\'s comment on that verdict, extract at most 2 NEW durable rules (what he values, what bores him, how to weigh signal kinds), merge with the existing rules, drop duplicates and one-off gripes, keep under {max} rules, each short and imperative. Return STRICT JSON: {"rules":["..."]}';

const DEFAULTS = {
  prompt: DEFAULT_PROMPT,
  urgency_thresholds: { high: 70, mid: 40 },
  scheduled_floor: 15,
  recent_sent_days: 14,
  recent_sent_floor: 25,
  batch_limit: 10,
  taste_rules: [],
  max_taste_rules: 20,
  feedback_prompt: DEFAULT_FEEDBACK_PROMPT,
  // '✓ acted' on a card mutes that person's signals for this long
  snooze_days: 7,
};

const seedBody = (cfg = DEFAULTS) => `# Signal priority

The reasoning rubric behind digest signal ordering: every LI signal is
scored 0-100 for the OPENING it creates, with a one-line reason, and the
score maps to the brief's urgency groups. Mechanical floors: someone with a
message already queued (scheduled_floor) or recently messaged
(recent_sent_floor within recent_sent_days) is engaged, so their new
signals sink regardless of content. taste_rules grow from the operator's
comments on scores (the chip's comment box) and bind every future score.
Edit anything here; no deploy needed.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;

export async function signalPriorityCfg(env) {
  let doc = await readKnowledge(env, DOC_SLUG);
  if (!doc) {
    await writeKnowledge(env, {
      slug: DOC_SLUG, title: 'Signal priority', body: seedBody(),
      scope: 'global', module: 'digest', parent_slug: 'module-digest',
    }).catch(() => {});
    doc = { body: seedBody() };
  }
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const parsed = m ? JSON.parse(m[1]) : null;
    if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed };
  } catch { /* malformed edit must not break scoring — defaults win */ }
  return DEFAULTS;
}

// The mechanical engagement facts for one person (no LLM): a queued or
// scheduled message on ANY surface, or a send within recent_sent_days.
// The engagement floors rode the send queue + scheduled-messages tables that
// left with the outreach machinery; nothing writes them, so the floors never
// fire. Kept as a stub so scoring stays shaped for a future send channel.
async function engagementFor() { return null; }

// Score ONE digest li_signal item: mechanical floors + the llm rubric.
// Persists meta.priority / meta.priority_reason, remaps the item's urgency,
// logs signal_scored. Idempotent: rescoring overwrites.
export async function scoreSignalItem(env, id) {
  const cfg = await signalPriorityCfg(env);
  const item = await env.DB.prepare(
    "SELECT id, kind, title, urgency, meta_json FROM digest_items WHERE id = ? AND kind = 'li_signal'",
  ).bind(id).first();
  if (!item) return { ok: false, error: 'li_signal item not found' };
  let meta = {};
  try { meta = JSON.parse(item.meta_json || '{}'); } catch { meta = {}; }

  // mechanical engagement facts
  const engaged = await engagementFor(env, cfg, meta);

  // the reasoning pass
  const { callGateway } = await import('../gateways/index.js');
  const taste = Array.isArray(cfg.taste_rules) && cfg.taste_rules.length
    ? `\n\nOPERATOR TASTE, learned from his feedback. Weigh these over the generic bands:\n${cfg.taste_rules.map((r) => '- ' + r).join('\n')}`
    : '';
  const raw = await callGateway(env, 'llm', 'text', {
    system: cfg.prompt + taste,
    prompt: `Person: ${meta.name || '?'}${meta.role ? ` (${meta.role})` : ''} at ${meta.company || '?'}
Signal: ${item.title}
Detail: ${JSON.stringify(meta.detail || meta || {}).slice(0, 600)}`,
    max_tokens: 300,
  });
  const s = String(raw || '');
  let score = 50, reason = 'unscored';
  try {
    const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    score = Math.max(0, Math.min(100, Number(j.score) || 0));
    reason = String(j.reason || '').slice(0, 240) || 'no reason given';
  } catch { return { ok: false, error: 'scorer returned no parseable verdict' }; }

  if (engaged && score > engaged.floor) {
    score = engaged.floor;
    reason = `${engaged.why}; ` + reason;
  }

  const th = cfg.urgency_thresholds || DEFAULTS.urgency_thresholds;
  const urgency = score >= (Number(th.high) || 70) ? 1 : score >= (Number(th.mid) || 40) ? 2 : 3;

  meta.priority = score;
  meta.priority_reason = reason;
  meta.priority_at = now();
  if (engaged) meta.contacted = { why: engaged.why, at: now() };
  else delete meta.contacted;
  await env.DB.prepare('UPDATE digest_items SET urgency = ?, meta_json = ? WHERE id = ?')
    .bind(urgency, JSON.stringify(meta), id).run();
  await logEvent(env, {
    kind: 'signal_scored', actor: 'system',
    payload: { id, score, urgency, engaged: !!engaged },
  });
  return { ok: true, id, score, urgency, reason };
}

// Score every unread, unscored li_signal (bounded per run by batch_limit).
// Safe to call spuriously; already-scored items are skipped.
export async function sweepSignalPriorities(env, { limit } = {}) {
  const cfg = await signalPriorityCfg(env);
  const cap = Math.max(1, Math.min(25, Number(limit) || Number(cfg.batch_limit) || 10));
  // Unscored selected in SQL, so no recency window can strand old signals:
  // every unread signal is eventually scored, newest first.
  const rows = (await env.DB.prepare(
    `SELECT id FROM digest_items
     WHERE kind = 'li_signal' AND read_at IS NULL
       AND json_extract(meta_json, '$.priority_at') IS NULL
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(cap).all()).results || [];
  const pending = rows;
  const out = [];
  for (const r of pending) {
    out.push(await scoreSignalItem(env, r.id).catch((e) => ({ ok: false, id: r.id, error: String(e?.message || e) })));
  }
  const scored = out.filter((x) => x.ok).length;
  if (scored) await logEvent(env, { kind: 'signals_prioritized', actor: 'system', payload: { scored, of: pending.length } });
  return { ok: true, scored, pending: pending.length, results: out };
}

// Operator comment on a score → durable taste rules → immediate rescore.
// The comment is the teaching signal: it distills into the doc's
// taste_rules (bounded), then the same signal is rescored under the
// updated rubric so the operator sees the effect at once.
export async function distillPriorityFeedback(env, id, comment) {
  const text = String(comment || '').trim();
  if (!text) return { ok: false, error: 'comment required' };
  const cfg = await signalPriorityCfg(env);
  const item = await env.DB.prepare(
    "SELECT id, title, meta_json FROM digest_items WHERE id = ? AND kind = 'li_signal'",
  ).bind(id).first();
  if (!item) return { ok: false, error: 'li_signal item not found' };
  let meta = {};
  try { meta = JSON.parse(item.meta_json || '{}'); } catch { meta = {}; }

  const { callGateway } = await import('../gateways/index.js');
  const raw = await callGateway(env, 'llm', 'text', {
    system: (cfg.feedback_prompt || DEFAULT_FEEDBACK_PROMPT).replace('{max}', String(cfg.max_taste_rules || 20)),
    prompt: `EXISTING RULES:\n${JSON.stringify(cfg.taste_rules || [])}\n\nSIGNAL: ${item.title}\nPerson: ${meta.name || '?'} (${meta.role || '?'}) at ${meta.company || '?'}\nSCORER'S VERDICT: P${meta.priority ?? '?'} — ${meta.priority_reason || '?'}\n\nOPERATOR'S COMMENT:\n"${text.slice(0, 600)}"`,
    max_tokens: 600,
  });
  const sRaw = String(raw || '');
  let rules;
  try {
    const j = JSON.parse(sRaw.slice(sRaw.indexOf('{'), sRaw.lastIndexOf('}') + 1));
    rules = (Array.isArray(j.rules) ? j.rules : []).filter((r) => typeof r === 'string' && r.trim())
      .slice(0, Number(cfg.max_taste_rules) || 20);
  } catch { return { ok: false, error: 'feedback distiller returned no parseable rules' }; }

  const next = { ...cfg, taste_rules: rules };
  await writeKnowledge(env, {
    slug: DOC_SLUG, title: 'Signal priority', body: seedBody(next),
    scope: 'global', module: 'digest', parent_slug: 'module-digest',
  });
  await logEvent(env, {
    kind: 'signal_feedback', actor: 'operator',
    payload: { id, comment: text.slice(0, 240), rules: rules.length },
  });
  const rescored = await scoreSignalItem(env, id);
  return { ok: true, rules: rules.length, rescored };
}

// Refresh the 'contacted' chip on every unread signal card, purely from the
// mechanical engagement facts (no LLM). Cheap enough to run with every
// sweep and digest generation, so the chip never lies for long.
export async function refreshContactedFlags(env) {
  const cfg = await signalPriorityCfg(env);
  const rows = (await env.DB.prepare(
    "SELECT id, meta_json FROM digest_items WHERE kind = 'li_signal' AND read_at IS NULL",
  ).all()).results || [];
  let changed = 0;
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta_json || '{}'); } catch { continue; }
    const engaged = await engagementFor(env, cfg, meta);
    const had = !!meta.contacted;
    if (!!engaged === had) continue;
    if (engaged) meta.contacted = { why: engaged.why, at: now() };
    else delete meta.contacted;
    await env.DB.prepare('UPDATE digest_items SET meta_json = ? WHERE id = ?')
      .bind(JSON.stringify(meta), r.id).run();
    changed++;
  }
  if (changed) await logEvent(env, { kind: 'signal_contacted_flags', actor: 'system', payload: { changed } });
  return { ok: true, changed, checked: rows.length };
}

// ── "I acted on this lead": snooze their signals ────────────────
// Keys are loose because a signal may carry a prospect id, a phone, or only
// a name; any of the three matching an active row mutes the person.
export function snoozeKeys({ prospect_id = null, phone = null, name = null } = {}) {
  const keys = [];
  if (prospect_id) keys.push('prospect:' + prospect_id);
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits) keys.push('phone:' + digits);
  const nm = String(name || '').trim().toLowerCase();
  if (nm) keys.push('name:' + nm);
  return keys;
}

// Is this person muted right now? (Legacy: nothing sets a future `until`
// since the ✓ stopped muting — kept so old rows expire gracefully.)
export async function isSnoozed(env, who) {
  const keys = snoozeKeys(who);
  if (!keys.length) return null;
  const row = await env.DB.prepare(
    `SELECT key, until FROM signal_snoozes WHERE until > ? AND key IN (${keys.map(() => '?').join(',')}) ORDER BY until DESC LIMIT 1`,
  ).bind(now(), ...keys).first().catch(() => null);
  return row || null;
}

// Tick the card's ✓: "I engaged with them on LinkedIn". It COUNTS the
// engagement (feeding lead heat) and clears this one card — it does NOT
// mute the person: their future signals keep flowing, because engaging
// with someone is a reason to keep watching them, not to go quiet.
export async function actOnSignal(env, id) {
  const item = await env.DB.prepare(
    "SELECT id, meta_json FROM digest_items WHERE id = ? AND kind = 'li_signal'",
  ).bind(id).first();
  if (!item) return { ok: false, error: 'li_signal item not found' };
  let meta = {};
  try { meta = JSON.parse(item.meta_json || '{}'); } catch { meta = {}; }

  const who = { prospect_id: meta.prospect_id || null, phone: meta.phone || null, name: meta.name || null };
  const keys = snoozeKeys(who);
  if (!keys.length) return { ok: false, error: 'nothing identifies this person' };
  // The engagement record lead-heat reads. `until` is set in the past so the
  // row never mutes anyone — the table now carries engagement, not silence.
  for (const key of keys) {
    await env.DB.prepare(
      `INSERT INTO signal_snoozes (key, until, label, reason, created_at, engaged_count, last_engaged_at)
       VALUES (?, 0, ?, 'engaged on LinkedIn', ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         label = excluded.label,
         engaged_count = signal_snoozes.engaged_count + 1,
         last_engaged_at = excluded.last_engaged_at`,
    ).bind(key, meta.name || null, now(), now()).run();
  }

  // only THIS card leaves the brief; their other signals stay live
  await env.DB.prepare('UPDATE digest_items SET read_at = ? WHERE id = ?').bind(now(), id).run();

  const eng = await env.DB.prepare(
    `SELECT MAX(engaged_count) n FROM signal_snoozes WHERE key IN (${keys.map(() => '?').join(',')})`,
  ).bind(...keys).first().catch(() => null);
  await logEvent(env, {
    kind: 'signal_engaged', actor: 'operator',
    payload: { id, name: meta.name || null, engaged_count: eng?.n || 1 },
  });
  return { ok: true, engaged_count: eng?.n || 1 };
}

// Explicit "snooze for a week": the operator wants this person quiet for a
// while. Separate from the ✓ (which counts engagement and keeps them
// flowing) because muting is a different intent, not a side effect.
export async function snoozePerson(env, id) {
  const cfg = await signalPriorityCfg(env);
  const item = await env.DB.prepare(
    "SELECT id, meta_json FROM digest_items WHERE id = ? AND kind = 'li_signal'",
  ).bind(id).first();
  if (!item) return { ok: false, error: 'li_signal item not found' };
  let meta = {};
  try { meta = JSON.parse(item.meta_json || '{}'); } catch { meta = {}; }

  const days = Number(cfg.snooze_days) || 7;
  const until = now() + days * 24 * 60 * 60 * 1000;
  const who = { prospect_id: meta.prospect_id || null, phone: meta.phone || null, name: meta.name || null };
  const keys = snoozeKeys(who);
  if (!keys.length) return { ok: false, error: 'nothing identifies this person' };
  for (const key of keys) {
    await env.DB.prepare(
      `INSERT INTO signal_snoozes (key, until, label, reason, created_at) VALUES (?, ?, ?, 'snoozed by the operator', ?)
       ON CONFLICT(key) DO UPDATE SET until = MAX(signal_snoozes.until, excluded.until), label = excluded.label`,
    ).bind(key, until, meta.name || null, now()).run();
  }
  const { consumeSignalsForPerson } = await import('./digest.js');
  const archived = await consumeSignalsForPerson(env, who);
  await env.DB.prepare('UPDATE digest_items SET read_at = ? WHERE id = ?').bind(now(), id).run();
  await logEvent(env, {
    kind: 'signal_snoozed', actor: 'operator',
    payload: { id, name: meta.name || null, days, until, archived: archived + 1 },
  });
  return { ok: true, until, days, archived: archived + 1 };
}

// Undo: wake this person's signals again.
export async function unsnoozePerson(env, who) {
  const keys = snoozeKeys(who);
  if (!keys.length) return { ok: false, error: 'nothing identifies this person' };
  const r = await env.DB.prepare(
    `DELETE FROM signal_snoozes WHERE key IN (${keys.map(() => '?').join(',')})`,
  ).bind(...keys).run();
  await logEvent(env, { kind: 'signal_unsnoozed', actor: 'operator', payload: { keys, removed: r.meta?.changes || 0 } });
  return { ok: true, removed: r.meta?.changes || 0 };
}
