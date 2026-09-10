// Digest — morning brief module. Scans recent WhatsApp group activity +
// OSINT mentions, materializes "actionable items" into the digest_items
// table. UI reads from that table. Operator marks read/starred to dismiss
// or pin. Email source lands when the email module ships.

import { now, uid, safeJSON } from './util.js';
import { callOpenAIText } from './openai.js';
import { logEvent, writeContact, readKnowledge, writeKnowledge } from './db.js';
import { sendText as waSendText, replyToWaMessage as waReply } from './whatsapp.js';

// ─── CRUD ───────────────────────────────────────────────────
export async function listDigestItems(env, { unread_only = false, starred_only = false, limit = 200 } = {}) {
  const where = [];
  if (unread_only)  where.push('read_at IS NULL');
  if (starred_only) where.push('starred = 1');
  const sql = `
    SELECT * FROM digest_items
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    -- LinkedIn signals lead the brief (operator priority, 2026-08-20);
    -- inside a tier the newest card wins as before.
    ORDER BY urgency ASC, (kind = 'li_signal') DESC, created_at DESC
    LIMIT ?
  `;
  const r = await env.DB.prepare(sql).bind(limit).all();
  return (r.results || []).map((x) => ({ ...x, meta: safeJSON(x.meta_json) }));
}

export async function readDigestItem(env, id) {
  const r = await env.DB.prepare('SELECT * FROM digest_items WHERE id = ?').bind(id).first();
  return r ? { ...r, meta: safeJSON(r.meta_json) } : null;
}

