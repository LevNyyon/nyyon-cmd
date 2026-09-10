// Plugin management tools — the Nyo-facing surface of the Plugins module.
// Each is ONE job over lib/plugins.js; the heavy pipeline lives there.
// Importing via chat is deliberately supported (Nyo can be handed a manifest),
// but the paste-a-JSON path most operators use is the Plugins page.

import {
  listPlugins, importPlugin, exportPlugin, removePlugin, verifyPlugin,
} from '../lib/plugins.js';

export const tools = {
  list_plugins: {
    def: {
      name: 'list_plugins',
      description: 'Installed plugins with status (imported/bound/materialized/active/blocked/removed), gateway bindings, and the last step report. A blocked plugin\'s report says exactly why.',
      input_schema: { type: 'object', properties: {} },
    },
    run: async (env) => ({ plugins: await listPlugins(env) }),
  },
  import_plugin: {
    def: {
      name: 'import_plugin',
      description: 'Import a DATA-ONLY nyyon plugin manifest (workflows + knowledge). Manifests carrying tool or gateway CODE are refused here on purpose — importing code is an operator action on the Plugins page. Validates the format contract, binds required gateways to this system (mechanically), activates workflows/knowledge/tables immediately, and queues tool/gateway code for the materializer. Returns the binding or the precise blocking errors. CONFIRM with the operator before importing anything they did not hand you themselves.',
      input_schema: {
        type: 'object',
        properties: { manifest: { type: 'object', description: 'the full plugin manifest JSON' } },
        required: ['manifest'],
      },
    },
    run: async (env, input) => {
      // A code-bearing plugin is foreign code that will run inside this
      // install. That decision belongs to a human looking at the source, not
      // to a model acting on a manifest someone pasted into a chat — so this
      // path accepts data-only plugins and sends the rest to the Plugins page.
      const m = input?.manifest || {};
      const codeCount = (Array.isArray(m?.provides?.tools) ? m.provides.tools.length : 0)
        + (Array.isArray(m?.provides?.gateways) ? m.provides.gateways.length : 0);
      if (codeCount) {
        return {
          ok: false,
          refused: 'carries code',
          error: `"${m.name || 'this plugin'}" ships ${codeCount} code component(s). Importing code is an operator action: open the Plugins page, read the source, and import it there.`,
        };
      }
      return importPlugin(env, input.manifest, { actor: 'nyo' });
    },
  },
  export_plugin: {
    def: {
      name: 'export_plugin',
      description: 'Export one installed plugin as its manifest JSON (round-trip safe, sha256-sealed) so the operator can hand it to another nyyon system.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    run: async (env, input) => exportPlugin(env, input.name),
  },
  verify_plugin: {
    def: {
      name: 'verify_plugin',
      description: 'Check whether a materialized plugin\'s tools are live in the pool, and flip it to active if so. Run after the applier restarts (self-hosted) or CI deploys (cloud).',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    run: async (env, input) => verifyPlugin(env, input.name),
  },
  remove_plugin: {
    def: {
      name: 'remove_plugin',
      description: 'Remove an installed plugin: workflows disable, code files are cleaned on the applier\'s next pass. Tables and their data are kept (they belong to the operator). CONFIRM with the operator first.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    run: async (env, input) => removePlugin(env, input.name),
  },
};
