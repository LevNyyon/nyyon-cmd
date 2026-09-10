// Install state — the row that says how far this copy has been claimed.
//
// A shipped command center has a moment the reference one never had: the gap
// between "somebody unzipped it" and "somebody owns it". In that gap the setup
// surface is reachable by anyone who can load the page, and it can set the
// admin password. That is the most dangerous surface in the product.
//
// It used to be one flag. It is now TWO, because setup no longer ends with the
// account — it STARTS with it:
//
//   HAS_ADMIN (admin_user + admin_hash, stamped admin_set_at)
//     An account exists. The operator can sign in, and is signed in. The setup
//     token is burned in the same write, because from here the session cookie
//     is the proof of setup access and a bearer token would only be a second,
//     weaker key to the same door.
//
//   SETUP_COMPLETE (setup_completed_at, mirrored into the legacy onboarded_at)
//     The voice interview produced its documents. THIS is the flag that closes
//     verifySetupAccess permanently. There is no reopen path in code — a
//     re-onboard is a deliberate DB edit, which is the correct amount of
//     friction for "let anyone run the setup surface again".
//
// So the access rules are, in order:
//
//   1. setup_completed_at set  → closed. Forever. No exemption, no token, no
//      session, no loopback.
//   2. no admin yet           → the pre-account window: loopback (you are at
//      the machine) or the setup token the installer printed.
//   3. admin exists, setup unfinished → a valid SESSION and nothing else. The
//      token/loopback exemption belonged to the window in step 2 and is gone.
//
// Between "has admin" and "complete" there is one soft state: setup_deferred_at
// ("I'll do the interview later"). It is not completion — it boots the operator
// into the app and raises a banner, and it is cleared when they come back. A
// deferral that closed the surface would make "resume later" a lie.
//
// Storage is the single-row install_state table (migration 0067, extended by
// 0068). The password is PBKDF2-SHA256 with a per-install random salt; the
// iteration count travels inside admin_hash so it can be raised later without
// a migration or a forced reset.

import { logEvent } from './db.js';
import { now } from './util.js';

const enc = new TextEncoder();

// The floor the security review asked for. Left AT the floor on purpose: this
// runs inside a Worker request, and a Workers Free install has a 10ms CPU
// budget per request that a much larger count would blow on every sign-in.
// Raising it later costs nothing — verify() reads the count out of the stored
// hash, so old and new hashes coexist.
const PBKDF2_ITERATIONS = 100_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

// ── crypto helpers ──────────────────────────────────────────────────────────
function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Constant time in the LENGTH-EQUAL case, which is the only case that leaks
// anything useful: an attacker learning that two strings differ in length has
// learned nothing they could not measure from the input they sent.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function safeStrEqual(a, b) {
  return timingSafeEqual(enc.encode(String(a ?? '')), enc.encode(String(b ?? '')));
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return new Uint8Array(bits);
}

