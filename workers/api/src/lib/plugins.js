// Plugins — trade capabilities between nyyon-lite systems.
//
// The contract is docs/plugin-format.md (v2); this file is its executor:
// validate → bind gateways → activate data → materialize code.
//
// WHERE THE BOUNDARY ACTUALLY IS
// v1 tried to confine plugins by regex-scanning their source at import. An
// adversarial review dismantled that: SQL built at runtime, gateways never
// declared, imports written without a space after the keyword. Source text
// cannot constrain what code does with a handle it holds.
//
// So enforcement moved to lib/plugin-runtime.js. A v2 plugin tool receives a
// CAPABILITY OBJECT, never `env`: a D1 proxy that TOKENIZES every statement at
// query time and allows only the exact tables the manifest declared, a gateway
// function closed over the declared slugs AND their declared modes, and a
// namespaced logger. Nothing in the code checks here is load-bearing for
// security any more — they are an honest LINT: they catch mistakes early and
// give a clear import-time error instead of a confusing runtime one.
//
// The one thing that IS load-bearing here: what the manifest is allowed to
// activate as DATA (tables, workflows, knowledge), because that runs with host
// authority at import time. Those rules are strict.
//
// MATERIALIZATION IS CLOUD-SHAPED HERE. A Worker cannot load new code at
// runtime, and cmd is a DEPLOYED worker — no sidecar can write files — so
// materializePending() commits the files to the repo through
// lib/github-gateway.js and the push-to-main CI pipeline redeploys (minutes).
// Everything that is data — workflows, knowledge, tables — activates instantly
// at import.
//
// Statuses: imported → bound → materialized → active | blocked | removed.
// Every transition logs to the activity bus.

import { logEvent, writeKnowledge } from './db.js';
import { now } from './util.js';
import { ghConfigured, ghPutFile, ghDeleteFile, ghListDir } from './github-gateway.js';
import { RESERVED_GATEWAYS, bundledGatewaySlug, tableNamespace } from './plugin-runtime.js';

// v2 is the capability contract. v1 manifests are accepted ONLY when they carry
// no code at all (knowledge/workflow packs) — a v1 tool expected raw `env` and
// there is no safe way to run it.
const FORMAT_VERSIONS = [1, 2];
const CODE_FORMAT_VERSION = 2;
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{1,60}$/;
const SLUG_RE = /^[a-z][a-z0-9-]{1,60}$/;
const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,80}$/;
// The view kinds the host knows how to render. A surface is a DESCRIPTION,
// so the renderer is the only thing that ever executes.
const SURFACE_VIEWS = new Set(['list', 'form', 'markdown']);
const HOST_READ_DENY = new Set(['gateway_config', 'plugins', 'sync_state', 'knowledge_docs', 'workflows', 'sessions', 'scheduled_sends']);

