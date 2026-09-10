// Image gateway — thin wrapper around Cloudflare Workers AI text-to-image
// models + R2 storage. Knows NOTHING about blogs. Takes a literal prompt and a
// storage key, returns a URL. Anything in Nyyon that wants an image lives on
// top of this gateway (lib/blog-images.js, future social-post imager, etc).
//
// Model names exposed by this module are friendly aliases (`flux-schnell`,
// `flux-dev`, `sdxl`). The mapping to whatever Cloudflare slugs them as today
// lives in MODEL_REGISTRY below — when CF renames a model or we want to swap
// to a newer one (e.g. FLUX.2), we change one row here and every caller picks
// it up.


// Models that use OpenAI's Images API instead of Workers AI.
// These are routed through renderImageOpenAI() rather than env.AI.run().
const OPENAI_MODELS = new Set(['dall-e-3', 'dall-e-2', 'gpt-image-1']);

// Friendly alias → actual Cloudflare Workers AI model slug.
// Keep aliases stable; rotate the underlying CF model when needed.
const MODEL_REGISTRY = {
  // Free-tier-friendly, ~28 neurons / image. Our default.
  'flux-schnell':  '@cf/black-forest-labs/flux-1-schnell',
  // Higher-quality SD baseline; useful fallback if Flux is unavailable.
  'sdxl':          '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  // Lightweight, very fast — good for thumbnails.
  'dreamshaper':   '@cf/lykon/dreamshaper-8-lcm',
};

const DEFAULT_MODEL  = 'dall-e-3';
const DEFAULT_WIDTH  = 1024;
const DEFAULT_HEIGHT = 1024;

function resolveModel(alias) {
  const slug = MODEL_REGISTRY[alias];
  if (!slug) throw new Error(`unknown model alias: ${alias}. Known: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
  return { alias, slug };
}

// Normalise the Workers AI response into raw PNG bytes. The shape has shifted
// across the model line — some return `{ image: "<base64>" }`, some return a
// ReadableStream, some a Uint8Array. We accept all three.
async function toBytes(result) {
  if (!result) throw new Error('image model returned nothing');
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (typeof ReadableStream !== 'undefined' && result instanceof ReadableStream) {
    return new Uint8Array(await new Response(result).arrayBuffer());
  }
  if (typeof result === 'object' && typeof result.image === 'string') {
    // base64 → Uint8Array (decode without Buffer for Workers compat)
    const bin = atob(result.image);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error(`unexpected image-model response shape: ${typeof result}`);
}

function nowMs() { return Date.now(); }

// OpenAI Images API path. DALL-E 3 always returns b64_json.
async function renderImageOpenAI(env, opts) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('image-gateway: OPENAI_API_KEY not set');

  const model  = opts.model || 'dall-e-3';
  const size   = '1024x1024';
  // DALL-E 3 has vivid (more saturated) and natural (muted). Natural fits Bauhaus better.
  const style  = opts.dalle_style || 'natural';
  const quality = opts.dalle_quality || 'standard';

  // Use url output — response_format + style are deprecated in newer API.
  const body = { model, prompt: opts.prompt.slice(0, 4000), n: 1, size };

  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI images API ${r.status}: ${t.slice(0, 400)}`);
  }
  const data = await r.json();
  const item = data?.data?.[0] || {};
  // gpt-image-1 returns b64_json; dall-e-2/3 may return a url. Handle both.
  let bytes;
  if (item.b64_json) {
    const bin = atob(item.b64_json);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else if (item.url) {
    const imgResp = await fetch(item.url);
    if (!imgResp.ok) throw new Error(`fetching OpenAI image URL: ${imgResp.status}`);
    bytes = new Uint8Array(await imgResp.arrayBuffer());
  } else {
    throw new Error('OpenAI images API: no b64_json or url in response');
  }

  return {
    bytes,
    model,
    prompt:     opts.prompt,
    width:      1024,
    height:     1024,
    seed:       null,
    size_bytes: bytes.byteLength,
  };
}

