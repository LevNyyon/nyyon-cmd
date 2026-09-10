// Blog featured-image handler — sits on top of the generic image-gateway and
// knows how to draft a Nyyon-brand prompt for a given blog post, generate the
// image, and persist the URL + prompt + model back to blog_posts.
//
// Callers (AEO cron, manual regenerate route, Nyo tool) all funnel through
// generateBlogFeaturedImage() — there is no other entry point for blog
// imagery, so the prompt template stays one place.

import { renderImage, storeImageBytes } from './image-gateway.js';
import { logEvent, readBlogPost, logWorkflowRun, readKnowledge, writeKnowledge } from './db.js';
import { callOpenAIText, callOpenAIVisionJson } from './openai.js';
import { now } from './util.js';

// How many candidates to render per blog. Vision judge picks the winner.
const CANDIDATES_PER_RUN = 3;

// ─── Nyyon visual style ────────────────────────────────────────────────────
// Deep navy space + electric blue/violet light physics. Each image uses light
// BEHAVIOR (refraction, diffusion, convergence, splitting, acceleration) as a
// cinematic metaphor for the article's argument. The light tells the story.
//
// Visual language: gpt-image-1, cinematic CGI, deep navy background, electric
// blue + violet light energy, volumetric, photorealistic light physics.
// A minimal scale/label bar is added at the bottom when it helps legibility.
//
// Approved direction (June 2026): user confirmed after iterating from pen-ink
// → Bauhaus → space/refraction. The "Noise → Signal" image locked the style.
const NYYON_STYLE_BLOCK = `Cinematic CGI render. Deep navy space background (very dark blue-black, #0B0F2E tone). Electric blue and violet light energy — volumetric, photorealistic light physics, high-end visual effects quality. No text overlays (except a minimal scale bar if described). No people, no faces, no hands, no body parts. No logos, no brand marks, no watermarks. No physical objects with brand associations (no phones, computers, buildings). Abstract light and energy only.`;

// Negative prompt for the Workers-AI (flux/sdxl) models — steers them away from
// the things the style block forbids. (Was referenced but never defined, which
// made every Workers-AI render throw "NEGATIVE is not defined".)
const NEGATIVE = 'text, words, letters, captions, watermark, logo, signature, brand marks, people, faces, hands, body parts, phones, computers, buildings, blurry, low quality, distorted, deformed, jpeg artifacts';

// ─── Brief drafter system prompt ──────────────────────────────────────────
// Given an article, the LLM picks HOW light behaves to embody the argument.
// Light behavior is the vocabulary: refraction, splitting, convergence,
// diffusion, focus, acceleration, interference, reflection, absorption.
const BRIEF_SYSTEM = `You design cinematic featured images for a premium AI marketing blog (Nyyon). The visual language is: deep navy space, electric blue and violet light energy, cinematic CGI, photorealistic light physics.

Your job: read the article's core argument, then describe a LIGHT BEHAVIOR SCENE that makes that argument VISIBLE. A reader glancing for 2 seconds should FEEL the concept.

Think in light metaphors:
- Refraction / prism → transformation, reinterpretation, splitting one thing into its components
- Convergence → multiple inputs unifying into one output, focus, synthesis
- Diffusion → noise, scatter, lack of direction, wasted energy
- Focused beam → precision, signal, direct path, clarity
- Splitting / divergence → choice, separation, two paths from one origin
- Acceleration / motion blur → speed, velocity, time compression
- Interference / wave overlap → conflict, resonance, two forces meeting
- Absorption → disappearance, simplification, hidden depth
- Cascading reflection → compounding, multiplication, exponential growth

Process silently:
1. What is the single core tension or transformation in this article?
2. Which light behavior maps to it most precisely?
3. How do I compose the scene so the metaphor is spatially clear — left to right, before/after, contrast, etc.?
4. What 2-word label pair (e.g. "Noise / Signal", "Old / New", "Scatter / Focus") would I put on a minimal scale bar at the bottom?

Output format — TWO parts separated by | :
SCENE: [max 40 words describing exactly what the viewer sees — light behavior, spatial arrangement, directionality]
LABEL: [left label] / [right label]

No style, color, or brand mentions in your output — those are appended.

Examples:

Article: "AI models that look the same but have completely different internal architectures"
SCENE: Two identical beams enter from the left. The top beam passes through an invisible surface and exits as one clean bright line. The bottom beam hits the same surface and scatters into dozens of dim crossing rays.
LABEL: Replicated / Rebuilt

Article: "Compounding marketing systems that grow faster over time"
SCENE: A single point of light on the far left emits one beam that splits at each reflection point, doubling each time, filling the right side of the frame with an expanding cascade of bright beams.
LABEL: Linear / Compound

Article: "How AI turns raw data noise into actionable decisions"
SCENE: Left side scattered diffuse electric blue light spreading in all directions. Center an invisible refractive surface. Right side all that scattered light bends into one sharp violet-white beam.
LABEL: Noise / Signal

Article: "Why most AI features fail to reach real users"
SCENE: A strong bright beam on the left loses intensity at each successive translucent barrier, arriving at the right edge as a faint diffuse glow — same origin, diminished output.
LABEL: Launched / Delivered`;

