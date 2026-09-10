// The Nyo tool pool — assembled from the per-group files in this directory.
// Spread order matters: it is the order tool defs are presented to the model,
// so keep it identical to the original chat/tools.js grouping.

import { flagsAsObject } from '../lib/db.js';
import { tools as knowledgeTools } from './knowledge.js';
import { tools as activityLogTools } from './activity-log.js';
import { tools as heartbeatTools } from './heartbeat.js';
import { tools as whatsappTools } from './whatsapp.js';
import { tools as workflowsTools } from './workflows.js';
import { tools as linkedinTools } from './linkedin.js';
import { tools as featureFlagsTools } from './feature-flags.js';
import { tools as gtmTools } from './gtm.js';
import { tools as dailyPlannerTools } from './daily-planner.js';
import { tools as hotTakesTools } from './hot-takes.js';
import { tools as conversationsTools } from './conversations.js';
import { tools as pluginMgmtTools } from './plugins.js';
import { tools as expandTools } from './expand.js';
import { pluginTools } from '../plugins/index.js';

const TOOL_REGISTRY = {
  // Installed plugins are spread FIRST so EVERY host family overwrites them on
  // a name clash. A later spread wins, so anything after this line is safe;
  // the old placement at the BOTTOM meant a plugin silently overrode host
  // tools. Import validation refuses clashes too, but that check reads
  // visibleToolDefs — which omits flag-disabled tools — so a plugin could
  // claim the name of a host tool that is currently switched off.
  ...pluginTools,
  ...knowledgeTools,
  ...activityLogTools,
  ...heartbeatTools,
  ...whatsappTools,
  ...workflowsTools,
  ...linkedinTools,
  ...featureFlagsTools,
  ...gtmTools,
  ...dailyPlannerTools,
  ...hotTakesTools,
  ...conversationsTools,
  ...pluginMgmtTools,
  ...expandTools,
};

export async function visibleToolDefs(env) {
  const flags = await flagsAsObject(env);
  return Object.entries(TOOL_REGISTRY)
    .filter(([name]) => flags[`tool.${name}`] !== false) // default-on
    .map(([, t]) => t.def);
}

// `ctx` carries per-turn context the caller knows but the model doesn't — today
// just the active conversation id, so a tool can refuse to destroy the thread
// it is running inside. Optional: every other caller passes nothing.
export async function runTool(env, name, input, ctx = {}) {
  const t = TOOL_REGISTRY[name];
  if (!t) throw new Error(`unknown tool ${name}`);
  const flags = await flagsAsObject(env);
  if (flags[`tool.${name}`] === false) throw new Error(`tool ${name} is disabled by feature flag`);
  return t.run(env, input || {}, ctx);
}

