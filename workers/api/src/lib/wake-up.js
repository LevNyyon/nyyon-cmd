// Nyo wake-up — proactive survey + catchup. Business rules extracted from
// the /api/system/wake-up route (index.js), behavior-identical. Surveys
// what's happened, what's pending, what's failed, and (optionally) fires any
// outbox retries that should already have happened. Composes a markdown
// "morning briefing" and queues it as a Nyo pending message so the floating
// button badges.
//
// Idempotent: if there's been no material change since the last wake-up
// (no new failures, no missed publishes, no new pending work), skips
// queueing so the operator doesn't get spammed every tab refocus.
//
// Thresholds (cadence hours, heartbeat, outbox retry window + limit) are
// EDITABLE: they live in the `wake-up-policy` knowledge doc as JSON. The
// defaults below are seeded into the doc on first run; a missing or broken
// doc falls back to the defaults — a bad edit must never kill the wake-up.

import {
  readKnowledge, writeKnowledge,
  queueNyoMessage, logEvent, logWorkflowRun,
} from './db.js';
import { EVENT_KINDS } from './event-kinds.js';
import { retryOutboxRow } from './outbox.js';

const POLICY_SLUG = 'wake-up-policy';

// Seeded defaults — mirrored into the knowledge doc so the operator can tune
// them without a deploy.
const POLICY_DEFAULTS = Object.freeze({
  // Legacy field, kept in the policy doc for compatibility; nothing reads it now.
  cadence_hours: 18,
  // Re-brief a standing (unchanged) problem at most once per this many hours.
  heartbeat_hours: 20,
  // Look-back window (hours) for outbox failures — both the briefing stat and
  // the auto-retry candidate query.
  outbox_window_hours: 72,
  // Max outbox auto-retries per wake-up.
  outbox_retry_limit: 5,
  // HARD CAP between queued chat briefings, regardless of reason. The operator
  // asked for the "👋 Morning" message once a day, not on every state change —
  // 20h ≈ daily with drift room. Server-side actions (autofire, retries) still
  // run on capped ticks; only the chat message is suppressed (visible in
  // Activity / Workflows instead).
  briefing_gap_hours: 20,
});

// Coerce a policy field to a finite number, else the default. A garbage value
// in the doc (e.g. "banana") must degrade to the default, not break SQL.
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Read the policy doc; seed it with the defaults if it doesn't exist yet.
// Any read/parse/seed failure falls back to the defaults.
async function loadWakeUpPolicy(env) {
  try {
    const doc = await readKnowledge(env, POLICY_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: POLICY_SLUG,
        title: 'Wake-up policy — cadence + retry thresholds',
        body: JSON.stringify(POLICY_DEFAULTS, null, 2),
      });
      return { ...POLICY_DEFAULTS };
    }
    const parsed = JSON.parse(doc.body);
    const src = (parsed && typeof parsed === 'object') ? parsed : {};
    return {
      cadence_hours:       num(src.cadence_hours,       POLICY_DEFAULTS.cadence_hours),
      heartbeat_hours:     num(src.heartbeat_hours,     POLICY_DEFAULTS.heartbeat_hours),
      outbox_window_hours: num(src.outbox_window_hours, POLICY_DEFAULTS.outbox_window_hours),
      outbox_retry_limit:  num(src.outbox_retry_limit,  POLICY_DEFAULTS.outbox_retry_limit),
      briefing_gap_hours:  num(src.briefing_gap_hours,  POLICY_DEFAULTS.briefing_gap_hours),
    };
  } catch (e) {
    console.error('wake-up-policy doc unreadable — using defaults:', e?.message || e);
    return { ...POLICY_DEFAULTS };
  }
}