// The visual style lives in the editable nyyon-visual-style knowledge doc,
// seeded from the approved June-2026 direction on first read. BOTH the
// generator prompt and the vision judge read this one doc — previously the
// judge scored against a retired Bauhaus rubric while the generator produced
// navy cinematic CGI, so every candidate was judged against the wrong
// aesthetic. Editing the doc now changes both sides together.
async function getVisualStyle(env) {
  try {
    const doc = await readKnowledge(env, 'nyyon-visual-style');
    if (doc?.body?.trim()) return doc.body.trim();
    await writeKnowledge(env, {
      slug: 'nyyon-visual-style',
      title: 'Visual style — blog covers + figures (read by generator AND judge)',
      body: NYYON_STYLE_BLOCK,
    });
  } catch { /* fall through to the coded default */ }
  return NYYON_STYLE_BLOCK;
}

function composePrompt({ style, visualBrief, label }) {
  const labelBar = label
    ? ` At the very bottom: a thin white horizontal line spanning 70% of the width, small dot on far left labeled "${label.split('/')[0].trim()}" in clean white sans-serif caps, small dot on far right labeled "${label.split('/')[1].trim()}" in clean white sans-serif caps. Minimal, understated.`
    : '';
  return `${style || NYYON_STYLE_BLOCK} ${visualBrief}${labelBar}`;
}

