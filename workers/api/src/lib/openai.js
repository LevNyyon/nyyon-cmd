// Provider-aware text LLM client used outside the Nyo SSE chat (cron writers,
// figure/AEO drafters, etc.). Function names keep the historic `callOpenAI*`
// spelling so existing call sites don't change, but the provider is chosen by
// LLM_PROVIDER (default 'anthropic', matching chat/index.js). Returns the
// assistant message content as a single string.

import { guardLlm, handleLlmFailure, noteLlmOk } from './llm.js';
import { loadModelConfig } from './model-config.js';

function providerOf(env) {
  return (env.LLM_PROVIDER || 'anthropic').toLowerCase();
}

export function resolveModel(env) {
  if (providerOf(env) === 'anthropic') return env.ANTHROPIC_MODEL || 'claude-opus-4-7';
  return env.OPENAI_MODEL || env.LLM_MODEL || 'gpt-4o';
}

// Parse JSON that may arrive wrapped in ```json fences or with prose around it
// (Anthropic has no response_format, so we tolerate both).
export function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* noop */ } }
  throw new Error(`LLM returned non-JSON: ${String(text).slice(0, 200)}`);
}

// Transient upstream errors self-heal instead of surfacing as a failed generate:
// Anthropic returns 503/529 ("Overloaded") under load, plus the usual rate-limit /
// gateway hiccups. Retry with exponential backoff + jitter, honouring Retry-After.
// After the attempts are spent it returns the failed response so the caller still
// throws loudly (a real outage is not silently swallowed).
// ponytail: fixed 4 attempts / 8s cap — bump if provider load gets worse.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
// Internal only — every LLM caller goes through the entry points below, never
// this raw transport. (Was exported; digest.js/gtm.js/chat each ran their own
// parallel provider boundary on top of it — the four-boundaries violation.)
async function fetchLLM(url, init, { attempts = 4, baseMs = 600 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1;
    try {
      const r = await fetch(url, init);
      if (r.ok || !RETRYABLE_STATUS.has(r.status) || last) return r;
      const ra = parseInt(r.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : baseMs * 2 ** i + Math.random() * 250;
      await new Promise((res) => setTimeout(res, Math.min(wait, 8000)));
    } catch (e) {
      if (last) throw e; // network error on the final try
      await new Promise((res) => setTimeout(res, baseMs * 2 ** i + Math.random() * 250));
    }
  }
}

// ── raw transports for the interactive chat loop ──────────────────────────
// The Nyo chat builds rich payloads (tool schemas, cache_control breakpoints,
// deferred tools) and consumes raw Responses. These two passthroughs keep that
// payload logic in chat/ while the PHYSICAL provider boundary (endpoints,
// auth headers, retry) lives here — the llm gateway is the only file that
// talks to a provider.
export function llmTransportAnthropic(env, body, { timeoutMs = 60_000 } = {}) {
  return fetchLLM('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, { attempts: 1 }); // chat loop does its own tier fallback; no blind retries
}
export function llmTransportOpenAICompat(env, { base, apiKey, body, timeoutMs = 60_000 } = {}) {
  return fetchLLM(`${base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, { attempts: 1 });
}

async function callAnthropicText(env, { system, prompt, model = null, wantJson = false, max_tokens = 6000, heavy = false }) {
  // Honour an explicit Claude model; map cheap OpenAI overrides (gpt-*-mini)
  // to Haiku; otherwise use the configured Anthropic model. Never pass a
  // gpt-* string through — the Messages API would 404.
  const mc = await loadModelConfig(env);
  const useModel = model && /^claude/i.test(model)
    ? model
    : (model && /mini|small|haiku/i.test(model))
      ? mc.writer_small
      : mc.writer;

  const sys = wantJson
    ? `${system ? system + '\n\n' : ''}Respond with ONLY the raw JSON — no markdown fences, no prose.`
    : system;

  // Circuit-breaker: if the main model is down (out of credit), light callers
  // (default) fall back to the local model; heavy callers (heavy:true — the AEO
  // writer) throw LlmDownError so the job pauses instead of writing badly.
  const g = await guardLlm(env, { heavy, system: sys, prompt, maxTokens: max_tokens });
  if (g.skip) return g.text;

  const r = await fetchLLM('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: useModel,
      max_tokens,
      system: sys || undefined,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    // credit/auth → open circuit + fall back (light) or throw LlmDownError (heavy);
    // transient/other → plain throw (no circuit change).
    return handleLlmFailure(env, r.status, await r.text().catch(() => ''), { heavy, system: sys, prompt, maxTokens: max_tokens });
  }
  await noteLlmOk(env);
  const json = await r.json();
  const text = (json.content || []).map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('Anthropic returned no content');
  return text;
}

export async function callOpenAIText(env, { system, prompt, model = null, response_format = null, max_tokens = 6000, heavy = false }) {
  env = await (await import('./gateway-config.js')).withResolvedCredentials(env);
  if (providerOf(env) === 'anthropic') {
    return callAnthropicText(env, { system, prompt, model, wantJson: response_format?.type === 'json_object', max_tokens, heavy });
  }
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model: model || resolveModel(env),
    messages,
    // gpt-5.x/o1/o3 reject `max_tokens` — use `max_completion_tokens`.
    max_completion_tokens: max_tokens,
  };
  if (response_format) body.response_format = response_format;

  const r = await fetchLLM('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`OpenAI ${r.status}: ${text.slice(0, 400)}`);
  }
  const json = await r.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no content');
  return text;
}

// Convenience: ask for strict JSON and parse it (tolerant of fenced output).
export async function callOpenAIJson(env, opts) {
  const text = await callOpenAIText(env, {
    ...opts,
    response_format: { type: 'json_object' },
  });
  return parseJsonLoose(text);
}

// Encode raw image bytes (Uint8Array) as a base64 data: URL for inline
// inclusion in OpenAI vision requests. Chunked to avoid String.fromCharCode's
// apply() stack-size limit on big images.
function bytesToDataUrl(bytes, contentType = 'image/png') {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

// Multimodal call. `images` is an array of either Uint8Array (raw bytes) or
// strings (already base64 data: URL, or a public http(s) URL).
//
// Picks `OPENAI_VISION_MODEL` from env if set, else `gpt-4o-mini` — cheap,
// capable, supports vision. Override per call via `opts.model`.
export async function callOpenAIVision(env, { system, prompt, images = [], model = null, response_format = null }) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const visionModel = model || (await loadModelConfig(env)).vision;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  const content = [];
  if (prompt) content.push({ type: 'text', text: prompt });
  for (const img of images) {
    let url;
    if (typeof img === 'string') {
      url = img.startsWith('data:') || /^https?:/i.test(img) ? img : `data:image/png;base64,${img}`;
    } else if (img instanceof Uint8Array) {
      url = bytesToDataUrl(img);
    } else if (img && img.bytes instanceof Uint8Array) {
      url = bytesToDataUrl(img.bytes);
    } else {
      throw new Error('callOpenAIVision: image must be Uint8Array or string URL');
    }
    // detail: 'low' caps the image to 512px squares = ~85 tokens vs ~765 for
    // high. For ranking small editorial illustrations the low tier is plenty
    // and keeps the judge call under a fraction of a cent.
    content.push({ type: 'image_url', image_url: { url, detail: 'low' } });
  }
  messages.push({ role: 'user', content });

  const body = {
    model: visionModel,
    messages,
    max_completion_tokens: 1500,
  };
  if (response_format) body.response_format = response_format;

  const r = await fetchLLM('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`OpenAI vision ${r.status}: ${text.slice(0, 400)}`);
  }
  const json = await r.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI vision returned no content');
  return text;
}

export async function callOpenAIVisionJson(env, opts) {
  const text = await callOpenAIVision(env, {
    ...opts,
    response_format: { type: 'json_object' },
  });
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`OpenAI vision returned non-JSON: ${text.slice(0, 200)}`); }
}