export async function patchDigestItem(env, id, patch) {
  const existing = await readDigestItem(env, id);
  if (!existing) throw new Error(`digest item ${id} not found`);
  const fields = [];
  const args   = [];
  if (patch.read !== undefined) {
    fields.push('read_at = ?');
    args.push(patch.read ? now() : null);
  }
  if (patch.starred !== undefined) {
    fields.push('starred = ?');
    args.push(patch.starred ? 1 : 0);
  }
  // Draft auto-save: the card's editable WA draft lives in meta_json. The
  // FIRST edit snapshots the AI's original (draft_original) so the learning
  // pass can diff the final send against what the AI wrote.
  if (typeof patch.draft === 'string') {
    const meta = existing.meta || {};
    if (meta.draft_original === undefined) meta.draft_original = meta.draft ?? null;
    meta.draft = patch.draft.slice(0, 2000);
    meta.draft_edited_at = now();
    fields.push('meta_json = ?');
    args.push(JSON.stringify(meta));
  }
  if (fields.length === 0) return existing;
  args.push(id);
  await env.DB.prepare(`UPDATE digest_items SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  return readDigestItem(env, id);
}

// ── one outreach moment per person, from EVERY surface ──────────
// Scheduling or sending to a person consumes their other unread signals:
// they existed to create the moment, the moment is used. Matched by
// prospect_id, canonical phone digits, or exact name.
export async function consumeSignalsForPerson(env, { phone = null, name = null, prospect_id = null, except_id = null } = {}) {
  const digits = String(phone || '').replace(/\D/g, '');
  const nm = String(name || '').trim().toLowerCase();
  if (!digits && !nm && !prospect_id) return 0;
  const sibs = (await env.DB.prepare(
    "SELECT id, meta_json FROM digest_items WHERE kind = 'li_signal' AND read_at IS NULL",
  ).all()).results || [];
  let archived = 0;
  for (const sib of sibs) {
    if (except_id && sib.id === except_id) continue;
    let m = null;
    try { m = JSON.parse(sib.meta_json || '{}'); } catch { continue; }
    const hit = (prospect_id && m.prospect_id === prospect_id)
      || (digits && String(m.phone || '').replace(/\D/g, '') === digits)
      || (nm && String(m.name || '').trim().toLowerCase() === nm);
    if (!hit) continue;
    await env.DB.prepare('UPDATE digest_items SET read_at = ? WHERE id = ?').bind(now(), sib.id).run();
    archived++;
  }
  if (archived) {
    await logEvent(env, {
      kind: 'digest_signals_consumed', actor: 'system',
      payload: { archived, prospect_id: prospect_id || null, name: name || null, phone_digits: digits || null },
    });
  }
  return archived;
}

// ── manual send: the operator opened wa.me and sent it by hand ──

// Pull a digest item with full source-row enrichment so the chat can speak
// about the *actual* message, not just the LLM summary. Different kinds resolve
// to different shapes:
//   wa_message / wa_group  → { message, chat, thread (last 10) }
//   osint_mention          → { mention }
//   email | note | opportunity → just the item + meta
export async function getDigestItemContext(env, id) {
  const item = await readDigestItem(env, id);
  if (!item) return null;
  const out = { item, message: null, chat: null, thread: [], mention: null, participants: {} };

  if ((item.kind === 'wa_message' || item.kind === 'wa_group') && item.ref_kind === 'wa_messages' && item.ref_id) {
    const msg = await env.DB.prepare('SELECT * FROM wa_messages WHERE id = ?').bind(item.ref_id).first();
    if (msg) {
      out.message = msg;
      const chat = await env.DB.prepare('SELECT * FROM wa_chats WHERE id = ?').bind(msg.chat_id).first();
      out.chat = chat || null;

      // Pull 20 most recent + 10 around the anchor message (5 before, 5
      // after), then merge + dedupe. Guarantees the reply target is always
      // visible in the thread strip, even when the LLM picked a message
      // older than the recent window.
      const [recent, around] = await Promise.all([
        env.DB.prepare(
          'SELECT id, from_me, sender_id, sender_name, body, timestamp FROM wa_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20',
        ).bind(msg.chat_id).all(),
        env.DB.prepare(
          `SELECT id, from_me, sender_id, sender_name, body, timestamp
             FROM wa_messages
            WHERE chat_id = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC
            LIMIT 12`,
        ).bind(msg.chat_id, msg.timestamp - 6 * 60 * 60 * 1000, msg.timestamp + 6 * 60 * 60 * 1000).all(),
      ]);
      const byId = new Map();
      for (const r of [...(recent.results || []), ...(around.results || [])]) byId.set(r.id, r);
      // Belt-and-suspenders — explicitly include the anchor in case D1 lost it.
      if (!byId.has(msg.id)) {
        byId.set(msg.id, {
          id: msg.id, from_me: msg.from_me, sender_id: msg.sender_id,
          sender_name: msg.sender_name, body: msg.body, timestamp: msg.timestamp,
        });
      }
      out.thread = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);

      // Participant enrichment — for every distinct inbound sender in the
      // thread (and the anchor message), try to match a contact by phone.
      // Gives the UI a real name + LinkedIn icon to render instead of the
      // raw `972...@c.us` id.
      const senderIds = new Set();
      if (msg.sender_id && !msg.from_me) senderIds.add(msg.sender_id);
      for (const m of out.thread) {
        if (m.sender_id && !m.from_me) senderIds.add(m.sender_id);
      }
      for (const sid of senderIds) {
        const phone = phoneFromWaId(sid);
        if (!phone) continue;
        try {
          const c = await env.DB.prepare(
            'SELECT id, full_name, email, linkedin_url FROM contacts WHERE phone = ? LIMIT 1',
          ).bind(phone).first();
          if (c) out.participants[sid] = c;
        } catch { /* contacts table missing in dev — skip */ }
      }
    }
  } else if ((item.kind === 'wa_message' || item.kind === 'wa_group') && !item.ref_id && item.source_label) {
    // Fallback: some items are materialized without a ref_id linking them to a
    // specific wa_messages row (the generator surfaced a summarized thread, not
    // one line). They still carry the group name in source_label ("WA · <group>").
    // Resolve the chat by name + load the recent thread so the operator still
    // gets a drafted reply instead of only the suggested_action text.
    // ponytail: name match, fine for a handful of watched groups; store a
    // chat_id in meta at generate-time if this ever needs to scale.
    const groupName = item.source_label.replace(/^WA\s*[·:-]\s*/i, '').trim();
    if (groupName) {
      const chat = await env.DB.prepare(
        'SELECT * FROM wa_chats WHERE name = ? ORDER BY last_message_at DESC LIMIT 1',
      ).bind(groupName).first();
      if (chat) {
        out.chat = chat;
        const recent = await env.DB.prepare(
          'SELECT id, from_me, sender_id, sender_name, body, timestamp FROM wa_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20',
        ).bind(chat.id).all();
        out.thread = [...(recent.results || [])].sort((a, b) => a.timestamp - b.timestamp);
      }
    }
  } else if (item.kind === 'osint_mention' && item.ref_kind === 'osint_mentions' && item.ref_id) {
    try {
      const m = await env.DB.prepare('SELECT * FROM osint_mentions WHERE id = ?').bind(item.ref_id).first();
      if (m) out.mention = m;
    } catch { /* table may not exist yet */ }
  }
  return out;
}

export async function insertDigestItem(env, item, { refresh = false } = {}) {
  const id = item.id || ('dig_' + uid().slice(0, 12));
  const cols = `(id, kind, ref_kind, ref_id, title, summary, source_label, source_url,
       urgency, actionable, suggested_action, starred, read_at, created_at, meta_json)`;
  const vals = `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`;
  // Two modes on an id collision:
  //  • default — INSERT OR IGNORE: a re-run of the same id is a silent no-op.
  //    Every content puller (WA/OSINT/heartbeat/insights) relies on this so a
  //    read/dismissed item never resurrects and its created_at stays pinned.
  //  • refresh — upsert the VOLATILE fields (title, summary, urgency, …) while
  //    preserving the operator's read_at/starred and the original created_at.
  //    pullCalendar uses this so an approaching meeting's urgency + "when" text
  //    track the clock instead of freezing at first insert.
  const sql = refresh
    ? `INSERT INTO digest_items ${cols} ${vals}
       ON CONFLICT(id) DO UPDATE SET
         title            = excluded.title,
         summary          = excluded.summary,
         source_label     = excluded.source_label,
         suggested_action = excluded.suggested_action,
         urgency          = excluded.urgency,
         actionable       = excluded.actionable`
    : `INSERT OR IGNORE INTO digest_items ${cols} ${vals}`;
  await env.DB.prepare(sql).bind(
    id,
    item.kind,
    item.ref_kind || null,
    item.ref_id   || null,
    item.title,
    item.summary  || null,
    item.source_label || null,
    item.source_url   || null,
    item.urgency != null ? item.urgency : 2,
    item.actionable ? 1 : 0,
    item.suggested_action || null,
    now(),
    item.meta ? JSON.stringify(item.meta) : null,
  ).run();
  return readDigestItem(env, id);
}

// ─── per-item actions ───────────────────────────────────────
// Drafts the actions an operator can take on a digest item. For WA items
// that's a suggested reply (LLM-drafted using the actual thread); for any
// item the "discuss with Nyo" and "dismiss" actions are always offered.
//
// Shape of each action:
//   { type, label, description, draft?, recipient?, metadata? }
//
// type: 'reply_wa' | 'discuss' | 'dismiss'
// draft: pre-filled body the operator can edit before approving
// recipient: { kind: 'wa_chat', id, name } for reply_wa
// Default WA reply system prompt — fallback when the editable knowledge doc
// `prompt-wa-reply` is absent. To customize for an operator, edit the doc in
// the ops Knowledge surface; this default is the "factory" voice.
const WA_REPLY_SYSTEM_DEFAULT = `You are drafting a WhatsApp reply for Nyyon, an AI marketing agency (founder Lev Kerzhner, B2B startups, AI-driven copy + paid + SEO + brand strategy).

Voice rules:
- Direct, warm, knowledgeable. No fluff.
- Match the language of the thread (Hebrew if the thread is Hebrew, English otherwise).
- Under 4 sentences unless a longer reply is clearly warranted.
- End with a clear next step or question if appropriate.
- No sign-offs like "Best regards". WhatsApp is informal.

Punctuation rules (strict — this is a tell that an LLM wrote it):
- NEVER use em-dash (—) or en-dash (–). Use a comma, parentheses, period, or restructure the sentence.
- NEVER use the ellipsis character (…). Use three dots (...) only if absolutely necessary.
- Use straight quotes (" ') not curly (" " ' ').
- Avoid "—" even when the source thread uses it. The reply is yours, not a quote.

Output ONLY the reply text. No quotes around it, no preamble, no "Sure, here's a draft:" header.`;

// Reads the live system prompt from the knowledge_docs table (slug
// 'prompt-wa-reply'), falling back to the default. Letting operators edit
// the prompt from the Knowledge UI means we don't need a redeploy to
// re-tune voice / ban new tells.
async function getWaReplySystem(env) {
  try {
    const row = await env.DB.prepare("SELECT body FROM knowledge_docs WHERE slug = 'prompt-wa-reply'").first();
    if (row?.body && String(row.body).trim().length > 50) return String(row.body);
  } catch { /* table missing or other transient — fall through */ }
  return WA_REPLY_SYSTEM_DEFAULT;
}

async function draftWaReply(env, item, ctx) {
  const lines = (ctx.thread || []).map((m) => {
    const who = m.from_me ? 'me' : (m.sender_name || m.sender_id || 'someone');
    const t   = new Date(m.timestamp).toISOString().slice(11, 16);
    return `${t} ${who}: ${(m.body || '').slice(0, 240)}`;
  }).join('\n');
  const user = `Digest signal: ${item.title}
Suggested action: ${item.suggested_action || '(none)'}
Context summary: ${item.summary || ''}

Recent thread (${ctx.thread?.length || 0} messages, oldest first):
${lines}

Now draft the reply.`;
  try {
    const system = await getWaReplySystem(env);
    return await callLLMText(env, system, user);
  } catch (e) {
    return '';
  }
}

// Extract a phone number from a WhatsApp sender id. WA participant ids look
// like `972508425412@c.us` or `972508425412@lid` or sometimes embedded in
// `972508425412-1471816179@g.us` (group id, not a sender). Returns
// `+972508425412` style or null when nothing usable.
function phoneFromWaId(id) {
  if (!id) return null;
  const base = String(id).split('@')[0];
  // For group ids we'd get `972508425412-1471816179` — take the leading run.
  const leading = base.split('-')[0];
  const digits  = leading.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 16) return null;
  return '+' + digits;
}

// Pull a likely person name out of free text — used as a fallback when the
// digest item's metadata.full_name is empty. The LLM that drafts the action
// usually surfaces the target's name in plain text ("Help Ohad…", "DM Daniel…"),
// so a Title-Case word after an action verb is the strongest signal. Falls
// back to the first Title-Case token. Single-word output so the downstream
// LIKE query stays loose (matches "Ohad", "Ohad Levi", etc.).
function guessPersonNameFromText(text) {
  if (!text || typeof text !== 'string') return '';
  // After a directing verb, the name is almost always next.
  const verbHit = text.match(/\b(?:DM|dm|message|ping|send|reply to|reach out to|follow up with|help|introduce|intro|pitch|email)\s+([A-Z][a-zA-Z'-]{1,24})/);
  if (verbHit) return verbHit[1];
  // Otherwise take the first plausible Title-Case word that isn't a
  // boilerplate stopword the LLM might lead with.
  const STOP = new Set(['Nyyon', 'WhatsApp', 'LinkedIn', 'AI', 'Help', 'Message', 'Reply', 'DM', 'Send', 'Pitch']);
  const tokens = text.match(/\b[A-Z][a-zA-Z'-]{1,24}\b/g) || [];
  for (const t of tokens) if (!STOP.has(t)) return t;
  return '';
}

// wa-gateway encodes the message author at the tail of the message id for
// group messages, even when the webhook payload's `author`/`participant`
// fields are missing. Format observed:
//   `false_120363427775223901@g.us_3A6EA2…_183300681392151@lid`
//   `true_972504443434@c.us_3EB0…_out`
//   `false_120363@g.us_3A6E…_972545492444@c.us`
// We split on `_`, look for the last token that ends in `@c.us` or `@lid`
// AND isn't the chat id itself, and return it. Null if nothing usable.
function extractAuthorFromMessageId(messageId, chatId) {
  if (!messageId || typeof messageId !== 'string') return null;
  const parts = messageId.split('_');
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p || p === chatId) continue;
    if (/^[0-9-]+@(c\.us|lid)$/i.test(p)) return p;
  }
  return null;
}

// Live wa-gateway roster lookup — given a group id and a name we're chasing,
// fetch the group's participants and return the best name match. Each
// participant carries an `id` (phone@c.us, sometimes phone@lid for newer
// accounts) plus various pushname/contact-name fields depending on what
// wa-gateway could resolve. We normalize case, strip non-letters, and prefer
// exact-substring hits over loose matches. Returns { phone, name } on a
// match, null otherwise.
async function matchGroupParticipantByName(env, groupId, targetName) {
  // Live group rosters came from the retired wa-gateway daemon; without it
  // there is nothing to match against. Callers already handle null.
  return null;
  /* eslint-disable no-unreachable */
  if (!groupId || !targetName) return null;
  const info = { participants: [] };
  const target = String(targetName).toLowerCase().replace(/[^a-zא-ת]/gi, '');
  if (!target) return null;
  let best = null;
  for (const p of (info.participants || [])) {
    // wa-gateway / whatsapp-web.js gives us many possible name fields depending
    // on whether the contact is in the user's address book, only in the
    // group, or just a pushname.
    const candidates = [
      p.contact?.name,
      p.contact?.pushname,
      p.contact?.shortName,
      p.contact?.formattedName,
      p.name,
      p.pushname,
      p.notifyName,
      p.shortName,
      p.formattedName,
    ].filter(Boolean);
    for (const c of candidates) {
      const flat = String(c).toLowerCase().replace(/[^a-zא-ת]/gi, '');
      if (!flat) continue;
      if (flat.includes(target) || target.includes(flat)) {
        // Prefer exact-substring matches that share the leading characters
        // (e.g. "ohad" matches "ohadl" better than "yohadan").
        const score = flat.startsWith(target) || target.startsWith(flat) ? 10 : 5;
        if (!best || score > best.score) {
          // Pull a usable phone out of the participant id — wa-gateway uses
          // various jid formats; strip everything but digits.
          const id = p.id?._serialized || p.id?.user || p.id || p.jid || '';
          const digits = String(id).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
          if (digits.length >= 7 && digits.length <= 16) {
            best = { phone: '+' + digits, name: c, score };
          }
        }
      }
    }
  }
  return best;
}

function bestSenderFromContext(ctx) {
  // Prefer the original ref'd message; otherwise newest non-from_me line in
  // the thread; otherwise the chat itself (for DMs).
  if (ctx.message && !ctx.message.from_me) {
    return { id: ctx.message.sender_id, name: ctx.message.sender_name };
  }
  for (const m of (ctx.thread || []).slice().reverse()) {
    if (!m.from_me && (m.sender_id || m.sender_name)) {
      return { id: m.sender_id, name: m.sender_name };
    }
  }
  if (ctx.chat && !ctx.chat.is_group) {
    return { id: ctx.chat.id, name: ctx.chat.name };
  }
  return { id: null, name: null };
}

// Pull every LinkedIn profile/company URL + email out of the digest context
// so the wishlist contact gets enriched on first click. Looks at the
// referenced message, the surrounding thread, the LLM-summary, and the
// suggested action. Returns first hit for each (best signal-to-noise).
const LINKEDIN_URL_RE = /https?:\/\/(?:www\.)?linkedin\.com\/[^\s)>\]'"]+/i;
const EMAIL_RE        = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
function extractEnrichmentFromContext(ctx, senderId) {
  const haystack = [
    ctx.item.title || '',
    ctx.item.summary || '',
    ctx.item.suggested_action || '',
    ctx.message?.body || '',
    ...(ctx.thread || [])
      // Skip outbound and skip messages from people other than the sender we
      // identified — otherwise random group chatter contaminates the contact.
      .filter((m) => !m.from_me && (!senderId || m.sender_id === senderId))
      .map((m) => m.body || ''),
    // Fall back to scanning the whole thread for LinkedIn URLs — operators
    // often share a profile from a different number.
    ...(ctx.thread || []).filter((m) => !m.from_me).map((m) => m.body || ''),
  ].join('\n');
  const li = haystack.match(LINKEDIN_URL_RE);
  const em = haystack.match(EMAIL_RE);
  return {
    linkedin_url: li ? li[0].replace(/[.,;:!?)\]>'"]+$/, '') : null,
    email:        em ? em[0] : null,
  };
}

export async function draftDigestActions(env, id) {
  const ctx = await getDigestItemContext(env, id);
  if (!ctx) return { item: null, actions: [] };
  const item = ctx.item;
  const actions = [];

  if ((item.kind === 'wa_group' || item.kind === 'wa_message') && ctx.chat) {
    const sender = bestSenderFromContext(ctx);
    let senderPhone = phoneFromWaId(sender.id);
    let senderName  = sender.name || null;
    // Recipient id we'll actually pass to wa-gateway when DMing. Defaults to the
    // sender id but gets overridden below as we recover better identifiers.
    let senderRecipientId = sender.id || null;

    // wa-gateway encodes the author into the trailing segment of the message id
    // for group messages, even when the top-level `author` / `participant`
    // fields are missing. Format:
    //   <fromMe>_<chatId>_<msgHash>_<authorId>
    // where authorId is either `<digits>@c.us` (legacy phone format) or
    // `<digits>@lid` (modern LinkedID). Both are valid DM targets — sendText
    // just passes the chatId through to whatsapp-web.js which dispatches on
    // jid type. This is the zero-friction recovery path: no contact add, no
    // roster fetch, no name match needed.
    if (!senderPhone && ctx.chat.is_group && ctx.message?.id) {
      const embeddedAuthor = extractAuthorFromMessageId(ctx.message.id, ctx.chat.id);
      if (embeddedAuthor) {
        senderRecipientId = embeddedAuthor;
        // For naming the dropdown row, keep whatever sender_name we have or
        // fall back to the readable digits.
        senderName = senderName || embeddedAuthor.split('@')[0];
        // Mark senderPhone as truthy so the rest of the pipeline (router
        // LLM gating, recipient build) knows we have a target to DM. The
        // actual recipient.id will be `embeddedAuthor` (preserving @lid).
        senderPhone = senderName;
      }
    }

    // Recover the "real" target person when we don't have one in the message
    // metadata. wa-gateway payloads occasionally lack the `author` field on group
    // messages → sender_id ends up as the group jid → senderPhone null.
    // Three-tier recovery, fastest to slowest:
    //   1. metadata.full_name (LLM-extracted at digest time).
    //   2. Title-Case name pulled out of the digest title or suggested_action
    //      ("Help Ohad reach…", "DM Daniel a positioning angle…").
    //   3. Match the name against the live group participant roster (single
    //      wa-gateway call) — works even when the person isn't in our contacts
    //      yet. This is the zero-friction path: no manual contact add,
    //      no copy-paste; the operator clicks Send and the message lands.
    let targetName = (item.metadata?.full_name || '').trim() || guessPersonNameFromText(`${item.title || ''} ${item.suggested_action || ''}`);
    if (!senderPhone && ctx.chat.is_group && targetName) {
      // First try contacts — cheap DB lookup, gives us the canonical name
      // and any enrichment (linkedin/email) the operator's already attached.
      const contact = await env.DB.prepare(
        `SELECT id, full_name, phone FROM contacts WHERE phone IS NOT NULL AND LOWER(full_name) LIKE LOWER(?) ORDER BY updated_at DESC LIMIT 1`
      ).bind(`%${targetName}%`).first();
      if (contact?.phone) {
        const digits = String(contact.phone).replace(/[^0-9]/g, '');
        if (digits.length >= 7 && digits.length <= 16) {
          senderPhone = '+' + digits;
          senderName  = contact.full_name || senderName;
          targetName  = contact.full_name || targetName;
        }
      }
    }
    if (!senderPhone && ctx.chat.is_group && targetName) {
      // Live roster fallback — fetch the group participants from wa-gateway and
      // fuzzy-match on the WhatsApp pushname / contact name. Roster fetch
      // tolerates failure (gateway down, permission denied) by returning a
      // null match; the operator can still pick "DM another contact" manually.
      const matched = await matchGroupParticipantByName(env, ctx.chat.id, targetName).catch(() => null);
      if (matched?.phone) {
        senderPhone = matched.phone;
        senderName  = matched.name || senderName || targetName;
        targetName  = matched.name || targetName;
      }
    }

    // ALWAYS run the router LLM for group items — even without a resolved
    // private recipient. If the LLM picks 'private' and we have no candidate,
    // the response carries `recommended_target_name` so the UI can auto-pop
    // the contact picker pre-filled with the right name. Without this, we'd
    // silently default to "group" any time sender resolution failed.
    const needsRouting = !!ctx.chat.is_group;
    const [draft, recRaw] = await Promise.all([
      draftWaReply(env, item, ctx),
      needsRouting ? inferDeliveryChannel(env, item, ctx, '').catch(() => null) : Promise.resolve(null),
    ]);

    // Build the set of valid delivery recipients. Group items get TWO
    // options: reply in the group (default for public / referral asks) OR
    // DM the sender (default for sales / sensitive / 1:1 follow-ups).
    const recipients = [];
    if (ctx.chat.is_group) {
      recipients.push({
        kind: 'wa_chat', mode: 'group',
        id:    ctx.chat.id,
        name:  ctx.chat.name || ctx.chat.id,
        label: `Reply in ${ctx.chat.name || 'the group'}`,
      });
      if (senderPhone) {
        // Prefer the recovered recipient id verbatim — could be a
        // `@c.us` jid (legacy phone), a `@lid` jid (modern LinkedID
        // extracted from the message id), or a constructed phone jid
        // when we resolved via contacts. Falls back to a synthesized
        // phone jid only when we have nothing more specific.
        const dmId = senderRecipientId && /@(c\.us|lid)$/i.test(senderRecipientId)
          ? senderRecipientId
          : (typeof senderPhone === 'string' && senderPhone.startsWith('+'))
            ? senderPhone.replace('+', '') + '@c.us'
            : senderRecipientId;
        if (dmId) {
          // Display name resolution order: actual sender_name from the
          // message → LLM-extracted target name → readable id digits.
          // For @lid recipients, the id digits aren't a phone, so we
          // strongly prefer the targetName ("Ohad") over showing
          // "183300681392151".
          const displayName =
            (sender.name && sender.name.trim())
              ? sender.name.trim()
              : (targetName && targetName.trim())
                ? targetName.trim()
                : dmId.split('@')[0];
          recipients.push({
            kind: 'wa_chat', mode: 'private',
            id:    dmId,
            name:  displayName,
            label: `DM ${displayName}`,
          });
        }
      }
    } else {
      recipients.push({
        kind: 'wa_chat', mode: 'private',
        id:    ctx.chat.id,
        name:  ctx.chat.name || ctx.chat.id,
        label: `Reply to ${ctx.chat.name || ctx.chat.id}`,
      });
    }

    // Apply the channel pick. Three-tier resolution:
    //   1. Router LLM result (most context-aware, but can throw / return
    //      garbage; that's why this whole block is defensive).
    //   2. Deterministic fallback: when the suggested_action is an explicit
    //      "DM/message/ping/reach out to <Name>", pick private. The action
    //      wording is the operator's stated intent at digest time; trusting
    //      it beats silently falling back to group whenever the LLM hiccups.
    //   3. First-recipient default (group for group items, private for DMs).
    let recommended_mode   = recipients[0]?.mode || 'group';
    let recommended_reason = null;
    if (recRaw && (recRaw.target === 'group' || recRaw.target === 'private')) {
      recommended_mode   = recRaw.target;
      recommended_reason = recRaw.reason || null;
    } else if (ctx.chat.is_group) {
      const action = (item.suggested_action || '').toLowerCase();
      const namesAPersonInAction = /\b(?:dm|message|ping|send|reply to|reach out to|follow up with|text|email)\s+[a-z֐-׿]/i.test(action);
      if (namesAPersonInAction) {
        recommended_mode   = 'private';
        recommended_reason = 'Suggested action explicitly names a person to DM/message — defaulted to private.';
      }
    }
    const chosen = recipients.find((r) => r.mode === recommended_mode) || recipients[0];

    actions.push({
      type: 'reply_wa',
      label: 'Reply on WhatsApp',
      description: chosen.label,
      draft,
      recipient: chosen,
      recipients,
      recommended_mode,
      recommended_reason,
      // Pass the LLM-extracted (or fallback-extracted) target person name
      // so the drawer can pre-fill the contact picker even when no contact
      // record exists yet. Lets the operator search-and-add in one flow.
      recommended_target_name: targetName || null,
    });

    // Wishlist action — reuses the sender / senderPhone we resolved above.
    const phone       = senderPhone;
    const displayName = sender.name || phone || (ctx.chat.is_group ? null : ctx.chat.name);
    const enrichment  = extractEnrichmentFromContext(ctx, sender.id);
    if (sender.id || displayName) {
      actions.push({
        type: 'add_to_wishlist',
        label: 'Mark person as interesting',
        description: displayName
          ? `Add ${displayName} to Contacts as a prospect (wishlist) with the context attached.`
          : 'Add this person to Contacts as a prospect (wishlist).',
        metadata: {
          full_name:    displayName,
          phone,
          sender_id:    sender.id,
          chat_name:    ctx.chat.name,
          linkedin_url: enrichment.linkedin_url,
          email:        enrichment.email,
        },
      });
    }
  }

  // OSINT mention → reply_wa-shaped action so the drawer can reuse all
  // of its existing UI (recipient picker, draft textarea, send button).
  // Recipients are TWO logical buckets, presented as one merged list:
  //   1. "Answer an open ask" — recent unread WA group questions the LLM
  //      thinks this story actually addresses. Each carries the original
  //      question's message id so executeDigestAction can quote-reply.
  //   2. "Post a take in a group" — every WA chat the operator follows
  //      (auto_listen=1). Plain sendText, no quote.
  // Recommended mode = first ask match if any (highest signal), else most
  // recently active followed group. Defaults to whichever bucket has data.
  if (item.kind === 'osint_mention' && ctx.mention) {
    try {
      const osintAction = await draftOsintShareAction(env, item, ctx);
      if (osintAction) actions.push(osintAction);
    } catch (e) {
      // Non-fatal — leave the operator with discuss + dismiss if the
      // drafter trips. Log so the failure is visible in activity.
      await logEvent(env, { kind: 'osint_share_draft_failed', actor: 'system', payload: { digest_id: id, error: String(e?.message || e).slice(0, 300) } });
    }
  }

  // News/signal/insight cards ("Draft a take") — turn the item itself into
  // a real blog draft or social reaction, reusing the exact pipelines a
  // manually-written post goes through. Generation happens on click (see
  // executeDigestAction), not here, so opening the drawer stays instant.
  if (item.kind === 'content_opportunity' || item.kind === 'osint_insight' || item.kind === 'osint_mention') {
    actions.push({
      type: 'draft_blog',
      label: 'Draft a blog post',
      description: 'Write this up through the normal article pipeline (house style, diagrams, cover). Lands as a draft in the Blog module for review.',
    });
    actions.push({
      type: 'draft_social',
      label: 'Draft a social commentary',
      description: 'Draft LinkedIn/Facebook reaction posts in Nyyon\'s voice. Lands as drafts in the Social module for review + send.',
    });
  }

  actions.push({
    type: 'discuss',
    label: 'Discuss with Nyo',
    description: 'Open in the full Nyo chat with this item pre-loaded as context.',
  });

  actions.push({
    type: 'dismiss',
    label: 'Mark read',
    description: 'Dismiss from the brief. The item stays in the activity log.',
  });

  return { item, context: ctx, actions };
}

// Turn a Digest item's own content into a real blog draft. Reuses
// composeAndSavePost — the same house-style rewrite + diagrams + cover
// pipeline every Nyo-written post goes through. When the item is
// heartbeat-backed (osint_signals) we pull the full source article first,
// so the pipeline reshapes real substance rather than just a headline.
async function draftBlogFromDigestItem(env, item) {
  let body = item.summary || item.title || '';
  if (item.ref_kind === 'osint_signals' && item.ref_id) {
    try {
      const { readSignalContent } = await import('./heartbeat.js');
      const sig = await readSignalContent(env, item.ref_id);
      if (sig?.full_text) body = sig.full_text.slice(0, 6000);
    } catch { /* fall back to the digest summary */ }
  }
  const parts = [body];
  if (item.suggested_action) parts.push(`Angle: ${item.suggested_action}`);
  if (item.source_url) parts.push(`Source: ${item.source_url}`);

  const { composeAndSavePost } = await import('./aeo-writer.js');
  const result = await composeAndSavePost(env, {
    title: item.title,
    body:  parts.filter(Boolean).join('\n\n'),
    actor: 'digest',
  });
  await markDigestSourceActioned(env, item);
  return result;
}

// Draft (not send) a reaction post per social channel — same drafting +
// Social-module review flow published articles get (see social-posts.js).
async function draftSocialFromDigestItem(env, item) {
  const { generateSocialPostsForDigestItem } = await import('./social-posts.js');
  const result = await generateSocialPostsForDigestItem(env, item);
  await markDigestSourceActioned(env, item);
  return result;
}

// Flip the underlying heartbeat row so an actioned signal/topic doesn't
// keep resurfacing in future digests as still fresh. Best-effort — a
// failure here shouldn't sink the draft that already succeeded.
async function markDigestSourceActioned(env, item) {
  try {
    if (item.ref_kind === 'osint_signals' && item.ref_id) {
      await env.DB.prepare(`UPDATE osint_signals SET status='actioned' WHERE id=?`).bind(item.ref_id).run();
    } else if (item.ref_kind === 'osint_topics' && item.ref_id) {
      await env.DB.prepare(`UPDATE osint_topics SET status='actioned' WHERE id=?`).bind(item.ref_id).run();
    }
  } catch { /* best effort */ }
}

// ─── OSINT share / reply-to-ask drafter ───────────────────────
// Builds a reply_wa-shaped action whose recipients are EITHER:
//   - "Reply to <person>'s question in <group>" — quote-reply to a recent
//     unread WA group ask the LLM believes is thematically related to the
//     OSINT headline.
//   - "Post a take in <group>" — fresh sendText into a followed WA chat.
// Returns null when no recipients are available (no followed chats AND
// no relevant open asks) so the caller doesn't push an empty action.
async function draftOsintShareAction(env, item, ctx) {
  // ── Recipient bucket 1: open asks worth answering with this news ──
  // Window: last 5 days of WA-group digest items the operator hasn't
  // dismissed. Limit kept small (20) so the LLM relevance pass stays
  // cheap. The matcher filters down to genuinely-on-topic asks.
  const askWindowMs = 5 * 24 * 60 * 60 * 1000;
  const asksRes = await env.DB.prepare(`
    SELECT di.id AS digest_id, di.title, di.summary, di.suggested_action,
           di.meta_json, di.ref_id AS msg_id, m.chat_id, m.id AS message_id,
           c.id AS chat_full_id, c.name AS chat_name
      FROM digest_items di
      LEFT JOIN wa_messages m ON m.id = di.ref_id
      LEFT JOIN wa_chats    c ON c.id = m.chat_id
     WHERE di.kind        = 'wa_group'
       AND di.read_at IS NULL
       AND di.actionable  = 1
       AND di.created_at >= ?
       AND m.id  IS NOT NULL
       AND c.id  IS NOT NULL
     ORDER BY di.created_at DESC
     LIMIT 20
  `).bind(now() - askWindowMs).all();
  const askCandidates = asksRes.results || [];

  // LLM relevance: which asks does THIS OSINT headline actually answer?
  // Cheap one-shot call returning {matches:[{digest_id, reason}]}. We
  // ask for STRICT matching — false positives ("Anthropic news → any
  // AI question") would put off-topic noise in front of real questions.
  let askMatches = [];
  if (askCandidates.length > 0) {
    const sys = `You are matching an industry news headline against open questions someone asked in WhatsApp groups. Return only the questions this headline DIRECTLY answers — the headline must contain useful, specific information the asker would value RIGHT NOW. Do NOT match a generic news item to a broad question just because they share a topic. Return JSON: {"matches":[{"digest_id":"<id>","reason":"<one short clause>"}]}.`;
    const ctxLines = askCandidates.map((a) => {
      const action = a.suggested_action || '';
      const summary = (a.summary || '').slice(0, 240);
      return `- id:${a.digest_id} | group:${a.chat_name || a.chat_full_id} | title:${a.title} | ask:${action} | summary:${summary}`;
    }).join('\n');
    const user = `Headline: ${item.title}
Headline summary: ${(item.summary || '').slice(0, 600)}

Open asks (up to 20, candidates only):
${ctxLines}

Return matches — STRICT — only asks this headline directly answers.`;
    try {
      const r = await callLLMJson(env, sys, user, { maxTokens: 1500 });
      askMatches = Array.isArray(r?.matches) ? r.matches : [];
    } catch {
      askMatches = [];
    }
  }
  const matchedAskById = new Map();
  for (const m of askMatches) {
    if (m?.digest_id) matchedAskById.set(m.digest_id, m.reason || null);
  }

  // ── Recipient bucket 2: every followed WA chat (auto_listen=1) ──
  // Sorted by last_message_at DESC so the most-active groups float to
  // the top of the picker.
  const chatsRes = await env.DB.prepare(`
    SELECT id, name, is_group, last_message_at
      FROM wa_chats
     WHERE auto_listen = 1
     ORDER BY COALESCE(last_message_at, 0) DESC
     LIMIT 30
  `).all();
  const followedChats = chatsRes.results || [];

  // Build the merged recipients list. Matched asks come first (highest
  // signal); followed groups follow as the "post a take" fallbacks. Same
  // group can legitimately appear twice — once as "answer X's question",
  // once as "post a take in <group>" — they're different operator intents.
  const recipients = [];
  for (const ask of askCandidates) {
    if (!matchedAskById.has(ask.digest_id)) continue;
    const reason = matchedAskById.get(ask.digest_id);
    const personGuess = guessPersonNameFromText(`${ask.title || ''} ${ask.suggested_action || ''}`) || 'someone';
    recipients.push({
      kind:  'wa_chat',
      mode:  'reply_to_ask',
      id:    ask.chat_full_id,
      name:  ask.chat_name || ask.chat_full_id,
      label: `Reply to ${personGuess}'s question in ${ask.chat_name || 'the group'}`,
      // Carry the source ask's message id so executeDigestAction can
      // quote-reply on it inside the originating group.
      quotedMessageId:    ask.message_id,
      source_digest_id:   ask.digest_id,
      source_ask_summary: (ask.summary || '').slice(0, 280),
      match_reason:       reason,
    });
  }
  for (const c of followedChats) {
    recipients.push({
      kind:  'wa_chat',
      mode:  'group',
      id:    c.id,
      name:  c.name || c.id,
      label: `Post a take in ${c.name || c.id}`,
    });
  }

  if (recipients.length === 0) return null;

  // Default: the top-ranked ask match if any (LLM put it first), else
  // the most-recently-active followed group. The operator can switch
  // from the drawer dropdown.
  const recommended = recipients[0];

  // Draft the take. For ask replies we hand the LLM the ask context too,
  // so it weaves the answer in. For plain group posts it's just the
  // headline + Lev's voice.
  const draft = await draftOsintShareText(env, item, ctx, recommended);

  return {
    type:        'reply_wa',
    label:       recommended.mode === 'reply_to_ask' ? 'Answer with this news' : 'Share a take in a group',
    description: recommended.label,
    draft,
    recipient:        recommended,
    recipients,
    recommended_mode: recommended.mode,
  };
}

