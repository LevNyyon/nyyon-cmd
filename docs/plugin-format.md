# Nyyon Plugin Format — v2 (canonical)

One plugin = one JSON document. Both the exporter and the importer validate
against this file and refuse anything outside it.

## Read this first: the trust model

**Installing a plugin means running someone else's code inside your install.**
There is no way around that: plugins exist to add capabilities, and a Worker
has no sandbox to put them in. So be plain about what is and is not enforced.

**What IS enforced, at runtime, by lib/plugin-runtime.js:**

A plugin tool never receives `env`. It receives a capability object:

| It gets | It can do | It cannot do |
|---|---|---|
| `api.db` | `prepare()` against the exact tables it declared in `requires.tables` | touch any other table — every statement is **tokenized at query time** (string- and comment-aware), so SQL assembled at runtime, hidden in a string literal, or reached by a comma join is caught too |
| `api.gateway(slug, mode, input)` | call **only** the gateways it declared, and **only in the modes** it declared | reach an undeclared gateway or mode, or a reserved gateway (`github`, `deploy`) |
| `api.log(kind, payload)` | write to the activity bus under its own name | impersonate another actor |

Because the capability object carries no credentials, a plugin that imports a
host library anyway gets a library with nothing to read.

**What is NOT enforced.** A plugin runs in-process: it can burn CPU, allocate
memory, and throw. Its declared gateways are real access — a plugin that
declares `whatsapp` can send WhatsApp messages, because you approved that. The
manifest `sha256` is a **checksum**, not a signature: it proves the document was
not mangled in transit, and proves nothing about who wrote it.

**The import-time checks in `lib/plugins.js` are a lint, not the boundary.**
They catch mistakes and old-contract code early with a clear message. Do not
rely on them to stop a determined author; rely on the runtime, and on
installing plugins from people you trust.

## The manifest

```json
{
  "nyyon_plugin": 2,
  "name": "web-headline",
  "title": "Web Headline",
  "version": "2.0.0",
  "description": "One paragraph: what the plugin does for the operator.",
  "origin": { "system": "cmd.nyyon.com", "exported_at": 1787900000000 },
  "requires": {
    "gateways": [
      { "slug": "web", "modes": ["text"], "purpose": "fetch the page to headline" }
    ],
    "tables": [
      { "name": "plugin_web_headline_log", "ddl": "CREATE TABLE IF NOT EXISTS plugin_web_headline_log (id TEXT PRIMARY KEY, url TEXT, title TEXT, at INTEGER)" }
    ]
  },
  "provides": {
    "tools": [
      { "name": "read_page_headline", "def": { "name": "read_page_headline", "description": "…", "input_schema": {} }, "code": "<ESM module source>" }
    ],
    "workflows": [
      { "slug": "headline-sweep", "name": "Headline sweep", "goal": "…", "steps": ["read_page_headline"] }
    ],
    "knowledge": [
      { "slug": "plugin-web-headline", "title": "…", "body": "…" }
    ],
    "gateways": [
      { "slug": "example", "service": "…", "modes": ["fetch"], "code": "<ESM module source>" }
    ]
  },
  "sha256": "<hex sha-256 of the canonical requires+provides JSON — a checksum, not a signature>"
}
```

## Tool code contract

A v2 tool **imports nothing**. Everything it may use arrives in `api`:

```js
export const def = { name: 'read_page_headline', description: '…', input_schema: { /* … */ } };

export async function run(api, input) {
  const r = await api.gateway('web', 'text', { url: input.url });   // declared gateways only
  await api.db.prepare('INSERT INTO plugin_web_headline_log (id, url) VALUES (?, ?)')
    .bind(id, input.url).run();                                     // own tables only
  await api.log('read', { url: input.url });
  return { title: /* … */ };
}
```

Rules (import is refused otherwise):

1. **No imports, of any kind** — no `import`, no `export … from`, no dynamic
   `import()`, no `require`. The rule is "none" precisely because an allowlist
   of shapes was trivially evaded (`import{x}from'…'` with no space slipped
   past a `startsWith('import ')` check).
2. `export const def` and `export async function run` must both exist, and
   `def.name` must equal the manifest tool name.
3. Every `api.gateway('slug', …)` literal must appear in `requires.gateways`.
   Non-literal slugs are allowed but resolved — and refused — at runtime, where
   the declared **mode** list is enforced as well.
4. `env.DB` and `callGateway(…)` are v1 constructs and are refused with a
   migration pointer.

### v1 manifests

`nyyon_plugin: 1` is accepted **only** for data-only packs (workflows and
knowledge, no code). A v1 tool expected raw `env` and cannot be run under the
capability contract; re-author it as v2. A v1 code plugin installed before v2
is skipped by the aggregator too, so it never reaches the pool.

## Bundled gateway contract

A plugin MAY bundle a gateway for a service the host lacks:

```js
export const gateway = {
  slug: 'example', service: '…', description: '…',
  modes: { fetch: async (env, input) => { /* raw fetch is legitimate HERE — this is the boundary */ } },
};
```

