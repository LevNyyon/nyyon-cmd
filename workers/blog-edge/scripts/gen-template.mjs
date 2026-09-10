// gen-template.mjs — generate the blog-edge worker's HTML templates from a
// faithful crawl of the LIVE site (~/Dev/nyyon-com-live-mirror), so worker-
// rendered pages are verbatim-identical to what nyyon.com serves today.
//
// Outputs:
//   src/template.js      — POST_TEMPLATE, HUB_TEMPLATE, FALLBACK_CSS
//   src/legacy-slugs.js  — LEGACY_SLUGS (posts that exist in the static build
//                          and should be passed through, not rendered)
//
// Re-run after any full-site redeploy of nyyon-lp (asset hashes change):
//   node scripts/gen-template.mjs [path-to-live-mirror]
//
// Every substitution is asserted; the script exits non-zero if the live HTML
// shape drifts from what the worker expects.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIRROR = process.argv[2] || `${process.env.HOME}/Dev/nyyon-com-live-mirror`;
const OUT = new URL('../src/', import.meta.url).pathname;

// The template donor: a recent, known-good prerendered post.
const DONOR_SLUG = 'roleplay-calibration-loop-train-agent-to-teach-itself';
// Legacy post whose live prerender is broken (contains the homepage shell,
// not the article) — excluded from passthrough so the worker renders it from D1.
const BROKEN_LEGACY = ['what-is-a-marketing-data-spine'];

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function assertOnce(haystack, needle, what) {
  const n = haystack.split(needle).length - 1;
  if (n < 1) fail(`${what}: expected at least 1 occurrence, found 0`);
  return n;
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- POST template ----------
const postPath = join(MIRROR, 'blog', DONOR_SLUG, 'index.html');
let post = readFileSync(postPath, 'utf-8');

// 1. Find + parse the Article JSON-LD (the block with "@type":"Article").
const ldBlocks = [...post.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
const articleBlock = ldBlocks.find((m) => m[1].includes('"@type":"Article"'));
if (!articleBlock) fail('no Article JSON-LD found in donor post');
const article = JSON.parse(articleBlock[1].replaceAll('\\u003c', '<'));
const TITLE = article.headline;
const EXCERPT = article.description;
const COVER = article.image;
if (!article.url.endsWith(`/blog/${DONOR_SLUG}/`)) fail('donor JSON-LD url does not match donor slug');

// 2. Replace the whole Article JSON-LD script with a placeholder.
post = post.replace(articleBlock[0], '{{ARTICLE_JSONLD}}');

// 3. KEEP the SPA module script — the site's header/nav/footer are rendered
//    by React after load; stripping the script strips the chrome (the 2026-07-09
//    incident). The 404-wipe hazard (React can't find a new post in the static
//    snapshot) is solved by the worker also serving a D1-merged
//    /snapshot/posts.json. Parameterize the hashed src like the CSS.
const moduleRe = /<script type="module"[^>]*src="(\/assets\/index-[\w-]+\.js)"><\/script>/;
const jsMatch = post.match(moduleRe);
if (!jsMatch) fail('SPA module script not found in donor post');
const FALLBACK_JS = jsMatch[1];
post = post.replaceAll(FALLBACK_JS, '{{JS_HREF}}');

// 4. Strip the Cloudflare RUM beacon (edge-injected on every response; keeping
//    it in the template would double-inject).
post = post.replace(/\s*<script[^>]*static\.cloudflareinsights\.com[^>]*>\s*<\/script>/g, '');

// 5. Parameterize the stylesheet href (hash changes on every Pages redeploy).
const cssMatch = post.match(/\/assets\/index-[\w-]+\.css/);
if (!cssMatch) fail('stylesheet href not found');
const FALLBACK_CSS = cssMatch[0];
post = post.replaceAll(FALLBACK_CSS, '{{CSS_HREF}}');

// 6. Cut the article body out of <div class="prose-body">…</div> (the close
//    is immediately before <aside).
const bodyOpen = post.indexOf('<div class="prose-body">');
if (bodyOpen < 0) fail('prose-body div not found');
const asideIdx = post.indexOf('<aside', bodyOpen);
if (asideIdx < 0) fail('aside CTA not found after prose-body');
const bodyCloseIdx = post.lastIndexOf('</div>', asideIdx);
if (bodyCloseIdx <= bodyOpen) fail('prose-body close not found');
post = post.slice(0, bodyOpen) + '<div class="prose-body">{{BODY}}</div>' +
       post.slice(bodyCloseIdx + '</div>'.length);

// 7. Parameterize title / excerpt (escaped + raw forms), slug, cover.
for (const [value, ph] of [[TITLE, '{{TITLE}}'], [EXCERPT, '{{DESCRIPTION}}']]) {
  const esc = escapeHtml(value);
  assertOnce(post, esc === value ? value : esc, ph);
  if (esc !== value) post = post.replaceAll(esc, ph);
  post = post.replaceAll(value, ph);
}
// Cover BEFORE slug — the cover URL contains the slug.
assertOnce(post, COVER, '{{COVER}}');
post = post.replaceAll(COVER, '{{COVER}}');
assertOnce(post, DONOR_SLUG, '{{SLUG}}');
post = post.replaceAll(DONOR_SLUG, '{{SLUG}}');

for (const ph of ['{{ARTICLE_JSONLD}}', '{{CSS_HREF}}', '{{JS_HREF}}', '{{BODY}}', '{{TITLE}}', '{{DESCRIPTION}}', '{{SLUG}}', '{{COVER}}'])
  assertOnce(post, ph, `post template ${ph}`);
if (post.includes('roleplay-calibration')) fail('donor slug leaked into post template');

// ---------- HUB template ----------
let hub = readFileSync(join(MIRROR, 'blog', 'index.html'), 'utf-8');

const hubLd = [...hub.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .find((m) => m[1].includes('"@type":"CollectionPage"'));
if (!hubLd) fail('no CollectionPage JSON-LD found in hub');
hub = hub.replace(hubLd[0], '{{COLLECTION_JSONLD}}');

if (!moduleRe.test(hub)) fail('SPA module script not found in hub');
hub = hub.replaceAll(FALLBACK_JS, '{{JS_HREF}}');
hub = hub.replace(/\s*<script[^>]*static\.cloudflareinsights\.com[^>]*>\s*<\/script>/g, '');
hub = hub.replaceAll(FALLBACK_CSS, '{{CSS_HREF}}');

const ulOpen = '<ul style="list-style:none;padding:0;margin:0">';
const ulStart = hub.indexOf(ulOpen);
if (ulStart < 0) fail('hub card <ul> not found');
const ulEnd = hub.indexOf('</ul>', ulStart);
if (ulEnd < 0) fail('hub card </ul> not found');
hub = hub.slice(0, ulStart + ulOpen.length) + '\n{{CARDS}}\n    ' + hub.slice(ulEnd);

for (const ph of ['{{COLLECTION_JSONLD}}', '{{CSS_HREF}}', '{{JS_HREF}}', '{{CARDS}}'])
  assertOnce(hub, ph, `hub template ${ph}`);

// ---------- legacy slug list ----------
const blogDir = join(MIRROR, 'blog');
const legacy = readdirSync(blogDir)
  .filter((n) => statSync(join(blogDir, n)).isDirectory())
  .filter((n) => !BROKEN_LEGACY.includes(n))
  .sort();
if (legacy.length < 190) fail(`legacy slug list suspiciously small: ${legacy.length}`);

// ---------- write outputs ----------
writeFileSync(join(OUT, 'template.js'),
`// GENERATED by scripts/gen-template.mjs from the live-site mirror — do not edit by hand.
// Donor post: ${DONOR_SLUG} (crawled from live nyyon.com).
export const POST_TEMPLATE = ${JSON.stringify(post)};
export const HUB_TEMPLATE = ${JSON.stringify(hub)};
export const FALLBACK_CSS = ${JSON.stringify(FALLBACK_CSS)};
export const FALLBACK_JS = ${JSON.stringify(FALLBACK_JS)};
`);
writeFileSync(join(OUT, 'legacy-slugs.js'),
`// GENERATED by scripts/gen-template.mjs — slugs present in the static build,
// served by passthrough. Excluded (broken live prerender, worker renders them):
// ${BROKEN_LEGACY.join(', ')}
export const LEGACY_SLUGS = new Set(${JSON.stringify(legacy, null, 0)});
`);

console.log(`✓ POST_TEMPLATE  (${post.length} bytes, donor: ${DONOR_SLUG})`);
console.log(`✓ HUB_TEMPLATE   (${hub.length} bytes)`);
console.log(`✓ FALLBACK_CSS   ${FALLBACK_CSS}`);
console.log(`✓ LEGACY_SLUGS   ${legacy.length} slugs (excluded broken: ${BROKEN_LEGACY.join(', ')})`);
