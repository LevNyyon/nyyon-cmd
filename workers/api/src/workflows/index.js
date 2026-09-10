// WORKFLOWS layer registry (nyyon-lite layer 3).
//
// A workflow is an ordered list of EXISTING tools with no business logic of
// its own — a generic runner threads a shared context through the steps.
// Today the definitions live in the D1 `workflows` table (surfaced via
// lib/db.js listWorkflows) and are display-only; the executing runner lands in
// refactor step 7. This index is the layer-dir entry point the validator
// enforces and the home for the runner + any code-defined workflow specs.
//
// Re-exported so the workflow layer has a single machine-readable seam while
// the D1-backed definitions and the (pending) runner converge here.

export { listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, listWorkflowRuns } from '../lib/db.js';
export { runWorkflow, validateWorkflowSteps, seedSystemWorkflows } from './runner.js';