// LLM-draft the actual message body. Lev's voice; 2-3 sentences. When
// the chosen recipient is a "reply_to_ask", weave the ask context in.
async function draftOsintShareText(env, item, ctx, recipient) {
  const headline = item.title || '';
  const summary  = (item.summary || '').slice(0, 800);
  const url      = ctx?.mention?.source_url || item.source_url || null;
  const isAskReply = recipient?.mode === 'reply_to_ask';

  const baseRules = `Voice rules:
- Direct, warm, knowledgeable. Lev Kerzhner's voice — Nyyon (AI marketing agency, B2B startups, AI-driven copy + paid + SEO + brand).
- 2-3 sentences max. No fluff. No "Hey everyone".
- Match the language of the group/person you're posting to. If the group/ask is Hebrew, write Hebrew. Otherwise English.
- No em-dash (—), no ellipsis character (…), straight quotes only.
- No sign-offs.`;

  let system, user;
  if (isAskReply) {
    system = `You are drafting a WhatsApp reply that answers a specific question someone asked in a group, using a piece of news as the substance of the answer.

${baseRules}

Structure:
- Start by addressing what they asked (one short clause).
- Land the news fact / link succinctly.
- Optionally one sentence of your read on what it means for them.

Output ONLY the reply text. No preamble.`;
    user = `Open question to answer:
- group: ${recipient.name}
- ask context: ${recipient.source_ask_summary || '(empty)'}
- why this news fits: ${recipient.match_reason || '(headline addresses their topic)'}

News to reference:
- headline: ${headline}
- detail: ${summary}
${url ? `- source url: ${url}` : ''}

Now draft the reply.`;
  } else {
    system = `You are drafting a short WhatsApp post sharing a piece of industry news with a group.

${baseRules}

Structure:
- Lead with the news (one clause).
- One sentence of your take — why it matters or what it changes.
- Optionally one short follow-up question to spark replies.

Output ONLY the post text. No preamble.`;
    user = `Group you're posting into: ${recipient.name}

News:
- headline: ${headline}
- detail: ${summary}
${url ? `- source url: ${url}` : ''}

Now draft the post.`;
  }

  try {
    return await callLLMText(env, system, user, { maxTokens: 500 });
  } catch {
    // Fall back to a bare quoted-headline so the operator at least sees
    // something they can edit, instead of an empty textarea.
    return `${headline}${url ? `\n${url}` : ''}`;
  }
}

