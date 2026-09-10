// The worker's own public origin, captured from the live request. Exists so
// asset URLs can default to THIS install's hostname instead of a hardcoded
// bucket URL: a clean deploy then serves its images through its own
// /assets/* routes with zero config, and ASSETS_BASE_URL (when set) still
// wins for CDN-backed serving.
// ponytail: cron-context calls before any fetch has landed fall back to a
// relative '/assets' base (fine for the in-app UI; publish flows are always
// request-driven, so webhook payloads get absolute URLs).

let origin = null;

export function noteSelfOrigin(requestUrl) {
  try { origin = new URL(requestUrl).origin; } catch { /* keep the last one */ }
}

export function assetsBase(env) {
  const configured = (env.ASSETS_BASE_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  return origin ? `${origin}/assets` : '/assets';
}

// The operator's PUBLIC WEBSITE base (where published articles live).
// WEBSITE_BASE_URL when set (db-first callers pass a resolved env; on the
// author's prod it is a secret), else this install's own origin — honest for
// preview links until a real site exists. Never someone else's domain.
export function siteBase(env) {
  const configured = (env?.WEBSITE_BASE_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  return origin || '';
}
