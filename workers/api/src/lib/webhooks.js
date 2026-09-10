// Outbound webhooks — the slim system's delivery boundary (nyyon-lite layer 5
// config + a layer-1-shaped sender). Hot Takes composes; whoever stands behind
// these URLs owns actually putting content on a website or a social channel.
//
// Config lives in the `outbound-webhooks` knowledge doc as a ```json block —
// editable in Knowledge or through Settings, no deploy. Loader mirrors the
// wake-up-policy pattern: seed on first read, never throw, fall back to {}.
// Every send writes an outbox row and, on failure, an event — the operator's
// rule is that errors are ALWAYS visible in Activity with full information.

import { readKnowledge, writeKnowledge, logEvent } from './db.js';
import { beginSend, markSent, markFailed } from './outbox.js';

const DOC_SLUG = 'outbound-webhooks';

const SEED_BODY = `Outbound webhooks — where finished content gets DELIVERED.

When a Hot Takes article is published, its full payload POSTs to
\`website_url\`. When a social leg fires, its payload POSTs to \`social_url\`.
Blank = that publish path fails visibly until a webhook is set. Edit the JSON
below (Settings edits this same doc).

\`\`\`json
{
  "website_url": "",
  "social_url": ""
}
\`\`\`
`;

export async function loadWebhooks(env) {
  try {
    let doc = await readKnowledge(env, DOC_SLUG);
    if (!doc) {
      await writeKnowledge(env, { slug: DOC_SLUG, title: 'Outbound webhooks', body: SEED_BODY, parent_slug: 'nyyon-root' }).catch(() => {});
      return { website_url: '', social_url: '' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const cfg = m ? JSON.parse(m[1]) : {};
    return { website_url: String(cfg.website_url || '').trim(), social_url: String(cfg.social_url || '').trim() };
  } catch { return { website_url: '', social_url: '' }; }
}

export async function saveWebhooks(env, { website_url = '', social_url = '' } = {}) {
  for (const u of [website_url, social_url]) {
    if (u && !/^https:\/\/.+/i.test(u)) throw new Error(`webhook must be an https:// URL: ${u.slice(0, 60)}`);
  }
  const body = SEED_BODY.replace(/```json[\s\S]*?```/, '```json\n' + JSON.stringify({ website_url, social_url }, null, 2) + '\n```');
  await writeKnowledge(env, { slug: DOC_SLUG, title: 'Outbound webhooks', body, parent_slug: 'nyyon-root' });
  await logEvent(env, { kind: 'webhooks_updated', actor: 'operator', payload: { website: !!website_url, social: !!social_url } });
  return { website_url, social_url };
}

// POST one payload to a configured webhook. Outbox-logged; failures land in
// Activity with the HTTP status and body head. Returns { ok, http, outbox_id }.
export async function sendWebhook(env, which, payload, { source = 'hottake', source_ref = null } = {}) {
  const cfg = await loadWebhooks(env);
  const url = which === 'website' ? cfg.website_url : cfg.social_url;
  if (!url) throw new Error(`no ${which} webhook configured (Settings → Outbound webhooks)`);
  const log = await beginSend(env, {
    channel: 'webhook', kind: which, to_id: url.slice(0, 120),
    body: JSON.stringify(payload).slice(0, 4000),
    payload: { which }, source, source_ref,
  });
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Nyyon-Event': payload?.type || which },
      body: JSON.stringify(payload),
    });
    const bodyHead = (await r.text().catch(() => '')).slice(0, 300);
    if (!r.ok) throw new Error(`webhook ${which} → HTTP ${r.status}: ${bodyHead}`);
    await markSent(env, log.id, { message_id: String(r.status) });
    return { ok: true, http: r.status, outbox_id: log.id };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    await markFailed(env, log.id, msg).catch(() => {});
    await logEvent(env, { kind: 'webhook_error', actor: 'system', payload: { which, url: url.slice(0, 120), source_ref, error: msg } }).catch(() => {});
    throw e;
  }
}
