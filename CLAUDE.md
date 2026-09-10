# nyyon-command-center — build rules (MANDATORY)

**This repository is built the nyyon-lite way. Always. No exceptions.**
Every change — a new capability, a bug fix, a tweak — must respect the five-layer
architecture and its guardrails. If a change would break a guardrail, redesign
the change; do not break the guardrail.

## Before writing code

1. **Load the `nyyon-lite` skill** (`/nyyon-lite`) for any non-trivial change, and
   the specific builder skill for the layer you're adding: `/nyyon-gateways`,
   `/nyyon-tools`, `/nyyon-workflows`, `/nyyon-modules`, `/nyyon-surfaces`,
   `/nyyon-knowledge`. For a whole capability, use `/nyyon`.
2. Decide which layer the change belongs in **before** editing. Put it there.

## The five layers (each may reach only the layer(s) below it)

1. **Gateway** — the boundary to ONE external service. Does NO reasoning. Only the
   `llm` gateway may call an LLM. Reach services via `callGateway(env, slug, mode, input)`.
2. **Tool** — ONE job, in the single shared pool (`tools/index.js`). Reaches
   services ONLY through gateways. May reason (via the `llm` gateway). Never calls
   another tool.
3. **Workflow** — an ordered list of EXISTING tools. No logic, no branching.
4. **Module** — a product area + a visualization (a page). Uses shared tools/
   gateways; never private ones; never raw `fetch`.
5. **Knowledge** — editable rules/constants/prompts, seeded with a default. Change
   behavior by editing a note, not code.

Under everything: the **activity bus** — every meaningful mutation calls
`logEvent(env, {kind, actor, payload})`.

## Hard guardrails (never break)

- Gateways don't think (no LLM except the `llm` gateway, no business logic, no
  cross-gateway calls).
- Tools share one pool; a tool never calls another tool; a tool/module never does
  raw `fetch` — go through a gateway.
- Constants, thresholds, lists, prompts, and model choices live in **knowledge
  notes**, not literals in code. (Model tiers come from the `llm-models` doc.)
- Every module ships a visualization and is registered.
- JSON in, JSON out at every boundary.
- Writing a shared file = writing the COMPLETE file (never a partial that silently
  drops the rest).

## Before ending any turn that changed code

Run **`/nyyon-review`** on the diff and fix every finding before considering the
change done. A change that hasn't been reviewed against the guardrails isn't done.

See the `nyyon-lite` skill for templates and the full checklist.
