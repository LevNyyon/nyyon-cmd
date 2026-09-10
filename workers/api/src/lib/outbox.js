// outbox.js — unified outbound send log.
//
// Every channel-send wrapper (WA reply/send/image/document/reaction,
// LinkedIn message-send, future email) flows through here:
//
//   const log = await beginSend(env, { channel:'wa', kind:'reply', to_id, to_name, body, payload, source });
//   try {
//     const res = await actualProviderCall(...);
//     await markSent(env, log.id, { message_id: res.messageId });
//     return res;
//   } catch (e) {
//     await markFailed(env, log.id, e);
//     throw e;
//   }
//
// The wrappers in whatsapp.js / linkedin.js still throw on failure so callers
// (digest execute, Nyo tool-use loop, etc.) can react. The outbox row remains
// behind as the operator's record of what was attempted and why it broke.

import { uid, now, safeJSON } from './util.js';
import { logEvent } from './db.js';

// ─── inserts / updates ────────────────────────────────────────
export async function beginSend(env, { channel, kind, to_id = null, to_name = null, body = null, payload = null, source = 'operator', source_ref = null, parent_id = null, attempt = 1 }) {
  const id = uid();
  const t  = now();
  await env.DB.prepare(`
    INSERT INTO outbound_log
      (id, channel, kind, to_id, to_name, body, payload_json, status, message_id, error, attempt, parent_id, source, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, channel, kind, to_id, to_name, body, payload ? JSON.stringify(payload) : null,
    attempt, parent_id, source, source_ref, t, t
  ).run();
  return { id, channel, kind, to_id, body, attempt, source, source_ref, parent_id, payload, created_at: t };
}

// The Outbox page is gone — Activity is where sends are SEEN now, so both
// outcomes log an event carrying the row's who/what/where, not just an id.
async function rowBrief(env, id) {
  try {
    const r = await env.DB.prepare(`SELECT channel, kind, to_id, to_name, source, source_ref FROM outbound_log WHERE id = ?`).bind(id).first();
    return r ? { channel: r.channel, kind: r.kind, to: r.to_name || r.to_id, source: r.source, source_ref: r.source_ref } : {};
  } catch { return {}; }
}

export async function markSent(env, id, { message_id = null } = {}) {
  await env.DB.prepare(`UPDATE outbound_log SET status = 'sent', message_id = ?, error = NULL, updated_at = ? WHERE id = ?`)
    .bind(message_id, now(), id).run();
  try { await logEvent(env, { kind: 'outbox_sent', actor: 'system', payload: { outbox_id: id, message_id, ...(await rowBrief(env, id)) } }); } catch {}
}

export async function markFailed(env, id, err) {
  const text = String(err?.message || err || 'unknown error').slice(0, 2000);
  await env.DB.prepare(`UPDATE outbound_log SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
    .bind(text, now(), id).run();
  // Material event: the wake-up surfaces NEW fails, and Activity shows the
  // full picture (channel, recipient, source, error). Wrapped — never fatal.
  try { await logEvent(env, { kind: 'outbox_failed', actor: 'system', payload: { outbox_id: id, error: text.slice(0, 500), ...(await rowBrief(env, id)) } }); } catch {}
}

// ─── helpers used by the route layer ──────────────────────────
export async function listOutbox(env, { channel = null, status = null, source = null, limit = 200 } = {}) {
  const where = [];
  const args  = [];
  if (channel) { where.push('channel = ?'); args.push(channel); }
  if (status)  { where.push('status = ?');  args.push(status);  }
  if (source)  { where.push('source = ?');  args.push(source);  }
  const sql = `SELECT * FROM outbound_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
  const r = await env.DB.prepare(sql).bind(...args).all();
  return (r.results || []).map(decorate);
}

export async function getOutboxRow(env, id) {
  const r = await env.DB.prepare('SELECT * FROM outbound_log WHERE id = ?').bind(id).first();
  return r ? decorate(r) : null;
}

export async function outboxStats(env) {
  const r = await env.DB.prepare(`
    SELECT
      channel,
      status,
      COUNT(*) AS n
    FROM outbound_log
    WHERE created_at > ?
    GROUP BY channel, status
  `).bind(now() - 7 * 24 * 3600 * 1000).all();
  // Reshape into { wa: { sent: 12, failed: 2 }, li: { ... }, ... }.
  const out = {};
  for (const row of r.results || []) {
    if (!out[row.channel]) out[row.channel] = { sent: 0, failed: 0, queued: 0 };
    out[row.channel][row.status] = row.n;
  }
  return out;
}

// ─── retry ────────────────────────────────────────────────────
// Re-fire an existing failed (or even sent — operator's call) row. We re-read
// the payload, build a fresh attempt row via beginSend with parent_id pointing
// at the original, then call the channel-appropriate sender. Imports are lazy
// so this module doesn't pull half the worker just for typecheck.
export async function retryOutboxRow(env, id) {
  const row = await getOutboxRow(env, id);
  if (!row) throw new Error('outbox row not found');
  // Hard guard — never re-fire a row that already succeeded. The provider's
  // de-dup keys (wa-gateway messageId, prod D1 PUT idempotency) usually catch
  // this anyway, but a double-send to a WhatsApp group reads worse than a
  // refused retry. Failed rows are the only valid retry targets.
  if (row.status === 'sent') {
    throw new Error(`outbox row ${id} already sent — retry refused`);
  }
  if (row.status === 'queued') {
    throw new Error(`outbox row ${id} is still queued — wait for it to finish or fail before retrying`);
  }
  // An operator's CANCEL (or a stale-ping expiry) is recorded as 'failed' so
  // the log shows the send never went out — but it is a DECISION, not a
  // transient failure. Nothing may resurrect it: not the Outbox retry button,
  // not the wake-up auto-retry (a cancelled message re-fired itself to a real
  // person before this guard existed).
  if (/^(cancelled by operator|expired before)/.test(row.error || '')) {
    throw new Error(`outbox row ${id} was ${row.error} — a cancelled/expired send is never retried; queue it fresh if it is really wanted`);
  }
  const payload = row.payload || {};
  if (row.channel === 'wa') {
    const wa = await import('./whatsapp.js');
    if (row.kind === 'reply' && payload.quotedMessageId && row.to_id) {
      // Recover @lid recipients that older rows stored as mangled @c.us.
      // Before toChatId preserved @lid, the digest drawer's "DM the sender"
      // path converted `<digits>@lid` → `<digits>@c.us` at row-insert time,
      // producing a fake phone-formatted recipient wa-gateway rejects with
      // /reply 500. If the to_id looks LID-shaped (15+ digits, no real
      // country code) AND the quotedMessageId still carries the original
      // `..._<lid>@lid` suffix, retry with the real LID.
      const chatId       = recoverLidRecipient(row.to_id, payload.quotedMessageId) || row.to_id;
      const sourceChatId = extractChatFromMessageId(payload.quotedMessageId);
      // Quoted-reply only works inside the originating chat. When the
      // operator chose to DM the sender of a group ask, the recipient
      // chat differs from the message's chat → wa-gateway /reply returns 500.
      // Fall back to plain sendText in that case so the retry actually
      // delivers as a fresh DM.
      if (sourceChatId && sourceChatId !== chatId) {
        return wa.sendText(env, { chatId, text: row.body },
          { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
      }
      return wa.replyToWaMessage(env, {
        chatId,
        quotedMessageId: payload.quotedMessageId,
        text: row.body,
      }, { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
    }
    if (row.kind === 'text' && row.to_id) {
      return wa.sendText(env, { chatId: row.to_id, text: row.body },
        { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
    }
    if (row.kind === 'image' && row.to_id && payload.url) {
      return wa.sendImage(env, { chatId: row.to_id, url: payload.url, caption: row.body },
        { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
    }
    if (row.kind === 'document' && row.to_id && payload.url) {
      return wa.sendDocument(env, { chatId: row.to_id, url: payload.url, filename: payload.filename, mimetype: payload.mimetype },
        { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
    }
    if (row.kind === 'reaction' && payload.messageId) {
      return wa.reactToMessage(env, { messageId: payload.messageId, reaction: payload.reaction },
        { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
    }
    throw new Error(`outbox retry: unsupported wa kind ${row.kind}`);
  }
  if (row.channel === 'li') {
    const li = await import('./linkedin.js');
    if (li.sendLinkedInMessage) {
      return li.sendLinkedInMessage(env, {
        profile_urn_id: payload.profile_urn_id || row.to_id,
        body: row.body,
      }, { source: 'retry', source_ref: row.id, parent_id: row.id, attempt: (row.attempt || 1) + 1 });
    }
    throw new Error('outbox retry: linkedin sender not exposed');
  }
  
  throw new Error(`outbox retry: unknown channel ${row.channel}`);
}

// ─── shared private bits ──────────────────────────────────────
function decorate(row) {
  return {
    ...row,
    payload: row.payload_json ? safeJSON(row.payload_json) : null,
  };
}

// If a WhatsApp reply row stored a `<digits>@c.us` recipient but the
// quotedMessageId's trailing author segment is actually a `@lid`, return
// the LID-formatted recipient so a retry hits the real WhatsApp account.
// Heuristic: WhatsApp phone numbers are at most ~13 digits including the
// longest country codes (Russia 7-digit + 9-digit subscriber, etc.); a
// `@c.us` jid with 14+ leading digits is almost certainly a LID we
// previously mangled when toChatId stripped the `@lid` suffix.
// Extract the originating chat id (the `@g.us` group or `@c.us` 1:1 chat
// that contained the quoted message) from a WhatsApp message id of shape
// `<fromMe>_<chatId>_<msgHash>_<authorId>`. Returns null when the shape
// doesn't match.
function extractChatFromMessageId(messageId) {
  if (!messageId) return null;
  const parts = String(messageId).split('_');
  if (parts.length < 3) return null;
  const candidate = parts[1];
  return /@(g\.us|c\.us)$/.test(candidate) ? candidate : null;
}

function recoverLidRecipient(toId, quotedMessageId) {
  if (!toId || !quotedMessageId) return null;
  if (!toId.endsWith('@c.us')) return null;
  const digits = toId.split('@')[0];
  if (!/^\d{14,}$/.test(digits)) return null;
  // Quoted message id shape on group messages:
  //   <fromMe>_<chatId>_<msgHash>_<authorId>
  // where authorId can be `<digits>@c.us` or `<digits>@lid`. Take the last
  // segment after the final underscore.
  const parts  = String(quotedMessageId).split('_');
  const author = parts[parts.length - 1] || '';
  if (!author.endsWith('@lid')) return null;
  // Only accept if the LID digits actually match the mangled to_id digits —
  // otherwise we'd be inferring a recipient the operator didn't pick.
  const lidDigits = author.split('@')[0];
  if (lidDigits !== digits) return null;
  return author;
}