/**
 * Render an image in memory without storing it. Used by the generate-and-pick
 * pipeline that produces N candidates → judges → stores only the winner.
 *
 *   opts.prompt           — required
 *   opts.model            — 'dall-e-3' (default) or alias from MODEL_REGISTRY
 *   opts.width / height   — pixels (Workers AI only; DALL-E always 1024)
 *   opts.negative_prompt  — Workers AI only
 *   opts.steps            — Workers AI only
 *   opts.seed             — Workers AI only
 *   opts.dalle_style      — 'natural' | 'vivid' (DALL-E 3 only, default 'natural')
 *   opts.dalle_quality    — 'standard' | 'hd' (DALL-E 3 only, default 'standard')
 *
 * Returns: { bytes, model, prompt, width, height, seed, size_bytes }
 */
export async function renderImage(env, opts) {
  if (!opts?.prompt) throw new Error('image-gateway: opts.prompt required');

  const modelAlias = opts.model || DEFAULT_MODEL;

  // OpenAI path — no Workers AI binding needed.
  if (OPENAI_MODELS.has(modelAlias)) {
    return renderImageOpenAI(env, { ...opts, model: modelAlias });
  }

  // Workers AI path.
  if (!env?.AI) throw new Error('image-gateway: env.AI binding missing — add `"ai": { "binding": "AI", "remote": true }` to wrangler.jsonc');

  const { alias, slug } = resolveModel(modelAlias);
  const width  = opts.width  || DEFAULT_WIDTH;
  const height = opts.height || DEFAULT_HEIGHT;

  const aiArgs = { prompt: opts.prompt, width, height };
  if (opts.negative_prompt)  aiArgs.negative_prompt = opts.negative_prompt;
  if (opts.steps != null)    aiArgs.num_steps      = opts.steps;
  if (opts.seed  != null)    aiArgs.seed           = opts.seed;

  const result = await env.AI.run(slug, aiArgs);
  const bytes  = await toBytes(result);

  return {
    bytes,
    model:      alias,
    prompt:     opts.prompt,
    width,
    height,
    seed:       opts.seed ?? null,
    size_bytes: bytes.byteLength,
  };
}

/**
 * Store raw image bytes in R2 and return the same-origin URL.
 */
export async function storeImageBytes(env, key, bytes, customMetadata = {}) {
  if (!env?.ASSETS) throw new Error('image-gateway: env.ASSETS binding missing — add an r2_buckets entry to wrangler.jsonc');
  if (!key)         throw new Error('image-gateway: key required');
  if (!bytes)       throw new Error('image-gateway: bytes required');

  await env.ASSETS.put(key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata,
  });
  const { assetsBase } = await import('./self-origin.js');
  const base = assetsBase(env);
  return `${base}/${key.replace(/^\/+/, '')}`;
}

/**
 * Convenience: render + store in one call. Kept for backward compatibility
 * with code paths that don't need candidate selection.
 *
 * Returns: { url, key, model, prompt, generated_at, size_bytes, width, height }
 */
export async function generateImage(env, opts) {
  if (!opts?.key) throw new Error('image-gateway: opts.key required');
  const r = await renderImage(env, opts);
  const url = await storeImageBytes(env, opts.key, r.bytes, {
    prompt:        opts.prompt.slice(0, 1500),
    model:         r.model,
    generated_at:  String(nowMs()),
    ...(opts.metadata || {}),
  });
  return {
    url,
    key:          opts.key,
    model:        r.model,
    prompt:       opts.prompt,
    generated_at: nowMs(),
    size_bytes:   r.size_bytes,
    width:        r.width,
    height:       r.height,
  };
}

// Reads an image back from R2 by key. Used by the /assets/* worker route to
// stream stored images to the browser. Returns null when the key isn't found.
export async function readImage(env, key) {
  if (!env?.ASSETS) throw new Error('image-gateway: env.ASSETS binding missing');
  const obj = await env.ASSETS.get(key);
  if (!obj) return null;
  return obj; // R2ObjectBody — caller streams body + reads metadata
}

export async function deleteImage(env, key) {
  if (!env?.ASSETS) throw new Error('image-gateway: env.ASSETS binding missing');
  await env.ASSETS.delete(key);
}

export const IMAGE_MODELS = Object.keys(MODEL_REGISTRY);
