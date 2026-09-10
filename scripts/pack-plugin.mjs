#!/usr/bin/env node
// Assemble a plugin FOLDER (the authoring form) into the canonical wire
// manifest: every code_file / body_file / page_file reference is inlined and
// the checksum recomputed. Mirrors lib/plugin-package.js assembleManifest,
// standalone so it runs in plain node without the worker import graph.
//
//   node scripts/pack-plugin.mjs plugins/daily-planner > /tmp/dp.json
//   curl -b cookies -X POST -H 'Content-Type: application/json' \
//        --data @/tmp/dp.json http://127.0.0.1:8799/api/plugins/import

import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { createHash } from 'node:crypto';

const dir = process.argv[2];
if (!dir) { console.error('usage: pack-plugin.mjs <plugin folder>'); process.exit(1); }

const read = (ref, what) => {
  const p = normalize(join(dir, ref));
  if (!p.startsWith(normalize(dir))) throw new Error(`${what}: ref escapes the folder: ${ref}`);
  return readFileSync(p, 'utf8');
};

const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const arr = (v) => (Array.isArray(v) ? v : []);

for (const lf of arr(m.lib)) {
  if (lf.code_file) { lf.code = read(lf.code_file, `lib ${lf.path}`); delete lf.code_file; }
}
for (const t of arr(m.provides?.tools)) {
  if (t.code_file) { t.code = read(t.code_file, `tool ${t.name}`); delete t.code_file; }
}
for (const g of arr(m.provides?.gateways)) {
  if (g.code_file) { g.code = read(g.code_file, `gateway ${g.slug}`); delete g.code_file; }
}
for (const k of arr(m.provides?.knowledge)) {
  if (k.body_file) { k.body = read(k.body_file, `knowledge ${k.slug}`); delete k.body_file; }
}
for (const sf of arr(m.provides?.surfaces)) {
  if (sf.page_file) { sf.page_code = read(sf.page_file, `surface ${sf.slug}`); delete sf.page_file; }
  for (const f of arr(sf.files)) {
    if (f.code_file) { f.code = read(f.code_file, `surface file ${f.path}`); delete f.code_file; }
  }
}

m.sha256 = createHash('sha256')
  .update(JSON.stringify({ requires: m.requires, provides: m.provides }))
  .digest('hex');

process.stdout.write(JSON.stringify({ manifest: m }));