export async function executeDigestAction(env, id, action) {
  if (!action?.type) throw new Error('action.type required');
  const ctx = await getDigestItemContext(env, id);
  if (!ctx) throw new Error('digest item not found');

  if (action.type === 'reply_wa') {
    const draftText = (action.text || action.draft || '').trim();
    if (!draftText) throw new Error('reply text is empty — edit the draft and try again');
    const chatId = action.recipient?.id || ctx.chat?.id;
    if (!chatId) throw new Error('no WhatsApp chat on this item — can\'t reply');
    // Quoted-reply only works WITHIN the chat that contains the quoted
    // message. When the operator picked "DM the sender" (recipient.id is
    // the @lid author OR a different @c.us), we'd be quoting a message
    // that lives in a different chat — wa-gateway's /reply returns 500 in
    // that case.
    //
    // Quote source — TWO origins:
    //   1. ctx.message?.id      — the original WA item this digest row
    //      is built from (only present for kind in wa_group/wa_message).
    //   2. action.recipient.quotedMessageId — populated when the digest
    //      row is OSINT and the operator picked "Reply to <person>'s
    //      ask" — carries the asker's message id so we can quote-reply
    //      to them with the news in-thread.
    // Recipient-supplied quote takes priority so OSINT→ask replies
    // route correctly even when the digest item has no native ctx.message.
    const quotedMessageId = action.recipient?.quotedMessageId || ctx.message?.id || null;
    const sourceChatId    = action.recipient?.quotedMessageId
      ? action.recipient.id
      : (ctx.message?.chat_id || ctx.chat?.id || null);
    const canQuoteReply   = !!quotedMessageId && sourceChatId === chatId;
    // ponytail: send the operator's text VERBATIM — never prepend/append
    // anything. (Previously a cross-chat "about <topic>…" opener was added;
    // it leaked an embarrassing preamble into real messages. Gone.)
    const text = draftText;
    // A scheduled reply always rides the queue plain (quoting cannot wait);
    // send_at is a ms epoch from the ScheduleSend popover.
    const notBefore = Number(action.send_at)
      ? new Date(Number(action.send_at)).toISOString().slice(0, 16).replace('T', ' ')
      : null;
    const res = (canQuoteReply && !notBefore)
      ? await waReply(env, { chatId, quotedMessageId, text })
      : await waSendText(env, { chatId, text }, notBefore ? { not_before: notBefore } : {});
    // Do NOT archive on reply — the operator may also want to draft a blog/social
    // take from the same item. Only an explicit dismiss (✕) archives.
    await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'reply_wa', chatId, quotedMessageId: canQuoteReply ? quotedMessageId : null, messageId: res.messageId || null, queue_id: res.queue_id || null } });
    return { ok: true, sent: res, quoted: canQuoteReply };
  }

  if (action.type === 'add_to_wishlist') {
    // Re-derive enrichment from the live context so the executor always has
    // the most recent linkedin/email even if the client sent stale metadata.
    const sender    = bestSenderFromContext(ctx);
    const meta      = action.metadata || {};
    const phone     = action.phone || meta.phone || phoneFromWaId(sender.id);
    const full_name = action.full_name || meta.full_name || sender.name || sender.id || 'WhatsApp contact';
    const live      = extractEnrichmentFromContext(ctx, sender.id);
    const linkedin_url = action.linkedin_url || meta.linkedin_url || live.linkedin_url || null;
    const email        = action.email        || meta.email        || live.email        || null;
    const extraNote = (action.note || '').trim();

    // Look up by phone if available, else by full_name (best-effort match).
    let existing = null;
    if (phone) {
      existing = await env.DB.prepare('SELECT * FROM contacts WHERE phone = ? LIMIT 1').bind(phone).first();
    }
    if (!existing && full_name) {
      existing = await env.DB.prepare('SELECT * FROM contacts WHERE full_name = ? LIMIT 1').bind(full_name).first();
    }

    // Build the auto-context note.
    const item = ctx.item;
    const noteLines = [
      `From digest item · ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')}`,
      ctx.chat?.name ? `Chat: ${ctx.chat.name}` : null,
      `Title: ${item.title}`,
      item.summary ? `Why: ${item.summary}` : null,
      item.suggested_action ? `Suggested: ${item.suggested_action}` : null,
      ctx.message?.body ? `Original message: "${ctx.message.body.slice(0, 300)}"` : null,
      extraNote ? `Note: ${extraNote}` : null,
    ].filter(Boolean);
    const note = noteLines.join('\n');

    const mergedTags = new Set();
    if (existing) {
      try { for (const t of (JSON.parse(existing.tags || '[]'))) mergedTags.add(t); } catch {}
    }
    mergedTags.add('wishlist');

    const contact = await writeContact(env, {
      id:        existing?.id, // upsert when phone+name matches
      full_name,
      phone:     phone ?? existing?.phone ?? null,
      email:     email ?? existing?.email ?? null,
      linkedin_url: linkedin_url ?? existing?.linkedin_url ?? null,
      status:    existing?.status === 'client' || existing?.status === 'partner'
        ? existing.status                   // never downgrade a real client/partner to prospect
        : 'prospect',
      source:    existing?.source || 'inbound_wa',
      tags:      [...mergedTags],
      notes:     existing?.notes ? `${existing.notes}\n\n---\n${note}` : note,
      updated_by: 'digest',
      created_by: existing ? undefined : 'digest',
    });

    // Adding to the wishlist isn't "done with the item" — leave it in the brief;
    // only an explicit dismiss archives.
    await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'add_to_wishlist', contact_id: contact.id, phone } });
    return { ok: true, contact };
  }

  if (action.type === 'dismiss') {
    await patchDigestItem(env, id, { read: true });
    await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'dismiss' } });
    return { ok: true };
  }

  if (action.type === 'draft_take') {
    // Pin the item as a Hot Takes topic and run the produce chain, which by
    // design STOPS at the angle gate: the Angle Document lands for the
    // operator to argue with; nothing writes an article from here.
    const { pinTopic } = await import('./hot-takes.js');
    const pkg = await pinTopic(env, {
      origin_ref: 'digest:' + id,
      title: ctx.item.title,
      summary: ctx.item.summary || null,
    }, 'operator');
    const { runWorkflow } = await import('../workflows/runner.js');
    const run = await runWorkflow(env, 'hottake-produce', { id: pkg.id }, { trigger_kind: 'event' }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'draft_take', package_id: pkg.id } });
    return { ok: true, package_id: pkg.id, run: run?.ok ?? null };
  }

  if (action.type === 'draft_blog') {
    const result = await draftBlogFromDigestItem(env, ctx.item);
    // Drafting a blog does NOT archive — the operator may still want to reply or
    // draft social from the same item. Only an explicit dismiss archives.
    if (result.ok) await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'draft_blog', slug: result.slug } });
    return result;
  }

  if (action.type === 'draft_social') {
    const result = await draftSocialFromDigestItem(env, ctx.item);
    if (result.ok) await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'draft_social', slug: result.slug, drafted: result.drafted } });
    return result;
  }

  // 'discuss' is handled entirely client-side (it nav's to Nyo). It does NOT
  // archive — only an explicit dismiss removes an item from the brief.
  if (action.type === 'discuss') {
    await logEvent(env, { kind: 'digest_action', actor: 'operator', payload: { id, type: 'discuss' } });
    return { ok: true };
  }

  throw new Error(`unknown action type: ${action.type}`);
}

