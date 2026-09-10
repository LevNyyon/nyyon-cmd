// EXPAND tools — the plugin-development desk's surface over lib/plugins.js.
// Plugin development is a HOST capability: the EXPAND agent drafts a manifest
// in conversation, checks it against the REAL validator, and installs through
// the REAL import pipeline. Each tool is ONE job; the heavy machinery
// (validation, binding, activation, materialization) lives in lib/plugins.js.
//
// install_plugin here accepts code-bearing manifests, unlike Nyo's
// import_plugin (which refuses code because a pasted manifest is foreign
// code). EXPAND's manifests are authored IN the conversation with the
// operator, who reads the final draft and explicitly confirms before the
// caller may install — Nyo asks the operator for an explicit yes before installing.

import { validateManifest, importPlugin, listPlugins } from '../lib/plugins.js';
import { loadPluginFormatDoc } from '../lib/expand-contract.js';
import { logEvent } from '../lib/db.js';

export const tools = {
  validate_plugin_manifest: {
    def: {
      name: 'validate_plugin_manifest',
      description: 'Check a drafted plugin manifest against the REAL import validator (shape, code contract, DDL namespace, gateway requirements, host collisions). Returns {ok, errors, warnings}. Read-only — it NEVER installs anything. Run it after every draft revision and fix every error it reports.',
      input_schema: {
        type: 'object',
        properties: { manifest: { type: 'object', description: 'the full plugin manifest JSON draft' } },
        required: ['manifest'],
      },
    },
    run: async (env, input) => {
      const r = await validateManifest(env, input?.manifest || {});
      return { ok: !!r.ok, errors: r.errors || [], warnings: r.warnings || [] };
    },
  },
  install_plugin: {
    def: {
      name: 'install_plugin',
      description: 'Install a validated plugin manifest through the real import pipeline (validate → bind gateways → activate tables/workflows/knowledge → queue code for materialization). Returns the pipeline result verbatim. Call ONLY after validate_plugin_manifest returned ok AND the operator saw the final manifest and explicitly confirmed the install.',
      input_schema: {
        type: 'object',
        properties: { manifest: { type: 'object', description: 'the final, validator-clean plugin manifest JSON' } },
        required: ['manifest'],
      },
    },
    run: async (env, input) => {
      const result = await importPlugin(env, input?.manifest || {}, { actor: 'expand' });
      await logEvent(env, {
        kind: 'expand_install',
        actor: 'expand',
        payload: { name: input?.manifest?.name || null, ok: !!result?.ok, status: result?.status || null },
      });
      return result;
    },
  },
  // Deliberately NOT list_plugins (Nyo's tool, full rows with binding +
  // report): the expand loop only needs the name/status projection, and the
  // two never share a pool — the chat loop scopes this set to the expand
  // agent, so tool-search under Nyo can only ever surface list_plugins.
  list_installed_plugins: {
    def: {
      name: 'list_installed_plugins',
      description: 'List the plugins installed on this system: name, version, status (imported/bound/materialized/active/blocked/removed), title. Read this before drafting so a new plugin never reuses an installed name. (Compact projection of list_plugins — for bindings and step reports the operator has the Plugins page.)',
      input_schema: { type: 'object', properties: {} },
    },
    run: async (env) => {
      const rows = await listPlugins(env);
      return { plugins: rows.map((r) => ({ name: r.name, version: r.version, status: r.status, title: r.title })) };
    },
  },
  read_plugin_contract: {
    def: {
      name: 'read_plugin_contract',
      description: 'Read the plugin format contract (the plugin-format knowledge doc — this install\'s editable copy of docs/plugin-format.md, v2/v2.1: manifest shape, tool code rules, DDL namespace, gateway binding, surfaces). Ground every draft in it; never guess the contract from memory.',
      input_schema: { type: 'object', properties: {} },
    },
    run: async (env) => {
      const doc = await loadPluginFormatDoc(env);
      return { slug: doc.slug, title: doc.title, body: doc.body };
    },
  },
};
