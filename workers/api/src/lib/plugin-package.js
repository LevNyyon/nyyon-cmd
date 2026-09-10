// Plugin packages — a folder of real files, zipped, unpacked into the one
// canonical manifest the rest of the system already understands.
//
// WHY BOTH FORMS EXIST
// The wire format is, and stays, a single JSON document: it checksums as one
// payload, survives any transport that carries text (including a chat
// message), and needs no archive reader on the receiving side. What it is
// terrible at is AUTHORING — tool source becomes a JSON-escaped string with no
// highlighting, no diff, no editor.
//
// So a package is the authoring form and JSON is the transport form. A .zip
// holding
//
//   manifest.json          — same shape, but code/body by FILE REFERENCE
//   tools/read_page.mjs    — real ESM, editable, diffable
//   knowledge/notes.md     — real markdown
//
// is unpacked here into the inline manifest and handed to the ordinary import
// pipeline. Nothing downstream knows or cares which form arrived.
//
// The zip reader is written out rather than pulled in: Workers have no zip
// support but DO have DecompressionStream('deflate-raw'), which is the only
// compression a normal zip (Finder "Compress", `zip -r`) uses. ~80 lines
// against a dependency in the security-critical import path is the right trade.

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u16 = (b, o) => dv(b).getUint16(o, true);
const u32 = (b, o) => dv(b).getUint32(o, true);

// Entries a plugin package may never carry: absolute paths, traversal, and the
// junk archivers add. A package is data, but its paths become lookups.
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const IGNORED = (name) => name.startsWith('__MACOSX/') || name.endsWith('/') || name.split('/').pop().startsWith('.');

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read a zip by walking its End Of Central Directory → central directory →
// local headers. Reading the central directory (rather than scanning for local
// headers) is what makes the entry list authoritative.
export async function readZip(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 22) throw new Error('not a zip file (too small)');
  // EOCD: scan back from the end for the signature (comment may follow it).
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66_000); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = u16(b, eocd + 10);
  let off = u32(b, eocd + 16);
  if (count > 500) throw new Error(`zip has ${count} entries — a plugin package should be a handful of files`);

  const files = {};
  for (let n = 0; n < count; n++) {
    if (u32(b, off) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = u16(b, off + 10);
    const compSize = u32(b, off + 20);
    const rawSize = u32(b, off + 24);
    const nameLen = u16(b, off + 28);
    const extraLen = u16(b, off + 30);
    const commentLen = u16(b, off + 32);
    const localOff = u32(b, off + 42);
    const name = new TextDecoder().decode(b.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;

    if (IGNORED(name)) continue;
    if (!SAFE_PATH.test(name)) throw new Error(`zip entry has an unsafe path: ${name}`);
    if (rawSize > 2_000_000) throw new Error(`zip entry too large: ${name}`);

    // Local header: its own variable-length fields sit before the data.
    if (u32(b, localOff) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const dataAt = localOff + 30 + u16(b, localOff + 26) + u16(b, localOff + 28);
    const comp = b.subarray(dataAt, dataAt + compSize);

    let bytes;
    if (method === 0) bytes = comp;                       // stored
    else if (method === 8) bytes = await inflateRaw(comp); // deflate
    else throw new Error(`unsupported compression in ${name} (method ${method})`);
    files[name] = new TextDecoder().decode(bytes);
  }
  return files;
}

// Turn a package's files into the canonical inline manifest.
//
// The packaged manifest.json is the SAME document, except a tool may carry
// `code_file` instead of `code`, and a knowledge doc `body_file` instead of
// `body`. Resolution happens here so validateManifest only ever sees one shape.
export function assembleManifest(files) {
  const raw = files['manifest.json'] ?? files['plugin.json'];
  if (!raw) throw new Error('package has no manifest.json at its root');
  let m;
  try { m = JSON.parse(raw); } catch (e) { throw new Error(`manifest.json is not valid JSON: ${String(e?.message || e)}`); }

  const read = (ref, what) => {
    const body = files[ref];
    if (body === undefined) {
      const have = Object.keys(files).filter((f) => f !== 'manifest.json').join(', ') || 'nothing else';
      throw new Error(`${what} points at "${ref}", which the package does not contain (it has: ${have})`);
    }
    return body;
  };

  for (const t of (Array.isArray(m?.provides?.tools) ? m.provides.tools : [])) {
    if (t?.code_file) { t.code = read(t.code_file, `tool ${t.name}`); delete t.code_file; }
  }
  for (const g of (Array.isArray(m?.provides?.gateways) ? m.provides.gateways : [])) {
    if (g?.code_file) { g.code = read(g.code_file, `gateway ${g.slug}`); delete g.code_file; }
  }
  for (const k of (Array.isArray(m?.provides?.knowledge) ? m.provides.knowledge : [])) {
    if (k?.body_file) { k.body = read(k.body_file, `knowledge ${k.slug}`); delete k.body_file; }
  }
  for (const lf of (Array.isArray(m?.lib) ? m.lib : [])) {
    if (lf?.code_file) { lf.code = read(lf.code_file, `lib ${lf.path}`); delete lf.code_file; }
  }
  for (const sf of (Array.isArray(m?.provides?.surfaces) ? m.provides.surfaces : [])) {
    if (sf?.page_file) { sf.page_code = read(sf.page_file, `surface ${sf.slug}`); delete sf.page_file; }
    for (const f of (Array.isArray(sf?.files) ? sf.files : [])) {
      if (f?.code_file) { f.code = read(f.code_file, `surface file ${f.path}`); delete f.code_file; }
    }
  }
  return m;
}

// One call for the route: bytes in, canonical manifest out. The checksum is
// deliberately RECOMPUTED over the assembled document rather than trusted from
// the package, because the package's own bytes are not what gets installed.
export async function manifestFromZip(buf) {
  const files = await readZip(buf);
  const manifest = assembleManifest(files);
  const { sha256Hex, manifestPayload } = await import('./plugins.js');
  manifest.sha256 = await sha256Hex(manifestPayload(manifest));
  return manifest;
}

// ─── writing a package ───────────────────────────────────────────
//
// Export produces the folder shape, not the inline blob: real .mjs and .md the
// operator can open, edit and diff. Entries are STORED (no compression) —
// plugin sources are small, every unzip tool reads stored entries, and it means
// no compressor in the export path.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function writeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (arr) => { chunks.push(arr); offset += arr.length; };

  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameB.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(8, 0, true);           // method: stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);

    const localOffset = offset;
    push(local);
    push(data);

    const cen = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);          // method: stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, localOffset, true);
    cen.set(nameB, 46);
    central.push(cen);
  }

  const cdStart = offset;
  for (const c of central) push(c);
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  push(eocd);

  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// The inverse of assembleManifest: inline manifest -> folder-shaped files.