// Anything that brings another module into a plugin's scope. v2 code imports
// NOTHING — it is handed everything it may use — so the rule is simply "none",
// which is far harder to slip past than an allowlist of shapes.
const IMPORTY = [
  [/(^|\n)\s*import\s*[{*'"a-zA-Z_$]/, 'import declaration'],
  [/(^|\n)\s*export\s+(\*|{[^}]*})\s*from\b/, 're-export from another module'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\brequire\s*\(/, 'require'],
];
// Lint only — the runtime is what actually stops these. Kept because they are
// reliable signals of a plugin written against the old contract.
const LINT = [
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function/, 'new Function'],
  [/\bprocess\./, 'process'],
];

const arr = (v) => (Array.isArray(v) ? v : []);
const safeParse = (s, fallback = {}) => {
  try { return JSON.parse(s || '') ?? fallback; } catch { return fallback; }
};

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// NOTE: this is a CHECKSUM, not a signature. It proves the manifest was not
// mangled in transit; it proves nothing about who wrote it, because the sender
// computes it with no key. Trusting a plugin is trusting its author.
export const manifestPayload = (m) => JSON.stringify({ requires: m.requires || {}, provides: m.provides || {} });

// ─── validation (import-time lint + the strict data rules) ───────

// Comments are prose; scanning them produced false positives on English text
// like "update contacts". Strip them before looking for code shapes.
const stripComments = (code) => String(code || '')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function checkCode(code, { kind, toolName, pluginName, declaredGateways, libNames, hostReadNames }) {
  const errors = [];
  let src = stripComments(code);

  // The ONE import form plugin code may use: a declared flat sibling lib.
  // Strip those before the imports-nothing check so everything else trips it.
  const libs = libNames || new Set();
  src = src.replace(/(^|\n)\s*import\s+(?:{[^}]*}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s+['"]\.\/([a-z][a-z0-9_-]{0,60}\.mjs)['"];?/g,
    (whole, lead, ref) => {
      if (!libs.has(ref)) errors.push(`${kind} ${toolName}: imports "./${ref}" which provides.lib does not declare`);
      return lead;
    });

  for (const [re, label] of IMPORTY) {
    // A bundled gateway is the service boundary and still imports nothing:
    // it is handed a projected env by the generated wrapper.
    if (re.test(src)) errors.push(`${kind} ${toolName}: ${label} — v2 plugin code imports nothing; everything it may use is passed in`);
  }
  for (const [re, label] of LINT) {
    if (re.test(src)) errors.push(`${kind} ${toolName}: ${label} is not allowed`);
  }

  if (kind === 'tool') {
    if (!/export\s+const\s+def\s*=/.test(src)) errors.push(`tool ${toolName}: missing "export const def"`);
    if (!/export\s+async\s+function\s+run\s*\(/.test(src)) errors.push(`tool ${toolName}: missing "export async function run("`);
    // v2 tools take the capability object. A tool still reaching for env.DB or
    // a bare callGateway was written against v1 and will fail at runtime.
    if (/\benv\s*\.\s*DB\b/.test(src)) errors.push(`tool ${toolName}: uses env.DB — v2 tools use api.db (run(api, input))`);
    if (/\bcallGateway\s*\(/.test(src)) errors.push(`tool ${toolName}: uses callGateway — v2 tools use api.gateway(slug, mode, input)`);
  }
  if (kind === 'gateway' && !/export\s+const\s+gateway\s*=/.test(src)) {
    errors.push(`gateway ${toolName}: missing "export const gateway"`);
  }

  // Lint: literal gateway slugs must have been declared. The runtime enforces
  // this for real (including slugs built at runtime, which this cannot see).
  if (kind === 'tool' && declaredGateways) {
    for (const m of src.matchAll(/\bapi\s*\.\s*gateway\s*\(\s*['"`]([a-z0-9-]+)['"`]/gi)) {
      const slug = m[1].toLowerCase();
      if (!declaredGateways.has(slug)) {
        errors.push(`tool ${toolName}: calls gateway "${slug}" which requires.gateways does not declare`);
      }
    }
  }

  // Lint: literal table names outside the namespace. Runtime is authoritative.
  // UPPERCASE keywords only — lowercase `from` appears constantly in prose and
  // JS (Array.from), and the runtime tokenizer is what actually decides.
  const ns = tableNamespace(pluginName);
  // `ON CONFLICT … DO UPDATE SET` is an upsert clause — the DO-preceded UPDATE
  // names no table (the runtime tokenizer already knew; this lint has to agree).
  for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|(?<!\bDO\s)UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)/g)) {
    const t = m[1].toLowerCase();
    if (!t.startsWith(ns) && !(hostReadNames || new Set()).has(t) && !['select', 'values'].includes(t)) {
      errors.push(`${kind} ${toolName}: references table "${t}" outside ${ns}*`);
    }
  }
  return errors;
}

// DDL runs with HOST authority at import time, so this one is a real gate, not
// a lint. The v1 version anchored only the prefix, which let
// `CREATE TABLE IF NOT EXISTS plugin_x_c AS SELECT * FROM gateway_config`
// copy the credential table into the plugin's namespace. Match the WHOLE
// statement instead, and require a column list.
// Returns `created`, the tables this DDL actually brings into existence, so
// the caller can check the manifest's declared `name` against reality rather
// than taking the plugin's word for it.
function checkDdl(ddl, pluginName) {
  const ns = tableNamespace(pluginName);
  const errors = [];
  const created = [];
  const raw = String(ddl || '');
  // Split on semicolons that are not inside a string literal.
  const stmts = raw.split(/;(?=(?:[^']*'[^']*')*[^']*$)/).map((s) => s.trim()).filter(Boolean);
  const TABLE_RE = new RegExp(`^CREATE TABLE IF NOT EXISTS (${ns}[a-z0-9_]*) \\(.*\\)$`, 'i');
  const INDEX_RE = new RegExp(`^CREATE INDEX IF NOT EXISTS idx_${ns}[a-z0-9_]* ON ${ns}[a-z0-9_]* \\(.*\\)$`, 'i');
  for (const s of stmts) {
    const n = s.replace(/\s+/g, ' ').trim();
    if (/\bAS\b\s*(WITH|SELECT|\()/i.test(n)) {
      errors.push(`ddl: CREATE ... AS SELECT is refused (it can copy host tables): ${n.slice(0, 90)}`);
      continue;
    }
    if (/\b(TEMP|TEMPORARY)\b/i.test(n) || /\bmain\s*\./i.test(n)) {
      errors.push(`ddl: temp tables and schema-qualified names are refused: ${n.slice(0, 90)}`);
      continue;
    }
    const hit = TABLE_RE.exec(n);
    if (hit) { created.push(hit[1].toLowerCase()); continue; }
    if (INDEX_RE.test(n)) continue; // an index creates no table
    errors.push(`ddl: refused — only "CREATE TABLE IF NOT EXISTS ${ns}… ( … )" and "CREATE INDEX IF NOT EXISTS idx_${ns}… ON ${ns}… ( … )": ${n.slice(0, 90)}`);
  }
  return { errors, stmts, created };
}

export async function validateManifest(env, m) {
  const errors = [];
  if (!m || !FORMAT_VERSIONS.includes(m.nyyon_plugin)) errors.push(`nyyon_plugin must be one of ${FORMAT_VERSIONS.join(', ')}`);
  if (!NAME_RE.test(m?.name || '')) errors.push('name: kebab-case slug required');
  if (!m?.title || !m?.version) errors.push('title + version required');
  if (errors.length) return { ok: false, errors };

  const p = m.provides || {};
  const tools = arr(p.tools);
  const gateways = arr(p.gateways);
  const workflows = arr(p.workflows);
  const knowledge = arr(p.knowledge);
  const declaredGateways = new Set(arr(m.requires?.gateways).map((g) => g?.slug).filter(Boolean));

  if (!tools.length && !workflows.length && !knowledge.length && !arr(p.surfaces).length) errors.push('provides: empty plugin');

  // v1 is data-only. A v1 tool was written for raw `env` and cannot be run
  // under the capability contract, so refuse it with a migration pointer.
  if (m.nyyon_plugin < CODE_FORMAT_VERSION && (tools.length || gateways.length)) {
    errors.push('nyyon_plugin 1 carries code: v1 tools expected raw env and are no longer runnable. Re-author as v2 (run(api, input) using api.db / api.gateway) — see docs/plugin-format.md.');
  }

  if (m.sha256) {
    const got = await sha256Hex(manifestPayload(m));
    if (got !== m.sha256) errors.push('checksum mismatch — the manifest was altered in transit');
  }

  // Shared lib files: real modules at pack scale cannot inline a thousand-line
  // lib into every tool. A lib is plugin code like any other — same lint, same
  // runtime authority (none beyond the api handed to it) — and tools may import
  // ONLY these declared flat siblings.
  const libNames = new Set();
  const hostReadNames = new Set(arr(m.requires?.host_reads).map((hr) => String((typeof hr === 'string' ? hr : hr?.table) || '').toLowerCase()).filter(Boolean));
  for (const lf of arr(m.lib)) {
    if (!/^[a-z][a-z0-9_-]{0,60}\.mjs$/.test(lf?.path || '')) errors.push(`lib path must be a flat name.mjs — got ${JSON.stringify(lf?.path)}`);
    else libNames.add(lf.path);
    if (typeof lf?.code !== 'string' || !lf.code.trim()) errors.push(`lib ${lf?.path}: no code`);
    else errors.push(...checkCode(lf.code, { kind: 'lib', toolName: lf.path, pluginName: m.name, declaredGateways, libNames, hostReadNames }));
  }
  for (const t of tools) {
    if (!TOOL_RE.test(t?.name || '')) errors.push(`tool name invalid: ${t?.name}`);
    if (t?.def?.name !== t?.name) errors.push(`tool ${t?.name}: def.name mismatch`);
    errors.push(...checkCode(t?.code, { kind: 'tool', toolName: t?.name, pluginName: m.name, declaredGateways, libNames, hostReadNames }));
  }
  for (const g of gateways) {
    if (!SLUG_RE.test(g?.slug || '')) errors.push(`gateway slug invalid: ${g?.slug}`);
    if (g?.slug && RESERVED_GATEWAYS.has(g.slug)) errors.push(`gateway ${g.slug}: reserved — a plugin may never provide it`);
    if (!arr(g?.modes).length) errors.push(`gateway ${g?.slug}: must declare its modes`);
    errors.push(...checkCode(g?.code, { kind: 'gateway', toolName: g?.slug, pluginName: m.name }));
  }
  // requires.tables[].name is NOT documentation. Since access moved from a
  // prefix test to exact membership in the declared set, this field IS the D1
  // grant — generateIndex copies it straight into the TABLES map the capability
  // object reads. Unchecked, `{"name":"gateway_config","ddl":"CREATE TABLE IF
  // NOT EXISTS plugin_x_t (…)"}` passed validation and handed the plugin the
  // host credential table. So the name must be in the namespace AND be a table
  // its own ddl actually creates.
  {
    const ns = tableNamespace(m.name);
    // Creates are gathered ACROSS the entries first: one entry's ddl may
    // legitimately create the table another entry names.
    const created = new Set();
    for (const tb of arr(m.requires?.tables)) {
      const r = checkDdl(tb?.ddl, m.name);
      errors.push(...r.errors);
      for (const c of r.created) created.add(c);
    }
    for (const tb of arr(m.requires?.tables)) {
      const nm = String(tb?.name || '').toLowerCase();
      if (!nm) { errors.push('requires.tables: every entry needs a name'); continue; }
      if (!TABLE_NAME_RE.test(nm)) { errors.push(`requires.tables: invalid table name "${tb?.name}"`); continue; }
      if (!nm.startsWith(ns)) {
        errors.push(`requires.tables: "${tb?.name}" is outside this plugin's namespace (${ns}*) — the declared table set is exactly what the runtime grants`);
      } else if (!created.has(nm)) {
        errors.push(`requires.tables: "${tb?.name}" is not created by this plugin's own DDL — a plugin may only claim tables it brings with it`);
      }
    }
  }

  // Host-table READ grants: SELECT-only access to named host tables, visible
  // at import. The denylist is absolute — the stores that hold credentials,
  // sessions, or the plugin system itself are never grantable, and knowledge
  // goes through api.knowledge so the grant surface stays one list.
  for (const hr of arr(m.requires?.host_reads)) {
    const t = String((typeof hr === 'string' ? hr : hr?.table) || '').toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(t)) errors.push(`requires.host_reads: bad table name ${JSON.stringify(t)}`);
    else if (HOST_READ_DENY.has(t) || t.startsWith('gate_') || t.startsWith('plugin')) {
      errors.push(`requires.host_reads: "${t}" is never grantable`);
    }
  }

  // Knowledge READ grants: host docs the plugin's tools may read at runtime
  // (its own plugin-<name>-* docs need no grant). Read-only by construction —
  // the runtime has no write path — and declared so the operator sees exactly
  // which of the host's editable rules a foreign module runs on.
  for (const k of arr(m.requires?.knowledge)) {
    const slug = typeof k === 'string' ? k : k?.slug;
    if (!/^[a-z][a-z0-9-]{1,80}$/.test(slug || '')) errors.push(`requires.knowledge: bad slug ${JSON.stringify(slug)}`);
  }

  // Surfaces: a module IS its page, so a plugin that cannot ship one cannot be
  // a module. It ships a DESCRIPTION, not code — the host renders it in its own
  // look. That is what makes a module exchangeable between users: nobody
  // installing a stranger's module should be injecting their React into their
  // own app with their own session, and a stranger's TSX that fails to compile
  // would break the RECEIVER's build. Declarative also means a surface is data,
  // so it activates at import with no rebuild.
  {
    const toolNames = new Set(tools.map((t) => t?.name).filter(Boolean));
    for (const sf of arr(p.surfaces)) {
      if (!SLUG_RE.test(sf?.slug || '')) { errors.push(`surface slug invalid: ${sf?.slug}`); continue; }
      if (!sf?.title) errors.push(`surface ${sf.slug}: needs a title`);
      // An icon travels WITH the surface: a host icon-set NAME, an emoji, or
      // inline SVG (≤4KB, no script/handlers — it renders in the sidebar).
      if (sf?.icon !== undefined) {
        const ic = String(sf.icon);
        if (ic.length > 4096) errors.push(`surface ${sf.slug}: icon over 4KB`);
        if (/^\s*</.test(ic) && /<script|on\w+\s*=|javascript:/i.test(ic)) {
          errors.push(`surface ${sf.slug}: svg icon may not carry scripts or handlers`);
        }
      }
      // Declarative only: a surface is a DESCRIPTION the host renders in its
      // own look. page_code (a real TSX page committed through CI) was removed
      // — re-add it the day a plugin genuinely needs module-grade UI.
      if (typeof sf?.page_code === 'string' && sf.page_code.trim()) {
        errors.push(`surface ${sf.slug}: page_code was removed from the contract — describe the surface with tabs (list / form / markdown)`);
        continue;
      }
      if (arr(sf.files).length) { errors.push(`surface ${sf.slug}: files accompanied page_code, which was removed`); continue; }
      const tabs = arr(sf?.tabs);
      if (!tabs.length) errors.push(`surface ${sf.slug}: needs tabs`);
      for (const tab of tabs) {
        if (!tab?.key || !tab?.title) { errors.push(`surface ${sf.slug}: every tab needs a key and a title`); continue; }
        const view = tab.view || {};
        if (!SURFACE_VIEWS.has(view.kind)) {
          errors.push(`surface ${sf.slug}/${tab.key}: view.kind must be one of ${[...SURFACE_VIEWS].join(', ')}`);
          continue;
        }
        // A surface may only drive THIS plugin's own tools — it must not become
        // a remote control for the host pool.
        if (view.kind !== 'markdown') {
          if (!view.tool) errors.push(`surface ${sf.slug}/${tab.key}: ${view.kind} needs a tool`);
          else if (!toolNames.has(view.tool)) {
            errors.push(`surface ${sf.slug}/${tab.key}: tool "${view.tool}" is not one this plugin provides`);
          }
        }
        for (const a of arr(view.actions)) {
          if (a?.tool && !toolNames.has(a.tool)) {
            errors.push(`surface ${sf.slug}/${tab.key}: action tool "${a.tool}" is not one this plugin provides`);
          }
        }
      }
    }
  }

  // Gateway requirements: no reserved slugs, no binding to another plugin's
  // bundled gateway, and a requirement that asserts no modes binds to anything.
  for (const g of arr(m.requires?.gateways)) {
    if (!SLUG_RE.test(g?.slug || '')) { errors.push(`requires.gateways: invalid slug ${g?.slug}`); continue; }
    if (RESERVED_GATEWAYS.has(g.slug)) errors.push(`requires.gateways: "${g.slug}" is reserved and can never be bound by a plugin`);
    if (g.slug.startsWith('plugin__') || g.slug.startsWith('plugin-')) errors.push(`requires.gateways: "${g.slug}" — a plugin may not bind another plugin's bundled gateway`);
    if (!arr(g.modes).length) errors.push(`requires.gateways: "${g.slug}" must list the modes it uses`);
  }

  // Host collisions: a plugin may not shadow an existing pool tool. The live
  // pool CONTAINS the currently-installed version of this very plugin, so its
  // own stored names are exempt — otherwise no code-bearing plugin could ever
  // be re-imported (an icon tweak collided with itself).
  try {
    const { visibleToolDefs } = await import('../tools/index.js');
    const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
    const prevRow = env?.DB
      ? await env.DB.prepare('SELECT manifest_json FROM plugins WHERE name = ?').bind(m.name).first().catch(() => null)
      : null;
    if (prevRow?.manifest_json) {
      try { for (const pt of arr(JSON.parse(prevRow.manifest_json)?.provides?.tools)) names.delete(pt?.name); }
      catch { /* unreadable stored manifest — keep the strict set */ }
    }
    for (const t of tools) if (names.has(t.name)) errors.push(`tool ${t.name}: name collides with the host pool`);
  } catch (e) {
    // Fail CLOSED: without the pool we cannot rule out shadowing a host tool.
    errors.push(`tool pool unavailable, cannot check name collisions: ${String(e?.message || e)}`);
  }

  // A plugin may only overwrite workflow slugs it created itself, and its
  // knowledge lives in the plugin's own namespace, like tables and gateways do.
  for (const w of workflows) {
    if (!SLUG_RE.test(w?.slug || '')) errors.push(`workflow slug invalid: ${w?.slug}`);
  }
  try {
    for (const w of workflows) {
      const row = await env.DB.prepare('SELECT created_by FROM workflows WHERE slug = ?').bind(w?.slug).first();
      if (row && row.created_by !== `plugin:${m.name}`) errors.push(`workflow ${w?.slug}: slug collides with a host workflow`);
    }
  } catch { /* db unavailable — the workflow upsert will surface it */ }
  for (const k of knowledge) {
    if (!String(k?.slug || '').startsWith(`plugin-${m.name}`)) {
      errors.push(`knowledge ${k?.slug}: must live in the plugin namespace (slug starting "plugin-${m.name}")`);
    }
  }

  // Workflow steps must exist post-install (host pool + this plugin's tools).
  try {
    const { visibleToolDefs } = await import('../tools/index.js');
    const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
    for (const t of tools) names.add(t.name);
    for (const w of workflows) {
      for (const st of arr(w.steps)) {
        const stepName = typeof st === 'string' ? st : st?.tool;
        if (stepName && !names.has(stepName)) errors.push(`workflow ${w.slug}: step "${stepName}" exists in neither the host pool nor this plugin`);
      }
    }
  } catch { /* already reported above */ }

  return { ok: !errors.length, errors };
}

// ─── gateway binding ─────────────────────────────────────────────

export async function bindGateways(env, m) {
  const { listGateways } = await import('../gateways/index.js');
  const host = Object.fromEntries(listGateways().map((g) => [g.slug, new Set(arr(g.modes))]));
  const bundled = Object.fromEntries(arr(m.provides?.gateways).map((g) => [g.slug, g]));
  const binding = {};
  const errors = [];
  for (const req of arr(m.requires?.gateways)) {
    const modes = arr(req.modes);
    if (RESERVED_GATEWAYS.has(req.slug)) { errors.push(`gateway ${req.slug}: reserved, never bindable by a plugin`); continue; }
    const have = host[req.slug];
    // `modes` travels INTO the binding: the operator approved a slug and a mode
    // list, and the runtime enforces both.
    if (have && modes.every((mode) => have.has(mode))) { binding[req.slug] = { via: 'host', target: req.slug, modes }; continue; }
    const bun = bundled[req.slug];
    if (bun) {
      // A bundle only satisfies the requirement if it offers every mode.
      const offers = new Set(arr(bun.modes));
      const short = modes.filter((mode) => !offers.has(mode));
      if (short.length) { errors.push(`gateway ${req.slug}: the bundled replacement lacks modes [${short}]`); continue; }
      binding[req.slug] = { via: 'bundled', target: bundledGatewaySlug(m.name, req.slug), modes };
      continue;
    }
    const missing = have ? modes.filter((mode) => !have.has(mode)) : modes;
    errors.push(`gateway ${req.slug}: host ${have ? `lacks modes [${missing}]` : 'does not have it'} and the plugin bundles no replacement`);
  }
  return { ok: !errors.length, binding, errors };
}

// ─── the import pipeline ─────────────────────────────────────────

export async function importPlugin(env, manifest, { actor = 'operator' } = {}) {
  const name = manifest?.name;
  // Refuse an unusable name BEFORE any write: the name becomes a repo path for
  // the materializer, so "../.." must never reach a stored row.
  if (!NAME_RE.test(name || '')) {
    return { ok: false, status: 'blocked', errors: ['name: kebab-case slug required (a plugin name becomes a repo path)'] };
  }

  const existing = await env.DB.prepare('SELECT status FROM plugins WHERE name = ?').bind(name).first().catch(() => null);
  const live = existing && ['active', 'materialized'].includes(existing.status);

  const save = (status, extra = {}) => env.DB.prepare(
    `INSERT INTO plugins (name, version, title, status, manifest_json, binding_json, report_json, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET version = excluded.version, title = excluded.title, status = excluded.status,
       manifest_json = excluded.manifest_json, binding_json = excluded.binding_json,
       report_json = excluded.report_json, updated_at = excluded.updated_at`,
  ).bind(name, manifest?.version || '0', manifest?.title || name, status,
    JSON.stringify(manifest), JSON.stringify(extra.binding || {}), JSON.stringify(extra.report || {}),
    now(), now()).run();

  // A failed re-import must NOT overwrite a working installation's row — that
  // replaced a live plugin's manifest with the rejected one.
  const reject = async (step, errs) => {
    if (live) {
      await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step, errors: errs.slice(0, 10), kept_installed: true } });
      return { ok: false, status: 'blocked', errors: errs, note: `the installed ${existing.status} plugin "${name}" was left untouched` };
    }
    await save('blocked', { report: { step, errors: errs } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step, errors: errs.slice(0, 10) } });
    return { ok: false, status: 'blocked', errors: errs };
  };

  const v = await validateManifest(env, manifest);
  if (!v.ok) return reject('validate', v.errors);

  const b = await bindGateways(env, manifest);
  if (!b.ok) return reject('bind', b.errors);

  // The previous manifest, read BEFORE the row is overwritten — it is what says
  // which workflow slugs this plugin used to own.
  const prevManifest = existing
    ? safeParse((await env.DB.prepare('SELECT manifest_json FROM plugins WHERE name = ?').bind(name).first().catch(() => null))?.manifest_json)
    : {};

  // Record the attempt BEFORE mutating anything, so a throw mid-way leaves a
  // row explaining the partial state instead of orphan tables with no record.
  // A LIVE plugin's row is not overwritten until activation succeeds, so a
  // failed upgrade cannot destroy a working installation's manifest.
  if (!live) await save('imported', { binding: b.binding, report: { step: 'activating' } });

  const warnings = [];
  const retired = [];
  try {
    for (const tb of arr(manifest.requires?.tables)) {
      const { errors: ddlErrors, stmts } = checkDdl(tb.ddl, name);
      if (ddlErrors.length) throw new Error(ddlErrors[0]);
      for (const stmt of stmts) await env.DB.prepare(stmt).run();
    }
    for (const w of arr(manifest.provides?.workflows)) {
      // An operator's deliberate disable survives a re-import.
      await env.DB.prepare(
        `INSERT INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'plugin', 'active', ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description,
           steps = excluded.steps, updated_at = excluded.updated_at,
           status = CASE WHEN workflows.status = 'disabled' THEN 'disabled' ELSE 'active' END`,
      ).bind(w.slug, w.name || w.slug, w.goal || w.description || null,
        JSON.stringify({ kind: 'manual' }), JSON.stringify(arr(w.steps)), now(), now(), `plugin:${name}`).run();
    }
    // Workflow slugs this plugin used to provide and no longer does are retired.
    if (existing) {
      const prevSlugs = new Set(arr(prevManifest?.provides?.workflows).map((w) => w?.slug).filter(Boolean));
      const nextSlugs = new Set(arr(manifest.provides?.workflows).map((w) => w?.slug).filter(Boolean));
      for (const slug of prevSlugs) {
        if (!nextSlugs.has(slug)) {
          // Disabling a workflow the operator was using is a real mutation, so
          // it is named in the plugin_imported event rather than happening
          // silently inside a swallowed catch.
          await env.DB.prepare("UPDATE workflows SET status = 'disabled', updated_at = ? WHERE slug = ? AND created_by = ?")
            .bind(now(), slug, `plugin:${name}`).run().catch(() => {});
          retired.push(slug);
        }
      }
    }
    for (const k of arr(manifest.provides?.knowledge)) {
      try {
        await writeKnowledge(env, { slug: k.slug, title: k.title || k.slug, body: k.body || '', scope: 'global', module: null, parent_slug: 'nyyon-root' });
      } catch (e) {
        warnings.push(`knowledge ${k.slug}: ${String(e?.message || e)}`);
      }
    }
  } catch (e) {
    const err = `activation failed: ${String(e?.message || e)}`;
    await save('blocked', { binding: b.binding, report: { step: 'activate', errors: [err], partial: true } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step: 'activate', error: err } });
    return { ok: false, status: 'blocked', errors: [err] };
  }

  // Knowledge-only plugins whose every write failed have delivered nothing.
  const onlyKnowledge = !arr(manifest.provides?.tools).length && !arr(manifest.provides?.workflows).length;
  if (onlyKnowledge && warnings.length === arr(manifest.provides?.knowledge).length && warnings.length) {
    await save('blocked', { binding: b.binding, report: { step: 'activate', errors: warnings } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step: 'activate', errors: warnings.slice(0, 10) } });
    return { ok: false, status: 'blocked', errors: warnings };
  }

  const hasCode = arr(manifest.provides?.tools).length || arr(manifest.provides?.gateways).length;
  await save(hasCode ? 'bound' : 'active', {
    binding: b.binding,
    report: {
      step: hasCode ? 'awaiting-materialize' : 'done',
      ...(warnings.length ? { warnings } : {}),
      ...(retired.length ? { retired_workflows: retired } : {}),
    },
  });
  await logEvent(env, {
    kind: 'plugin_imported',
    actor,
    payload: { name, version: manifest.version, binding: b.binding, needs_materialization: !!hasCode, warnings, retired_workflows: retired },
  });
  return { ok: true, status: hasCode ? 'bound' : 'active', binding: b.binding, warnings, retired_workflows: retired };
}

// ─── materialization ─────────────────────────────────────────────

const pluginDir = (name) => `workers/api/src/plugins/${name}`;

// Only gateways the binding actually chose are materialized: a bundle the host
// superseded is dead code, and registering it would let another plugin bind it.
const bundledInUse = (manifest, binding) =>
  arr(manifest.provides?.gateways).filter((g) => binding?.[g.slug]?.via === 'bundled');

export function filesFor(manifest, binding) {
  const files = [];
  if (!NAME_RE.test(manifest?.name || '')) return files; // never build a path from a bad name
  for (const t of arr(manifest.provides?.tools)) {
    if (!TOOL_RE.test(t?.name || '')) continue;
    // Source is materialized VERBATIM — no rewriting. The gateway binding is
    // resolved at runtime by the capability object, so there is nothing to
    // patch and no call form that can be missed.
    files.push({ path: `${pluginDir(manifest.name)}/tool-${t.name}.mjs`, content: String(t.code || '') });
  }
  for (const g of bundledInUse(manifest, binding)) {
    files.push({ path: `${pluginDir(manifest.name)}/gateway-${g.slug}.mjs`, content: String(g.code || '') });
  }
  for (const lf of arr(manifest.lib)) {
    if (!/^[a-z][a-z0-9_-]{0,60}\.mjs$/.test(lf?.path || '')) continue;
    files.push({ path: `${pluginDir(manifest.name)}/${lf.path}`, content: String(lf.code || '') });
  }
  return files;
}

// plugins/index.js is GENERATED, fully, from the set of installed plugins —
// deterministic, never reading the previous file. It is also the injection
// point for the capability boundary: every plugin run() is wrapped so it
// receives pluginApi(...) instead of env.
export function generateIndex(rows) {
  const head = [
    '// GENERATED by the Plugins module — do not edit by hand.',
    '// Aggregates every installed plugin into the tool pool and gateway registry.',
    '// Each plugin runs against a capability object (lib/plugin-runtime.js): a',
    '// namespace-scoped DB, a gateway function closed over its own binding, and',
    '// a namespaced logger. Plugin code never receives env.',
  ];
  const imports = [];
  const toolRefs = [];
  const gwRefs = [];
  const seenTool = new Set();
  const seenGw = new Set();
  let i = 0;
  const bindings = {};
  const tables = {};
  const knowledge = {};
  const hostReads = {};

  for (const row of rows) {
    let m;
    try { m = JSON.parse(row.manifest_json); } catch { continue; }
    if (!NAME_RE.test(m?.name || '')) continue;
    // A v1 manifest that carries code is not runnable under the capability
    // contract: its tools expect raw `env` and the wrapper below hands them
    // `api`. Import refuses such a manifest now; a row installed BEFORE v2 must
    // not be wired into the pool either, or a regenerated aggregator quietly
    // resurrects a tool that throws on its first call. Re-author it as v2, or
    // remove_plugin it. (cmd-only: cmd's repo IS the deployment source, so the
    // committed aggregator has to survive stale rows.)
    const codeful = arr(m.provides?.tools).length || arr(m.provides?.gateways).length;
    if (codeful && Number(m.nyyon_plugin) < CODE_FORMAT_VERSION) continue;
    let binding = {};
    try { binding = JSON.parse(row.binding_json || '{}'); } catch { /* none */ }
    // Bindings stored before modes were enforced carry only {via, target}.
    // Backfill from the manifest the operator approved, so tightening the
    // rule does not silently break an already-installed plugin.
    const declaredModes = Object.fromEntries(
      arr(m.requires?.gateways).map((g) => [g?.slug, arr(g?.modes)]),
    );
    bindings[m.name] = Object.fromEntries(
      Object.entries(binding).map(([slug, b]) => [
        slug,
        { ...b, modes: arr(b?.modes).length ? b.modes : (declaredModes[slug] || []) },
      ]),
    );
    // The EXACT tables this plugin declared. Access is decided by membership in
    // this set, never by a name prefix: `plugin_a_` is a prefix of
    // `plugin_a_b_`, so prefix matching let plugin "a" read plugin "a-b"'s data.
    // Re-filtered to the namespace here as belt-and-braces: this map IS the D1
    // grant, and it is built from a manifest, so it never trusts validation
    // alone to have caught a name pointing at a host table.
    const ns = tableNamespace(m.name);
    tables[m.name] = arr(m.requires?.tables)
      .map((t) => String(t?.name || '').toLowerCase())
      .filter((n) => n && n.startsWith(ns));
    hostReads[m.name] = arr(m.requires?.host_reads)
      .map((hr) => String((typeof hr === 'string' ? hr : hr?.table) || '').toLowerCase())
      .filter(Boolean);
    knowledge[m.name] = arr(m.requires?.knowledge)
      .map((k) => String((typeof k === 'string' ? k : k?.slug) || '').toLowerCase())
      .filter(Boolean);

    for (const t of arr(m.provides?.tools)) {
      if (!TOOL_RE.test(t?.name || '') || seenTool.has(t.name)) continue;
      seenTool.add(t.name);
      const v = `p${i++}`;
      imports.push(`import * as ${v} from './${m.name}/tool-${t.name}.mjs';`);
      toolRefs.push(
        `  ${JSON.stringify(t.name)}: { def: ${v}.def, run: (env, input, ctx) => `
        + `${v}.run(pluginApi(env, ${JSON.stringify(m.name)}, BINDINGS[${JSON.stringify(m.name)}], TABLES[${JSON.stringify(m.name)}], KNOWLEDGE[${JSON.stringify(m.name)}], HOST_READS[${JSON.stringify(m.name)}]), input, ctx) },`,
      );
    }
    for (const g of arr(m.provides?.gateways).filter((gg) => binding?.[gg.slug]?.via === 'bundled')) {
      const key = bundledGatewaySlug(m.name, g.slug);
      if (seenGw.has(key)) continue;
      seenGw.add(key);
      const v = `p${i++}`;
      imports.push(`import * as ${v} from './${m.name}/gateway-${g.slug}.mjs';`);
      gwRefs.push(
        `  ${JSON.stringify(key)}: { ...${v}.gateway, slug: ${JSON.stringify(key)}, `
        + `modes: wrapGatewayModes(${v}.gateway.modes, ${JSON.stringify(m.name)}, TABLES[${JSON.stringify(m.name)}]) },`,
      );
    }
  }

  const lines = [
    ...head,
    '',
    "import { pluginApi, wrapGatewayModes } from '../lib/plugin-runtime.js';",
    ...imports,
    '',
    `const BINDINGS = ${JSON.stringify(bindings, null, 2)};`,
    `const TABLES = ${JSON.stringify(tables, null, 2)};`,
    `const KNOWLEDGE = ${JSON.stringify(knowledge, null, 2)};`,
    `const HOST_READS = ${JSON.stringify(hostReads, null, 2)};`,
    '',
    'export const pluginTools = {',
    ...toolRefs,
    '};',
    '',
    'export const pluginGateways = {',
    ...gwRefs,
    '};',
    '',
  ];
  return lines.join('\n');
}

const INDEX_PATH = 'workers/api/src/plugins/index.js';

// The work list for the LOCAL materializer (scripts/materialize.mjs, run from
// the operator's own checkout): files to write, the regenerated aggregator,
// and removals to clean. Same files the GitHub path commits — one source of
// truth (filesFor / generateIndex), two ways to get them onto a deploy.
export async function pendingMaterializations(env) {
  const pending = (await env.DB.prepare("SELECT * FROM plugins WHERE status = 'bound'").all()).results || [];
  const installed = (await env.DB.prepare("SELECT * FROM plugins WHERE status IN ('bound','materialized','active')").all()).results || [];
  const removedRows = (await env.DB.prepare("SELECT name, report_json FROM plugins WHERE status = 'removed'").all()).results || [];
  // A removal already cleaned must drop off the list, or it repeats forever.
  const remove = removedRows
    .filter((r) => safeParse(r.report_json)?.step !== 'cleaned')
    .map((r) => r.name)
    .filter((n) => NAME_RE.test(n || ''));
  const shape = (r) => ({ name: r.name, version: r.version, files: filesFor(safeParse(r.manifest_json), safeParse(r.binding_json)) });
  return {
    pending: pending.map(shape),
    // Everything installed, so a checkout that lost a file gets healed.
    installed: installed.map(shape),
    verify: installed.filter((r) => r.status === 'materialized').map((r) => r.name),
    index_file: { path: INDEX_PATH, content: generateIndex(installed) },
    remove,
  };
}

// The CLOUD materializer: commit every bound plugin's files to the repo via
// lib/github-gateway.js and let CI redeploy. One commit message per plugin
// ("plugin: install <name> v<version>" — the contents API makes one commit per
// file PUT, all carrying that message), then the regenerated plugins/index.js,
// and only THEN the deletions for removed plugins.
//
// The order is not cosmetic:
//   installs  → files first, index second (the index must never import a file
//               that is not on main yet, or CI builds a broken worker).
//   removals  → index first, files second (deleting first leaves main
//               importing files that no longer exist — same broken build).
// The index commit is inside the try: it used to run after the statuses had
// already flipped, so a failure there left plugins marked "materialized" whose
// code nothing imports. On failure they roll back to "bound" and the next pass
// retries them.
export async function materializePending(env) {
  // Repo + token may live in gateway_config (Settings → Plugins publishing)
  // rather than env — resolve db-first so a Settings-entered token works.
  try { env = await (await import('./gateway-config.js')).withResolvedCredentials(env); } catch { /* env-only */ }
  if (!ghConfigured(env)) {
    return { ok: false, error: 'GitHub publishing is not configured. Either run `node scripts/materialize.mjs` from your checkout (writes the plugin files and deploys from your machine), or set a repo + token in Settings → Plugin publishing for hands-off deploys.' };
  }

  const failed = [];
  // A stored name is already NAME_RE-checked at import, but this is the code
  // that turns a name into a repo path — re-check it here rather than trust
  // whatever a row happens to hold.
  const named = (rows) => rows.filter((r) => {
    if (NAME_RE.test(r?.name || '')) return true;
    failed.push({ name: String(r?.name), error: 'refused: plugin name is not a kebab-case slug (it becomes a repo path)' });
    return false;
  });

  const bound = named((await env.DB.prepare("SELECT * FROM plugins WHERE status = 'bound'").all()).results || []);
  // Removed plugins whose files were not cleaned up yet (report step ≠ cleaned).
  const removed = named(((await env.DB.prepare("SELECT name, report_json FROM plugins WHERE status = 'removed'").all()).results || [])
    .filter((r) => safeParse(r.report_json)?.step !== 'cleaned'));

  if (!bound.length && !removed.length) {
    return { ok: !failed.length, committed: [], cleaned: [], failed, note: 'nothing bound and nothing to clean — no commits made' };
  }

  // ── phase 1: install files ──────────────────────────────────
  const committed = [];
  for (const row of bound) {
    const manifest = safeParse(row.manifest_json, null);
    if (!manifest) {
      await markMaterialized(env, row.name, { ok: false, error: 'stored manifest is unreadable' });
      failed.push({ name: row.name, error: 'stored manifest is unreadable' });
      continue;
    }
    const files = filesFor(manifest, safeParse(row.binding_json));
    const message = `plugin: install ${row.name} v${row.version}`;
    try {
      for (const f of files) await ghPutFile(env, { path: f.path, content: f.content, message });
      const marked = await markMaterialized(env, row.name, { ok: true });
      if (!marked.ok) { failed.push({ name: row.name, error: marked.error }); continue; }
      committed.push(row.name);
    } catch (e) {
      await markMaterialized(env, row.name, { ok: false, error: String(e?.message || e) });
      failed.push({ name: row.name, error: String(e?.message || e) });
    }
  }

  // ── phase 2: the aggregators ────────────────────────────────
  // Regenerated from what is ACTUALLY materialized (a plugin whose commits
  // failed is blocked and excluded, so the index never imports files that do
  // not exist and the CI deploy stays green). Removed plugins are excluded too,
  // which is what makes phase 3 safe.
  //
  let indexOk = true;
  const installed = (await env.DB.prepare("SELECT * FROM plugins WHERE status IN ('materialized','active')").all()).results || [];
  try {
    const message = committed.length
      ? `plugin: install ${committed.join(', ')} (regenerate index)`
      : `plugin: remove ${removed.map((r) => r.name).join(', ')} (regenerate index)`;
    await ghPutFile(env, { path: INDEX_PATH, content: generateIndex(installed), message });
  } catch (e) {
    indexOk = false;
    const err = String(e?.message || e);
    // The files landed but nothing imports them: put those rows back to
    // "bound" so the next Materialize retries instead of stranding them.
    for (const name of committed) await rollbackToBound(env, name, err);
    failed.push({
      name: INDEX_PATH,
      error: `${err}${committed.length ? ` — rolled ${committed.join(', ')} back to "bound" for the next pass` : ''}; no files were deleted`,
    });
    committed.length = 0;
  }

  // ── phase 3: removals, only once the index stopped importing them ──
  const cleaned = [];
  if (indexOk) {
    for (const r of removed) {
      try {
        {
          const { files } = await ghListDir(env, pluginDir(r.name));
          for (const f of files) await ghDeleteFile(env, { path: f.path, message: `plugin: remove ${r.name}` });
        }
        await markCleaned(env, r.name);
        cleaned.push(r.name);
      } catch (e) {
        failed.push({ name: r.name, error: String(e?.message || e) });
      }
    }
  }

  await logEvent(env, { kind: 'plugin_materialize_committed', actor: 'operator', payload: { committed, cleaned, failed } });
  return {
    ok: !failed.length,
    committed,
    cleaned,
    failed,
    note: committed.length ? 'CI deploys the commit in a few minutes — then run verify_plugin (or wait for the page to poll).' : undefined,
  };
}

// Status transitions are guarded in SQL: a blocked plugin must not be walked
// forward to materialized/active by a report that names the wrong plugin.
export async function markMaterialized(env, name, { ok, error = null } = {}) {
  const r = await env.DB.prepare(
    "UPDATE plugins SET status = ?, report_json = ?, updated_at = ? WHERE name = ? AND status = 'bound'",
  ).bind(ok ? 'materialized' : 'blocked', JSON.stringify({ step: 'materialize', error }), now(), name).run();
  const changed = r?.meta?.changes ?? r?.changes ?? 0;
  if (!changed) return { ok: false, error: `plugin "${name}" is not awaiting materialization` };
  await logEvent(env, { kind: ok ? 'plugin_materialized' : 'plugin_blocked', actor: 'applier', payload: { name, error } });
  return { ok: true };
}

// Put a just-materialized plugin back in the queue. Guarded the same way, so it
// can only ever undo the flip this pass made.
async function rollbackToBound(env, name, error) {
  await env.DB.prepare(
    "UPDATE plugins SET status = 'bound', report_json = ?, updated_at = ? WHERE name = ? AND status = 'materialized'",
  ).bind(JSON.stringify({ step: 'awaiting-materialize', error: `index commit failed, retrying: ${error}` }), now(), name)
    .run().catch(() => {});
  await logEvent(env, { kind: 'plugin_materialize_rolled_back', actor: 'operator', payload: { name, error } }).catch(() => {});
}

// Called after a removed plugin's files are deleted, so the removal drops off
// the work list instead of repeating on every pass.
export async function markCleaned(env, name) {
  const r = await env.DB.prepare(
    "UPDATE plugins SET report_json = ?, updated_at = ? WHERE name = ? AND status = 'removed'",
  ).bind(JSON.stringify({ step: 'cleaned' }), now(), name).run();
  const changed = r?.meta?.changes ?? r?.changes ?? 0;
  if (changed) await logEvent(env, { kind: 'plugin_cleaned', actor: 'applier', payload: { name } });
  return { ok: !!changed };
}

// Post-deploy verification: the plugin's tools must be in the live pool.
export async function verifyPlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) return { ok: false, error: 'unknown plugin' };
  // Only a materialized plugin verifies active (re-verifying an active one is
  // an idempotent no-op). Without this guard, a blocked-for-collision plugin
  // would pass by definition — its tool names ARE host tools.
  if (!['materialized', 'active'].includes(row.status)) {
    return { ok: false, error: `plugin is ${row.status} — only a materialized plugin flips active` };
  }
  const m = safeParse(row.manifest_json, null);
  if (!m) return { ok: false, error: 'stored manifest is unreadable' };
  // A row installed under v1 WITH code predates the capability contract. Its
  // tools expect raw `env`, so generateIndex refuses to wire them into the
  // pool and they can never verify. Say that plainly instead of reporting the
  // symptom ("tools not live yet") forever.
  const codeful = arr(m.provides?.tools).length || arr(m.provides?.gateways).length;
  if (codeful && Number(m.nyyon_plugin) < CODE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `"${name}" is a v${m.nyyon_plugin || '1'} plugin carrying code. v1 tools expected raw env and are not runnable under the capability contract, so they are deliberately not in the pool. Re-author it as v2 and re-import, or remove_plugin it (then Materialize to delete its files).`,
    };
  }
  const { visibleToolDefs } = await import('../tools/index.js');
  const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
  const missing = arr(m.provides?.tools).map((t) => t?.name).filter((n) => !names.has(n));
  if (missing.length) return { ok: false, error: `tools not live yet: ${missing.join(', ')}` };
  await env.DB.prepare("UPDATE plugins SET status = 'active', updated_at = ? WHERE name = ? AND status IN ('materialized','active')").bind(now(), name).run();
  await logEvent(env, { kind: 'plugin_active', actor: 'system', payload: { name } });
  return { ok: true };
}

// A row installed under v1 WITH code cannot run under the capability contract,
// so generateIndex leaves it out of the pool. Derived at READ time, never
// written: the status column stays the operator's, but the list stops claiming
// a plugin is live when its tools are not.
const needsReauthoring = (m) => {
  const codeful = arr(m?.provides?.tools).length || arr(m?.provides?.gateways).length;
  return !!codeful && Number(m?.nyyon_plugin) < CODE_FORMAT_VERSION;
};

export async function listPlugins(env) {
  const rows = (await env.DB.prepare('SELECT name, version, title, status, manifest_json, binding_json, report_json, installed_at, updated_at FROM plugins ORDER BY installed_at DESC').all()).results || [];
  return rows.map((r) => {
    const m = safeParse(r.manifest_json);
    return {
      ...r,
      format: m.nyyon_plugin || null,
      needs_reauthoring: needsReauthoring(m),
      binding: safeParse(r.binding_json),
      report: safeParse(r.report_json),
      manifest_json: undefined,
      binding_json: undefined,
      report_json: undefined,
    };
  });
}

// The plugin registry: every installed plugin's full component map — the
// paths its code lives at, the gateways it binds or bundles, its workflows,
// tools, knowledge docs, tables and surfaces. This IS the Registry, scoped to
// plugins and owned by the Plugins module.
export async function pluginRegistry(env) {
  const rows = (await env.DB.prepare(
    'SELECT name, version, title, status, manifest_json, binding_json, installed_at, updated_at FROM plugins ORDER BY installed_at DESC',
  ).all()).results || [];
  return rows.map((r) => {
    try {
      const m = safeParse(r.manifest_json);
      const binding = safeParse(r.binding_json);
      const p = m.provides || {};
      const dir = pluginDir(r.name);
      return {
        name: r.name, title: r.title, version: r.version, status: r.status,
        format: m.nyyon_plugin || null,
        needs_reauthoring: needsReauthoring(m),
        origin: m.origin || null,
        installed_at: r.installed_at, updated_at: r.updated_at,
        path: dir,
        tools: arr(p.tools).map((t) => ({
          name: t?.name, path: `${dir}/tool-${t?.name}.mjs`, description: t?.def?.description || '',
        })),
        gateways: arr(p.gateways).map((g) => ({
          slug: g?.slug,
          installed_as: bundledGatewaySlug(r.name, g?.slug),
          in_use: binding?.[g?.slug]?.via === 'bundled',
          path: `${dir}/gateway-${g?.slug}.mjs`, service: g?.service || '',
        })),
        // `modes` is what the runtime actually enforces alongside the slug, so
        // the registry shows the operator the full grant, not half of it.
        gateway_bindings: Object.entries(binding).map(([slug, b]) => ({ slug, via: b?.via, target: b?.target, modes: arr(b?.modes) })),
        requires_gateways: arr(m.requires?.gateways).map((g) => ({ slug: g?.slug, modes: arr(g?.modes) })),
        workflows: arr(p.workflows).map((w) => ({
          slug: w?.slug, name: w?.name || w?.slug,
          steps: arr(w?.steps).map((st) => (typeof st === 'string' ? st : st?.tool)).filter(Boolean),
        })),
        knowledge: arr(p.knowledge).map((k) => ({ slug: k?.slug, title: k?.title || k?.slug })),
        tables: arr(m.requires?.tables).map((t) => t?.name),
        surfaces: arr(p.surfaces).map((sf) => ({ slug: sf?.slug, title: sf?.title, tabs: arr(sf?.tabs).length })),
      };
    } catch (e) {
      // One unreadable row must not 500 the whole registry.
      return { name: r.name, status: r.status, error: String(e?.message || e) };
    }
  });
}

// Every active plugin's surfaces, for the sidebar and the renderer. Only
// `active` plugins appear: a surface whose tools are not yet live would render
// a page whose every button fails.
export async function pluginSurfaces(env) {
  const rows = (await env.DB.prepare(
    "SELECT name, title, manifest_json FROM plugins WHERE status = 'active' ORDER BY name",
  ).all()).results || [];
  const out = [];
  for (const r of rows) {
    let m = {};
    try { m = JSON.parse(r.manifest_json) || {}; } catch { continue; }
    for (const sf of arr(m.provides?.surfaces)) {
      if (!sf?.slug) continue;
      out.push({
        plugin: r.name,
        plugin_title: r.title,
        slug: `${r.name}:${sf.slug}`,
        title: sf.title || sf.slug,
        kind: 'tabs',
        icon: sf.icon || null,
        tabs: arr(sf.tabs).map((t) => ({ key: t.key, title: t.title, view: t.view || {} })),
      });
    }
  }
  return out;
}

// Run ONE tool belonging to ONE plugin, for that plugin's own surface. Scoped
// deliberately: the surface renderer must not become a way to call the host
// pool from the browser, so a tool that this plugin does not provide is
// refused even though the caller is the signed-in operator.
export async function invokePluginTool(env, pluginName, toolName, input) {
  const row = await env.DB.prepare('SELECT status, manifest_json FROM plugins WHERE name = ?').bind(pluginName).first();
  if (!row) return { ok: false, error: 'unknown plugin' };
  if (row.status !== 'active') return { ok: false, error: `plugin is ${row.status}, not active` };
  const m = safeParse(row.manifest_json, null);
  if (!m) return { ok: false, error: 'stored manifest unreadable' };
  const owns = arr(m.provides?.tools).some((t) => t?.name === toolName);
  if (!owns) return { ok: false, error: `"${toolName}" is not a tool this plugin provides` };
  const { runTool } = await import('../tools/index.js');
  try {
    const result = await runTool(env, toolName, input || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function exportPlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) throw new Error(`unknown plugin: ${name}`);
  const manifest = JSON.parse(row.manifest_json);
  manifest.sha256 = await sha256Hex(manifestPayload(manifest));
  manifest.origin = { ...(manifest.origin || {}), re_exported_at: now() };
  await logEvent(env, { kind: 'plugin_exported', actor: 'operator', payload: { name } });
  return manifest;
}

export async function removePlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) throw new Error(`unknown plugin: ${name}`);
  const m = safeParse(row.manifest_json);
  // Scoped to rows THIS plugin created: a slug it merely names must not let it
  // disable a host workflow on the way out. Which ones actually went down is
  // named in the event, not left implicit.
  const disabled = [];
  for (const w of arr(m.provides?.workflows)) {
    const r = await env.DB.prepare("UPDATE workflows SET status = 'disabled', updated_at = ? WHERE slug = ? AND created_by = ?")
      .bind(now(), w?.slug, `plugin:${name}`).run().catch(() => null);
    if ((r?.meta?.changes ?? r?.changes ?? 0) > 0) disabled.push(w?.slug);
  }
  // report_json is reset so the materializer sees an uncleaned removal.
  await env.DB.prepare("UPDATE plugins SET status = 'removed', report_json = '{}', updated_at = ? WHERE name = ?").bind(now(), name).run();
  await logEvent(env, { kind: 'plugin_removed', actor: 'operator', payload: { name, disabled_workflows: disabled } });
  return { ok: true, disabled_workflows: disabled, note: 'code files are cleaned on the next Materialize pass; tables are kept (data is the operator\'s)' };
}