// Run the full wake-up. opts: { autofire?: boolean } — if true (default),
// the outbox auto-retry actually fires. If false, just reports what would
// be done. Returns { status, body } — the route serializes body as JSON with
// that HTTP status (same shapes the inline route returned).
export async function runWakeUp(env, opts = {}) {
  const autofire = opts.autofire !== false; // default true
  const now = Date.now();

  const policy = await loadWakeUpPolicy(env);

  // Each query wrapped so we don't fail the whole wake-up if one table is

  // Each query wrapped so one missing table can't kill the whole wake-up.
  async function safeFirst(sql, ...args) {
    try { return await env.DB.prepare(sql).bind(...args).first(); }
    catch { return null; }
  }
  async function safeAll(sql, ...args) {
    try { return (await env.DB.prepare(sql).bind(...args).all()).results || []; }
    catch { return []; }
  }

  // 2. Recent outbox failures (any channel) in the policy window.
  const recentFails = await safeAll(
    `SELECT channel, COUNT(*) AS n FROM outbound_log WHERE status = 'failed' AND created_at > ? GROUP BY channel`,
    now - policy.outbox_window_hours * 3600 * 1000,
  );

  // 3. Was the last wake-up notification before any material event since?
  const lastWakeUp   = await safeFirst(`SELECT created_at, payload FROM events WHERE kind = 'nyo_wake_up_sent' ORDER BY created_at DESC LIMIT 1`);
  const lastWakeUpAt = lastWakeUp?.created_at || 0;
  // Signature of the briefing we last sent — lets us tell "same news" from
  // "new news" and skip re-posting an identical briefing on every refocus.
  let lastSig = null;
  try { lastSig = lastWakeUp?.payload ? (JSON.parse(lastWakeUp.payload)?.state_sig ?? null) : null; } catch { /* legacy event without a sig */ }

  const actions = [];   // [{ kind, ok, label, detail?, ref? }]
  // 5b. Auto-retry recent outbox failures. Conservative — one auto-retry per
  // original failure, ever. If the retry also fails, the operator decides
  // whether to push harder via the Outbox UI.
  //   - parent_id IS NULL: only originals (skip rows that are themselves
  //     retries of something else)
  //   - NOT EXISTS child: no auto-retry has been attempted yet
  //   - created_at within the policy window: don't dig through ancient history on every wake
  //   - LIMIT (policy retry limit): don't blast the operator with 50 retries on a bad day
  if (autofire) {
    const retryCandidates = await safeAll(
      // NEVER auto-retry outreach channels (li = LinkedIn DMs/connects, social =
      // company/personal posts). A stale failure there re-sends a real message
      // to a real person on the next wake — exactly the incident where fixing
      // the DM endpoint made an old failed test DM to a 1st-degree connection
      // resurrect and deliver. Those channels own their own retry (the LI
      // campaign tick; social is operator-approved), so they're excluded here.
      // Auto-retry is only for transient operational sends (wa/blog).
      // Media sends are excluded for the same reason: a wa-gateway 500 raised
      // AFTER the media actually landed logged a false failure, and auto-retry
      // then delivered the same image to a real group over and over. A send we
      // cannot prove failed must never be re-fired automatically.
      `SELECT id, channel, kind, to_name, attempt FROM outbound_log o
        WHERE o.status = 'failed'
          AND o.channel NOT IN ('li', 'social')
          AND o.source != 'scheduled'   -- scheduled sends fail CLOSED, never auto-retry
          -- operator cancels + queue expiries are decisions, not failures
          AND o.error NOT LIKE 'cancelled by operator%'
          AND o.error NOT LIKE 'expired before%'
          AND o.kind NOT IN ('image', 'video', 'audio', 'document')
          AND o.parent_id IS NULL
          AND o.created_at > ?
          AND NOT EXISTS (SELECT 1 FROM outbound_log r WHERE r.parent_id = o.id)
        ORDER BY o.created_at DESC
        LIMIT ?`,
      now - policy.outbox_window_hours * 3600 * 1000,
      policy.outbox_retry_limit,
    );
    for (const cand of retryCandidates) {
      const label = `${cand.channel} ${cand.kind} to ${cand.to_name || 'unknown'}`;
      try {
        await retryOutboxRow(env, cand.id);
        actions.push({ kind: 'outbox_retry', ok: true, label: `Retried ${label}`, ref: cand.id });
      } catch (e) {
        actions.push({ kind: 'outbox_retry', ok: false, label: `Retried ${label} — still failing`, detail: String(e?.message || e).slice(0, 120), ref: cand.id });
      }
    }
  }

  // 6. Compose. No greeting ritual and no "all clean" notes: the wake-up says
  // something only when there is something to say. A fresh install with no
  // voice docs gets the interview invite (once — it rides the state signature
  // like everything else); a running one hears about send failures and what
  // the wake-up just did about them.
  const lines = [];
  const voiceMissing = !(await readKnowledge(env, 'nyyon-brand-voice').catch(() => null));
  if (voiceMissing) {
    lines.push('No voice docs yet, so nothing I write will sound like you. Say "let\'s do the interview" and I\'ll run it right here — about fifteen minutes, stop any time.');
  }
  const failsByChannel = recentFails.map((r) => `${r.channel}=${r.n}`).join(', ');
  if (failsByChannel) {
    lines.push(`Outbox failures (${policy.outbox_window_hours}h): ${failsByChannel}.`);
  }
  if (actions.length) {
    lines.push('');
    lines.push(`**What I did this wake-up:**`);
    for (const a of actions) {
      const icon = a.ok ? '✅' : '⚠️';
      const detail = a.detail ? ` — ${a.detail}` : '';
      lines.push(`- ${icon} ${a.label}${detail}`);
    }
  }

  // Trigger gate — the point of this rewrite: brief ONCE per distinct state,
  // not on every mount/refocus.
  //
  // We hash the *material* state into a signature (last publish, pending /
  // outbox fails). If it
  // matches the signature of the briefing we last sent, the news is identical
  // → stay quiet. We re-brief when: (a) a real action was taken, (b) the
  // signature changed (new publish / failure / pending), or (c) a heartbeat
  // (policy hours) lapsed so a standing problem resurfaces once a day, not as
  // a flood. A null lastSig (first-ever brief, or a legacy event) counts as changed.
  const stateSig = [
    recentFails.map((r) => `${r.channel}:${r.n}`).sort().join(',') || 'noFails',
    voiceMissing ? 'noVoice' : 'voice',
  ].join('|');

  const HEARTBEAT_MS     = policy.heartbeat_hours * 3600 * 1000;
  const actionTaken      = actions.length > 0;
  const stateChanged     = lastSig === null || lastSig !== stateSig;
  const heartbeatDue     = lastWakeUpAt > 0 && (now - lastWakeUpAt) >= HEARTBEAT_MS;
  // Nothing composed = nothing queued, whatever the signature says.
  const anythingToReport = lines.length > 0 && (actionTaken || stateChanged || heartbeatDue);
  const reason           = actionTaken ? 'action' : stateChanged ? 'changed' : 'heartbeat';

  // Hard once-per-gap cap on the CHAT MESSAGE (operator: "once a day, not 50
  // good-mornings"). State changes and auto-actions still happen and still log
  // to Activity/Workflows on capped ticks; we just don't queue another chat
  // briefing until the gap has passed. First-ever briefing is never capped.
  const BRIEFING_GAP_MS = policy.briefing_gap_hours * 3600 * 1000;
  const briefingCapped  = lastWakeUpAt > 0 && (now - lastWakeUpAt) < BRIEFING_GAP_MS;

  if (anythingToReport && !briefingCapped) {
    try {
      const msg = await queueNyoMessage(env, {
        kind:    'wake_up',
        content: lines.join('\n'),
        payload: {
          outbox_fails:    recentFails,
          actions,
        },
      });
      await logEvent(env, {
        kind: 'nyo_wake_up_sent', actor: 'system',
        payload: { queued_id: msg.id, actions_n: actions.length, state_sig: stateSig, reason },
      });
      await logWorkflowRun(env, {
        workflow_slug: 'nyo-wake-up', status: 'succeeded',
        output: { queued: true, reason, actions_n: actions.length },
      }).catch(console.error);
      return { status: 200, body: { queued: true, message_id: msg.id, reason, actions, summary: lines.join('\n') } };
    } catch (e) {
      await logWorkflowRun(env, {
        workflow_slug: 'nyo-wake-up', status: 'failed',
        error: String(e?.message || e), output: { queued: false, actions_n: actions.length },
      }).catch(console.error);
      return { status: 500, body: { queued: false, error: String(e?.message || e), actions } };
    }
  }

  // Quiet tick: either same news as last time, or the once-per-gap briefing
  // cap is holding. Don't badge the operator for nothing — the trail lives in
  // the workflow run either way.
  const quietReason = briefingCapped && anythingToReport
    ? `briefing capped (once per ${policy.briefing_gap_hours}h)`
    : 'no change since last briefing';
  await logWorkflowRun(env, {
    workflow_slug: 'nyo-wake-up', status: 'succeeded',
    output: { queued: false, reason: quietReason, actions_n: actions.length },
  }).catch(console.error);
  return { status: 200, body: { queued: false, reason: quietReason, state_sig: stateSig, actions } };
}