export async function clearReadDigestItems(env) {
  const r = await env.DB.prepare('DELETE FROM digest_items WHERE read_at IS NOT NULL').run();
  const cleared = r.meta?.changes ?? 0;
  if (cleared > 0) await logEvent(env, { kind: 'digest_cleared', actor: 'operator', payload: { cleared } });
  return { cleared };
}

// ─── generator ──────────────────────────────────────────────
// Rule-based v1 — scans last `since_ms` of inbound WhatsApp group messages +
// OSINT mentions, dedupes against already-present digest items, inserts new
// ones. LLM summarization is a v2 enhancement; for now we copy text + classify
// urgency based on simple heuristics (mentions of "rfp", "deal", "now", etc.).
const URGENCY_HOTWORDS = [
  /\b(urgent|asap|now|today|emergency|fire|deadline|tomorrow)\b/i,
  /\b(rfp|proposal|signed|contract|invoice|paying|payment|offer)\b/i,
];
function urgencyOf(text) {
  if (!text) return 3;
  if (URGENCY_HOTWORDS[0].test(text)) return 1;
  if (URGENCY_HOTWORDS[1].test(text)) return 2;
  return 3;
}
function actionableOf(text) {
  if (!text) return 0;
  return /\?|please|can you|need|call|reply|asap|today|rfp|proposal/i.test(text) ? 1 : 0;
}

// ─── channels (the data sources feeding the digest) ─────────
export async function listDigestChannels(env) {
  const r = await env.DB.prepare('SELECT * FROM digest_channels ORDER BY enabled DESC, source ASC').all();
  return r.results || [];
}
export async function readDigestChannel(env, source) {
  return env.DB.prepare('SELECT * FROM digest_channels WHERE source = ?').bind(source).first();
}
export async function patchDigestChannel(env, source, patch) {
  const existing = await readDigestChannel(env, source);
  if (!existing) throw new Error(`unknown digest channel ${source}`);
  const t = now();
  await env.DB.prepare(`
    UPDATE digest_channels
       SET enabled = ?, cadence = ?, notes = ?, updated_at = ?
     WHERE source = ?
  `).bind(
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
    patch.cadence ?? existing.cadence,
    patch.notes   ?? existing.notes,
    t,
    source,
  ).run();
  await logEvent(env, { kind: 'digest_channel_updated', actor: 'operator', payload: { source, enabled: patch.enabled !== undefined ? !!patch.enabled : !!existing.enabled } });
  return readDigestChannel(env, source);
}
async function recordChannelRun(env, source, { ok, added, error }) {
  const t = now();
  await env.DB.prepare(`
    UPDATE digest_channels
       SET last_run_at = ?, last_status = ?, last_error = ?,
           total_runs  = total_runs + 1,
           total_added = total_added + ?,
           updated_at  = ?
     WHERE source = ?
  `).bind(t, ok ? 'ok' : 'error', error || null, added || 0, t, source).run();
}
async function isChannelEnabled(env, source) {
  const row = await readDigestChannel(env, source);
  // If the row doesn't exist yet (pre-migration env) treat as enabled so
  // generator stays backwards-compatible.
  return row ? !!row.enabled : true;
}

// ─── per-source pulls ───────────────────────────────────────
// LLM-driven WhatsApp digest. Instead of dumping every inbound message
// (the v1 regex-urgency approach), we feed the last 7 days of conversation
// per auto-listen chat to the LLM and ask it to identify points of contact /
// opportunities / actionable threads. This is what the operator actually
// needs in a morning brief.
// Lookback window for WhatsApp chat scans. Was 7 days; operator narrowed to
// 5 days (2026-06-07) — felt the 7-day window was pulling in stale items
// the LLM had to re-evaluate every run, while 5 days matches how often
// most asks stay actionable in busy founder/lead groups.
const WA_DIGEST_LOOKBACK_MS = 5 * 24 * 60 * 60 * 1000;

// ─── digest policy (knowledge-backed) ────────────────────────
// The tunable digest thresholds live in the `digest-policy` knowledge doc as
// JSON (wake-up-policy pattern): the operator edits the doc, no deploy. The
// constants above/below stay as the seeded defaults; a missing or broken doc
// falls back to them.
const DIGEST_POLICY_DEFAULTS = Object.freeze({
  wa_lookback_days: 5,           // WA chat scan window (operator-tuned from 7, 2026-06-07)
  wa_max_messages_per_chat: 400, // per-chat cap fed to the LLM (raised from 120, 2026-06-07)
  osint_per_target_cap: 6,       // OSINT mentions per target per digest
  osint_lookback_days: 7,        // OSINT news window
  stale_after_days: 7,           // soft-archive unread, unstarred, non-urgent items
  delete_after_days: 14,         // hard-delete read items past this horizon
});
function polNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function loadDigestPolicy(env) {
  try {
    const row = await env.DB.prepare("SELECT body FROM knowledge_docs WHERE slug = 'digest-policy'").first();
    if (!row?.body) {
      const { writeKnowledge } = await import('./db.js');
      await writeKnowledge(env, {
        slug: 'digest-policy',
        title: 'Digest policy — scan windows + caps',
        body: JSON.stringify(DIGEST_POLICY_DEFAULTS, null, 2),
      }).catch(() => {});
      return { ...DIGEST_POLICY_DEFAULTS };
    }
    const m = String(row.body).match(/\{[\s\S]*\}/);
    const src = m ? JSON.parse(m[0]) : {};
    const out = {};
    for (const [k, dflt] of Object.entries(DIGEST_POLICY_DEFAULTS)) out[k] = polNum(src[k], dflt);
    return out;
  } catch {
    return { ...DIGEST_POLICY_DEFAULTS };
  }
}
const WA_MIN_MESSAGES_TO_ANALYZE = 3;
// Cap raised 2026-06-07. The previous 120-msg cap caught only 30-50% of the
// 7-day window in our active groups (200-400 msgs/week each), so legit asks
// from earlier in the week were silently dropped. 400 covers the largest
// active group fully and stays under the LLM context budget for gpt-5.5.
const WA_MAX_MESSAGES_PER_CHAT  = 400;

// Plain-text variant of the LLM call for action drafting — returns the raw
// assistant string. Used for "draft me a WhatsApp reply" style asks where
// we don't want JSON wrapping. Provider abstraction mirrors callLLMJson.
async function callLLMText(env, system, user, { maxTokens = 800 } = {}) {
  // Delegates to the single LLM boundary (lib/openai.js): provider switch,
  // circuit breaker, and retry all live there now. Signature kept so the
  // ~20 digest call sites stay untouched.
  return callOpenAIText(env, { system, prompt: user, max_tokens: maxTokens });
}

async function callLLMJson(env, system, user, { maxTokens = 8000 } = {}) {
  // Same single boundary; keeps digest's tolerant parse (a garbled reply
  // degrades to {items: []} so one bad chat never sinks the whole digest run).
  const parseLoose = (s) => { const f = String(s || '').match(/```(?:json)?\s*([\s\S]*?)```/); try { return JSON.parse((f ? f[1] : s).trim()); } catch { return { items: [] }; } };
  const text = await callOpenAIText(env, {
    system, prompt: user, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  });
  return parseLoose(text);
}

const WA_DIGEST_SYSTEM = `You are scanning a WhatsApp conversation for Nyyon's operator. Your job is to surface every concrete asker, opportunity, intro request, or thread that warrants a personal follow-up. Think like a sharp chief of staff who reads every channel the founder is in — you flag asks the operator could meaningfully respond to, not just "marketing" asks.

Be GENEROUS, not stingy. A week of activity in a busy group should typically yield 5-15 items, not 1-2. If in doubt about an ask, include it at urgency 2 or 3 — the operator can star or dismiss. Missing a real lead is worse than surfacing a soft one.

INCLUDE every one of these as a separate item:
- ANY direct ask to the group ("anyone know X?", "מישהו מכיר?", "looking for…", "תוכלו לעזור?", "need help with…", "מחפש המלצה ל…")
- Anyone introducing themselves with a company / role — that's a relationship to seed
- Anyone asking for an intro, recommendation, or referral (to a person, tool, vendor, or service)
- Anyone sharing a launch, milestone, fundraise, hire, RFP, or event the operator could engage with
- Anyone whose own ask Nyyon (AI marketing agency: strategy, SEO, content, AI workflows, ad ops, copy, branding) could uniquely answer
- Time-sensitive items (deadlines, "this week", "by Friday", "TODAY", "happening now")
- Recurring discussions where the operator's POV is missing and would land well
- Mentions of specific named people or companies the operator might want to track

EXCLUDE: pure greetings ("בוקר טוב", "good morning"), thumbs-up emoji-only messages, link drops with no context, group admin events ("joined", "left"), exact duplicate forwards, jokes/memes.

Hebrew, Arabic, English, mixed — all count equally. A Hebrew ask is just as actionable as an English one.

For each item, output:
{
  "title": "short actionable line under 80 chars, written from the operator's perspective",
  "summary": "1-2 sentence context explaining what's happening and why it matters",
  "urgency": 1 | 2 | 3,
  "source_message_id": "the WhatsApp message id this item stems from (must match an id in the transcript)",
  "suggested_action": "one-line next step the operator could take"
}

Urgency:
- 1 = HIGH — direct ask aimed at the operator OR a clear time-bound RFP / deadline OR a sales-stage prospect making a concrete request. Should be reserved for things the operator must touch today.
- 2 = MEDIUM — any group ask Nyyon could answer, intro requests, opportunities to engage. The default for most items.
- 3 = LOW — relationship-building, soft signals, things to note but not chase.

Return ONLY valid JSON:
{ "items": [ ...items... ] }

If a chat has only chit-chat with zero asks/opportunities, an empty array is fine. But that is the exception, not the default.`;

// Quick LLM call to decide if the drafted reply should land in the group or
// land as a private DM. Defaults are baked into the prompt — the user can
// always flip the choice in the drawer.
// Doc override (prompt-wa-delivery), mirroring getWaReplySystem — the routing
// policy (group-vs-private bias, tie-breakers) is operator policy, not code.
async function getWaDeliverySystem(env) {
  try {
    const row = await env.DB.prepare("SELECT body FROM knowledge_docs WHERE slug = 'prompt-wa-delivery'").first();
    if (row?.body && String(row.body).trim().length > 50) return String(row.body);
  } catch { /* fall through */ }
  return DELIVERY_SYSTEM;
}
const DELIVERY_SYSTEM = `You decide WhatsApp routing for a reply Nyyon is about to send. Pick exactly one: "group" (post publicly in the original chat) or "private" (DM the specific person).

Treat this as a binary classifier with a strong DEFAULT-TO-PRIVATE bias. Group sends are high-cost (everyone in the room sees them, irreversible). Private sends are low-cost (one person, easy to recover). When uncertain, choose private.

Strong signals → PRIVATE
- The digest item's title or suggested_action mentions a specific person by name and says "DM <name>", "message <name>", "send <name>", "reply to <name>", "follow up with <name>", "reach out to <name>". This is the dominant signal — if present, return private unless something explicitly overrides it.
- The reply contains pricing, sales discovery, a calendar link, an offer, a quote, personal contact info, NDA/contract talk, or anything financial.
- The original ask reads as a 1:1 favor or personal request (the operator owes someone a follow-up).
- The reply would be off-topic for the room (group is broad chat, family/friends, alumni, etc.) and only the asker cares.
- The group is large (50+ likely participants in a general community) and the reply is a niche 1:1 exchange.

Strong signals → GROUP
- The original message was an explicit public ask ("anyone know X?", "can someone recommend Y?") posted to a community/professional group where peers benefit from reading the answer.
- The reply offers a referral, intro, or helpful answer that lifts others' understanding (technical answer in a builder group, market take in a founders group).
- The group is purpose-built for this topic (a deal group, a hiring channel, a buyer community) and the reply is in-scope.
- Posting publicly builds credibility for Nyyon with cold readers who are watching.

Tie-breakers
- If the digest item's suggested_action contradicts the thread context, trust the suggested_action — it represents the operator's intent at digest time.
- If the chat name suggests a private/personal group (e.g. family group, "home", "house", "בית", small friends pod), strongly bias private even for public-seeming questions.
- If the draft reply is empty, ignore that field and base the call on the title + suggested_action + thread.

Output ONLY this JSON, no prose:
{"target": "group" | "private", "reason": "<one short sentence — what swung the call>"}

Examples
- Item "Pitch marketing help to founder Daniel", action "DM Daniel 3 initial positioning angles" → {"target":"private","reason":"Suggested action is an explicit DM to a named founder; pitching is 1:1."}
- Item "Anyone know a good Postgres DBA?", in a 200-person founders group, draft offers a referral → {"target":"group","reason":"Public ask in a peer community; the referral helps others reading."}
- Item "Help Ohad reach influencers", action "DM Ohad to understand his thesis and offer feedback" → {"target":"private","reason":"Suggested action names Ohad and asks for a 1:1 follow-up."}
- Item in family group "Dinner Friday?", draft confirms → {"target":"group","reason":"Logistics question for the whole household."}`;

