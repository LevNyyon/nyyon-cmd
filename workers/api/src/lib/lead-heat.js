// ─── Lead heat: how warm is this relationship, 0-100 ─────────────
// A mechanical score (no LLM, cheap enough to stamp across a whole brief)
// built from what actually happened between us and them: did they reply,
// did they accept, are they talking to us on WhatsApp, are they active,
// have we engaged with their content. Every weight lives in the `lead-heat`
// knowledge doc, so the definition of "hot" is editable without a deploy.
//
// The score is deliberately explainable: computeHeat returns the factors
// that produced it, and the UI shows them on hover.

import { logEvent, readKnowledge, writeKnowledge } from './db.js';
import { now } from './util.js';

const DOC_SLUG = 'lead-heat';
const DAY = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  // points awarded per fact; the total is capped at 100
  replied: 45,              // they answered us — the strongest signal there is
  connected: 18,            // they accepted the connection
  invited: 4,               // we asked, no answer yet
  inbound_each: 9,          // each inbound WhatsApp message from them
  inbound_max: 27,          // ...capped
  our_message_each: 3,      // our sent touches (effort, not warmth)
  our_message_max: 9,
  signal_each: 4,           // their recent LinkedIn activity = reachable/alive
  signal_max: 16,
  we_engaged: 6,            // we liked/commented their post (legacy stamps)
  // each ✓ on a card = the operator engaged with them on LinkedIn by hand
  engaged_each: 10,
  engaged_max: 30,
  // recency decay: heat fades when nothing has happened
  stale_after_days: 21,     // no interaction for this long → decay starts
  stale_floor: 0.45,        // decay never drops below this fraction
  hot_at: 60,               // UI: bar reads "hot" at or above
  warm_at: 30,              // ...and "warm" here
};

