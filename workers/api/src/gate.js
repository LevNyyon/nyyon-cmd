// Simple auth gate for the online command center.
//
// One credential (GATE_USER / GATE_PASSWORD, supplied as Cloudflare *secrets*
// — never committed), an HMAC-signed session cookie (GATE_SECRET), and a
// 3-failed-attempts-per-hour-per-IP rate limit backed by D1. Every request
// (SPA + API) passes through here first, so an unauthenticated visitor sees
// only the login page.
//
// Deliberately NOT storing the password in the repo: same lesson as the
// hardcoded key in scheduler.sh. The logic ships in git; the secret does not.

const COOKIE          = 'nyyon_gate';
const SESSION_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days
const RL_WINDOW_MS    = 60 * 60 * 1000;           // 1 hour
const RL_MAX_FAILS    = 3;                         // per IP per window

const enc = new TextEncoder();

// ── base64url ────────────────────────────────────────────────
function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function makeToken(secret, user) {
  const payload = b64urlFromBytes(enc.encode(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS })));
  const sig = b64urlFromBytes(await hmac(secret, payload));
  return `${payload}.${sig}`;
}
async function verifyToken(secret, token) {
  if (!secret || !token || token.indexOf('.') < 0) return false;
  const [payload, sig] = token.split('.');
  let expected;
  try { expected = await hmac(secret, payload); } catch { return false; }
  // b64urlToBytes -> atob THROWS on a malformed cookie. Outside a try that
  // became a 500 on every request carrying a corrupt cookie — including the
  // login page itself, which locks the operator out of their own install.
  // An unparsable signature is simply not a valid session.
  let got;
  try { got = b64urlToBytes(sig || ''); } catch { return false; }
  if (!timingSafeEqual(expected, got)) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch { return false; }
}