async function inferDeliveryChannel(env, item, ctx, draft) {
  const recentLines = (ctx.thread || []).slice(-8).map((m) => {
    const who = m.from_me ? 'me' : (m.sender_name || 'someone');
    return `${who}: ${(m.body || '').slice(0, 200)}`;
  }).join('\n');
  const chatName    = ctx.chat?.name || ctx.chat?.id || '(unknown)';
  const isGroup     = !!ctx.chat?.is_group;
  // Heuristic flags surfaced explicitly so the LLM weighs them properly
  // instead of having to derive them from prose. These are cheap, deterministic
  // hints — the model still gets to override them with the full context.
  const action      = (item.suggested_action || '').toLowerCase();
  const namesAPersonInAction = /\b(dm|message|send|ping|reply to|reach out to|follow up with|text)\s+\S+/.test(action);
  const looksSalesy = /\b(pricing|quote|proposal|nda|calendar|book a call|offer|deck|pitch)\b/i.test(`${item.title} ${item.suggested_action || ''} ${(draft || '')}`);
  const user = `Chat: "${chatName}" (${isGroup ? 'group' : 'DM'})

Digest title: ${item.title}
Suggested action: ${item.suggested_action || '(none)'}
Heuristic flags:
- suggested_action explicitly names a person to DM/message/follow-up: ${namesAPersonInAction ? 'YES' : 'no'}
- title/action/draft mentions sales / pricing / deck / calendar: ${looksSalesy ? 'YES' : 'no'}

Anchor message we're replying to:
"${(ctx.message?.body || '').slice(0, 400)}"

Last 8 messages in the thread (oldest → newest):
${recentLines || '(no thread context)'}

Drafted reply (may be empty if still loading):
"${(draft || '').slice(0, 600)}"

Decide: group or private? Apply the default-to-private bias. Output JSON only.`;
  return await callLLMJson(env, await getWaDeliverySystem(env), user, { maxTokens: 200 });
}

async function analyzeChatWithLLM(env, chat, messages) {
  // Order oldest → newest so the LLM reads the thread naturally.
  const ordered = messages.slice().sort((a, b) => a.timestamp - b.timestamp);
  const lines = ordered.map((m) => {
    const t  = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    const w  = m.from_me ? 'me' : (m.sender_name || m.sender_id || 'unknown');
    const b  = (m.body || '').replace(/\s+/g, ' ').trim();
    return `[${m.id} | ${t} | ${w}] ${b}`;
  }).join('\n');
  // Operator's editable interest profile steers what counts as "actionable".
  // The doc was seeded + advertised but never read (audit: knowledge drift);
  // now editing nyyon-digest-interests actually changes digest behavior.
  let interests = '';
  try {
    const doc = await readKnowledge(env, 'nyyon-digest-interests');
    if (doc?.body) interests = `\n\nOPERATOR'S INTEREST PROFILE (editable knowledge doc nyyon-digest-interests — weigh items against this):\n${doc.body.slice(0, 2000)}`;
  } catch { /* doc unreadable — prompt works without it */ }
  const user = `Group: ${chat.name || chat.id}\nWindow: last 7 days\nMessages (${ordered.length}, oldest first):\n\n${lines}\n\nNow extract every actionable item per the rules.`;
  const result = await callLLMJson(env, WA_DIGEST_SYSTEM + interests, user);
  return Array.isArray(result?.items) ? result.items : [];
}

async function pullWhatsApp(env, _sinceTs) {
  // Read PERSISTED messages from D1 (wa_messages), joined to watched chats by the
  // STABLE chat_id. No live-daemon dependency and no name-matching — the two
  // things that used to silently break WhatsApp (daemon down/QR/500, or a chat
  // rename/emoji/duplicate-name drifting out of the name key). The inbound
  // webhook keeps wa_messages fresh, so the brief works regardless of daemon UI
  // state. auto_listen=1 stays the "watch this chat" toggle; the join is by id.
  const policy = await loadDigestPolicy(env);
  const lookbackMs = policy.wa_lookback_days * 24 * 60 * 60 * 1000;
  const since = now() - lookbackMs;

  const watched = (await env.DB.prepare(
    'SELECT id, name, is_group FROM wa_chats WHERE auto_listen = 1',
  ).all()).results || [];

  const inserted = [];
  let chatsAnalyzed = 0, totalMessagesScanned = 0, llmErrors = 0, freshestMs = 0;

  for (const chat of watched) {
    const rows = (await env.DB.prepare(
      `SELECT id, from_me, sender_id, sender_name, body, timestamp
         FROM wa_messages
        WHERE chat_id = ? AND timestamp > ? AND length(trim(COALESCE(body, ''))) >= 3
        ORDER BY timestamp ASC LIMIT ?`,
    ).bind(chat.id, since, policy.wa_max_messages_per_chat).all()).results || [];
    if (rows.length) freshestMs = Math.max(freshestMs, rows[rows.length - 1].timestamp);
    if (rows.length < WA_MIN_MESSAGES_TO_ANALYZE) continue;
    totalMessagesScanned += rows.length;
    chatsAnalyzed++;

    let items = [];
    try {
      items = await analyzeChatWithLLM(env, chat, rows);
    } catch (e) {
      llmErrors++;
      continue;
    }

    for (const it of items) {
      if (!it?.title) continue;
      // Deterministic id so re-runs OR-IGNORE dedupe; seed on the real message id
      // when the model cites one, else the title, scoped to the stable chat id.
      const seed = (it.source_message_id || it.title || '') + '|' + chat.id;
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(seed));
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const r = await insertDigestItem(env, {
        id: 'wa_llm_' + hex.slice(0, 24),
        kind: chat.is_group ? 'wa_group' : 'wa_message',
        ref_kind: 'wa_messages',
        ref_id:   it.source_message_id || null,
        title:    String(it.title).slice(0, 200),
        summary:  String(it.summary || '').slice(0, 600),
        source_label: `WA · ${chat.name || (chat.is_group ? 'group' : 'DM')}`,
        urgency:    [1, 2, 3].includes(Number(it.urgency)) ? Number(it.urgency) : 2,
        actionable: 1,
        suggested_action: it.suggested_action ? String(it.suggested_action).slice(0, 240) : null,
      });
      if (r) inserted.push(r.id);
    }
  }

  // Honest soft warning when nothing landed, pointing at the ACTUAL cause.
  let softError = null;
  if (chatsAnalyzed === 0) {
    if (!watched.length) {
      softError = 'No chats are marked auto_listen=1. Flip it on for the chats you want in the brief.';
    } else if (!freshestMs) {
      softError = `Watched chats have no messages in D1 within the last ${Math.round(lookbackMs / 86400000)}d. The inbound WhatsApp webhook may have stopped persisting — check it is running.`;
    } else {
      softError = `Watched chats had fewer than ${WA_MIN_MESSAGES_TO_ANALYZE} recent messages to analyze.`;
    }
  } else if (llmErrors > 0 && inserted.length === 0) {
    softError = `LLM analysis failed on ${llmErrors} chat${llmErrors === 1 ? '' : 's'} — check provider key`;
  }

  return {
    ids: inserted,
    error: softError,
    meta: { chats_analyzed: chatsAnalyzed, messages_scanned: totalMessagesScanned, llm_errors: llmErrors, source: 'd1:wa_messages' },
  };
}

const OSINT_RELEVANCE_SYSTEM = `You filter OSINT mentions for a NEWS digest. The operator wants genuinely NEW, timely things — recent developments worth reacting to — NOT old evergreen filler. Each candidate is a public web snippet that matched a target's NAME or DOMAIN.

You get the TARGET context (what the brand does) and CANDIDATES (snippet + source). Many candidates have NO reliable date, so judge NEWSWORTHINESS from the content itself. For each, decide keep or skip:

KEEP only if it is BOTH:
1. clearly about THIS target (not a coincidental name match), AND
2. genuinely NEWS — a specific recent development: an announcement, launch, release, funding, incident/outage, research finding, policy change, controversy, or a live discussion/debate happening now.

SKIP (this is the important part — be strict) anything that is EVERGREEN or reference, not news, even if it mentions the target correctly:
- "What is X" / definitions / explainers / glossaries
- product reviews, comparisons, "best X tools", listicles, roundups
- pricing pages, feature pages, marketing/landing pages, how-to guides, tutorials
- generic "Features and Statistics", "Review 2026", "Customer Service Reviews", star-rating pages
- documentation, README/repo files, old articles, timeless opinion with no fresh hook
- coincidental name matches, unrelated entities, noise

When unsure whether something is NEWS vs evergreen, SKIP it — a quiet digest beats an old-junk digest. Only lean keep when it's clearly a fresh, specific development.

Return JSON ONLY:
{
  "verdicts": [
    { "id": "<the mention id>", "decision": "keep" | "skip", "reason": "short why" }
  ]
}`;

