// The minimal workflow runner (nyyon-lite layer 3, "Phase 2" the 0013
// migration promised). A workflow is an ordered list of EXISTING tools with no
// logic of its own; this generic runner threads a shared context through the
// steps and writes the full audit trail (workflow_runs + workflow_step_runs).
//
// Step shapes accepted (the D1 `workflows.steps` JSON array):
//   "tool_name"                          — run with the shared ctx input
//   { "tool": "tool_name" }              — same
//   { "tool": "tool_name", "input": {} } — fixed input, merged over shared ctx
// Each step's result lands in ctx.results[i] and (if an object) is shallow-
// merged into ctx.shared so later steps can consume earlier outputs — the
// "generic runner threads a shared context" contract, nothing smarter.

import { runTool } from '../tools/index.js';
import { uid, now } from '../lib/util.js';

function normalizeStep(s, i) {
  if (typeof s === 'string') return { tool: s, input: null, index: i };
  if (s && typeof s === 'object' && typeof s.tool === 'string') return { tool: s.tool, input: s.input ?? null, index: i };
  return null;
}

// Validate steps against the live tool pool — used by write_workflow and the
// dev bench so an authored workflow can't reference a tool that doesn't exist.
export async function validateWorkflowSteps(env, steps) {
  const problems = [];
  if (!Array.isArray(steps) || !steps.length) return ['steps must be a non-empty array'];
  const { visibleToolDefs } = await import('../tools/index.js');
  const pool = new Set((await visibleToolDefs(env)).map((d) => d.name));
  steps.forEach((s, i) => {
    const st = normalizeStep(s, i);
    if (!st) problems.push(`step ${i}: not a tool name or {tool, input} object`);
    else if (!pool.has(st.tool)) problems.push(`step ${i}: tool "${st.tool}" not in the shared pool`);
  });
  return problems;
}

export async function runWorkflow(env, slug, input = {}, { trigger_kind = 'manual' } = {}) {
  const row = await env.DB.prepare(
    'SELECT slug, name, steps, status FROM workflows WHERE slug = ?',
  ).bind(slug).first();
  if (!row) return { ok: false, error: `unknown workflow "${slug}"` };
  if (row.status === 'disabled') return { ok: false, error: `workflow "${slug}" is disabled` };

  let rawSteps;
  try { rawSteps = JSON.parse(row.steps); } catch { return { ok: false, error: 'steps JSON is invalid' }; }
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).map(normalizeStep).filter(Boolean);
  if (!steps.length) return { ok: false, error: 'workflow has no runnable steps (observability-only definition?)' };

  const runId = 'wr_' + uid();
  const startedAt = now();
  await env.DB.prepare(
    `INSERT INTO workflow_runs (id, workflow_slug, status, trigger_kind, trigger_payload, started_at)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).bind(runId, slug, trigger_kind, JSON.stringify(input || {}), startedAt).run();

  const ctx = { input: input || {}, shared: { ...(input || {}) }, results: [] };
  for (const step of steps) {
    const stepId = 'wsr_' + uid();
    const t0 = now();
    await env.DB.prepare(
      `INSERT INTO workflow_step_runs (id, run_id, step_index, step_name, step_type, input, started_at)
       VALUES (?, ?, ?, ?, 'tool', ?, ?)`,
    ).bind(stepId, runId, step.index, step.tool, JSON.stringify(step.input ?? ctx.shared), t0).run();
    try {
      const result = await runTool(env, step.tool, step.input ? { ...ctx.shared, ...step.input } : ctx.shared);
      ctx.results.push({ tool: step.tool, ok: true, result });
      if (result && typeof result === 'object' && !Array.isArray(result)) Object.assign(ctx.shared, result);
      await env.DB.prepare(
        `UPDATE workflow_step_runs SET status='succeeded', output=?, finished_at=? WHERE id=?`,
      ).bind(JSON.stringify(result).slice(0, 20000), now(), stepId).run();
    } catch (e) {
      const error = String(e?.message || e).slice(0, 1000);
      ctx.results.push({ tool: step.tool, ok: false, error });
      await env.DB.prepare(
        `UPDATE workflow_step_runs SET status='failed', error=?, finished_at=? WHERE id=?`,
      ).bind(error, now(), stepId).run();
      await env.DB.prepare(
        `UPDATE workflow_runs SET status='failed', error=?, finished_at=? WHERE id=?`,
      ).bind(`step ${step.index} (${step.tool}): ${error}`, now(), runId).run();
      return { ok: false, run_id: runId, failed_step: step.index, tool: step.tool, error, results: ctx.results };
    }
  }

  await env.DB.prepare(
    `UPDATE workflow_runs SET status='succeeded', output=?, finished_at=? WHERE id=?`,
  ).bind(JSON.stringify({ steps: steps.length }), now(), runId).run();
  return { ok: true, run_id: runId, steps: steps.length, results: ctx.results };
}

// Idempotent seed for the five workflow slugs the code has always logged runs
// under with no stored definition — their history was invisible in the
// Workflows UI. Seeded as observability definitions (empty steps): they
// document real hardcoded pipelines; converting one to runnable steps is a
// deliberate edit, not a seed.
const ORPHAN_SLUGS = [
  ['blog-shape',          'Blog · shape a draft',        'composeAndSavePost pipeline: voice docs -> house-style rewrite -> save draft'],
  ['article-figures',     'Blog · article figures',      'draft figure specs -> render SVG->PNG -> R2 -> embed + set cover'],
  ['blog-featured-image', 'Blog · featured image',       'visual brief -> N candidates -> vision judge -> R2 -> set featured_image_url'],
  ['social-card',         'Social · share card',         'render a share-card template SVG->PNG -> R2'],
  ['nyo-wake-up',            'Nyo · wake-up',               'app open / tab refocus: survey state -> auto-actions -> queue a briefing (capped once per gap)'],
  ['hourly-awareness-sweep', 'Cron · hourly awareness',     'OSINT scrape (stale >3h) -> heartbeat scoring -> regenerate the digest, one chain per tick'],
];
// Runnable system seeds — unlike ORPHAN_SLUGS these carry REAL steps and run
// through runWorkflow. [slug, name, description, trigger, steps]
const RUNNABLE_SEEDS = [
  ['hottake-produce', 'Hot Takes · produce to the angle gate',
   'The editorial spine up to the ANGLE GATE: draft the take → build the brief. The brief lands the angle in Nyo chat for the operator to argue with; the article is deliberately NOT part of this chain — nothing writes until the operator engages or says write it (hottake_write_article with confirm). Run with {id: <hot-take package id>}.',
   { kind: 'on-demand', note: 'run_workflow with {id}; stops at the angle gate by design' },
   [{ tool: 'hottake_draft_take' }, { tool: 'hottake_build_brief' }]],
];
export async function seedSystemWorkflows(env) {
  const t = now();
  for (const [slug, name, description] of ORPHAN_SLUGS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, '[]', 'system', 'active', ?, ?, 'system')`,
    ).bind(slug, name, description, JSON.stringify({ kind: 'code', note: 'hardcoded pipeline; runs logged by code' }), t, t).run();
  }
  for (const [slug, name, description, trigger, steps] of RUNNABLE_SEEDS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'system', 'active', ?, ?, 'system')`,
    ).bind(slug, name, description, JSON.stringify(trigger), JSON.stringify(steps), t, t).run();
  }
}