// Returns { scene, label } — scene is the light behavior description,
// label is the "Left / Right" pair for the scale bar (may be null).
async function draftVisualBrief(env, { title, excerpt, tags }) {
  const prompt = [
    `Title: ${title}`,
    excerpt ? `Excerpt: ${excerpt}` : null,
    Array.isArray(tags) && tags.length ? `Tags: ${tags.slice(0, 4).join(', ')}` : null,
    '',
    'Draft the scene and label now.',
  ].filter(Boolean).join('\n');

  try {
    const raw = (await callOpenAIText(env, { system: BRIEF_SYSTEM, prompt })).trim();
    // Parse "SCENE: ... | LABEL: ..." or just treat the whole thing as scene.
    const sceneMatch = raw.match(/SCENE:\s*([\s\S]+?)(?:\nLABEL:|$)/i);
    const labelMatch = raw.match(/LABEL:\s*(.+)/i);
    const scene = (sceneMatch?.[1] || raw).trim().replace(/^["']|["']$/g, '');
    const label = labelMatch?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
    return { scene, label };
  } catch (e) {
    return {
      scene: `Scattered electric blue light on the left converges through an invisible refractive surface into a single focused beam on the right, embodying the transformation described in "${title}".`,
      label: null,
    };
  }
}

// Vision judge — ranks N candidate images against the Nyyon rubric and picks
// the winner. Cheap (one gpt-4o-mini call with low-detail images = a fraction
// of a cent). Returns `{ winner, scores, reasoning }` — winner is 1-based.
// Judge rubric is built from the SAME style doc the generator uses — the two
// can no longer contradict (previously this scored for a retired Bauhaus look).
const judgeSystem = (style) => `You evaluate AI-generated featured-image candidates for a premium B2B publication (Nyyon) and pick the best one for a specific article.

You will see N candidates. The target aesthetic, verbatim from the house style guide:

${style}

Score each 0-100:

- composition (0-35): Confident, intentional composition that fills the frame with visual weight and purpose. Elements should relate to each other deliberately. Random scatter = low. Deliberate tension and balance = high.
- topic_aptness (0-25): Does the image abstractly gesture at the article's core argument? Disconnected generic pattern = low.
- aesthetic_polish (0-25): How faithfully does the candidate execute the target aesthetic above — its materials, lighting, palette, and finish? Off-style execution (wrong medium, wrong palette, wrong rendering style) = low.
- brand_fit (0-10): Feels premium editorial and matches the style guide's palette and restrictions. Any stock-photo or generic AI look = 0.
- artifacts (0-5): NO unrequested text, labels, numbers, signatures, watermarks, faces, hands, or people. Any of those = 0.

Total = sum (max 100).

Output ONLY a JSON object:
{ "winner": <1-based index of best>, "scores": [{"composition":N,"topic_aptness":N,"aesthetic_polish":N,"brand_fit":N,"artifacts":N,"total":N}, ...], "reasoning": "<one short sentence about why the winner won>" }`;

async function judgeCandidates(env, { candidates, title, style }) {
  const prompt = `Article title: "${title}"\n\nThere are ${candidates.length} candidate images below in order. Score each, then pick the winner.`;
  const images = candidates.map((c) => c.bytes);
  return callOpenAIVisionJson(env, { system: judgeSystem(style || NYYON_STYLE_BLOCK), prompt, images });
}

// Workers don't have a global RNG seed control but Math.random() is fine for
// picking diverse Flux seeds. We use ints in the uint32 range — what Flux expects.
function randomSeed() {
  return Math.floor(Math.random() * 0xFFFFFFFF);
}

/**
 * Generate the featured image for a blog post and persist the URL back to
 * blog_posts. Idempotent: re-running overwrites the R2 object at the same
 * key (`blog/<slug>.png`) and updates the row.
 *
 *   env, { slug, title, excerpt, tags?, prompt_override?, model?, actor? }
 *
 * Returns the same payload as the gateway plus the slug.
 */
export async function generateBlogFeaturedImage(env, opts) {
  if (!opts?.slug)  throw new Error('blog-images: slug required');
  if (!opts?.title) throw new Error('blog-images: title required');

  const startedAt = now();
  // Operator can hand-craft a prompt to override the LLM brief drafter; that
  // path skips the OpenAI call entirely.
  let scene       = null;
  let label       = null;
  let prompt      = opts.prompt_override;
  const style     = await getVisualStyle(env);
  if (!prompt) {
    const brief = await draftVisualBrief(env, { title: opts.title, excerpt: opts.excerpt, tags: opts.tags });
    scene  = brief.scene;
    label  = brief.label;
    prompt = composePrompt({ style, visualBrief: scene, label });
  }
  const key = `blog/${opts.slug}.png`;
  const N   = opts.candidates || CANDIDATES_PER_RUN;

  try {
    // 1. Render N candidates. Default to the OpenAI generator only when a key is
    //    configured; otherwise fall back to Cloudflare Workers AI (flux-schnell),
    //    which needs no external key — so image regen works even with OPENAI_API_KEY
    //    unset (previously the no-arg call died on "OPENAI_API_KEY not set").
    const model = opts.model || (env.OPENAI_API_KEY ? 'gpt-image-1' : 'flux-schnell');
    const isDalle = ['dall-e-3', 'dall-e-2', 'gpt-image-1'].includes(model);
    let candidates;
    if (isDalle) {
      candidates = [];
      for (let i = 0; i < N; i++) {
        candidates.push(await renderImage(env, { prompt, model }));
      }
    } else {
      const seeds = Array.from({ length: N }, randomSeed);
      candidates = await Promise.all(seeds.map((seed) => renderImage(env, {
        prompt,
        model,
        width:  1280,
        height: 720,
        negative_prompt: NEGATIVE,
        steps: 4,
        seed,
      })));
    }

    // 2. Vision judge picks the winner. We fall through to candidate 0 if the
    //    judge errors so a flaky OpenAI call doesn't fail the whole run.
    let winnerIdx   = 0;
    let judgeReport = null;
    if (N > 1 && env.OPENAI_API_KEY) { // the vision judge needs OpenAI; skip it (use candidate 0) when unset
      try {
        judgeReport = await judgeCandidates(env, { candidates, title: opts.title, style });
        const idx = Number(judgeReport?.winner) - 1;
        if (Number.isFinite(idx) && idx >= 0 && idx < N) winnerIdx = idx;
      } catch (judgeErr) {
        judgeReport = { error: String(judgeErr?.message || judgeErr).slice(0, 300) };
      }
    }
    const winner = candidates[winnerIdx];

    // 3. Store only the winner. R2 caps total customMetadata headers at 2KB,
    //    so we keep this slim — the full prompt lives in blog_posts.featured_image_prompt.
    const generatedAt = now();
    const url = await storeImageBytes(env, key, winner.bytes, {
      brief:            (scene || '').slice(0, 300),
      model:            winner.model,
      seed:             String(winner.seed ?? ''),
      generated_at:     String(generatedAt),
      kind:             'blog_featured',
      slug:             opts.slug,
      candidates_total: String(N),
      judge_winner:     String(winnerIdx + 1),
    });

    // Cache-bust: the R2 key is content-addressed by slug (blog/<slug>.png), so a
    // regenerated cover reuses the exact same URL and the browser/CDN keeps
    // showing the OLD image ("I regenerated but can't see it"). Pin a version
    // query on the stored URL so a fresh render always renders fresh.
    const versionedUrl = `${url}${url.includes('?') ? '&' : '?'}v=${generatedAt}`;
    await env.DB.prepare(
      `UPDATE blog_posts
          SET featured_image_url          = ?,
              featured_image_prompt       = ?,
              featured_image_model        = ?,
              featured_image_generated_at = ?
        WHERE slug = ?`,
    ).bind(versionedUrl, prompt, winner.model, generatedAt, opts.slug).run();

    await logEvent(env, {
      kind:  'blog_image_generated',
      actor: opts.actor || 'system',
      payload: { slug: opts.slug, model: winner.model, size_bytes: winner.size_bytes, candidates_total: N, judge_winner: winnerIdx + 1 },
    });

    await logWorkflowRun(env, {
      workflow_slug:   'blog-featured-image',
      status:          'succeeded',
      trigger_kind:    opts.actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { slug: opts.slug, title: opts.title },
      output: {
        url,
        model: winner.model,
        size_bytes: winner.size_bytes,
        visual_brief: scene,
        candidates_total: N,
        judge_winner: winnerIdx + 1,
        judge_report: judgeReport,
      },
      started_at: startedAt,
    });

    return {
      url:          versionedUrl,
      key,
      model:        winner.model,
      prompt,
      generated_at: generatedAt,
      size_bytes:   winner.size_bytes,
      width:        winner.width,
      height:       winner.height,
      slug:         opts.slug,
      visual_brief: scene,
      candidates_total: N,
      judge_winner:     winnerIdx + 1,
      judge_report:     judgeReport,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    await logEvent(env, {
      kind:  'blog_image_failed',
      actor: opts.actor || 'system',
      payload: { slug: opts.slug, error: msg.slice(0, 300) },
    });
    await logWorkflowRun(env, {
      workflow_slug:   'blog-featured-image',
      status:          'failed',
      trigger_kind:    opts.actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { slug: opts.slug },
      error:           msg,
      started_at:      startedAt,
    });
    throw e;
  }
}

/**
 * Convenience: look up a blog post by slug and generate (or regenerate) its
 * featured image. Used by the manual ops button + Nyo tool.
 */
export async function regenerateBlogFeaturedImage(env, slug, { actor, prompt_override, model } = {}) {
  const post = await readBlogPost(env, slug);
  if (!post) throw new Error(`blog post not found: ${slug}`);
  let tags = post.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
  return generateBlogFeaturedImage(env, {
    slug,
    title:   post.title,
    excerpt: post.excerpt,
    tags,
    actor,
    prompt_override,
    model,
  });
}
