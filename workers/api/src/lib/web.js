// Identity stitching (the funnel/analytics module is gone; these remain
// because WhatsApp inbound persistence resolves people through them).
import { uid, now, safeJSON } from './util.js';
import { logEvent } from './db.js';

// ─── identity ────────────────────────────────────────────────
function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// Re-point every row from one person_id onto another, then delete the loser.
// Used when the same cookie has been linked to two different person_ids
// (e.g. user identified once with email_A then later with email_B on the
// same browser — almost always the same human).
export async function mergePersonIds(env, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return { merged: false };

  const loser  = await env.DB.prepare('SELECT * FROM identities WHERE id = ?').bind(fromId).first();
  const winner = await env.DB.prepare('SELECT * FROM identities WHERE id = ?').bind(toId).first();
  if (!loser || !winner) return { merged: false, reason: 'one side missing' };

  // Re-point every reference. Order: sessions → web_events → conversions → identity_links → identity row.
  await env.DB.prepare('UPDATE sessions       SET person_id   = ? WHERE person_id   = ?').bind(toId, fromId).run();
  await env.DB.prepare('UPDATE web_events     SET person_id   = ? WHERE person_id   = ?').bind(toId, fromId).run();
  await env.DB.prepare('UPDATE conversions    SET identity_id = ? WHERE identity_id = ?').bind(toId, fromId).run();
  await env.DB.prepare('UPDATE identity_links SET person_id   = ? WHERE person_id   = ?').bind(toId, fromId).run();

  // Fold loser metadata into winner if winner is missing it. Keep the older first_seen_at.
  const newFirstSeen = Math.min(loser.first_seen_at ?? winner.first_seen_at, winner.first_seen_at ?? loser.first_seen_at);
  const newLastSeen  = Math.max(loser.last_seen_at  ?? 0,                    winner.last_seen_at  ?? 0);
  await env.DB.prepare(
    `UPDATE identities
        SET display_name = COALESCE(display_name, ?),
            phone        = COALESCE(phone,        ?),
            handle       = COALESCE(handle,       ?),
            meta         = COALESCE(meta,         ?),
            first_seen_at = ?,
            last_seen_at  = ?
      WHERE id = ?`,
  ).bind(loser.display_name, loser.phone, loser.handle, loser.meta, newFirstSeen, newLastSeen, toId).run();

  // Write an audit row so the merge is visible in identity_links + ops Activity.
  await env.DB.prepare(
    `INSERT INTO identity_links (id, cookie_id, person_id, identifier_type, identifier_value, method, source_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uid(), loser.cookie_id ?? null, toId, 'merge', String(fromId), 'merge_from_prior_person', null, now()).run();

  await env.DB.prepare('DELETE FROM identities WHERE id = ?').bind(fromId).run();
  await logEvent(env, { kind: 'identity_merged', payload: { from: fromId, to: toId, loser_email: loser.email } });

  return { merged: true, from: fromId, to: toId };
}

// Upsert an identity by email + backfill person_id onto every session AND
// every web_event for this cookie. If the cookie was previously linked to a
// different person, merge that person INTO this email's canonical person.
// Always writes an identity_links row for the (cookie ↔ person ↔ email) tuple.
export async function identifyByEmail(env, body) {
  const email = normalizeEmail(body.email);
  if (!email) throw new Error('email required');
  const cookie_id  = body.cookie_id  || null;
  const session_id = body.session_id || null;
  const t = now();

  // 1. Find or create canonical identity by email.
  let identity = await env.DB.prepare('SELECT * FROM identities WHERE email = ?').bind(email).first();
  let person_id;
  if (identity) {
    person_id = identity.id;
    await env.DB.prepare(
      'UPDATE identities SET cookie_id = COALESCE(cookie_id, ?), last_seen_at = ? WHERE id = ?',
    ).bind(cookie_id, t, person_id).run();
  } else {
    person_id = uid();
    await env.DB.prepare(
      `INSERT INTO identities (id, cookie_id, email, channel, display_name, meta, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      person_id, cookie_id, email, 'web',
      body.display_name ?? null,
      body.meta ? JSON.stringify(body.meta) : null,
      t, t,
    ).run();
  }

  // 2. Merge any prior person_ids that the cookie was already linked to.
  // Sources of truth: sessions OR identity_links.
  const merges = [];
  if (cookie_id) {
    const priorR = await env.DB.prepare(`
      SELECT DISTINCT pid FROM (
        SELECT person_id AS pid FROM sessions       WHERE cookie_id = ? AND person_id IS NOT NULL
        UNION
        SELECT person_id AS pid FROM identity_links WHERE cookie_id = ? AND person_id IS NOT NULL
      ) WHERE pid IS NOT NULL AND pid != ?
    `).bind(cookie_id, cookie_id, person_id).all();
    for (const row of (priorR.results || [])) {
      const r = await mergePersonIds(env, row.pid, person_id);
      if (r.merged) merges.push(row.pid);
    }
  }

  // 3. Backfill person_id on all sessions for this cookie.
  let sessions_backfilled = 0;
  if (cookie_id) {
    const r = await env.DB.prepare(
      'UPDATE sessions SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    sessions_backfilled = r.meta?.changes ?? 0;
  } else if (session_id) {
    await env.DB.prepare('UPDATE sessions SET person_id = ? WHERE id = ?').bind(person_id, session_id).run();
    sessions_backfilled = 1;
  }

  // 4. Backfill person_id on all web_events for this cookie.
  let events_backfilled = 0;
  if (cookie_id) {
    const r = await env.DB.prepare(
      'UPDATE web_events SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    events_backfilled = r.meta?.changes ?? 0;
  }

  // 5. Audit the (cookie ↔ person ↔ email) link. Skip if exact tuple already exists.
  if (cookie_id) {
    const exists = await env.DB.prepare(
      `SELECT id FROM identity_links
        WHERE cookie_id = ? AND person_id = ? AND identifier_type = 'email' AND identifier_value = ?`,
    ).bind(cookie_id, person_id, email).first();
    if (!exists) {
      await env.DB.prepare(
        `INSERT INTO identity_links (id, cookie_id, person_id, identifier_type, identifier_value, method, source_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid(), cookie_id, person_id, 'email', email,
        body.method ?? 'email_submit',
        body.source_event_id ?? null,
        t,
      ).run();
    }
  }

  return {
    person_id, email,
    sessions_backfilled, events_backfilled,
    merged_person_ids: merges,
  };
}

// Symmetric to identifyByEmail but keyed on phone — for the WhatsApp channel.
// Same backfill of sessions + web_events for the cookie, same merge of any
// prior person_id seen on the cookie, same identity_links audit row.
function normalizePhone(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // Strip everything that isn't a digit; require + prefix on output.
  const digits = t.replace(/\D/g, '');
  return digits ? '+' + digits : '';
}

export async function identifyByPhone(env, body) {
  const phone = normalizePhone(body.phone);
  if (!phone) throw new Error('phone required');
  const cookie_id  = body.cookie_id  || null;
  const session_id = body.session_id || null;
  const t = now();

  let identity = await env.DB.prepare('SELECT * FROM identities WHERE phone = ?').bind(phone).first();
  let person_id;
  if (identity) {
    person_id = identity.id;
    await env.DB.prepare(
      'UPDATE identities SET cookie_id = COALESCE(cookie_id, ?), last_seen_at = ? WHERE id = ?',
    ).bind(cookie_id, t, person_id).run();
  } else {
    person_id = uid();
    await env.DB.prepare(
      `INSERT INTO identities (id, cookie_id, phone, channel, display_name, meta, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      person_id, cookie_id, phone,
      body.channel || 'whatsapp',
      body.display_name ?? null,
      body.meta ? JSON.stringify(body.meta) : null,
      t, t,
    ).run();
  }

  // Merge any prior person_ids the cookie was linked to.
  const merges = [];
  if (cookie_id) {
    const priorR = await env.DB.prepare(`
      SELECT DISTINCT pid FROM (
        SELECT person_id AS pid FROM sessions       WHERE cookie_id = ? AND person_id IS NOT NULL
        UNION
        SELECT person_id AS pid FROM identity_links WHERE cookie_id = ? AND person_id IS NOT NULL
      ) WHERE pid IS NOT NULL AND pid != ?
    `).bind(cookie_id, cookie_id, person_id).all();
    for (const row of (priorR.results || [])) {
      const r = await mergePersonIds(env, row.pid, person_id);
      if (r.merged) merges.push(row.pid);
    }
  }

  // Backfill sessions + web_events for this cookie.
  let sessions_backfilled = 0;
  let events_backfilled = 0;
  if (cookie_id) {
    const sr = await env.DB.prepare(
      'UPDATE sessions SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    sessions_backfilled = sr.meta?.changes ?? 0;
    const er = await env.DB.prepare(
      'UPDATE web_events SET person_id = ? WHERE cookie_id = ? AND (person_id IS NULL OR person_id != ?)',
    ).bind(person_id, cookie_id, person_id).run();
    events_backfilled = er.meta?.changes ?? 0;
  }

  // Audit the (cookie ↔ person ↔ phone) link.
  if (cookie_id) {
    const exists = await env.DB.prepare(
      `SELECT id FROM identity_links
        WHERE cookie_id = ? AND person_id = ? AND identifier_type = 'phone' AND identifier_value = ?`,
    ).bind(cookie_id, person_id, phone).first();
    if (!exists) {
      await env.DB.prepare(
        `INSERT INTO identity_links (id, cookie_id, person_id, identifier_type, identifier_value, method, source_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid(), cookie_id, person_id, 'phone', phone,
        body.method ?? 'wa_inbound',
        body.source_event_id ?? null,
        t,
      ).run();
    }
  }

  return { person_id, phone, sessions_backfilled, events_backfilled, merged_person_ids: merges };
}