async function filterOsintRelevance(env, candidates, targetContext) {
  if (!candidates.length) return new Set();
  const lines = candidates.map((c) => {
    const snippet = (c.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return `[id=${c.id}] source=${c.source}  url=${c.source_url || '-'}\n  "${snippet}"`;
  }).join('\n\n');
  const user = `TARGET context:\n${targetContext}\n\nCANDIDATES (${candidates.length}):\n\n${lines}\n\nNow output verdicts for each id.`;
  let result;
  try {
    result = await callLLMJson(env, OSINT_RELEVANCE_SYSTEM, user, { maxTokens: 4000 });
  } catch (e) {
    // LLM failure → fall back to "keep everything" so we don't silently lose data.
    return new Set(candidates.map((c) => c.id));
  }
  const keep = new Set();
  for (const v of (result?.verdicts || [])) {
    if (v?.decision === 'keep') keep.add(v.id);
  }
  return keep;
}

// Per-target cap so a single high-confidence brand (e.g. a generic
// "anthropic.com TrustPilot" page at confidence=1.0) can't crowd out
// every other target's lower-confidence news (e.g. the actual Opus 4.8
// HN headline at confidence=0.4). Cap = 6 keeps the digest scan-able
// while still letting 12+ targets each contribute their top mentions.
const OSINT_PER_TARGET_CAP = 6;
// Industry news (HN headlines, Reddit threads, DDG hits) is reasonable
// to surface for a few days after it broke — an Opus 4.8 launch from 3
// days ago is still worth a "weigh in" suggestion. The caller's default
// `since_ms` (24h) is tuned for WA reply urgency, not industry news,
// so OSINT widens its own window independently.
// Industry news from the past week is still worth surfacing — a model
// launch from 6 days ago is "this week's news" the operator may not have
// weighed in on yet. Stale items beyond the 7-day pruner threshold get
// archived automatically on the next generate, so the window can't grow
// stale across runs.
const OSINT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

async function pullOsint(env, _sinceTs) {
  const policy = await loadDigestPolicy(env);
  const perTargetCap = polNum(policy.osint_per_target_cap, OSINT_PER_TARGET_CAP);
  const sinceTs = now() - policy.osint_lookback_days * 24 * 60 * 60 * 1000;
  const inserted = [];
  // Per-target query — SQLite window functions would also work, but a
  // JS loop is simpler and lets each target's batch get its own LLM
  // relevance pass cleanly. Cap is small enough that even 20 targets
  // stays well under the digest's overall budget.
  const targetsRes = await env.DB.prepare(`SELECT id, name, domain, notes FROM osint_targets`).all();
  const targets = targetsRes.results || [];
  const byTarget = new Map();
  // Per-source slice WITHIN each target so DuckDuckGo (which often returns
  // null posted_at and thus sorts as "today" via COALESCE) can't swallow
  // every slot at the expense of HN/Reddit headlines from a few days ago.
  // SOURCES_PER_TARGET = ceil(OSINT_PER_TARGET_CAP / number-of-sources).
  // With 3 sources (hn, reddit, duckduckgo) and cap=6 → 2 each. That keeps
  // the digest balanced even when one source dominates the candidate pool.
  const OSINT_SOURCES_FOR_DIVERSITY = ['hn', 'reddit', 'duckduckgo'];
  const PER_SOURCE_CAP = Math.max(1, Math.floor(perTargetCap / OSINT_SOURCES_FOR_DIVERSITY.length));
  for (const t of targets) {
    const collected = [];
    for (const src of OSINT_SOURCES_FOR_DIVERSITY) {
      const r = await env.DB.prepare(`
        SELECT id, source, text, reviewer, source_url, posted_at, confidence
          FROM osint_mentions
         WHERE target_id = ?
           AND source    = ?
           AND COALESCE(posted_at, created_at) >= ?
           AND COALESCE(confidence, 0) >= 0.4
         ORDER BY COALESCE(posted_at, created_at) DESC, COALESCE(confidence, 0) DESC
         LIMIT ?
      `).bind(t.id, src, sinceTs, PER_SOURCE_CAP).all();
      collected.push(...(r.results || []));
    }
    if (collected.length) byTarget.set(t.id, { target: t, rows: collected });
  }
  if (!byTarget.size) return inserted;

  // LLM relevance pass per target — drops false positives (murder trial
  // of a person named Nyyon, sports player, religious term, etc.) that
  // the name-only scorer can't distinguish from real brand mentions.
  const keepIds = new Set();
  const allRows = [];
  for (const [tid, { target, rows }] of byTarget) {
    const ctx = [
      `Name:   ${target.name || tid}`,
      target.domain ? `Domain: ${target.domain}` : null,
      target.notes  ? `Notes:  ${target.notes}`  : null,
    ].filter(Boolean).join('\n');
    const enriched = rows.map((r) => ({
      ...r,
      target_id:     target.id,
      target_name:   target.name,
      target_domain: target.domain,
      target_notes:  target.notes,
    }));
    const kept = await filterOsintRelevance(env, enriched, ctx);
    for (const id of kept) keepIds.add(id);
    allRows.push(...enriched);
  }

  for (const x of allRows) {
    if (!keepIds.has(x.id)) continue;
    // Better title: take the first line of the snippet (HN/Reddit/DDG
    // all lead with the actual headline). Falls back to the generic
    // "X mentioned on Y" if the snippet is empty.
    const firstLine = (x.text || '').split('\n')[0].trim();
    const headline  = firstLine.length > 8 ? firstLine.slice(0, 140) : null;
    const title     = headline
      ? `${x.target_name || 'target'}: ${headline}`
      : `${x.target_name || 'someone'} mentioned on ${x.source}`;
    const r = await insertDigestItem(env, {
      id: 'osint_' + x.id,
      kind: 'osint_mention',
      ref_kind: 'osint_mentions',
      ref_id:   x.id,
      title,
      summary:  (x.text || '').slice(0, 280),
      source_label: x.source,
      source_url:   x.source_url,
      urgency:      x.confidence >= 0.9 ? 2 : 3,
      actionable:   actionableOf(x.text),
      suggested_action: x.source === 'reddit' || x.source === 'hn' ? 'Weigh in as Nyyon' : null,
    });
    if (r) inserted.push(r.id);
  }
  return inserted;
}

// Heartbeat → digest: surface the week's strongest content opportunities as
// their own item kind. These are the awareness layer's output — real industry
// signals scored high enough to write/post about. The drawer offers → Blog /
// → Social actions (see DigestItemDrawer).
async function pullHeartbeat(env) {
  const inserted = [];
  let signals = [];
  try {
    const { topSignals, heartbeatGates } = await import('./heartbeat.js');
    const gates = await heartbeatGates(env);
    signals = await topSignals(env, { days: 7, minContent: gates.digest_min_content, limit: 6 });
  } catch { return inserted; }

  for (const s of signals) {
    const fmt = (s.formats || '').toLowerCase();
    const action = fmt.includes('blog') ? 'Turn into a blog post'
                 : fmt.includes('social') ? 'Draft a social post'
                 : 'Capitalise on this';
    const r = await insertDigestItem(env, {
      id: 'hb_' + s.id,
      kind: 'content_opportunity',
      ref_kind: 'osint_signals',
      ref_id:   s.id,
      title:    `${s.source_name}: ${s.title}`.slice(0, 160),
      summary:  (s.suggested_angle || s.summary || '').slice(0, 280),
      source_label: s.source_name,
      source_url:   s.url,
      urgency:      s.content_score >= 85 ? 2 : 3,
      actionable:   1,
      suggested_action: action,
    });
    if (r) {
      inserted.push(r.id);
      await env.DB.prepare(`UPDATE osint_signals SET status='surfaced' WHERE id=? AND status='scored'`).bind(s.id).run();
    }
  }
  return inserted;
}

// Synthesized OSINT hot topics — the blog-grade angles. urgency=1 so they lead
// the digest (the read sort buckets by urgency first).
async function pullOsintInsights(env) {
  const inserted = [];
  let topics = [];
  try {
    const { topHotTopics } = await import('./heartbeat.js');
    topics = await topHotTopics(env, { days: 4, limit: 6 });
  } catch { return inserted; }

  for (const t of topics) {
    const src = (t.sources && t.sources[0]) || {};
    const summary = [t.thesis, t.why_now && `Why now: ${t.why_now}`, t.angle && `The counter: ${t.angle}`]
      .filter(Boolean).join(' ').slice(0, 600);
    const r = await insertDigestItem(env, {
      id: 'oi_' + t.id,
      kind: 'osint_insight',
      ref_kind: 'osint_topics',
      ref_id:   t.id,
      title:    String(t.title).slice(0, 200),
      summary,
      source_label: `OSINT · ${(t.sources || []).length} signals`,
      source_url:   src.url || null,
      urgency:      1,            // hot topics lead the digest
      actionable:   1,
      suggested_action: String(t.format).includes('social') ? 'Draft a social post on this' : 'Draft a blog post on this',
    });
    if (r) {
      inserted.push(r.id);
      await env.DB.prepare(`UPDATE osint_topics SET status='surfaced' WHERE id=? AND status='new'`).bind(t.id).run();
    }
  }
  return inserted;
}

async function pullCalendar(env, nowMs /*, sinceMs */) {
  // Look-AHEAD window — events in the next 7 days. Calendar items are
  // forward-looking so we always use a wider window than WA/OSINT (which
  // look BACK at the last `sinceMs`).
  const inserted = [];
  const CAL_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
  const horizon = nowMs + CAL_LOOKAHEAD_MS;
  // Window on END, not start: include events that start within 7 days AND
  // haven't finished yet (assume a 1h duration when ends_at is null). Keying
  // the lower bound on starts_at alone dropped a meeting the moment it began —
  // and never surfaced one added after it started — even while still ongoing.
  const r = await env.DB.prepare(`
    SELECT id, kind, title, description, starts_at, ends_at, all_day, status,
           location, link_url, platform
      FROM calendar_events
     WHERE starts_at <= ?
       AND COALESCE(ends_at, starts_at + 3600000) >= ?
       AND status != 'cancelled'
     ORDER BY starts_at ASC
     LIMIT 50
  `).bind(horizon, nowMs).all();
  for (const e of (r.results || [])) {
    const startsIn = e.starts_at - nowMs;
    const minutes  = Math.round(startsIn / 60000);
    let when;
    if (Math.abs(minutes) < 60) when = minutes <= 0 ? 'now' : `in ${minutes}m`;
    else if (Math.abs(minutes) < 1440) when = `in ${Math.round(minutes / 60)}h`;
    else when = `${new Date(e.starts_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;

    // Urgency: soon → high; today → medium; later → low.
    const urgency = minutes < 60 ? 1 : minutes < 12 * 60 ? 2 : 3;
    const inserted_ = await insertDigestItem(env, {
      id: 'cal_' + e.id,
      kind: 'opportunity', // shows under the orange-amber chip; reads as "upcoming"
      ref_kind: 'calendar_events',
      ref_id:   e.id,
      title:    `${e.title} · ${when}`,
      summary:  e.description || (e.location ? `Location: ${e.location}` : null),
      source_label: `Calendar · ${e.kind || 'event'}`,
      source_url:   e.link_url,
      urgency,
      actionable: 1,
      suggested_action: e.kind === 'meeting' ? 'Open invite' : 'Confirm / prep',
    }, { refresh: true }); // re-run updates urgency + "when" as the meeting nears
    if (inserted_) inserted.push(inserted_.id);
  }
  return inserted;
}

// Sweep stale digest items off the brief. Anything older than 7 days that
// the operator hasn't marked starred AND isn't urgency=1 (the "high" band)
// gets soft-archived by setting read_at — the row stays in the DB for
// audit, it just stops topping the brief alongside fresh items. Runs at
// the top of every generateDigest() pass so the brief never carries
// week-old urgency=2 "noise" forward into a new run.
//
// Rationale: when the operator hits Generate, the truthful "what's
// actionable RIGHT NOW" is what they want — not last week's leftover
// asks. Urgency=1 + starred are explicit "keep me visible" signals, so
// those are exempt.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// Hard-delete horizon. Soft-archive (read_at) never removes rows, so the table
// would grow without bound and the client's capped fetch would start silently
// dropping the oldest/low-urgency items. So, well past the 7-day archive, we
// DELETE rows that are already read, unstarred, and not high-urgency. The
// pullers only look back 5–7 days, so nothing this old gets re-inserted; the
// underlying source rows (wa_messages, osint_mentions, calendar_events) are
// untouched — only the derived digest row goes.
const DELETE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export async function pruneStaleDigestItems(env, { staleAfterMs = null } = {}) {
  const policy = await loadDigestPolicy(env);
  const cutoff = now() - (staleAfterMs ?? policy.stale_after_days * 24 * 60 * 60 * 1000);
  const r = await env.DB.prepare(
    `UPDATE digest_items
        SET read_at = ?
      WHERE read_at IS NULL
        AND starred = 0
        AND urgency != 1
        AND created_at < ?`,
  ).bind(now(), cutoff).run();
  const pruned = r?.meta?.changes ?? r?.changes ?? 0;

  const delCutoff = now() - policy.delete_after_days * 24 * 60 * 60 * 1000;
  const d = await env.DB.prepare(
    `DELETE FROM digest_items
      WHERE read_at IS NOT NULL
        AND starred = 0
        AND urgency != 1
        AND created_at < ?`,
  ).bind(delCutoff).run();
  const deleted = d?.meta?.changes ?? d?.changes ?? 0;

  if (pruned > 0 || deleted > 0) {
    await logEvent(env, { kind: 'digest_pruned_stale', payload: { pruned, deleted, cutoff_ms: cutoff, delete_cutoff_ms: delCutoff, stale_after_ms: staleAfterMs } });
  }
  return { pruned, deleted, cutoff };
}



// ─── system attention channel ────────────────────────────────────
// Cards that say the SYSTEM needs the operator: the outreach pool ran dry,
// the publishing pipeline is thin. One card per check per day while the
// condition holds (id carries the date; INSERT OR IGNORE dedups). Thresholds
// live in the editable digest-attention note, seeded on first read.
async function attentionCfg(env) {
  const DEFAULTS = { pool_min_queued: 1, articles_min: 2, articles_window_days: 5 };
  try {
    const doc = await readKnowledge(env, 'digest-attention');
    if (!doc) {
      const { writeKnowledge } = await import('./db.js');
      await writeKnowledge(env, {
        slug: 'digest-attention',
        title: 'Digest · system attention thresholds',
        parent_slug: 'module-digest',
        body: `When the Digest raises a "system needs you" card. Edit the JSON, no deploy.\n- pool_min_queued: alert when fewer LI prospects are queued for connects.\n- articles_min / articles_window_days: alert when fewer articles are scheduled inside the window.\n\n\u0060\u0060\u0060json\n${JSON.stringify(DEFAULTS, null, 2)}\n\u0060\u0060\u0060`,
      }).catch(() => {});
      return DEFAULTS;
    }
    const m = String(doc.body || '').match(/\u0060\u0060\u0060json\s*([\s\S]*?)\u0060\u0060\u0060/);
    return { ...DEFAULTS, ...(m ? JSON.parse(m[1]) : {}) };
  } catch { return { pool_min_queued: 1, articles_min: 2, articles_window_days: 5 }; }
}

async function pullAttention(env) {
  const inserted = [];
  const cfg = await attentionCfg(env);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const checks = [];
  const pool = await env.DB.prepare(`SELECT COUNT(*) n FROM li_prospects WHERE status='queued'`).first();
  if ((pool?.n ?? 0) < cfg.pool_min_queued) {
    checks.push({
      key: 'li_pool',
      title: `LinkedIn outreach pool is empty (${pool?.n ?? 0} queued)`,
      summary: 'The connect engine has nobody left to work. Add prospects in LI Outreach.',
      action: 'Add prospects',
    });
  }
  const t = now();
  const art = await env.DB.prepare(`SELECT COUNT(*) n FROM hot_take_packages WHERE scheduled_at > ? AND scheduled_at < ?`)
    .bind(t, t + cfg.articles_window_days * 24 * 60 * 60 * 1000).first();
  if ((art?.n ?? 0) < cfg.articles_min) {
    const n = art?.n ?? 0;
    checks.push({
      key: 'articles',
      title: `Publishing pipeline thin: ${n} article${n === 1 ? '' : 's'} scheduled in the next ${cfg.articles_window_days} days`,
      summary: `Below the ${cfg.articles_min}-article floor. Approve a draft in Hot Takes and schedule it.`,
      action: 'Schedule articles',
    });
  }
  for (const c of checks) {
    const digId = `att_${c.key}_${day}`;
    const exists = await env.DB.prepare(`SELECT id FROM digest_items WHERE id=?`).bind(digId).first();
    if (exists) continue;
    const r = await insertDigestItem(env, {
      id: digId, kind: 'attention', ref_kind: 'system', ref_id: c.key,
      title: c.title, summary: c.summary, source_label: 'System',
      urgency: 1, actionable: 1, suggested_action: c.action,
    });
    if (r) inserted.push(r.id);
  }
  return inserted;
}

// ─── LI signals channel ─────────────────────────────────────
// Mirrors NEW LinkedIn signals (li_signals, written by the :45 scan) into the
// digest feed as actionable cards. Idempotent: the digest id is derived from
// the signal id, so INSERT OR IGNORE makes re-runs no-ops and a dismissed
// card never resurrects. Urgency/action wording lives in the editable
// digest-li-signals knowledge note, seeded below on first read.
async function liSignalDigestCfg(env) {
  const DEFAULTS = {
    lookback_days: 3,
    max_per_run: 20,
    urgency: { open_role: 1, job_change: 2, post: 2, news: 3 },
    actions: {
      with_phone: 'Message them on WhatsApp',
      open_role: 'Reach out about the role',
      job_change: 'Congratulate and open the door',
      post: 'Reply to their post',
      news: 'Open with the news',
    },
    kind_labels: { open_role: 'hiring', job_change: 'job change', post: 'post', news: 'news' },
  };
  try {
    const doc = await readKnowledge(env, 'digest-li-signals');
    if (!doc) {
      const { writeKnowledge } = await import('./db.js');
      await writeKnowledge(env, {
        slug: 'digest-li-signals',
        title: 'Digest · LinkedIn signals channel',
        parent_slug: 'module-digest',
        body: `How LinkedIn signals surface in the Digest feed. The sync reads the JSON below at run time — edit here, no deploy. urgency: 1 high / 2 medium / 3 low per signal kind. actions: the suggested-action wording (with_phone wins when the person has a known WhatsApp number).\n\n\u0060\u0060\u0060json\n${JSON.stringify(DEFAULTS, null, 2)}\n\u0060\u0060\u0060`,
      }).catch(() => {});
      return DEFAULTS;
    }
    const m = String(doc.body || '').match(/\u0060\u0060\u0060json\s*([\s\S]*?)\u0060\u0060\u0060/);
    const cfg = m ? JSON.parse(m[1]) : {};
    return {
      ...DEFAULTS, ...cfg,
      urgency: { ...DEFAULTS.urgency, ...(cfg.urgency || {}) },
      actions: { ...DEFAULTS.actions, ...(cfg.actions || {}) },
      kind_labels: { ...DEFAULTS.kind_labels, ...(cfg.kind_labels || {}) },
    };
  } catch { return DEFAULTS; }
}

async function pullLiSignals(env) {
  const inserted = [];
  const cfg = await liSignalDigestCfg(env);
  const rows = (await env.DB.prepare(
    `SELECT s.id, s.kind, s.title, s.detail, s.draft, s.detected_at,
            p.id AS prospect_id, p.name, p.company, p.role, p.public_id
     FROM li_signals s JOIN li_prospects p ON p.id = s.prospect_id
     WHERE s.status = 'new' AND s.detected_at > ?
     ORDER BY s.detected_at DESC LIMIT ?`,
  ).bind(now() - cfg.lookback_days * 24 * 60 * 60 * 1000, cfg.max_per_run).all()).results || [];
  for (const s of rows) {
    const digId = 'dig_li_' + s.id;
    // count only genuinely-new cards; INSERT OR IGNORE would re-read old ones
    const exists = await env.DB.prepare(`SELECT id FROM digest_items WHERE id=?`).bind(digId).first();
    if (exists) continue;
    const raw = safeJSON(s.detail);
    const detail = raw && typeof raw === 'object' ? raw : {};
    // Best-effort WhatsApp match: CRM contacts first, then the GTM lead pool.
    let phone = null;
    try {
      const c = await env.DB.prepare(
        `SELECT phone FROM contacts WHERE phone IS NOT NULL AND TRIM(phone) != '' AND LOWER(TRIM(full_name)) = LOWER(TRIM(?)) LIMIT 1`,
      ).bind(s.name).first();
      phone = c?.phone || null;
      if (!phone) {
        const g = await env.DB.prepare(
          `SELECT COALESCE(NULLIF(TRIM(normalized_phone), ''), phone) AS phone FROM gtm_leads
           WHERE phone IS NOT NULL AND LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
        ).bind(s.name).first();
        phone = g?.phone || null;
      }
    } catch { /* no match — the card still ships, just without the WA action */ }
    // Acted-on people are muted: their new signals do not enter the brief
    // until the snooze expires (the ✓ on the card sets it).
    try {
      const { isSnoozed } = await import('./signal-priority.js');
      const snoozed = await isSnoozed(env, { prospect_id: s.prospect_id, phone, name: s.name });
      if (snoozed) continue;
    } catch { /* snooze check must never block the brief */ }

    const waDigits = phone ? String(phone).replace(/[^0-9]/g, '') : null;
    // Where this person comes from: the Prospecting pool (gtm_leads) or pure
    // LI Outreach. Drives the digest's source filters.
    let origin = 'li-outreach';
    try {
      const pub = String(s.public_id || '').toLowerCase();
      const gl = await env.DB.prepare(
        `SELECT 1 FROM gtm_leads WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
           OR (? != '' AND LOWER(COALESCE(linkedin, '')) LIKE '%/in/' || ? || '%') LIMIT 1`,
      ).bind(s.name, pub, pub).first();
      if (gl) origin = 'prospecting';
    } catch { /* origin stays li-outreach */ }
    const permalink = s.kind === 'post' && typeof detail.urn === 'string'
      ? `https://www.linkedin.com/feed/update/${detail.urn}/`
      : (typeof detail.link === 'string' ? detail.link : (typeof detail.url === 'string' ? detail.url : null));
    const r = await insertDigestItem(env, {
      id: digId,
      kind: 'li_signal',
      ref_kind: 'li_signals',
      ref_id: s.id,
      // the kind chip + source label already say it's a post — 'posted:' in the
      // title reads as a stutter
      title: `${s.name}${s.company ? ' · ' + s.company : ''}: ${String(s.title).replace(/^posted:\s*/i, '')}`.slice(0, 160),
      summary: String(detail.text || detail.snippet || detail.new || s.draft || '').slice(0, 280),
      source_label: `LI · ${cfg.kind_labels[s.kind] || s.kind}`,
      source_url: permalink,
      urgency: cfg.urgency[s.kind] ?? 2,
      actionable: 1,
      suggested_action: waDigits ? cfg.actions.with_phone : (cfg.actions[s.kind] || 'Message them'),
      meta: {
        signal_id: s.id, prospect_id: s.prospect_id, signal_kind: s.kind,
        name: s.name, role: s.role || null, company: s.company || null,
        detail, // the drawer renders the post mockup from this
        profile_url: s.public_id ? `https://www.linkedin.com/in/${s.public_id}/` : null,
        draft: s.draft || null, phone: phone || null,
        wa_url: waDigits ? `https://wa.me/${waDigits}` : null,
        origin,
      },
    });
    if (r) inserted.push(r.id);
  }
  return inserted;
}

