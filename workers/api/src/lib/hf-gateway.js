// Hugging Face gateway — one external service: HF Inference Providers
// (router.huggingface.co, OpenAI-compatible chat completions, HF_TOKEN auth).
//
// Role in the system: the WRITING fallback. When the Anthropic credit breaker
// opens, heavy prose writers (AEO articles, GTM angles, digest synthesis) run
// here instead of pausing — the model is picked for community-attested
// long-form writing quality, not code or tool-use. Chat fallback stays on the
// local Ollama model (chat needs the tool loop; this path is plain text).
//
// The model id is operator-editable: llm-models knowledge doc `writer_fallback`
// (Settings > Nyo brain), then HF_WRITER_MODEL env, then the coded default.

const ROUTER = 'https://router.huggingface.co/v1/chat/completions';

export function hfConfigured(env) {
  return !!env.HF_TOKEN;
}

export async function hfComplete(env, { system, prompt, model = null, maxTokens = 4000, timeoutMs = 120_000 } = {}) {
  if (!env.HF_TOKEN) throw new Error('HF_TOKEN not set — no HF fallback available');
  const { loadModelConfig } = await import('./model-config.js');
  const mc = await loadModelConfig(env).catch(() => null);
  const useModel = model || mc?.writer_fallback || env.HF_WRITER_MODEL;
  if (!useModel) throw new Error('no HF writer model configured (llm-models doc writer_fallback / HF_WRITER_MODEL)');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  // The router fans out to third-party providers; an occasional pick returns
  // an empty message. One retry rides past the flake before failing loudly.
  let lastDetail = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(ROUTER, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.HF_TOKEN}` },
      body: JSON.stringify({ model: useModel, messages, max_tokens: maxTokens, stream: false }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HF router ${r.status}: ${body.slice(0, 300)}`);
    }
    const j = await r.json();
    const msg = j.choices?.[0]?.message || {};
    let text = msg.content;
    if (Array.isArray(text)) text = text.map((b) => b?.text || '').join('');
    if (!text) text = msg.reasoning_content || '';
    if (text) return String(text).trim();
    lastDetail = `finish_reason=${j.choices?.[0]?.finish_reason ?? '?'} body=${JSON.stringify(j).slice(0, 200)}`;
  }
  throw new Error(`HF router returned no content (${lastDetail})`);
}

// Cheap reachability probe — a 1-token completion proves auth + model routing
// without burning meaningful free-tier quota.
export async function probeHf(env) {
  if (!env.HF_TOKEN) return { ok: false, error: 'HF_TOKEN not set' };
  try {
    const text = await hfComplete(env, { prompt: 'Say "ok".', maxTokens: 4, timeoutMs: 30_000 });
    return { ok: true, sample: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
