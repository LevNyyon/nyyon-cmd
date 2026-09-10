#!/usr/bin/env node
// Materialize code-carrying plugins FROM YOUR OWN MACHINE. No GitHub, no CI:
// your checkout is the source, Cloudflare runs the result.
//
//   node scripts/materialize.mjs --url https://<your-install>.workers.dev
//
// It signs in with your operator login (prompted, or NYYON_USER/NYYON_PASSWORD
// in the environment), asks the install which plugins are waiting, writes
// their files into workers/api/src/plugins/, regenerates the aggregator,
// deletes removed plugins, builds, deploys, and tells the install what
// landed so it can verify and flip them active. Re-runnable any time.
//
//   --no-deploy   write files only (inspect the diff, deploy later)
//
// ponytail: sequential + verbose on purpose; this runs a few times a month.

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'workers', 'api');
const args = process.argv.slice(2);
const flag = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const noDeploy = args.includes('--no-deploy');
let url = (flag('--url') || process.env.NYYON_URL || '').replace(/\/+$/, '');
const step = (m) => console.log(`\n→ ${m}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
if (!url) url = (await rl.question('Install URL (https://…workers.dev): ')).trim().replace(/\/+$/, '');
const user = process.env.NYYON_USER || (await rl.question('Operator email: ')).trim();
const pass = process.env.NYYON_PASSWORD || (await rl.question('Password: ')).trim();
rl.close();

// ── sign in (the same gate you use in the browser) ───────────────
step('signing in');
const login = await fetch(`${url}/__gate/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
if (!login.ok || !cookie) { console.error(`sign-in failed (${login.status})`); process.exit(1); }
const call = async (path, init = {}) => {
  const r = await fetch(url + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${j.error || ''}`);
  return j;
};

// ── the work list ────────────────────────────────────────────────
step('asking the install what is waiting');
const work = await call('/api/plugins/pending');
const pending = work.pending || [];
const remove = work.remove || [];
console.log(`pending: ${pending.map((p) => `${p.name} v${p.version}`).join(', ') || 'none'} · remove: ${remove.join(', ') || 'none'}`);
if (!pending.length && !remove.length && !(work.verify || []).length) { console.log('\nNothing to do.'); process.exit(0); }

// ── write files: installed set (heals a lost file), then removals ─
step('writing plugin files into the checkout');
for (const p of work.installed || []) {
  for (const f of p.files || []) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  console.log(`  ${p.name}: ${(p.files || []).length} file(s)`);
}
if (work.index_file) {
  const abs = join(root, work.index_file.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, work.index_file.content);
  console.log('  aggregator regenerated');
}
for (const name of remove) {
  const dir = join(api, 'src', 'plugins', name);
  if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); console.log(`  removed ${name}/`); }
}

if (noDeploy) { console.log('\n--no-deploy: files written, nothing deployed. Run again without the flag to deploy.'); process.exit(0); }

// ── build + deploy from here ─────────────────────────────────────
step('building the web app');
execSync('npm run build', { cwd: join(root, 'web'), stdio: 'inherit' });
step('deploying');
execSync('npx wrangler deploy', { cwd: api, stdio: 'inherit' });

// ── tell the install what landed, then verify ────────────────────
step('reporting back');
if (pending.length) await call('/api/plugins/applied', { method: 'POST', body: JSON.stringify({ names: pending.map((p) => p.name), ok: true }) });
if (remove.length) await call('/api/plugins/cleaned', { method: 'POST', body: JSON.stringify({ names: remove }) });
const toVerify = [...new Set([...(work.verify || []), ...pending.map((p) => p.name)])];
for (const name of toVerify) {
  const v = await call('/api/plugins/verify', { method: 'POST', body: JSON.stringify({ name }) }).catch((e) => ({ ok: false, error: String(e.message) }));
  console.log(`  ${name}: ${v.ok ? 'active' : `not yet (${v.error})`}`);
}
console.log('\n✓ Done. Commit the new files under workers/api/src/plugins/ so your checkout stays the source of truth.');