It imports nothing, does no reasoning, and receives a **projected env**: the
plugin's own scoped DB and nothing else — never the host's resolved
credentials. It installs namespaced `plugin__<name>__<slug>` (double
underscores: `plugin-a-b-c` was ambiguous between plugin `a-b`/slug `c` and
plugin `a`/slug `b-c`, so one plugin could shadow another's gateway). A bundle
is only installed when the binding actually chose it.

## Surfaces — a module IS its page

A plugin ships its page as a **description**, never as code:

```json
"surfaces": [{
  "slug": "main", "title": "Headlines",
  "tabs": [
    { "key": "read", "title": "Read a page",
      "view": { "kind": "form", "tool": "read_page_headline",
                "fields": [{ "key": "url", "label": "Page URL" }],
                "submit_label": "Read headline" } },
    { "key": "log", "title": "History",
      "view": { "kind": "list", "tool": "list_page_headlines", "rows_path": "rows",
                "columns": [{ "key": "at", "label": "when" }, { "key": "title", "label": "headline" }] } }
  ]
}]
```

View kinds: `list`, `form`, `markdown`. The host renders them in its own look
and adds the page to the sidebar under Plugins.

**Why surfaces are declarative.** This format exists so operators can exchange
modules. Installing someone else's module must not inject their React into your
app with your session, and their code failing to compile must not break YOUR
build. Describing the surface keeps it DATA, so it activates the moment the
plugin imports — no rebuild. A surface may only drive its own plugin's tools;
it is not a remote control for the host pool. (An earlier `page_code` form
shipped real TSX pages through CI; it was removed — tabs are the contract.)

## Size limits

- The manifest is ONE JSON document stored as one database row: keep the
  whole thing under ~1 MB (hard ceiling ~2 MB; the import doors refuse over
  5 MB).
- Every tool / lib file materializes as its own repo commit: keep any single
  code string under ~500 KB.
- Real plugins run tens of KB. Wanting more code than these limits usually
  means the capability should be split into smaller tools, or should lean on
  host gateways instead of vendoring logic.

## Contract v2.1 additions (module-scale packs)

- **`requires.host_reads`**: `[{table, purpose}]` — SELECT-only access to named
  host tables (wa_messages, contacts, ...), enforced by the runtime tokenizer:
  any statement containing a write verb is held to the plugin's own tables.
  Never grantable: gateway_config, plugins, sync_state, knowledge_docs,
  workflows, gate_*. Copy host rows with two statements (SELECT in JS, then
  INSERT) — single-statement INSERT...SELECT from a host table is refused.
- **`api.saveKnowledge(slug, {title, body})`**: a plugin may WRITE its own
  `plugin-<name>-*` docs (that is where its editable rules live). Host docs
  stay unreachable in both directions.
- **`lib`**: `[{path: "name.mjs", code|code_file}]` — flat shared sibling
  files, same lint as tool code, importable from tools/lib as `./name.mjs`
  ONLY when declared. Materialized into the plugin dir beside the tools.
- **Internal host gateways**: host stores plugins may not touch get gateway
  boundaries like any external service — `crm` (promote / write_contact /
  pipeline / update_deal) first; `render`, `outbox`, `calendar` with the
  editorial pack.

## Tables

`requires.tables[].ddl` must match, for the whole statement:

- `CREATE TABLE IF NOT EXISTS plugin_<name>_… ( … )`
- `CREATE INDEX IF NOT EXISTS idx_plugin_<name>_… ON plugin_<name>_… ( … )`

The `plugin_<name>_` prefix is a **naming** rule. Runtime access is decided by
exact membership in the declared table set, never by prefix — `plugin_a_` is a
prefix of `plugin_a_b_`, so prefix matching would let plugin `a` read plugin
`a-b`'s data.

`CREATE … AS SELECT` is refused outright: prefix-anchoring alone let
`CREATE TABLE IF NOT EXISTS plugin_x_c AS SELECT * FROM gateway_config` copy the
host credential table into the plugin's namespace. Temp tables and
schema-qualified names are refused too. DDL runs with host authority at import
time, so this is a real gate, not a lint.

## Import pipeline

1. **Validate** — shape, checksum, code contract, DDL, namespaces, no reserved
   gateways, no host-owned workflow slugs, knowledge inside `plugin-<name>…`,
   workflow steps that will exist, no collision with a host tool. Any failure
   stores the plugin `blocked` with the reason and activates nothing. A failed
   re-import never overwrites an already-installed plugin's record.
2. **Bind gateways** — host has the slug with every required mode → bind to the
   host; else the plugin bundles it with every required mode → install
   namespaced; else `blocked`. The binding is stored and is what the runtime
   enforces. **No source rewriting happens at any point.**
3. **Activate data** — tables, workflows, knowledge apply immediately. An
   operator's deliberately disabled workflow stays disabled across re-imports;
   workflow slugs a new version drops are retired.
4. **Materialize code** — a Worker cannot load code at runtime:
   - Self-hosted: the applier writes `workers/api/src/plugins/<name>/…`,
     regenerates `plugins/index.js` (which wraps every `run` in the capability
     object), restarts, and re-verifies. It heals missing files from the DB.
   - Cloud: the worker commits the same files and CI redeploys.
5. **Verify** — the plugin's tools must be live in the pool before `active`.

Statuses: `imported → bound → materialized → active`, or `blocked`, or
`removed`. Transitions are guarded in SQL; every one logs to the activity bus.

## Who may import

Importing **code** is an operator action, taken in the Plugins page after
reading the source. The model-callable `import_plugin` tool accepts data-only
plugins and refuses anything carrying tools or gateways.

The one exception is the EXPAND desk (the host's plugin-development chat): its
`install_plugin` tool accepts code, because there the manifest is not foreign —
it is authored IN the conversation, and the operator reads the final draft and
explicitly confirms before install. The gate is mechanical, not just a persona
rule: the chat loop hands `install_plugin` (and the rest of the expand set)
ONLY to the `expand` agent, so no other chat surface can reach it, and every
install logs to the activity bus as actor `expand`.

## What is deliberately NOT in v2

- No remote registries, no auto-updates, no dependency graphs between plugins.
- No signature verification (see the trust model above).
- No UI surfaces in plugins.
- No CPU/memory limits — the boundary confines data reach, not resources.
