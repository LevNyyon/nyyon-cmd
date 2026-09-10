#!/usr/bin/env node
// Bootstrap a FRESH Nyyon Command Center on the Cloudflare account you are
// logged into with wrangler. One command:
//
//   npx wrangler login          (once)
//   node scripts/bootstrap.mjs  [--name my-cmd] [--account-id <id>]
//
// It creates the D1 database and R2 bucket, applies the consolidated schema,
// writes their ids into workers/api/wrangler.jsonc, builds the SPA, deploys
// the worker, sets a generated GATE_SECRET, mints a setup token, and prints
// the URL that opens the setup wizard. Re-running is safe: existing resources
// are reused, the schema is idempotent, and an already-claimed install is
// never reset.
//
// ponytail: shells out to wrangler and parses its text output — if a wrangler
// major changes its output shape, update the two parse points marked PARSE.

import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'workers', 'api');
const args = process.argv.slice(2);
const flag = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const name = flag('--name', 'nyyon-cmd');
const dbName = `${name}-db`;
const bucket = `${name}-assets`;

const run = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], cwd: api, ...opts });
const step = (msg) => console.log(`\n→ ${msg}`);

// ── 0. auth ──────────────────────────────────────────────────────
step('checking wrangler auth');
let whoami = '';
try { whoami = run('npx wrangler whoami'); } catch (e) {
  console.error('wrangler is not logged in. Run: npx wrangler login'); process.exit(1);
}
// PARSE: account table row "| Account Name | 32-hex-id |"
const accounts = [...whoami.matchAll(/\|\s*([^|]+?)\s*\|\s*([0-9a-f]{32})\s*\|/g)].map((m) => ({ name: m[1], id: m[2] }));
let accountId = flag('--account-id');
if (!accountId) {
  if (accounts.length === 1) accountId = accounts[0].id;
  else if (accounts.length > 1) {
    console.error(`This wrangler login can reach ${accounts.length} accounts — pass --account-id <id>:\n` +
      accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n'));
    process.exit(1);
  } else { console.error('could not read an account id from `wrangler whoami` — pass --account-id'); process.exit(1); }
}
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
console.log(`account: ${accountId}`);

// Write YOUR account id + worker name into wrangler.jsonc BEFORE creating
// anything: wrangler reads account_id from the config, and the shipped file
// carries a placeholder from another account until this line runs.
const cfgPath0 = join(api, 'wrangler.jsonc');
{
  let c = readFileSync(cfgPath0, 'utf8');
  c = c.replace(/"name":\s*"[^"]+"/, `"name": "${name}"`);
  c = c.replace(/"account_id":\s*"[0-9a-f]{32}"/, `"account_id": "${accountId}"`);
  writeFileSync(cfgPath0, c);
}

// ── 1. D1 database (create or reuse) ─────────────────────────────
step(`D1 database "${dbName}"`);
let dbId = null;
try {
  const created = run(`npx wrangler d1 create ${dbName}`);
  dbId = (created.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1] || null; // PARSE
} catch {
  // exists — find it
  try {
    const list = JSON.parse(run('npx wrangler d1 list --json'));
    dbId = (list.find((d) => d.name === dbName) || {}).uuid || null;
  } catch { /* fall through */ }
}
if (!dbId) { console.error(`could not create or find the D1 database "${dbName}"`); process.exit(1); }
console.log(`database_id: ${dbId}`);

// ── 2. R2 bucket (create or reuse) ───────────────────────────────
step(`R2 bucket "${bucket}"`);
try { run(`npx wrangler r2 bucket create ${bucket}`); console.log('created'); }
catch (e) {
  const msg = String(e?.stderr || e?.message || e);
  if (/already exists/i.test(msg)) console.log('exists (reusing)');
  else {
    // Most common on a brand-new account: R2 needs one-time activation.
    console.error(msg.slice(0, 400));
    console.error(`\nCould not create the R2 bucket. If this is a new Cloudflare account,\nR2 needs a one-time activation: open https://dash.cloudflare.com -> R2,\nclick through the activation (the free tier is fine), then run this\nbootstrap again.`);
    process.exit(1);
  }
}

// ── 3. write the ids into wrangler.jsonc ─────────────────────────
step('patching workers/api/wrangler.jsonc');
const cfgPath = join(api, 'wrangler.jsonc');
let cfg = readFileSync(cfgPath, 'utf8');
cfg = cfg.replace(/"database_name":\s*"[^"]+"/, `"database_name": "${dbName}"`);
cfg = cfg.replace(/"database_id":\s*"[^"]+"/, `"database_id": "${dbId}"`);
cfg = cfg.replace(/"bucket_name":\s*"[^"]+"/, `"bucket_name": "${bucket}"`);
writeFileSync(cfgPath, cfg);
console.log(`name=${name} db=${dbName} bucket=${bucket}`);

// ── 4. schema ────────────────────────────────────────────────────
step('applying the schema (remote D1)');
run(`npx wrangler d1 execute ${dbName} --remote -y --file schema.sql`, { stdio: 'inherit' });

// ── 5. build the SPA + deploy the worker ─────────────────────────
step('building the web app');
run('npm ci --no-audit --no-fund', { cwd: join(root, 'web'), stdio: 'inherit' });
run('npm run build', { cwd: join(root, 'web'), stdio: 'inherit' });
step('deploying the worker');
run('npm ci --no-audit --no-fund', { cwd: api, stdio: 'inherit' });
// First deploy runs VISIBLY: on a brand-new account wrangler may ask to
// register your workers.dev subdomain, and a piped prompt would hang unseen.
run('npx wrangler deploy', { stdio: 'inherit' });
// Second deploy is instant and non-interactive — it exists only so the URL
// can be captured from its output.
const deployOut = run('npx wrangler deploy');
const url = (deployOut.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0] || `https://${name}.<your-subdomain>.workers.dev`; // PARSE

// ── 6. GATE_SECRET (sessions cannot be issued without it) ────────
step('setting GATE_SECRET');
const gateSecret = randomBytes(32).toString('hex');
const sec = spawnSync('npx', ['wrangler', 'secret', 'put', 'GATE_SECRET'], { cwd: api, input: gateSecret, encoding: 'utf8' });
if (sec.status !== 0) { console.error(sec.stderr || 'secret put failed'); process.exit(1); }

// ── 7. setup token (first-entry proof beyond the 1-hour claim window) ──
step('minting the setup token');
const token = randomBytes(16).toString('hex');
run(`npx wrangler d1 execute ${dbName} --remote -y --command "INSERT INTO install_state (id, created_at, setup_token) VALUES (1, ${Date.now()}, '${token}') ON CONFLICT(id) DO UPDATE SET setup_token = CASE WHEN admin_user IS NULL THEN '${token}' ELSE setup_token END"`);

// ── 8. push the install's config into YOUR git (Local > Git > CF) ──
// Your fork is the source of truth: CI deploys every push to main, and code
// plugins ship as commits. The bootstrap's direct deploy above was only the
// first boot.
step('syncing your fork');
let origin = '';
try { origin = run('git remote get-url origin', { cwd: root }).trim(); } catch { /* no remote */ }
const isCanonical = /LevNyyon\/nyyon-cmd(\.git)?$/.test(origin);
if (isCanonical || !origin) {
  console.log(`
  This checkout is not YOUR repository yet (origin: ${origin || 'none'}).
  Give it one so pushes deploy:
    1. Create your own repo (private is fine): https://github.com/new
    2. git remote set-url origin https://github.com/YOUR-USER/YOUR-REPO.git
       git push -u origin main
    3. Re-run this bootstrap; it commits and pushes your install's config.`);
} else {
  try {
    run('git add workers/api/wrangler.jsonc', { cwd: root });
    run('git -c user.name=nyyon-bootstrap -c user.email=bootstrap@localhost commit -m "bootstrap: this install\'s ids"', { cwd: root });
  } catch { /* nothing new to commit */ }
  try { run('git push origin HEAD', { cwd: root, stdio: 'inherit' }); console.log('pushed to your fork'); }
  catch { console.log('could not push (check your git login) — push manually: git push origin HEAD'); }
}

console.log(`
✓ Your Nyyon Command Center is live.

  Open this to set it up (account, model key, connections):

    ${url}/?setup=${token}

  The link works until setup completes; a brand-new install also lets the
  first visitor in without it for one hour. Keep the token private.

  Optional, for push-to-main deploys from a GitHub fork:
    1. Create a Cloudflare token (template "Edit Cloudflare Workers"):
       https://dash.cloudflare.com/profile/api-tokens
    2. Add it to your fork as a secret named CLOUDFLARE_API_TOKEN:
       your fork -> Settings -> Secrets and variables -> Actions
`);