const seedBody = (cfg) => `# Lead heat

How warm a lead is, 0-100, from what actually happened between us: replies
and accepted connections weigh most, live WhatsApp conversation next, their
LinkedIn activity and our own engagement least. Heat decays when nothing has
happened for stale_after_days (never below stale_floor of the raw score).
hot_at / warm_at set where the bar changes colour. Edit any weight here; no
deploy needed.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;

export async function leadHeatCfg(env) {
  let doc = await readKnowledge(env, DOC_SLUG);
  if (!doc) {
    await writeKnowledge(env, {
      slug: DOC_SLUG, title: 'Lead heat', body: seedBody(DEFAULTS),
      scope: 'global', module: 'digest', parent_slug: 'module-digest',
    }).catch(() => {});
    doc = { body: seedBody(DEFAULTS) };
  }
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const parsed = m ? JSON.parse(m[1]) : null;
    if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed };
  } catch { /* malformed edit must not break scoring — defaults win */ }
  return DEFAULTS;
}

// Heat for ONE person. `who` may carry any of prospect_id / phone / name /
// liked_at / commented_at; every lookup is optional and failures are silent
// (a missing table must never break a brief).
export async function computeHeat(env, who = {}, cfg = null) {
  const c = cfg || await leadHeatCfg(env);
  const factors = [];
  let score = 0;
  let lastTouch = 0;

  // A name alone still resolves: find the prospect (and their phone) so
  // asking "how hot is Dana?" works, not just id-keyed lookups.
  if (!who.prospect_id && who.name) {
    const p = await env.DB.prepare(
      'SELECT id FROM li_prospects WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1',
    ).bind(who.name).first().catch(() => null);
    if (p) who = { ...who, prospect_id: p.id };
  }
  if (!who.phone && who.name) {
    const g = await env.DB.prepare(
      `SELECT COALESCE(NULLIF(TRIM(normalized_phone), ''), phone) AS phone FROM gtm_leads
        WHERE phone IS NOT NULL AND LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
    ).bind(who.name).first().catch(() => null);
    if (g?.phone) who = { ...who, phone: g.phone };
  }

  // ── LinkedIn relationship state
  if (who.prospect_id) {
    const p = await env.DB.prepare(
      'SELECT status, accepted_at, replied_at, updated_at FROM li_prospects WHERE id = ?',
    ).bind(who.prospect_id).first().catch(() => null);
    if (p) {
      if (p.replied_at) { score += c.replied; factors.push('replied to us'); lastTouch = Math.max(lastTouch, p.replied_at); }
      else if (p.accepted_at || p.status === 'connected') { score += c.connected; factors.push('accepted the connection'); lastTouch = Math.max(lastTouch, p.accepted_at || 0); }
      else if (p.status === 'invited') { score += c.invited; factors.push('invite pending'); }
    }
    // their recent activity: reachable and alive
    const sig = await env.DB.prepare(
      'SELECT COUNT(*) n, MAX(detected_at) last FROM li_signals WHERE prospect_id = ? AND detected_at > ?',
    ).bind(who.prospect_id, now() - 30 * DAY).first().catch(() => null);
    if (sig?.n) {
      const pts = Math.min(c.signal_max, sig.n * c.signal_each);
      score += pts;
      factors.push(`${sig.n} recent signal${sig.n === 1 ? '' : 's'}`);
      lastTouch = Math.max(lastTouch, sig.last || 0);
    }
    // our own outbound effort
    const t = await env.DB.prepare(
      "SELECT COUNT(*) n FROM li_touches WHERE prospect_id = ? AND status = 'sent'",
    ).bind(who.prospect_id).first().catch(() => null);
    if (t?.n) { score += Math.min(c.our_message_max, t.n * c.our_message_each); factors.push(`${t.n} message${t.n === 1 ? '' : 's'} from us`); }
  }

  // ── live WhatsApp conversation: inbound is the warmest everyday signal
  const digits = String(who.phone || '').replace(/\D/g, '');
  if (digits) {
    let chatId = null;
    try { const { toChatId } = await import('./whatsapp.js'); chatId = toChatId(who.phone); } catch { chatId = null; }
    if (chatId) {
      const inb = await env.DB.prepare(
        'SELECT COUNT(*) n, MAX(timestamp) last FROM wa_messages WHERE chat_id = ? AND from_me = 0',
      ).bind(chatId).first().catch(() => null);
      if (inb?.n) {
        score += Math.min(c.inbound_max, inb.n * c.inbound_each);
        factors.push(`${inb.n} WhatsApp repl${inb.n === 1 ? 'y' : 'ies'}`);
        lastTouch = Math.max(lastTouch, inb.last || 0);
      }
    }
  }

  // ── the operator's own engagement, recorded by the card's ✓
  try {
    const { snoozeKeys } = await import('./signal-priority.js');
    const keys = snoozeKeys(who);
    if (keys.length) {
      const eng = await env.DB.prepare(
        `SELECT MAX(engaged_count) n, MAX(last_engaged_at) last FROM signal_snoozes
          WHERE key IN (${keys.map(() => '?').join(',')})`,
      ).bind(...keys).first().catch(() => null);
      if (eng?.n) {
        score += Math.min(c.engaged_max ?? 30, eng.n * (c.engaged_each ?? 10));
        factors.push(`engaged ${eng.n}×`);
        lastTouch = Math.max(lastTouch, eng.last || 0);
      }
    }
  } catch { /* engagement is additive; never break the score */ }

  // The old liked/commented stamps are NOT scored: they were written even
  // when LinkedIn refused the action, so they cannot be trusted. The ✓
  // engagement counter above is the honest record.

  // ── decay: warmth fades without contact
  let decayed = score;
  if (lastTouch) {
    const idleDays = (now() - lastTouch) / DAY;
    const staleAfter = Number(c.stale_after_days) || 21;
    if (idleDays > staleAfter) {
      const over = (idleDays - staleAfter) / staleAfter;          // 1 = twice the window
      const factor = Math.max(Number(c.stale_floor) || 0.45, 1 - over * 0.5);
      decayed = score * factor;
      if (factor < 1) factors.push(`quiet ${Math.round(idleDays)}d`);
    }
  }

  const final = Math.max(0, Math.min(100, Math.round(decayed)));
  return {
    score: final,
    band: final >= (c.hot_at ?? 60) ? 'hot' : final >= (c.warm_at ?? 30) ? 'warm' : 'cold',
    factors,
    last_touch: lastTouch || null,
  };
}

// Stamp heat onto every unread signal card (mechanical, no LLM). Runs with
// the priority sweep so the bars stay honest without their own cron.
export async function refreshLeadHeat(env) {
  const cfg = await leadHeatCfg(env);
  const rows = (await env.DB.prepare(
    "SELECT id, meta_json FROM digest_items WHERE kind = 'li_signal' AND read_at IS NULL",
  ).all()).results || [];
  let changed = 0;
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta_json || '{}'); } catch { continue; }
    const h = await computeHeat(env, {
      prospect_id: meta.prospect_id || null, phone: meta.phone || null, name: meta.name || null,
      liked_at: meta.liked_at || null, commented_at: meta.commented_at || null,
    }, cfg);
    if (meta.heat === h.score && meta.heat_band === h.band) continue;
    meta.heat = h.score;
    meta.heat_band = h.band;
    meta.heat_factors = h.factors;
    await env.DB.prepare('UPDATE digest_items SET meta_json = ? WHERE id = ?')
      .bind(JSON.stringify(meta), r.id).run();
    changed++;
  }
  if (changed) await logEvent(env, { kind: 'lead_heat_refreshed', actor: 'system', payload: { changed, checked: rows.length } });
  return { ok: true, changed, checked: rows.length };
}
