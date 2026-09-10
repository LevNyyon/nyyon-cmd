// The plugin capability boundary — where plugin permissions are ACTUALLY enforced.
//
// WHY THIS FILE EXISTS
// v1 tried to confine plugins by regex-scanning their source before install:
// "no raw fetch", "only plugin_<name>_* tables", "only these imports". An
// adversarial review took that apart in minutes. Every one of these passed the
// source scan and then did whatever it liked at runtime:
//
//   env.DB.prepare('SELECT * FROM ' + 'gateway_config')      // built at runtime
//   env.DB.prepare(input.q)                                  // SQL not in the source at all
//   callGateway(env, 'whatsapp', 'send', …)                  // a gateway never declared
//
// A regex cannot constrain a handle whose queries are assembled at runtime.
// So the boundary moved to where the real values exist: the call itself.
//
// A plugin tool never receives `env`. It receives the object built here:
//
//   api.db        — prepare() only, and every statement is TOKENIZED at query
//                   time; it may name only tables the manifest declared
//   api.gateway   — closed over THIS plugin's binding: only declared slugs, and
//                   only the modes declared for each
//   api.log       — the activity bus, stamped with the plugin as actor
//
// WHY A TOKENIZER AND NOT REGEXES
// The first version of this file scanned SQL with regexes after stripping
// comments. That was itself bypassable, because the strip was not string-aware:
//
//   SELECT k FROM plugin_x_t WHERE k = '--' UNION SELECT api_key FROM gateway_config
//
// The `--` lives inside a string literal, but the stripper treated it as a
// comment and deleted the rest — so the checks validated a truncated statement
// while D1 executed the whole one. The same trick hid `;` and CREATE TRIGGER
// bodies (a path to host WRITES). Nothing built on text-mangling is safe;
// the scanner below walks the statement once, tracking string and comment
// state properly, and every check runs on that token stream.
//
// Honest about the limits: this confines DATA REACH, not CPU or memory, and a
// plugin still runs in-process. Installing a plugin is trusting its author.

import { logEvent, writeKnowledge } from './db.js';

// Gateways a plugin may never bind, whatever it declares. `github` is the cloud
// materializer's repo-write path (a straight line from "install a plugin" to
// "arbitrary code on main"); `deploy` ships the public site.
export const RESERVED_GATEWAYS = new Set(['github', 'deploy']);

// The prefix a plugin's tables must carry. NOTE: the prefix is a NAMING rule
// enforced on DDL; it is NOT how access is decided — `plugin_a_` is a prefix of
// `plugin_a_b_`, so prefix matching would let plugin "a" read plugin "a-b"'s
// tables. Access is decided by exact membership in the declared table set.
export const tableNamespace = (pluginName) => `plugin_${String(pluginName).replace(/-/g, '_')}_`;

// Statements a plugin may run at all. Anything else — CREATE/DROP/ALTER,
// triggers, views, ATTACH, PRAGMA — is refused outright.
const ALLOWED_LEADING = new Set(['SELECT', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'WITH']);
// Keywords that may never appear as a bare token anywhere in the statement.
const BANNED_WORDS = new Set([
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'TRIGGER', 'VIEW',
  'CREATE', 'DROP', 'ALTER', 'REINDEX', 'ANALYZE',
]);
// After these, the next identifier position names a table.
const TABLE_LEAD = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);
// Words that end a FROM list at ITS OWN paren depth (so a following comma is
// not another table). ON/USING are deliberately NOT here: they are part of a
// join clause, and treating them as terminators let
// `FROM a JOIN b ON 1, gateway_config` smuggle a comma-joined host table.
const CLAUSE_END = new Set([
  'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'RETURNING',
  'UNION', 'INTERSECT', 'EXCEPT', 'VALUES',
]);

