// system introspection tools (registry + health). The WhatsApp send tools
// that used to live here died with the sender extension: outbound WhatsApp
// is the operator clicking a wa.me link, never a machine send.

import { probeTheorg } from '../lib/gtm-context.js';
import { buildRegistry } from '../lib/registry.js';

export const tools = {
  read_registry: {
    def: {
      name: 'read_registry',
      description: 'The LIVE system registry — every external gateway (with configured/missing status), your real tools grouped by domain (derived from the running tool registry, not a hand-list), the scheduled + on-demand workflows, and the knowledge_docs each depends on. Use for "what can you do / what is connected / what powers X / which doc drives Y". This is ground truth; trust it over memory.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => buildRegistry(env),
  },
  system_health: {
    def: {
      name: 'system_health',
      description: 'Probe every service Nyo depends on and report status: the Nyyon worker itself and the GTM gateways (theorg org charts reachability + which optional enrichment keys are configured: PDL / SerpApi / Twilio). Use whenever the operator says "is everything up?", "why is X down?", or before a multi-step task that needs enrichment.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const theorg = await probeTheorg(env);
      const out = {
        nyyon_worker: { ok: true, note: 'this tool ran, so the worker is up' },
        gtm_theorg:   theorg,
        gtm_enrichment_keys: {
          pdl:     !!env.PDL_API_KEY,
          serpapi: !!env.SERPAPI_KEY,
          twilio:  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
          note: 'optional — unset legs skip gracefully in gtm_enrich_lead',
        },
      };
      return out;
    },
  },


};