// ── the row ─────────────────────────────────────────────────────────────────
// `SELECT *` on purpose: an install that has run 0067 but not yet 0068 simply
// comes back without the new columns (undefined, which every reader below
// treats as "not stamped") instead of erroring out and failing the whole
// install state closed.
//
// Throws on a REAL database failure and returns null when the table simply is
// not there yet (a not-yet-migrated install is indistinguishable from a fresh
// one, and both mean "no operator has claimed this"). The distinction matters:
// verifySetupAccess must fail CLOSED on an error it does not understand, and
// it can only do that if a transient D1 failure is not quietly flattened into
// "fresh install".
async function readRow(env) {
  if (!env?.DB) return null;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS install_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      created_at INTEGER,
      admin_user TEXT, admin_hash TEXT, admin_salt TEXT, admin_set_at INTEGER,
      setup_token TEXT, setup_completed_at INTEGER, setup_deferred_at INTEGER,
      onboarded_at INTEGER, ephemeral_ack INTEGER, updated_at INTEGER
    )`).run().catch(() => {});
    const row = await env.DB.prepare('SELECT * FROM install_state WHERE id = 1').first();
    if (row) return row;
    // First contact with a brand-new install: stamp WHEN it came up. That
    // timestamp is what makes the claim window below possible — without it
    // there is no way to tell a minute-old deploy from a month-old one.
    await env.DB.prepare(
      'INSERT OR IGNORE INTO install_state (id, created_at) VALUES (1, ?)',
    ).bind(now()).run().catch(() => {});
    return (await env.DB.prepare('SELECT * FROM install_state WHERE id = 1').first()) || null;
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return null;
    throw e;
  }
}

// How long a freshly deployed install lets the FIRST visitor claim it.
//
// A brand-new user has no token to present: they clicked deploy and opened the
// URL. Demanding a code they have never seen is where an install stops being
// usable. So the door is open briefly — the same thing every self-hosted app
// does — and then it locks and asks for the code the deploy generated.
const CLAIM_WINDOW_MS = 60 * 60 * 1000;

async function writeRow(env, patch) {
  const ts = now();
  const cur = (await readRow(env)) || {};
  const next = {
    onboarded_at:       cur.onboarded_at ?? null,
    setup_completed_at: cur.setup_completed_at ?? null,
    setup_deferred_at:  cur.setup_deferred_at ?? null,
    setup_token:        cur.setup_token ?? null,
    admin_user:         cur.admin_user ?? null,
    admin_hash:         cur.admin_hash ?? null,
    admin_salt:         cur.admin_salt ?? null,
    admin_set_at:       cur.admin_set_at ?? null,
    created_at:         cur.created_at || ts,
    ...patch,
  };
  await env.DB.prepare(
    `INSERT INTO install_state
       (id, onboarded_at, setup_completed_at, setup_deferred_at, setup_token,
        admin_user, admin_hash, admin_salt, admin_set_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       onboarded_at       = excluded.onboarded_at,
       setup_completed_at = excluded.setup_completed_at,
       setup_deferred_at  = excluded.setup_deferred_at,
       setup_token        = excluded.setup_token,
       admin_user         = excluded.admin_user,
       admin_hash         = excluded.admin_hash,
       admin_salt         = excluded.admin_salt,
       admin_set_at       = excluded.admin_set_at,
       updated_at         = excluded.updated_at`,
  ).bind(
    next.onboarded_at, next.setup_completed_at, next.setup_deferred_at, next.setup_token,
    next.admin_user, next.admin_hash, next.admin_salt, next.admin_set_at,
    next.created_at, ts,
  ).run();
  return next;
}

// One place decides what "finished" means, so a row written before 0068 (which
// only has onboarded_at) and one written after are read identically.
function isComplete(row) {
  return Boolean(row?.setup_completed_at || row?.onboarded_at);
}
function hasAdminRow(row) {
  return Boolean(row?.admin_user && row?.admin_hash);
}

// ── contract ────────────────────────────────────────────────────────────────

// The one question every caller asks: where is this install in setup?
// Deliberately narrow — no token, no hash, no salt ever comes back out of
// here, because this feeds an UNAUTHENTICATED status endpoint (the SPA has to
// know which boot screen to render before anyone has signed in).
export async function readInstallState(env) {
  let row = null;
  try { row = await readRow(env); } catch { /* report as un-onboarded but never leak why */ }
  const has_admin      = hasAdminRow(row);
  const setup_complete = isComplete(row);
  // A deferral only means anything while setup is unfinished; a completed
  // install has nothing left to come back to.
  const setup_deferred = Boolean(row?.setup_deferred_at) && !setup_complete;
  return {
    has_admin,
    setup_complete,
    setup_deferred,
    // Boot lands on the setup surface only while there is a step left that the
    // operator has not chosen to postpone.
    needs_setup: !setup_complete && !setup_deferred,
    // Legacy name, unchanged meaning: "setup is finished". Kept so a caller
    // that still reads `onboarded` cannot accidentally read it as "has an
    // account" — that is `has_admin` and always was.
    onboarded: setup_complete,
    setup_token_set: Boolean(row?.setup_token) || Boolean(env?.SETUP_TOKEN),
    // A fingerprint for THIS database. The browser caches transcripts, and a
    // cache has no idea the install underneath it was rebuilt — so a wiped
    // install came back up showing the previous one's conversations. The SPA
    // stamps its caches with this and drops anything from a different install.
    // created_at is stamped once, on first contact, and never changes.
    install_id: row?.created_at ? String(row.created_at) : null,
    onboarded_at: row?.setup_completed_at ? Number(row.setup_completed_at)
      : row?.onboarded_at ? Number(row.onboarded_at) : null,
    admin_set_at: row?.admin_set_at ? Number(row.admin_set_at) : null,
    admin_username: row?.admin_user || null,
  };
}



// THE SECURITY BOUNDARY. Guards every setup handler.
//
// Fails closed on anything it does not understand, including a database error
// it cannot classify. The completion check is FIRST and has no escape: once
// setup_completed_at is stamped this returns false forever, whatever the
// caller presents.
//
// @param {string}  token    the setup token the caller sent (pre-account only)
// @param {string}  host     the request Host header (loopback = pre-account proof)
// @param {boolean} session  the caller carries a VALID signed session cookie.
//                           The caller proves this; this function never parses
//                           a cookie itself.
export async function verifySetupAccess(env, { token = '', host = '', session = false } = {}) {
  let row;
  try { row = await readRow(env); } catch { return false; }
  if (isComplete(row)) return false; // closed, permanently

  // An account exists: the operator is a signed-in user now, so being the
  // person at the keyboard is no longer a claim about the install, it is a
  // claim about a session. The token has been burned and loopback proves
  // nothing that a cookie does not prove better.
  if (hasAdminRow(row)) return session === true;

  // The pre-account window. Loopback IS the proof — a deployed Worker never
  // sees a localhost Host header (Cloudflare routes by hostname), so this can
  // only be true for someone already on the machine running the install.
  const h = String(host || '').toLowerCase().trim();
  const bare = h.startsWith('[') ? h.replace(/^(\[[^\]]*\]).*$/, '$1') : h.split(':')[0];
  if (LOOPBACK_HOSTS.has(bare) || bare.endsWith('.localhost')) return true;

  // A token, if the caller has one (the local installer prints it; a hosted
  // deploy puts it in the operator's own dashboard).
  const expected = String(row?.setup_token || env?.SETUP_TOKEN || '').trim();
  if (expected && safeStrEqual(String(token || '').trim(), expected)) return true;

  // Or: this install is brand new and nobody has claimed it yet. The first
  // person through the door within the window becomes the operator. After it
  // closes, only the token gets you in — so a forgotten public URL cannot be
  // taken over a week later.
  const bornAt = Number(row?.created_at || 0);
  if (bornAt > 0 && (now() - bornAt) < CLAIM_WINDOW_MS) return true;

  return false;
}

// STEP ONE of setup: the operator's own credential. It creates the account and
// nothing else — it does NOT finish setup, because the model key and the voice
// interview still have to happen and their routes have to stay reachable.
//
// It does burn the setup token, in the same write: from this instant the proof
// of setup access is the session cookie the caller issues on the way out, and
// leaving a bearer token alive alongside it would be a second key to a door
// that now has a better lock.
//
// One write — a partial failure that burned the token without storing a hash
// would leave an install nobody could claim or sign in to.
export async function setAdminCredentials(env, { username, password } = {}) {
  const user = String(username || '').trim().toLowerCase();
  const pass = String(password || '');
  if (!user) throw new Error('email required');
  // The sign-in form is type="email", so a non-email username creates an
  // account the operator can never type into it — the browser refuses to
  // submit and they are locked out of the install they just made. Enforce the
  // same shape here, where it is authoritative, rather than trusting the form.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(user)) {
    throw new Error('sign-in uses an email address — enter one (this is what you will type to log in)');
  }
  if (pass.length < 8) throw new Error('password must be at least 8 characters');

  const row = await readRow(env);
  if (isComplete(row)) throw new Error('this install has already finished setup');
  // Re-running step one would silently take over somebody else's install.
  if (hasAdminRow(row)) throw new Error('this install already has an account. Sign in instead.');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pass, salt, PBKDF2_ITERATIONS);

  await writeRow(env, {
    admin_user:   user,
    admin_hash:   `pbkdf2$${PBKDF2_ITERATIONS}$${b64(hash)}`,
    admin_salt:   b64(salt),
    admin_set_at: now(),
    setup_token:  null,   // burned
  });

  await logEvent(env, { kind: 'install_admin_created', actor: 'operator', payload: { username: user } });
  return { ok: true, username: user, has_admin: true };
}

// Change the credentials of an install you are ALREADY signed in to.
//
// Step one creates the account and is irreversible by design — you cannot
// "go back" and un-create a login. But an operator who mistyped their username
// on the very first screen should not be stuck with it, so going back from a
// later step re-opens this form and rewrites the credential in place.
//
// The caller proves an existing session (routes only reach this behind the
// cookie gate). That is the whole authorisation: whoever holds the session
// already owns the install, and the setup token was burned when the account
// was created.
export async function updateAdminCredentials(env, { username, password } = {}) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user) throw new Error('username required');
  if (pass.length < 8) throw new Error('password must be at least 8 characters');

  const row = await readRow(env);
  if (!hasAdminRow(row)) throw new Error('this install has no account yet');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pass, salt, PBKDF2_ITERATIONS);

  await writeRow(env, {
    admin_user: user,
    admin_hash: `pbkdf2$${PBKDF2_ITERATIONS}$${b64(hash)}`,
    admin_salt: b64(salt),
  });

  await logEvent(env, { kind: 'install_admin_updated', actor: 'operator', payload: { username: user } });
  return { ok: true, username: user, has_admin: true };
}

// THE LAST STEP: setup is finished. Stamps setup_completed_at (and the legacy
// onboarded_at alongside it, same instant, so both readings agree), which
// closes verifySetupAccess permanently.
//
// Refuses on an install with no account: "finished" would mean an install
// nobody can sign in to and whose setup surface is dead — bricked.
export async function markSetupComplete(env, { reason = 'interview' } = {}) {
  const row = await readRow(env);
  if (!hasAdminRow(row)) throw new Error('cannot finish setup before an account exists');
  if (isComplete(row)) return { ok: true, setup_complete: true, already: true };

  const ts = now();
  await writeRow(env, { setup_completed_at: ts, onboarded_at: ts, setup_deferred_at: null, setup_token: null });
  await logEvent(env, { kind: 'install_setup_completed', actor: 'operator', payload: { reason } });
  return { ok: true, setup_complete: true, at: ts };
}

// "Later." The operator goes into the app with the shipped default voice docs;
// the setup surface stays alive for them (session-authenticated) and the app
// raises a banner offering to finish. Deliberately NOT completion: completion
// is irreversible, and an interview you are promised you can resume must not
// be closed behind you.
export async function deferSetup(env) {
  const row = await readRow(env);
  if (!hasAdminRow(row)) throw new Error('cannot postpone setup before an account exists');
  if (isComplete(row)) return { ok: true, setup_complete: true, setup_deferred: false };
  await writeRow(env, { setup_deferred_at: now() });
  await logEvent(env, { kind: 'install_setup_deferred', actor: 'operator', payload: {} });
  return { ok: true, setup_deferred: true };
}

// Coming back to a deferred interview. Clears the postponement so boot lands on
// the setup surface again and the banner drops.
export async function resumeSetup(env) {
  const row = await readRow(env);
  if (isComplete(row)) throw new Error('setup is already finished on this install');
  if (!hasAdminRow(row)) throw new Error('there is nothing to resume yet');
  await writeRow(env, { setup_deferred_at: null });
  await logEvent(env, { kind: 'install_setup_resumed', actor: 'operator', payload: {} });
  return { ok: true, setup_deferred: false };
}

// Timing-safe on both halves, and it does the PBKDF2 derivation even when the
// username is wrong so a wrong-user attempt costs the same as a wrong-password
// one. Returns false — never throws — so a login handler cannot leak the
// difference between "no admin configured" and "bad password" through a 500.
export async function verifyAdmin(env, { username, password } = {}) {
  let row;
  try { row = await readRow(env); } catch { return false; }
  if (!row?.admin_user || !row?.admin_hash || !row?.admin_salt) return false;

  const parts = String(row.admin_hash).split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  let salt, expected;
  try { salt = unb64(String(row.admin_salt)); expected = unb64(parts[2]); } catch { return false; }

  const got = await pbkdf2(String(password || ''), salt, iterations);
  const pOk = timingSafeEqual(got, expected);
  // Emails are not case-sensitive in practice and the account is stored
  // lowercased, so "Dev@Example.com" must sign in as "Dev@Example.com" — comparing
  // exactly would lock out an operator who typed their own address naturally.
  const uOk = safeStrEqual(String(username || '').trim().toLowerCase(), String(row.admin_user || '').toLowerCase());
  return uOk && pOk;
}