// A single pass over the statement that understands '…' (with '' escapes),
// "…", `…`, […] and both comment forms. Everything downstream reads this.
function tokenize(sql) {
  const s = String(sql);
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      if (i >= s.length) throw new Error('plugin sql: unterminated block comment');
      i += 2; continue;
    }
    if (c === "'") { // string literal; '' is an escaped quote
      i++;
      for (;;) {
        if (i >= s.length) throw new Error('plugin sql: unterminated string literal');
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      toks.push({ t: 'str' });
      continue;
    }
    if (c === '"' || c === '`') { // quoted identifier
      const q = c; i++; let v = '';
      for (;;) {
        if (i >= s.length) throw new Error('plugin sql: unterminated quoted identifier');
        if (s[i] === q) { if (s[i + 1] === q) { v += q; i += 2; continue; } i++; break; }
        v += s[i++];
      }
      toks.push({ t: 'id', v });
      continue;
    }
    if (c === '[') { // bracketed identifier
      i++; let v = '';
      while (i < s.length && s[i] !== ']') v += s[i++];
      if (i >= s.length) throw new Error('plugin sql: unterminated bracketed identifier');
      i++;
      toks.push({ t: 'id', v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let v = '';
      while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) v += s[i++];
      toks.push({ t: 'word', v });
      continue;
    }
    if (/[0-9]/.test(c)) { while (i < s.length && /[0-9.]/.test(s[i])) i++; toks.push({ t: 'num' }); continue; }
    toks.push({ t: 'p', v: c });
    i++;
  }
  return toks;
}

// Every table the statement names, read off the token stream. Handles the
// comma cross-join (`FROM a, b`) and quoted names with no separating space
// (`FROM"gateway_config"`), both of which a keyword-adjacency regex missed.
function tablesFromTokens(toks) {
  const names = [];
  // Common table expressions are names the statement defines for itself, not
  // host tables: `WITH c AS (SELECT … FROM plugin_x_t) SELECT * FROM c` must
  // work. Collect the aliases first so the table check can skip them.
  const ctes = new Set();
  {
    let depth = 0;
    let expectingCte = false;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t === 'p' && tk.v === '(') { depth++; continue; }
      if (tk.t === 'p' && tk.v === ')') { depth--; continue; }
      if (depth !== 0) continue;
      const w = tk.t === 'word' ? tk.v.toUpperCase() : null;
      if (w === 'WITH') { expectingCte = true; continue; }
      if (!expectingCte) continue;
      // `<name> AS (` — and after the closing paren a comma introduces another.
      if ((tk.t === 'word' || tk.t === 'id')
          && toks[i + 1]?.t === 'word' && toks[i + 1].v.toUpperCase() === 'AS') {
        ctes.add(String(tk.v).toLowerCase());
        continue;
      }
      // The CTE list ends at the statement's real leading verb.
      if (w && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(w)) expectingCte = false;
    }
  }

  let depth = 0;
  let fromDepth = -1;   // paren depth the current FROM list lives at
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'p' && tk.v === '(') { depth++; continue; }
    if (tk.t === 'p' && tk.v === ')') { depth--; if (depth < fromDepth) fromDepth = -1; continue; }

    const word = tk.t === 'word' ? tk.v.toUpperCase() : null;
    if (word && CLAUSE_END.has(word) && depth === fromDepth) fromDepth = -1;

    if (word && TABLE_LEAD.has(word)) {
      // `ON CONFLICT (…) DO UPDATE SET x = 1` is an upsert clause, not a table
      // reference — without this, `SET` parsed as a table and no plugin could
      // upsert into its own table.
      const prev = [...toks.slice(0, i)].reverse().find((t) => t.t === 'word');
      if (word === 'UPDATE' && prev && prev.v.toUpperCase() === 'DO') continue;
      const next = toks[i + 1];
      if (next && (next.t === 'id' || next.t === 'word')) {
        const name = String(next.v).toLowerCase();
        if (!ctes.has(name)) names.push(name);
        const after = toks[i + 2];
        if (after && after.t === 'p' && after.v === '.') throw new Error('plugin sql: schema-qualified table names are not allowed');
        i++;
        if (word === 'FROM' || word === 'JOIN') fromDepth = depth;
      }
      continue;
    }
    // `FROM a, b` — a comma at the FROM list's own depth starts another table.
    if (fromDepth === depth && tk.t === 'p' && tk.v === ',') {
      const next = toks[i + 1];
      if (next && (next.t === 'id' || next.t === 'word')) {
        const name = String(next.v).toLowerCase();
        if (!ctes.has(name)) names.push(name);
        i++;
      }
    }
  }
  return [...new Set(names)];
}