function readCookie(c, name) {
  const h = c.req.header('Cookie') || '';
  for (const part of h.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

// ── D1-backed rate limit (self-provisioning table) ───────────
async function ensureTable(db) {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS gate_attempts (ip TEXT, ts INTEGER)',
  ).run();
}
async function recentFails(db, ip) {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM gate_attempts WHERE ip = ? AND ts > ?')
    .bind(ip, Date.now() - RL_WINDOW_MS)
    .first();
  return r?.n || 0;
}
async function recordFail(db, ip) {
  await db.prepare('INSERT INTO gate_attempts (ip, ts) VALUES (?, ?)').bind(ip, Date.now()).run();
  // opportunistic cleanup so the table can't grow unbounded
  await db.prepare('DELETE FROM gate_attempts WHERE ts < ?').bind(Date.now() - RL_WINDOW_MS).run();
}

// ── middleware: runs first, gates everything except the login POST ──
export function gate() {
  return async (c, next) => {
    // Setup exemption: while setup is incomplete, /api/onboarding/* runs its
    // own guard (requireSetupAccess) — the cookie gate steps aside. Completed
    // setup makes those routes 404, so the exemption dies with it.
    //
    // And while NO ACCOUNT exists yet, a GET of the app shell (and its static
    // assets) is public too: a first visitor has no cookie and never could,
    // so gating the shell showed them the login page instead of the wizard.
    // The shell is static HTML; every API behind it still checks access.
    // Account creation issues the cookie, and from then on the shell is gated.
    {
      const p0 = new URL(c.req.url).pathname;
      const isOnboardingApi = p0.startsWith('/api/onboarding/');
      const isShellGet = !p0.startsWith('/api/') && c.req.method === 'GET';
      if (isOnboardingApi || isShellGet) {
        try {
          const { readInstallState } = await import('./lib/install.js');
          const st = await readInstallState(c.env);
          if (st && !st.setup_complete) {
            if (isOnboardingApi) return next();
            if (!st.has_admin) return next();
          }
        } catch { /* fall through */ }
      }
    }
    const path = c.req.path;
    if (path === '/__gate/login' || path === '/__gate/logout') return next();

    // Public brand/favicon assets — served without auth so the Nyyon icon renders
    // on the login page and in the browser tab before sign-in. Not sensitive.
    if (path === '/favicon.ico' ||
        path === '/assets/nyyon-logo-dark.svg' ||
        path === '/assets/nyyon-logo-light.svg') return next();

    // Published imagery — R2-served figures, covers, social cards, photos.
    // Public by design: articles delivered through the outbound webhooks embed
    // these URLs, so the receiving website's readers must be able to load
    // them. GET only; keys are content-addressed-ish and unguessable enough,
    // and the bucket holds nothing that is not already published output.
    if (c.req.method === 'GET' && path.startsWith('/assets/')) return next();

    // Dev-invoke API — bearer-key auth for curl access, scoped to /api/dev/*
    // ONLY. The key (DEV_API_KEY, a Cloudflare secret) unlocks the component
    // test bench, never the operator surface. Timing-safe compare, same
    // discipline as the login path. Falls through to the cookie check so a
    // logged-in operator can also use /api/dev from the browser.
    if (path.startsWith('/api/dev')) {
      const auth   = c.req.header('Authorization') || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const key    = bearer || c.req.header('X-Api-Key') || '';
      if (c.env.DEV_API_KEY && key) {
        const [got, expected] = await Promise.all([sha256(key), sha256(c.env.DEV_API_KEY)]);
        if (timingSafeEqual(got, expected)) return next();
      }
    }

    const ok = await verifyToken(c.env.GATE_SECRET, readCookie(c, COOKIE)).catch(() => false);
    if (ok) return next();

    if (path.startsWith('/api') || path === '/health') {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    return c.html(LOGIN_HTML, 200);
  };
}

export async function handleGateLogin(c) {
  const env = c.env;
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';

  if (!env.GATE_SECRET) return c.json({ ok: false, error: 'gate not configured' }, 500);

  await ensureTable(env.DB);
  const fails = await recentFails(env.DB, ip);
  if (fails >= RL_MAX_FAILS) {
    return c.json({ ok: false, error: 'Too many attempts. Try again in up to an hour.' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const user = String(body.username ?? '');
  const pass = String(body.password ?? '');

  let good = false;
  if (env.GATE_USER && env.GATE_PASSWORD) {
    const [uProvided, uExpected, pProvided, pExpected] = await Promise.all([
      sha256(user), sha256(env.GATE_USER), sha256(pass), sha256(env.GATE_PASSWORD),
    ]);
    good = timingSafeEqual(uProvided, uExpected) && timingSafeEqual(pProvided, pExpected);
  }
  if (!good) {
    // Setup-created account: PBKDF2-verified against install_state (constant
    // work whether or not the user exists — see lib/install.js verifyAdmin).
    try {
      const { verifyAdmin } = await import('./lib/install.js');
      good = await verifyAdmin(c.env, { username: user, password: pass });
    } catch { /* env-only installs keep working */ }
  }

  if (good) {
    const token = await makeToken(env.GATE_SECRET, user);
    const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : '';
    c.header(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
    return c.json({ ok: true });
  }

  await recordFail(env.DB, ip);
  return c.json({ ok: false, error: 'Invalid credentials.', remaining: Math.max(0, RL_MAX_FAILS - (fails + 1)) }, 401);
}

export function handleGateLogout(c) {
  c.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  return c.json({ ok: true });
}

// Login page styled to match the command center (nyyon logo, faint grid,
// Inter + JetBrains Mono, hairline card, auto light/dark). Self-contained;
// only the fonts come from Google's public CDN (same as the SPA's index.html).
const LOGIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>nyyon · command center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light dark;
    --paper:#FAFAF9; --ink:#0A0A0A; --line:#E7E5E4; --mute:#78716C; --card:#FFFFFF;
    --grid:10,10,10; --card-rgb:255,255,255;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper:#09090B; --ink:#FAFAF9; --line:#27272A; --mute:#A1A1AA; --card:#18181B;
      --grid:250,250,250; --card-rgb:24,24,27;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    background: var(--paper); color: var(--ink);
    -webkit-font-smoothing: antialiased;
    background-image:
      linear-gradient(to right,  rgba(var(--grid), .04) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(var(--grid), .04) 1px, transparent 1px);
    background-size: 56px 56px;
  }
  .card {
    width: 340px; max-width: 100%; padding: 34px 30px 30px;
    border: 1px solid var(--line); border-radius: 16px;
    background: rgba(var(--card-rgb), .7); backdrop-filter: blur(6px);
    box-shadow: 0 24px 70px -28px rgba(0,0,0,.45);
  }
  .brand { display: flex; flex-direction: column; align-items: center; gap: 14px; margin-bottom: 26px; }
  .logo { width: 34px; height: auto; color: var(--ink); display: block; }
  .brand .name { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
  .brand .eyebrow {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--mute);
  }
  label {
    display: block; font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 10px; text-transform: uppercase; letter-spacing: .12em;
    color: var(--mute); margin: 16px 0 7px;
  }
  input {
    width: 100%; padding: 11px 13px; border: 1px solid var(--line); border-radius: 9px;
    background: var(--paper); color: var(--ink); font-size: 14px; font-family: inherit;
    transition: border-color .12s ease;
  }
  input::placeholder { color: var(--mute); opacity: .7; }
  input:focus { outline: 1.5px solid var(--ink); outline-offset: 2px; border-color: var(--ink); }
  button {
    width: 100%; margin-top: 24px; padding: 12px; border: 0; border-radius: 9px;
    background: var(--ink); color: var(--paper); font-family: inherit;
    font-weight: 600; font-size: 14px; cursor: pointer; transition: opacity .12s ease;
  }
  button:hover { opacity: .9; }
  button:disabled { opacity: .45; cursor: default; }
  .err { margin-top: 16px; min-height: 15px; font-size: 12.5px; color: #DC2626; text-align: center; }
  @media (prefers-color-scheme: dark) { .err { color: #F87171; } }
  .foot {
    margin-top: 22px; text-align: center; font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--mute); opacity: .8;
  }
</style></head><body>
  <form class="card" id="f">
    <div class="brand">
      <svg class="logo" viewBox="0 0 64 70" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M33,0 L64,0 L64,66 L33,50 L33,0 Z M0,4 L31,20 L31,70 L0,70 L0,4 Z" fill="currentColor"/>
      </svg>
      <div class="name">nyyon</div>
      <div class="eyebrow">Command Center</div>
    </div>
    <label for="u">Email</label>
    <input id="u" name="u" type="email" autocomplete="username" placeholder="you@nyyon.com" autofocus>
    <label for="p">Password</label>
    <input id="p" name="p" type="password" autocomplete="current-password" placeholder="••••••••">
    <button id="b" type="submit">Sign in</button>
    <div class="err" id="e"></div>
    <div class="foot">Authorized operators only</div>
  </form>
<script>
  const f = document.getElementById('f'), b = document.getElementById('b'), e = document.getElementById('e');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault(); e.textContent = ''; b.disabled = true;
    try {
      const r = await fetch('/__gate/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }),
      });
      if (r.ok) { location.reload(); return; }
      const d = await r.json().catch(() => ({}));
      e.textContent = d.error || 'Sign in failed.';
      if (typeof d.remaining === 'number') e.textContent += ' (' + d.remaining + ' attempts left)';
    } catch { e.textContent = 'Network error.'; }
    b.disabled = false;
  });
</script>
</body></html>`;


// ── setup-flow session helpers (ported from nyyon-app) ──────────────────────
export async function hasGateSession(c) {
  return verifyToken(c.env.GATE_SECRET, readCookie(c, COOKIE)).catch(() => false);
}
export async function issueGateSession(c, user) {
  if (!c.env.GATE_SECRET) return false;
  const token = await makeToken(c.env.GATE_SECRET, user);
  const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : '';
  c.header(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
  return true;
}