export function packageFiles(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  const files = {};
  const arr = (v) => (Array.isArray(v) ? v : []);

  for (const t of arr(m?.provides?.tools)) {
    if (typeof t?.code === 'string') {
      const ref = `tools/${t.name}.mjs`;
      files[ref] = t.code;
      t.code_file = ref;
      delete t.code;
    }
  }
  for (const g of arr(m?.provides?.gateways)) {
    if (typeof g?.code === 'string') {
      const ref = `gateways/${g.slug}.mjs`;
      files[ref] = g.code;
      g.code_file = ref;
      delete g.code;
    }
  }
  for (const k of arr(m?.provides?.knowledge)) {
    if (typeof k?.body === 'string') {
      const ref = `knowledge/${k.slug}.md`;
      files[ref] = k.body;
      k.body_file = ref;
      delete k.body;
    }
  }
  for (const lf of arr(m?.lib)) {
    if (typeof lf?.code === 'string') {
      const ref = `lib/${lf.path}`;
      files[ref] = lf.code;
      lf.code_file = ref;
      delete lf.code;
    }
  }
  for (const sf of arr(m?.provides?.surfaces)) {
    if (typeof sf?.page_code === 'string') {
      const ref = `surface/${sf.slug}.tsx`;
      files[ref] = sf.page_code;
      sf.page_file = ref;
      delete sf.page_code;
    }
    for (const f of arr(sf?.files)) {
      if (typeof f?.code === 'string') {
        const ref = `surface/${f.path}`;
        files[ref] = f.code;
        f.code_file = ref;
        delete f.code;
      }
    }
  }
  // The checksum describes the ASSEMBLED document, which this file no longer
  // is. Drop it here; import recomputes it after reassembly.
  delete m.sha256;
  files['manifest.json'] = JSON.stringify(m, null, 2) + '\n';
  return files;
}

