// Dev-invoke — authenticated curl access to every gateway, tool, and workflow.
//
// The operator's test bench: POST /api/dev/{tools|gateways|workflows}/:name
// with a JSON input body, get the component's JSON result back. Auth is a
// DEV_API_KEY bearer token checked in gate.js (scoped to /api/dev/* only —
// the key unlocks this surface, not the whole API).
//
// Every invocation logs to the activity bus (kind: dev_invoke) with the
// layer, name, ok/error, and duration — test traffic is visible in Activity
// like any other mutation, per the everything-logs guardrail.

import { visibleToolDefs, runTool } from '../tools/index.js';
import { listGateways, callGateway } from '../gateways/index.js';
import { logEvent } from './db.js';
import { EVENT_KINDS } from './event-kinds.js';
import { now } from './util.js';

export async function devListRegistry(env) {
  // Idempotent: makes sure the five code-logged workflow slugs have visible
  // definitions before listing (they were invisible in the UI for months).
  try { await (await import('../workflows/index.js')).seedSystemWorkflows(env); } catch (e) { console.error('workflow seed failed:', e?.message || e); }
  const [tools, workflows] = await Promise.all([
    visibleToolDefs(env),
    env.DB.prepare('SELECT slug, name, description, trigger, steps, status, updated_at FROM workflows ORDER BY slug').all()
      .then((r) => (r.results || []).map((w) => ({
        slug: w.slug, name: w.name, description: w.description, status: w.status,
        trigger: safeParse(w.trigger), steps: safeParse(w.steps) || [],
        updated_at: w.updated_at,
      })))
      .catch(() => []),
  ]);
  return {
    gateways: listGateways(),
    tools: tools.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema })),
    workflows,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function logged(env, layer, name, fn) {
  const started = now();
  try {
    const result = await fn();
    await logEvent(env, {
      kind: EVENT_KINDS.DEV_INVOKE, actor: 'dev-api',
      payload: { layer, name, ok: true, ms: now() - started },
    }).catch((e) => console.error('dev_invoke logEvent failed:', e?.message || e));
    return { ok: true, ms: now() - started, result };
  } catch (e) {
    const error = String(e?.message || e).slice(0, 500);
    await logEvent(env, {
      kind: EVENT_KINDS.DEV_INVOKE, actor: 'dev-api',
      payload: { layer, name, ok: false, ms: now() - started, error },
    }).catch((e2) => console.error('dev_invoke logEvent failed:', e2?.message || e2));
    return { ok: false, ms: now() - started, error };
  }
}

export function devInvokeTool(env, name, input) {
  return logged(env, 'tool', name, () => runTool(env, name, input));
}

// Gateway invocations take { mode, input } — mode selects the operation.
export function devInvokeGateway(env, slug, body) {
  const mode = body?.mode;
  if (!mode) {
    return Promise.resolve({ ok: false, error: 'body must be { "mode": "<mode>", "input": {...} } — GET /api/dev/registry lists each gateway\'s modes' });
  }
  return logged(env, 'gateway', `${slug}.${mode}`, () => callGateway(env, slug, mode, body?.input));
}

// Workflows execute through the generic runner (workflows/runner.js): each
// step dispatches into the shared tool pool, the full trail lands in
// workflow_runs + workflow_step_runs, and the invocation logs like any other.
export function devInvokeWorkflow(env, slug, input) {
  return logged(env, 'workflow', slug, async () => {
    const { runWorkflow } = await import('../workflows/index.js');
    const r = await runWorkflow(env, slug, input || {});
    if (!r.ok) throw new Error(r.error || `workflow ${slug} failed`);
    return r;
  });
}
