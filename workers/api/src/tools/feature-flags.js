// feature flags — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import { listFlags, setFlag } from '../lib/db.js';

export const tools = {
  // ── feature flags ──────────────────────────────────────────
  list_feature_flags: {
    def: {
      name: 'list_feature_flags',
      description: 'List every feature flag with current value + scope. Surface flags gate UI sections; tool flags gate which tools Nyo can call.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ flags: await listFlags(env) }),
  },
  set_feature_flag: {
    def: {
      name: 'set_feature_flag',
      description: 'Flip a feature flag on or off. Creates the flag if it does not exist (scope defaults to tool).',
      input_schema: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'boolean' } },
        required: ['key', 'value'],
      },
    },
    run: async (env, input) => { await setFlag(env, input.key, !!input.value); return { ok: true }; },
  },

};