// ─── fetching a package from a source URL ────────────────────────
//
// The primary import path, and the reason it beats both paste and a local zip:
// a URL is a SOURCE. It carries a version, it can be re-fetched when the author
// fixes something, and you can go read who wrote it before you trust it. A zip
// on your desktop answers none of those — if the author ships a fix you have no
// way to hear about it.
//
// Accepted:
//   https://github.com/owner/repo            → that repo's default branch
//   https://github.com/owner/repo/tree/v2    → a tag/branch/commit
//   https://…/anything.zip                   → a package archive
//   https://…/manifest.json                  → a bare manifest
//
// Everything goes out through the `web` gateway: a lib must not open its own
// socket, and routing it there keeps one place responsible for egress.

const GH = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?\/?$/;

// Where a source URL's bytes actually live, plus the identity to record.
export function resolveSource(url, ref) {
  const raw = String(url || '').trim();
  if (!/^https:\/\//i.test(raw)) throw new Error('a plugin source must be an https URL');
  const gh = raw.match(GH);
  if (gh) {
    const [, owner, repo, treeRef] = gh;
    const at = ref || treeRef || 'HEAD';
    return {
      kind: 'zip',
      fetch_url: `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(at)}`,
      origin: { source_url: `https://github.com/${owner}/${repo}`, ref: at },
    };
  }
  if (/\.zip($|\?)/i.test(raw)) return { kind: 'zip', fetch_url: raw, origin: { source_url: raw, ref: ref || null } };
  if (/\.json($|\?)/i.test(raw)) return { kind: 'json', fetch_url: raw, origin: { source_url: raw, ref: ref || null } };
  throw new Error('unrecognised source — give a GitHub repo URL, or a link ending in .zip or .json');
}

// A GitHub zipball nests everything under "repo-ref/". Strip exactly one
// leading directory when every entry shares it, so the same manifest lookup
// works whether the archive was made by GitHub or by `zip -r`.
function stripRoot(files) {
  const names = Object.keys(files);
  if (!names.length) return files;
  const first = names[0].split('/')[0];
  if (!names.every((n) => n.startsWith(first + '/'))) return files;
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k.slice(first.length + 1)] = v;
  return out;
}

export async function manifestFromUrl(env, url, ref) {
  const src = resolveSource(url, ref);
  const { callGateway } = await import('../gateways/index.js');

  if (src.kind === 'json') {
    const r = await callGateway(env, 'web', 'text', { url: src.fetch_url, max_bytes: 5_000_000 });
    if (!r?.ok) throw new Error(`could not fetch ${src.fetch_url} (HTTP ${r?.status ?? '?'})`);
    let m;
    try { m = JSON.parse(r.text); } catch (e) { throw new Error(`that URL did not return JSON: ${String(e?.message || e)}`); }
    m.origin = { ...(m.origin || {}), ...src.origin, fetched_at: Date.now() };
    const { sha256Hex, manifestPayload } = await import('./plugins.js');
    m.sha256 = await sha256Hex(manifestPayload(m));
    return m;
  }

  const r = await callGateway(env, 'web', 'bytes', { url: src.fetch_url, max_bytes: 5_000_000 });
  if (!r?.ok || !r.bytes) throw new Error(`could not fetch ${src.fetch_url} (HTTP ${r?.status ?? '?'})`);
  const files = stripRoot(await readZip(r.bytes));
  const manifest = assembleManifest(files);
  manifest.origin = { ...(manifest.origin || {}), ...src.origin, fetched_at: Date.now() };
  const { sha256Hex, manifestPayload } = await import('./plugins.js');
  manifest.sha256 = await sha256Hex(manifestPayload(manifest));
  return manifest;
}
