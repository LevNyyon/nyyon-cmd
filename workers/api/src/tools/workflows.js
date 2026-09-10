// workflows (named, stitched pipelines across modules) — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import { listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, listWorkflowRuns } from '../lib/db.js';

export const tools = {
  // ── workflows (named, stitched pipelines across modules) ────
  list_workflows: {
    def: {
      name: 'list_workflows',
      description: 'List every workflow defined in the system. Workflows are named pipelines (trigger + ordered steps) that stitch other modules together. source=system means the workflow is hardcoded in worker code and surfaced for visibility only; source=nyo means it was authored via this chat and will (Phase 2) be executed by the runtime.',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['system', 'nyo', 'manual'] },
          status: { type: 'string', enum: ['active', 'draft', 'disabled'] },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ workflows: await listWorkflows(env, input || {}) }),
  },
  read_workflow: {
    def: {
      name: 'read_workflow',
      description: 'Read one workflow by slug. Returns the full trigger + steps JSON definition plus metadata. Read existing system workflows before authoring a new one so the operator gets a consistent shape.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => {
      const w = await readWorkflow(env, input.slug);
      return w ? { found: true, workflow: w } : { found: false };
    },
  },
  write_workflow: {
    def: {
      name: 'write_workflow',
      description: 'Create or update a RUNNABLE workflow: an ordered list of EXISTING tools with no logic of its own (rules live in knowledge; branching belongs in a tool). steps is an array of {"tool":"<name>","input":{...}} (input optional — omitted steps receive the shared run context). Every step is validated against the live tool pool before saving. Execute with run_workflow or POST /api/dev/workflows/:slug.',
      input_schema: {
        type: 'object',
        properties: {
          slug:        { type: 'string', description: 'kebab-case' },
          name:        { type: 'string' },
          description: { type: 'string' },
          trigger:     { type: 'object', description: 'e.g. {"kind":"manual"} or {"kind":"cron","schedule":"0 9 * * 1"} (cron/event wiring pending; manual runs work now)' },
          steps:       { type: 'array', items: {}, description: 'ordered steps: "tool_name" or {"tool":"tool_name","input":{...}}' },
          status:      { type: 'string', enum: ['active', 'draft', 'disabled'] },
        },
        required: ['slug', 'name', 'trigger', 'steps'],
      },
    },
    run: async (env, input) => {
      const { validateWorkflowSteps } = await import('../workflows/runner.js');
      const problems = await validateWorkflowSteps(env, input.steps);
      if (problems.length) return { ok: false, error: 'steps failed validation against the tool pool', problems };
      return { ok: true, workflow: await writeWorkflow(env, { ...input, source: 'nyo', created_by: 'nyo', updated_by: 'nyo' }) };
    },
  },
  run_workflow: {
    def: {
      name: 'run_workflow',
      description: 'EXECUTE a stored workflow through the generic runner: each step dispatches into the shared tool pool with a threaded context; the full trail lands in workflow_runs + workflow_step_runs (visible in the Workflows page). Fails fast on the first failing step. input is the initial shared context handed to step 1.',
      input_schema: {
        type: 'object',
        properties: {
          slug:  { type: 'string' },
          input: { type: 'object', description: 'initial shared context (optional)' },
        },
        required: ['slug'],
      },
    },
    run: async (env, i) => {
      const { runWorkflow } = await import('../workflows/runner.js');
      return runWorkflow(env, i.slug, i.input || {});
    },
  },
  delete_workflow: {
    def: {
      name: 'delete_workflow',
      description: 'Delete a workflow. Refuse to delete system-source workflows — those are hardcoded in worker code and the row is only descriptive.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => {
      const w = await readWorkflow(env, input.slug);
      if (w?.source === 'system') return { ok: false, error: 'cannot delete system workflows' };
      await deleteWorkflow(env, input.slug);
      return { ok: true };
    },
  },
  list_workflow_runs: {
    def: {
      name: 'list_workflow_runs',
      description: 'List recent workflow runs (every fire of a workflow leaves a row here). Filter by workflow_slug or status. Use to answer "how often did the AEO writer fire this week" or "what failed last night".',
      input_schema: {
        type: 'object',
        properties: {
          workflow_slug: { type: 'string' },
          status:        { type: 'string', enum: ['running', 'succeeded', 'failed'] },
          limit:         { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ runs: await listWorkflowRuns(env, input || {}) }),
  },

};
