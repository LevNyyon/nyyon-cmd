// Pipeline — the sales board (clients that carry a stage/deal) and lead
// promotion, one shared implementation.
//
// Previously listPipeline/updateDeal SQL lived twice (routes + list_pipeline/
// update_deal tools) and promoteLeadToPipeline lived twice (route + the
// gtm_promote_lead tool), none logging the stage/deal mutation. Nyo could move
// deals on the board with no activity trace. This is the single pool both
// callers delegate to; every mutation logs.

import { now } from './util.js';
import { logEvent, writeClient, writeContact } from './db.js';
import { getLead, leadState } from './gtm.js';

const DEAL_COLS = 'id, name, status, stage, deal_value, mrr_value, engagement';

export async function listPipeline(env) {
  const r = await env.DB.prepare(
    `SELECT ${DEAL_COLS} FROM clients WHERE stage IS NOT NULL OR status IN ('active','prospect','partner') ORDER BY updated_at DESC`,
  ).all();
  return { deals: r.results || [] };
}

// Move a deal on the board / set its value. id = client id.
export async function updateDeal(env, id, patch = {}, actor = 'system') {
  const sets = [], vals = [];
  for (const k of ['stage', 'deal_value', 'mrr_value']) if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(patch[k]); }
  if (!sets.length) return { ok: false, error: 'nothing to update' };
  sets.push('updated_at=?'); vals.push(now()); vals.push(id);
  await env.DB.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  const deal = await env.DB.prepare(`SELECT ${DEAL_COLS} FROM clients WHERE id = ?`).bind(id).first();
  if (!deal) return { ok: false, error: 'not found' };
  await logEvent(env, { kind: 'deal_updated', actor, payload: { id, changed: Object.keys(patch), stage: deal.stage } });
  return { ok: true, deal };
}

// Promote a GTM lead into the client pipeline: create the client (stage
// 'target'), mirror a contact, and stamp the lead with its new client_id.
// writeClient/writeContact log their own client_added/contact_added; this adds
// the lead_promoted event so the promotion itself is visible end to end.
export async function promoteLeadToPipeline(env, id, actor = 'system') {
  const lead = await getLead(env, id);
  if (!lead) return { ok: false, error: 'not found', code: 404 };
  if (lead.client_id) return { ok: true, client_id: lead.client_id, note: 'already in pipeline' };
  if (!lead.name) return { ok: false, error: 'lead has no name yet — enrich first', code: 400 };

  const client = await writeClient(env, {
    name: lead.company ? `${lead.name} (${lead.company})` : lead.name,
    status: 'prospect',
    tags: ['person', 'gtm'],
    notes: `From GTM intake. ${lead.position ? lead.position + (lead.company ? ' at ' + lead.company : '') + '. ' : ''}Phone ${lead.normalized_phone || lead.phone}.${lead.linkedin ? ' LinkedIn: ' + lead.linkedin : ''}`,
  });
  await env.DB.prepare("UPDATE clients SET stage='target', updated_at=? WHERE id=?").bind(now(), client.id).run();
  await writeContact(env, {
    full_name: lead.name, phone: lead.normalized_phone || lead.phone, company: lead.company,
    title: lead.position, linkedin_url: lead.linkedin, email: lead.email,
    status: 'prospect', source: 'cold_outreach', client_id: client.id, tags: ['gtm'],
  });
  await env.DB.prepare('UPDATE gtm_leads SET client_id=?, updated_at=? WHERE id=?').bind(client.id, now(), id).run();
  await logEvent(env, { kind: 'lead_promoted', actor, payload: { lead_id: id, client_id: client.id, name: lead.name } });

  const updated = await getLead(env, id);
  return { ok: true, client_id: client.id, lead: { ...updated, state: leadState(updated) } };
}
