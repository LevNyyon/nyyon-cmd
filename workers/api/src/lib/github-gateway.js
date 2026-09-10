// GitHub contents-API gateway — the boundary to ONE external service (GitHub).
//
// Exists for the Plugins module's cloud materializer: cmd is a deployed
// Worker, so "write the plugin's code files" means "commit them to the repo
// and let CI redeploy" (the .github/workflows/deploy.yml push-to-main
// pipeline). This file does NO reasoning — it is a mechanical wrapper over
// PUT/GET/DELETE /repos/{repo}/contents/{path}, registered as the `github`
// gateway in gateways/index.js.
//
// Config: PLUGINS_GH_REPO (var, owner/name) + PLUGINS_GH_TOKEN (secret, a
// fine-grained token with Contents read/write on that one repo). Branch is
// always main — that is the branch CI deploys.

const API = 'https://api.github.com';
const BRANCH = 'main';

export function ghConfigured(env) {
  return !!(env.PLUGINS_GH_TOKEN && env.PLUGINS_GH_REPO);
}

function headers(env) {
  return {
    Authorization: `Bearer ${env.PLUGINS_GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nyyon-cmd-plugins',
    'Content-Type': 'application/json',
  };
}

// btoa chokes on non-latin1; base64 the UTF-8 bytes chunk-wise instead.
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function gh(env, method, path, body = null) {
  const res = await fetch(`${API}/repos/${env.PLUGINS_GH_REPO}/${path}`, {
    method,
    headers: headers(env),
    body: body ? JSON.stringify(body) : undefined,
  });
  // A 404 is an ANSWER on a read ("that file is not there") and a FAILURE on a
  // write (wrong repo, a token without Contents access, a missing branch).
  // Swallowing it for every method made ghPutFile/ghDeleteFile report a commit
  // that never happened, and the Plugins module then flipped rows to
  // "materialized" for code that was never on main.
  if (res.status === 404 && method === 'GET') return { status: 404, data: null };
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`github ${method} ${path}: ${res.status} ${data?.message || ''}`.trim());
  return { status: res.status, data };
}

// { exists, sha } for one repo file (content itself is not needed by callers).
export async function ghGetFile(env, path) {
  const r = await gh(env, 'GET', `contents/${path}?ref=${BRANCH}`);
  if (r.status === 404 || Array.isArray(r.data)) return { exists: false, sha: null };
  return { exists: true, sha: r.data?.sha || null };
}

// Files in one repo directory: [{ path, sha }]. Empty when the dir is absent.
export async function ghListDir(env, path) {
  const r = await gh(env, 'GET', `contents/${path}?ref=${BRANCH}`);
  if (r.status === 404 || !Array.isArray(r.data)) return { files: [] };
  return { files: r.data.filter((e) => e.type === 'file').map((e) => ({ path: e.path, sha: e.sha })) };
}

// Create or update one file on main. The contents API 409s an update without
// the current blob sha, so fetch it first (mechanical, not a decision).
//
// The commit sha is ASSERTED, not merely reported: the only evidence a write
// landed is GitHub naming the commit it made. A response without one is a
// failure, and the caller must hear about it rather than record a materialized
// plugin whose code is not on main.
export async function ghPutFile(env, { path, content, message }) {
  const { sha } = await ghGetFile(env, path);
  const body = { message, content: b64utf8(String(content)), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await gh(env, 'PUT', `contents/${path}`, body);
  const commit = r.data?.commit?.sha || null;
  if (!commit) throw new Error(`github PUT contents/${path}: ${r.status} with no commit sha — the write did not land`);
  return { ok: true, path, commit };
}

// Delete one file on main (no-op when it is already gone).
export async function ghDeleteFile(env, { path, message }) {
  const { exists, sha } = await ghGetFile(env, path);
  if (!exists) return { ok: true, path, skipped: 'absent' };
  const r = await gh(env, 'DELETE', `contents/${path}`, { message, sha, branch: BRANCH });
  const commit = r.data?.commit?.sha || null;
  if (!commit) throw new Error(`github DELETE contents/${path}: ${r.status} with no commit sha — the delete did not land`);
  return { ok: true, path, commit };
}
