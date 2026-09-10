// nyyon-blog-edge — incremental blog publishing for nyyon.com.
//
// Routes (zone nyyon.com):  /blog*  and  /sitemap.xml
//
// The static site (CF Pages project nyyon-lp) stays exactly as deployed; this
// worker only ADDS the ability for a post to go live the moment its
// `published` flag flips in D1 — no site rebuild, no wrangler deploy.
//
//   /blog/<slug>/   legacy slug (in the static build)   → passthrough to Pages
//                   new slug, published in D1           → rendered here from D1
//                   unknown slug                        → passthrough (as today)
//   /blog/          hub rendered from D1 (so new posts get internal links)
//   /sitemap.xml    rendered from D1 (so new posts get sitemap entries)
//
// Fail-safe: ANY error → transparent passthrough to the Pages origin, i.e.
// the failure mode is "today's site," never a broken page. Rollback = remove
// the routes.
//
// Templates are generated verbatim from a crawl of the live site
// (scripts/gen-template.mjs). The SPA module <script> is deliberately absent
// from rendered pages: the live bundle uses createRoot (not hydrateRoot) and
// replaces #root from the STATIC snapshot JSON — a new post isn't in that
// snapshot, so keeping the script would blank the article into a 404.

import { POST_TEMPLATE, HUB_TEMPLATE, FALLBACK_CSS, FALLBACK_JS } from './template.js';
import { LEGACY_SLUGS } from './legacy-slugs.js';

const PAGES_ORIGIN = 'https://nyyon-lp.pages.dev';
const SITE = 'https://nyyon.com';
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// JSON-LD embeds in <script>; only escape < so nothing can break out.
const escapeJsonLd = (s) => String(s).replace(/</g, '\\u003c');
// Operator's standing rule (applied at snapshot time in the static pipeline):
// no em/en dashes anywhere on the public site. D1 bodies may still carry them.
const noDashes = (s) => (s == null ? s : String(s).replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, '-'));
const stripHtml = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const iso = (ms) => new Date(ms).toISOString();

// The CSS + JS bundle hashes change on every Pages redeploy of the full site.
// Resolve the current pair from the live hub at most hourly; fall back to the
// hashes captured at template-generation time.
let assetCache = { css: FALLBACK_CSS, js: FALLBACK_JS, ts: 0 };
async function currentAssets() {
  if (Date.now() - assetCache.ts < 3_600_000) return assetCache;
  try {
    const res = await fetch(`${PAGES_ORIGIN}/blog/`, { cf: { cacheTtl: 300 } });
    const html = await res.text();
    const css = html.match(/\/assets\/index-[\w-]+\.css/);
    const js = html.match(/\/assets\/index-[\w-]+\.js/);
    if (css && js) assetCache = { css: css[0], js: js[0], ts: Date.now() };
  } catch { /* keep fallbacks */ }
  assetCache.ts = Date.now();
  return assetCache;
}

function passthrough(request, url) {
  return fetch(`${PAGES_ORIGIN}${url.pathname}${url.search}`, request);
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'x-nyyon-blog-edge': 'render',
};

// ---------- renderers ----------

async function renderPost(env, slug) {
  const row = await env.DB.prepare(
    'SELECT slug, title, excerpt, body, published_at, updated_at, featured_image_url FROM blog_posts WHERE slug = ?1 AND published = 1'
  ).bind(slug).first();
  if (!row) return null;

  const title = noDashes(row.title || row.slug);
  const body = noDashes(row.body || '');
  const excerpt = noDashes(
    (row.excerpt || stripHtml(row.body).slice(0, 200) || `Read ${title} on the Nyyon blog.`).trim()
  );
  const url = `${SITE}/blog/${row.slug}/`;
  const cover = row.featured_image_url || `${SITE}/assets/og-image.png`;
  const pub = row.published_at ? iso(row.published_at) : iso(Date.now());

  const articleJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: excerpt,
    datePublished: pub,
    dateModified: row.updated_at ? iso(row.updated_at) : pub,
    author: { '@type': 'Organization', name: 'Nyyon', url: SITE },
    publisher: {
      '@type': 'Organization',
      name: 'Nyyon',
      logo: { '@type': 'ImageObject', url: `${SITE}/assets/nyyon-logo-dark.svg` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    image: cover,
  });

  const assets = await currentAssets();
  const html = POST_TEMPLATE
    .replaceAll('{{CSS_HREF}}', assets.css)
    .replaceAll('{{JS_HREF}}', assets.js)
    .replaceAll('{{ARTICLE_JSONLD}}', `<script type="application/ld+json">${escapeJsonLd(articleJsonLd)}</script>`)
    .replaceAll('{{TITLE}}', escapeHtml(title))
    .replaceAll('{{DESCRIPTION}}', escapeHtml(excerpt))
    .replaceAll('{{SLUG}}', row.slug)
    .replaceAll('{{COVER}}', cover)
    .replaceAll('{{BODY}}', body);

  return new Response(html, { headers: HTML_HEADERS });
}

async function listPublished(env) {
  const { results } = await env.DB.prepare(
    'SELECT slug, title, excerpt, published_at, updated_at FROM blog_posts WHERE published = 1 ORDER BY COALESCE(published_at, updated_at) DESC'
  ).all();
  return results || [];
}