// Throws unless the statement is one the plugin may run, against tables it
// declared. `allowed` is the EXACT set of table names from requires.tables —
// exact membership, never a prefix test.
export function assertScopedSql(sql, pluginName, allowed, hostReads) {
  const allow = allowed instanceof Set ? allowed : new Set(allowed || []);
  const reads = hostReads instanceof Set ? hostReads : new Set(hostReads || []);
  const toks = tokenize(sql);
  if (!toks.length) throw new Error('plugin sql: empty statement');

  // Multi-statement: a `;` token (a literal semicolon inside a string is a
  // 'str' token and never reaches here). A single trailing one is fine.
  const semis = toks.filter((t) => t.t === 'p' && t.v === ';');
  const trailing = toks[toks.length - 1].t === 'p' && toks[toks.length - 1].v === ';';
  if (semis.length > (trailing ? 1 : 0)) throw new Error('plugin sql: multiple statements are not allowed');

  const lead = toks.find((t) => t.t === 'word');
  if (!lead || !ALLOWED_LEADING.has(lead.v.toUpperCase())) {
    throw new Error(`plugin sql: only ${[...ALLOWED_LEADING].join('/')} statements are allowed`);
  }
  for (const t of toks) {
    if (t.t === 'word' && BANNED_WORDS.has(t.v.toUpperCase())) {
      throw new Error(`plugin sql: ${t.v.toUpperCase()} is not allowed`);
    }
    if (t.t === 'id' && /^sqlite_/i.test(t.v)) throw new Error('plugin sql: sqlite internals are not allowed');
    if (t.t === 'word' && /^sqlite_/i.test(t.v)) throw new Error('plugin sql: sqlite internals are not allowed');
  }

  // Declared host READS widen the allowed set only for statements that cannot
  // mutate: anything containing a write verb at any position is held to the
  // plugin's own tables. (UPDATE after DO is the upsert clause, not a verb.)
  let canWrite = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'word') continue;
    const w = t.v.toUpperCase();
    if (['INSERT', 'REPLACE', 'DELETE', 'CREATE', 'DROP', 'ALTER'].includes(w)) { canWrite = true; break; }
    if (w === 'UPDATE') {
      const prev = toks.slice(0, i).reverse().find((x) => x.t === 'word');
      if (!prev || prev.v.toUpperCase() !== 'DO') { canWrite = true; break; }
    }
  }

  const tables = tablesFromTokens(toks);
  if (!tables.length) throw new Error('plugin sql: no table named — a plugin may only touch the tables it declared');
  for (const t of tables) {
    if (allow.has(t)) continue;
    if (!canWrite && reads.has(t)) continue;
    if (reads.has(t)) throw new Error(`plugin sql: table "${t}" is a declared host READ — it may appear only in pure SELECT statements`);
    throw new Error(`plugin sql: table "${t}" is not one this plugin declared (${allow.size ? [...allow].join(', ') : 'none'})`);
  }
  return true;
}

// A D1 handle that can only see the plugin's own declared tables.
// prepare() ALONE: batch/exec/dump would each need their own parsing, and a
// plugin has no need for them.
function scopedDb(env, pluginName, tables, hostReads) {
  return {
    prepare(sql) {
      assertScopedSql(sql, pluginName, tables, hostReads);
      return env.DB.prepare(sql);
    },
  };
}

// The plugin's view of the gateway layer: only the slugs its manifest declared,
// and for each, only the modes it declared. The binding is materialized beside
// the tool, so this holds even though plugin source is never rewritten.
function scopedGateway(env, pluginName, binding) {
  return async (slug, mode, input) => {
    const b = binding && binding[slug];
    if (!b) {
      const declared = Object.keys(binding || {});
      throw new Error(
        `plugin gateway: "${slug}" was not declared by this plugin `
        + `(declared: ${declared.length ? declared.join(', ') : 'none'})`,
      );
    }
    if (RESERVED_GATEWAYS.has(slug) || RESERVED_GATEWAYS.has(b.target)) {
      throw new Error(`plugin gateway: "${slug}" is reserved and can never be used by a plugin`);
    }
    // The operator approved a slug AND a mode list. Enforce both — otherwise a
    // plugin that declared whatsapp:[chats] could call whatsapp:send.
    const modes = Array.isArray(b.modes) ? b.modes : [];
    if (!modes.includes(mode)) {
      throw new Error(`plugin gateway: "${slug}" was declared for mode(s) [${modes.join(', ') || 'none'}], not "${mode}"`);
    }
    const { callGateway } = await import('../gateways/index.js');
    return callGateway(env, b.target, mode, input);
  };
}

