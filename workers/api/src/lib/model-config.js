// Model configuration — knowledge-backed (nyyon-lite layer 5).
//
// Which model each surface runs on used to be wrangler.jsonc env vars only
// (deploy to change). The `llm-models` knowledge doc now overrides them at
// runtime: doc value > env var > coded default, per field. The Settings page
// renders a friendly editor over the doc; editing the doc directly works too.
//
// Fields:
//   nyo_mid / nyo_high — the chat tier switch
//   writer        — the heavy background writers (digest synthesis, AEO
//                   articles, GTM angles) — the old ANTHROPIC_MODEL
//   writer_small  — cheap utility mapping for "mini/haiku" call sites
//   vision        — image judging (OpenAI vision)

import { readKnowledge, writeKnowledge } from './db.js';

const DOC_SLUG = 'llm-models';

export function modelDefaults(env) {
  return {
    nyo_mid:      env.NYO_MODEL_MID  || 'claude-sonnet-5',
    nyo_high:     env.NYO_MODEL_HIGH || 'claude-opus-4-8',
    writer:       env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    writer_small: env.ANTHROPIC_SMALL_MODEL || 'claude-haiku-4-5-20251001',
    vision:       env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
    // HF Inference Providers model the heavy writers fall back to when the
    // Anthropic credit breaker is open. Picked for prose quality, not code.
    writer_fallback: env.HF_WRITER_MODEL || '',
    // Chat TIER (low/mid/high, not a model id) the Hot Takes drafting wizard
    // runs on. High by default: the angle conversation is where the
    // operator's input matters most (mid-tier drafting read as "word salad").
    wizard_tier: env.HOTTAKES_WIZARD_TIER || 'high',
  };
}

function cleanModelId(v) {
  const s = String(v ?? '').trim();
  // model ids are short tokens — refuse anything that looks like prose/injection
  return s && s.length <= 120 && !/\s{2,}|\n/.test(s) ? s : null;
}

// Read the doc override merged over env/coded defaults. Seeds the doc on first
// read so the operator can find it in the Knowledge tree. Never throws.
export async function loadModelConfig(env) {
  const defaults = modelDefaults(env);
  try {
    const doc = await readKnowledge(env, DOC_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: DOC_SLUG,
        title: 'LLM models — which model runs each surface',
        body: seedBody(defaults),
        parent_slug: 'module-nyo',
      }).catch(() => {});
      return { ...defaults, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const out = { source: 'doc' };
    for (const [k, dflt] of Object.entries(defaults)) {
      out[k] = cleanModelId(src[k]) || dflt;
    }
    return out;
  } catch {
    return { ...defaults, source: 'defaults' };
  }
}

// Merge a partial patch into the doc's JSON block (whole-doc rewrite, keeping
// the explanatory prose). Returns the new effective config.
export async function saveModelConfig(env, patch = {}) {
  const cur = await loadModelConfig(env);
  const defaults = modelDefaults(env);
  const next = {};
  for (const k of Object.keys(defaults)) {
    const v = patch[k] !== undefined ? cleanModelId(patch[k]) : cur[k];
    next[k] = v || defaults[k];
  }
  await writeKnowledge(env, {
    slug: DOC_SLUG,
    title: 'LLM models — which model runs each surface',
    body: seedBody(next),
    parent_slug: 'module-nyo',
  });
  return { ...next, source: 'doc' };
}

function seedBody(models) {
  return `Which model each surface runs on. The code reads the JSON block below at run time (\`loadModelConfig\` in lib/model-config.js) — edit here or in Settings, no deploy. Invalid or missing fields fall back to the wrangler.jsonc env vars, then the coded defaults.

- \`nyo_mid\` / \`nyo_high\` — the chat tier switch
- \`writer\` — heavy background writers: digest synthesis, AEO articles, GTM outreach angles
- \`writer_small\` — the cheap utility model "mini/haiku" call sites map to
- \`vision\` — image judging (featured-image picker)
- \`writer_fallback\` — the Hugging Face model heavy writers use while Anthropic credit is out (empty = writers pause instead)
- \`wizard_tier\` — the chat tier (low / mid / high) the Hot Takes drafting wizard runs on

\`\`\`json
${JSON.stringify(models, null, 2)}
\`\`\``;
}