export async function generateDigest(env, { since_ms = 24 * 60 * 60 * 1000 } = {}) {
  const nowMs   = now();
  const sinceTs = nowMs - since_ms;
  const inserted = [];
  const perSource = {};
  // Step 0: archive anything that's gone stale since the last run. The
  // count flows back to the API caller so the UI can show "X archived"
  // alongside the per-source +N adds.
  const prune = await pruneStaleDigestItems(env);

  // Run each enabled channel. Record stats per channel (even on partial fail).
  async function maybeRun(source, runFn) {
    if (!(await isChannelEnabled(env, source))) {
      perSource[source] = { count: 0, skipped: 'disabled' };
      return;
    }
    let added = 0, softErr = null, hardErr = null;
    try {
      // Each puller may return either `string[]` (just ids, success) or
      // `{ ids, error }` (success/partial + a soft error to surface). A soft
      // error is NOT a failure — data landed, or there was simply nothing to
      // digest (e.g. "fewer than 3 recent messages"). Keep it as a note but
      // leave the channel 'ok'; only a thrown/hard error is a real failure.
      const r = await runFn();
      const ids   = Array.isArray(r) ? r : (r?.ids || []);
      softErr     = Array.isArray(r) ? null : (r?.error || null);
      inserted.push(...ids);
      added = ids.length;
    } catch (e) {
      hardErr = String(e?.message || e);
    }
    const error = hardErr || softErr;
    perSource[source] = { count: added, error };
    // 'ok' unless a HARD error was thrown — a soft warning stays green + noted.
    try { await recordChannelRun(env, source, { ok: !hardErr, added, error }); } catch {}
  }

  await maybeRun('attention', () => pullAttention(env));
  await maybeRun('li_signals', () => pullLiSignals(env));
  await maybeRun('osint_insights', () => pullOsintInsights(env));
  await maybeRun('whatsapp',  () => pullWhatsApp(env, sinceTs));
  await maybeRun('osint',     () => pullOsint(env, sinceTs));
  await maybeRun('heartbeat', () => pullHeartbeat(env));
  await maybeRun('calendar',  () => pullCalendar(env, nowMs));

  await logEvent(env, { kind: 'digest_generated', actor: 'digest', payload: { count: inserted.length, per_source: perSource, pruned: prune.pruned } });
  return { generated: inserted.length, pruned: prune.pruned, since_ms, per_source: perSource };
}

export async function digestStats(env) {
  const r = await env.DB.prepare(`
    SELECT
      COUNT(*)                                                AS total,
      SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END)        AS unread,
      SUM(CASE WHEN read_at IS NULL AND urgency = 1 THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN read_at IS NULL AND actionable = 1 THEN 1 ELSE 0 END) AS action_count,
      SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END)            AS starred
    FROM digest_items
  `).first();
  // Pull the timestamp of the most recent generate() run from the events
  // log. This lets the UI render "last updated N min ago" without keeping
  // any extra state — the events row that generate() already writes is the
  // single source of truth for "did we run, and when".
  const last = await env.DB.prepare(
    `SELECT created_at FROM events WHERE kind = 'digest_generated' ORDER BY created_at DESC LIMIT 1`
  ).first();
  return {
    ...(r || { total: 0, unread: 0, high: 0, action_count: 0, starred: 0 }),
    last_generated_at: last?.created_at || null,
  };
}