// Build one plugin's capability object. Called by the GENERATED
// plugins/index.js wrapper — plugin code never constructs its own.
export function pluginApi(env, pluginName, binding, tables, knowledgeSlugs, hostReadTables) {
  const allowed = new Set((tables || []).map((t) => String(t).toLowerCase()));
  const hostReads = new Set((hostReadTables || []).map((t) => String(t).toLowerCase()));
  // Host knowledge a plugin may READ. Its OWN docs (plugin-<name>-*) are
  // always readable; anything else must be declared in requires.knowledge so
  // the operator sees the read at import. Never a write path — plugin writes
  // to host docs would let one plugin rewrite the rules every other module
  // runs on. Secrets live in gateway_config, not knowledge, which is what
  // makes a declared read grant safe to offer at all.
  const readable = new Set((knowledgeSlugs || []).map((k) => String(k).toLowerCase()));
  const ownDoc = new RegExp(`^plugin-${pluginName}(-|$)`);
  return {
    db: scopedDb(env, pluginName, allowed, hostReads),
    gateway: scopedGateway(env, pluginName, binding || {}),
    knowledge: async (slug) => {
      const sl = String(slug || '').toLowerCase();
      if (!ownDoc.test(sl) && !readable.has(sl)) {
        throw new Error(`plugin ${pluginName}: knowledge doc "${sl}" is not in its declared read set`);
      }
      const row = await env.DB.prepare('SELECT slug, title, body FROM knowledge_docs WHERE slug = ?').bind(sl).first();
      return row || null;
    },
    // A plugin may WRITE only its own plugin-<name>-* docs — that is where its
    // editable rules live (guardrail #5) and where tools like save_drafting_rules
    // persist operator edits. Host docs stay out of reach in both directions.
    saveKnowledge: async (slug, { title, body } = {}) => {
      const sl = String(slug || '').toLowerCase();
      if (!ownDoc.test(sl)) throw new Error(`plugin ${pluginName}: may only write its own plugin-${pluginName}-* docs`);
      await writeKnowledge(env, {
        slug: sl, title: String(title || sl), body: String(body || ''),
        scope: 'global', module: null, parent_slug: 'nyyon-root',
      });
      return { ok: true, slug: sl };
    },
    log: (kind, payload) => logEvent(env, {
      kind: `plugin_${String(pluginName).replace(/-/g, '_')}_${kind}`,
      actor: `plugin:${pluginName}`,
      payload: payload || {},
    }),
    plugin: {
      name: pluginName,
      tables: [...allowed],
      gateways: Object.keys(binding || {}),
      knowledge: [...readable],
      host_reads: [...hostReads],
    },
  };
}

// The installed-as key for a bundled gateway. Double underscores because a
// single dash is ambiguous: plugin "a-b" + slug "c" and plugin "a" + slug "b-c"
// both produced "plugin-a-b-c", so one plugin could silently shadow another's
// gateway. Neither component may contain "__" (NAME_RE forbids it).
export const bundledGatewaySlug = (pluginName, slug) => `plugin__${pluginName}__${slug}`;

// A bundled gateway is FOREIGN CODE registered in the host gateway registry —
// the one place raw fetch is legitimate. It must not therefore receive the
// host's resolved credentials. Each mode runs against a projection: the
// plugin's own scoped DB and nothing else.
export function wrapGatewayModes(modes, pluginName, tables) {
  const allowed = new Set((tables || []).map((t) => String(t).toLowerCase()));
  const out = {};
  for (const [mode, fn] of Object.entries(modes || {})) {
    if (typeof fn !== 'function') continue;
    out[mode] = (env, input) => fn({ DB: scopedDb(env, pluginName, allowed) }, input);
  }
  return out;
}