async function renderHub(env) {
  const posts = await listPublished(env);

  const cards = posts.map((p) => {
    const title = escapeHtml(noDashes(p.title || p.slug));
    const excerpt = escapeHtml(noDashes((p.excerpt || '').trim()));
    return `    <li style="margin:0 0 28px;padding:0 0 28px;border-bottom:1px solid #ececec">
      <a href="/blog/${p.slug}/" style="color:#1a1a1c;text-decoration:none;font-size:20px;font-weight:500;letter-spacing:-0.01em;line-height:1.3">${title}</a>
      <p style="font-size:15px;color:#555;margin:8px 0 0;line-height:1.5">${excerpt}</p>
    </li>`;
  }).join('\n');

  const collectionJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Blog · Nyyon',
    url: `${SITE}/blog/`,
    description: 'Field notes from operators in the arena: actionable systems, real breakdowns, and practical guidance for teams putting AI to work.',
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${SITE}/blog/${p.slug}/`,
        name: noDashes(p.title || p.slug),
      })),
    },
  });

  const assets = await currentAssets();
  const html = HUB_TEMPLATE
    .replaceAll('{{CSS_HREF}}', assets.css)
    .replaceAll('{{JS_HREF}}', assets.js)
    .replaceAll('{{COLLECTION_JSONLD}}', `<script type="application/ld+json">${escapeJsonLd(collectionJsonLd)}</script>`)
    .replaceAll('{{CARDS}}', cards);

  return new Response(html, { headers: HTML_HEADERS });
}

async function renderSitemap(env) {
  const posts = await listPublished(env);
  const today = new Date().toISOString().slice(0, 10);
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : today);

  const entry = (loc, lastmod, priority, changefreq) =>
    `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const entries = [
    entry(`${SITE}/`, today, '1.0', 'daily'),
    entry(`${SITE}/blog/`, today, '0.9', 'daily'),
    entry(`${SITE}/nyyon-vs-traditional-agency`, today, '0.8', 'monthly'),
    entry(`${SITE}/resources`, today, '0.6', 'monthly'),
    entry(`${SITE}/resources/product-hunt-organic-playbook`, today, '0.7', 'monthly'),
    entry(`${SITE}/legal/`, today, '0.3', 'yearly'),
    ...posts.map((p) => entry(`${SITE}/blog/${p.slug}/`, day(p.updated_at || p.published_at), '0.7', 'monthly')),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-nyyon-blog-edge': 'render',
    },
  });
}

// The React app looks posts up in /snapshot/posts.json — a STATIC file baked
// at build time. If a post is missing from it, BlogPost.tsx renders "Article
// not found" over the server HTML (createRoot replaces #root). So the worker
// serves this path as the static snapshot MERGED with D1: React finds new
// posts and renders them with the full site chrome, identically to legacy
// posts. This is what makes keeping the SPA script safe.
async function renderSnapshot(env) {
  let posts = [];
  try {
    const res = await fetch(`${PAGES_ORIGIN}/snapshot/posts.json`, { cf: { cacheTtl: 300 } });
    if (res.ok) posts = (await res.json()).posts || [];
  } catch { /* fall through to D1-only */ }

  const bySlug = new Map(posts.map((p) => [p.slug, p]));
  const { results } = await env.DB.prepare(
    'SELECT slug, title, excerpt, body, tags, published_at, published, updated_at, updated_by, featured_image_url, featured_image_prompt, featured_image_model, featured_image_generated_at FROM blog_posts WHERE published = 1'
  ).all();
  for (const row of results || []) {
    const existing = bySlug.get(row.slug);
    if (!existing || (row.updated_at || 0) > (existing.updated_at || 0)) {
      bySlug.set(row.slug, {
        ...row,
        title: noDashes(row.title),
        excerpt: noDashes(row.excerpt),
        body: noDashes(row.body),
      });
    }
  }
  const merged = [...bySlug.values()].sort(
    (a, b) => (b.published_at || b.updated_at || 0) - (a.published_at || a.updated_at || 0)
  );

  return new Response(JSON.stringify({ posts: merged }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
      'x-nyyon-blog-edge': 'render',
    },
  });
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/sitemap.xml') return await renderSitemap(env);
      if (url.pathname === '/snapshot/posts.json') return await renderSnapshot(env);
      if (url.pathname === '/blog' || url.pathname === '/blog/') return await renderHub(env);

      const m = url.pathname.match(/^\/blog\/([^/]+)(\/?)$/);
      if (m) {
        const slug = decodeURIComponent(m[1]);
        if (!SLUG_RE.test(slug)) return passthrough(request, url);
        // Legacy posts stay byte-identical to the static build (incl. SPA chrome).
        if (LEGACY_SLUGS.has(slug)) return passthrough(request, url);
        if (!m[2]) {
          // Canonical form has a trailing slash — match static-site behavior.
          return Response.redirect(`${SITE}/blog/${slug}/`, 301);
        }
        const rendered = await renderPost(env, slug);
        return rendered || passthrough(request, url);
      }

      return passthrough(request, url);
    } catch (err) {
      // Fail open: degrade to exactly what the static site serves today.
      console.error('blog-edge error, passing through:', err && err.message);
      return passthrough(request, url);
    }
  },
};
