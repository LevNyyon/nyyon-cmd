// GTM module — gtm-blackbox (GTM Builder) folded into the command center.
// This lib is the intake + identity-enrichment layer: lead store, phone-list
// import, and the per-lead enrichment chain (accuracy order):
//   locate (at import) → company-from-LinkedIn → PDL → Twilio → Google
// PDL / SerpApi / Twilio are direct SaaS calls behind optional keys — every
// caller degrades to { skipped: 'not configured' } when a key is missing.
// The old WhatsApp-identity leg (daemon contact lookup) was removed with the
// daemon; the manual fallback is the per-row Truecaller link + inline edit.
//
// Provenance model (ported): leads.sources = {field:{tool,at}}; disagreements
// append to leads.conflicts instead of overwriting; removed social links are
// tombstoned in leads.dismissed so searches never re-add them.

import { logEvent } from './db.js';
import { bumpUsage, cacheQuota, pdlQuotaFromHeaders } from './gtm-usage.js';
import { callOpenAIText } from './openai.js';
import { locatePhone, truecallerUrl, normalizePhone, parsePhoneList } from './gtm-phone.js';
import { fetchText as webFetchText, fetchBytes as webFetchBytes } from './web-gateway.js';

const now = () => Date.now();
const gid = (p) => `${p}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const eqCI = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ── lead store (the only way anything touches gtm_leads) ────────────────────

const LEAD_COLS = new Set([
  'phone', 'normalized_phone', 'status', 'source', 'batch_id', 'country', 'region',
  'name', 'photo', 'socials', 'linkedin', 'email', 'company', 'position',
  'line_type', 'carrier', 'sources', 'conflicts', 'dismissed', 'active_tool',
  'org_status', 'org_note', 'theorg_slug', 'icp_fit', 'icp_reasons',
  'company_li_id', 'open_positions', 'positions_checked_at', 'outreach_lang', 'client_id',
  'steps',
  'company_staff_count', 'company_context', 'company_checked_at',
  'watch', 'watch_started_at', 'watch_checked_at', 'headline_snapshot',
]);

// ── the enrichment chain, as data ────────────────────────────────────────────
// The six steps enrichFullOne runs, in order, each with the predicate that
// decides whether a call that RAN actually found anything. `label` travels with
// the persisted record so a surface renders what the chain reports rather than
// keeping its own copy of the step list.
const ENRICH_STEPS = [
  { key: 'li',      label: 'LinkedIn', found: (r) => !!r.company },
  { key: 'pdl',     label: 'PDL',      found: (r) => !!(r.matched && (r.name || r.company)) },
  { key: 'twilio',  label: 'Twilio',   found: (r) => !!(r.line_type || r.carrier || r.caller_name) },
  { key: 'serp',    label: 'SerpApi',  found: (r) => (r.added || 0) > 0 || (r.linkedin_verified || 0) > 0 },
  { key: 'confirm', label: 'Confirm',  found: (r) => !!r.company },
];

// Steps outside the enrichment chain (the manual ICP match) live in the SAME
// steps column; every chain writer must carry them forward or a re-enrich
// silently erases the record of a run it knows nothing about.
const ENRICH_KEYS = new Set(ENRICH_STEPS.map((d) => d.key));
const foreignSteps = (prior) => (Array.isArray(prior) ? prior : []).filter((s) => s && !ENRICH_KEYS.has(s.key));

// Turn one step's return value into a persisted verdict. Every step returns
// either data, {skipped:<why>}, or {error:<msg>} — this is the only place that
// mapping lives, so "why is that dot amber" has exactly one answer.
function stepVerdict(def, r, at) {
  const base = { key: def.key, label: def.label, at };
  if (!r || typeof r !== 'object') return { ...base, status: 'empty', reason: null };
  if (r.skipped)         return { ...base, status: 'skipped', reason: String(r.skipped) };
  if (r.error)           return { ...base, status: 'error',   reason: String(r.error) };
  if (r.matched === false) return { ...base, status: 'empty', reason: 'no match for this phone number' };
  const found = def.found(r);
  return { ...base, status: found ? 'found' : 'empty', reason: found ? null : (r.note ? String(r.note) : null) };
}

export async function getLead(env, id) {
  return env.DB.prepare('SELECT * FROM gtm_leads WHERE id = ?').bind(id).first();
}

export async function listLeads(env, { batch_id = null, status = null, q = null, stage = null, limit = 500 } = {}) {
  const where = [];
  const binds = [];
  if (batch_id) { where.push('batch_id = ?'); binds.push(batch_id); }
  if (status)   { where.push('status = ?');   binds.push(status); }
  if (q)        { where.push('(name LIKE ? OR company LIKE ? OR phone LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (stage === 'green') {
    // SQL prefilter — a strict SUPERSET of leadState's green (two-word name +
    // company + linkedin-ish + position); leadState below stays the authority.
    // Without this, stage:'green' hauled EVERY lead's wide row (big JSON
    // columns) out of D1 just to keep the green few — ~12s reads once the
    // first big import landed.
    where.push(`name LIKE '% %' AND company IS NOT NULL AND position IS NOT NULL AND (linkedin IS NOT NULL OR socials LIKE '%linkedin%')`);
  }
  const sql = `SELECT * FROM gtm_leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  const r = await env.DB.prepare(sql).bind(...binds, Math.min(500, limit)).all();
  let leads = r.results || [];
  if (stage) leads = leads.filter((l) => leadState(l) === stage);
  return leads.map((l) => ({
    ...l,
    state: leadState(l),
    confidence: evaluateConfidence(l),
    truecaller_url: truecallerUrl(l.normalized_phone || l.phone),
    // null on leads enriched before 0056 — the surface falls back to inferring
    // from provenance for those rather than showing them as never-run.
    steps: parseJson(l.steps, null),
  }));
}

export async function updateLead(env, id, fields) {
  const cols = Object.keys(fields || {}).filter((k) => LEAD_COLS.has(k));
  if (!cols.length) return getLead(env, id);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const vals = cols.map((c) => fields[c] ?? null);
  await env.DB.prepare(`UPDATE gtm_leads SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...vals, now(), id).run();
  return getLead(env, id);
}

export async function findByPhone(env, normalized) {
  return env.DB.prepare('SELECT * FROM gtm_leads WHERE normalized_phone = ? LIMIT 1').bind(normalized).first();
}

// new_count powers the module's auto-resume: on mount it looks for any batch
// still carrying un-enriched leads (the client-side enrich loop died mid-run —
// tab switch, closed browser, network blip) and picks the drain back up
// without the operator having to notice or click anything.
export async function listBatches(env) {
  const r = await env.DB.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM gtm_leads l WHERE l.batch_id = b.id AND l.status = 'new') AS new_count
     FROM gtm_batches b ORDER BY b.created_at DESC LIMIT 100`,
  ).all();
  return r.results || [];
}

// Rename a list. The name lives on the batch (gtm_batches.source) AND is
// denormalized onto every lead (gtm_leads.source), so both are rewritten
// together — otherwise the rail would show the new name while the rows kept the
// old one.
export async function renameBatch(env, id, source) {
  const s = String(source || '').trim() || null;
  await env.DB.prepare('UPDATE gtm_batches SET source = ? WHERE id = ?').bind(s, id).run();
  await env.DB.prepare('UPDATE gtm_leads SET source = ? WHERE batch_id = ?').bind(s, id).run();
  await logEvent(env, { kind: 'gtm_batch_renamed', actor: 'operator', payload: { id, source: s } });
  return { id, source: s };
}

// Manual "dead end": the operator gives up enriching a lead we couldn't resolve.
// Modeled as a terminal value of the EXISTING status column — no migration —
// which is exactly why it behaves: the batch stepper and new_count both filter
// status='new', so a dead end is automatically dropped from re-enrichment and
// stops nagging as "new". Reversible: reviving sets status back to 'new' so the
// chain can run again.
export async function setLeadDeadEnd(env, id, dead) {
  await updateLead(env, id, { status: dead ? 'dead_end' : 'new', active_tool: null });
  await logEvent(env, { kind: 'gtm_lead_dead_end', actor: 'operator', payload: { id, dead: !!dead } });
  return getLead(env, id);
}

// A linkedin.com/company/ page is the COMPANY, never the person — and it can
// arrive in either place a person's profile is read from (the `linkedin` column
// or a socials entry typed 'linkedin'). One definition, so completeness, the
// "needs" hint and the rendered profile link can never disagree.
export const isCompanyLinkedin = (u) => /linkedin\.com\/company\//i.test(String(u || ''));
const personLinkedin = (lead, socials) =>
  (lead.linkedin && !isCompanyLinkedin(lead.linkedin) ? lead.linkedin : null)
  || (socials.find((s) => s.type === 'linkedin' && !isCompanyLinkedin(s.url))?.url ?? null);

// Enrichment signal (matches the UI dot): green = first + last name + company +
// linkedin + position; red = none; yellow = partial. Green gates Enrich+Outreach.
export function leadState(lead) {
  let socials = [];
  try { socials = lead.socials ? JSON.parse(lead.socials) : []; } catch { socials = []; }
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  const signals = [
    parts.length >= 1,
    parts.length >= 2,
    !!lead.company,
    // The PERSON's profile. A /company/ page is not one, in EITHER place it can
    // land — counting it made a lead read green while the very same row reported
    // "needs: linkedin", and green gates Qualification + Outreach.
    !!personLinkedin(lead, socials),
    !!lead.position,
  ];
  const n = signals.filter(Boolean).length;
  return n === signals.length ? 'green' : n === 0 ? 'red' : 'yellow';
}

// ── confidence (derived-on-read, like leadState) ─────────────────────────────
// Distinct from leadState, which measures COMPLETENESS (do we have the fields).
// Confidence measures whether the identity HOLDS TOGETHER across sources — the
// "this might be the wrong person" signal. Pure function of the lead's own
// persisted fields (conflicts, sources, linkedin, line_type), so it is always
// fresh: the next read after an enrich or a manual edit recomputes it from the
// new data, no stored column to go stale. Returns { score 0-100, level
// 'green'|'yellow', flags: [{severity, label, detail}] }.
function prettyTool(t) {
  const map = {
    wa_fetch_name: 'WhatsApp', wa_fetch_photo: 'WhatsApp',
    pdl_enrich: 'People Data Labs', twilio_lookup: 'Twilio caller ID',
    serp_search: 'Google', manual: 'your manual edit',
    company_from_linkedin: 'LinkedIn', linkedin_company: 'LinkedIn',
  };
  return map[t] || t || 'a source';
}
function confNameTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-zÀ-ɏ\s'-]/g, ' ')
    .split(/[\s'-]+/).filter((t) => t.length >= 2);
}
export function linkedinSlug(url) {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

// ── linkedin identity verification ──────────────────────────────────────────
// The cardinal rule: a LinkedIn profile is only THIS lead's profile if the
// names are a relative match (a little different is fine — nicknames,
// transliteration; wildly different is a namesake/wrong person). We verify
// against two independent signals: the profile URL slug (usually the
// latinized name) and the search-result title ("Name - Title | LinkedIn").

// Hebrew-name transliteration variants (shachar/shahar, yitzchak/yitzhak…):
// normalize both sides the same way so spelling variance doesn't read as a
// different person.
const translit = (t) => t.replace(/ch/g, 'h').replace(/ph/g, 'f').replace(/ck/g, 'k');
const latinToks = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z]+/).filter((t) => t.length >= 2).map(translit);

function lev2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

const tokStrongMatch = (a, b) =>
  a === b
  || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)))
  || (Math.min(a.length, b.length) >= 4 && lev2(a, b) <= 1)
  // squished-name slugs ("orlatovitz", "yorubin") — the name token appears
  // INSIDE the concatenated slug token; require ≥4 chars so tiny tokens don't
  // false-match
  || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));

// How many of the lead's name tokens find a counterpart in the candidate tokens.
function nameTokenOverlap(leadName, candidateToks) {
  const nToks = latinToks(leadName);
  if (!nToks.length || !candidateToks.length) return { overlap: 0, verifiable: false, total: nToks.length };
  const overlap = nToks.filter((n) => candidateToks.some((c) => tokStrongMatch(n, c))).length;
  return { overlap, verifiable: true, total: nToks.length };
}

// Slug vs lead name: 'match' | 'mismatch' | 'unverifiable' (Hebrew-only name,
// or an opaque/custom slug that carries no name tokens).
export function slugNameCheck(leadName, url) {
  const slug = linkedinSlug(url);
  if (!slug) return 'unverifiable';
  const slugToks = slug.split(/[-_.]/).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^[0-9a-f]{6,}$/.test(t)).map(translit);
  if (!slugToks.length) return 'unverifiable';
  const { overlap, verifiable, total } = nameTokenOverlap(leadName, slugToks);
  if (!verifiable) return 'unverifiable';
  if (overlap === 0) return 'mismatch';
  // one shared token on a multi-token name (e.g. only the first name) is weak —
  // exactly the namesake trap — unless the slug itself only carries one token.
  if (total >= 2 && overlap < 2 && slugToks.length >= 2) return 'mismatch';
  return 'match';
}

// Does a LinkedIn search result belong to this lead? 'yes' | 'no' | 'unknown'.
// title is the SERP result title, e.g. "Dana Levin - VP Product at X | LinkedIn".
export function linkedinBelongsTo(leadName, { url, title }) {
  const slugVerdict = slugNameCheck(leadName, url);
  const t = String(title || '').replace(/\s*[|–-]\s*LinkedIn.*$/i, '');
  const titleName = t.split(' - ')[0].trim();
  const { overlap, verifiable, total } = nameTokenOverlap(leadName, latinToks(titleName));
  const titleStrong = verifiable && (total >= 2 ? overlap >= 2 : overlap >= 1);
  const titleZero = verifiable && overlap === 0 && latinToks(titleName).length >= 2;
  if (titleStrong || slugVerdict === 'match') {
    // positive evidence wins unless the OTHER signal outright contradicts
    if (slugVerdict === 'mismatch' && !titleStrong) return 'no';
    if (titleZero && slugVerdict !== 'match') return 'no';
    return 'yes';
  }
  if (slugVerdict === 'mismatch' || titleZero) return 'no';
  return 'unknown'; // cross-script name (e.g. Hebrew vs Latin) or opaque slug — cannot verify
}
export function evaluateConfidence(lead) {
  const flags = [];       // problems, worst-first
  const positives = [];   // reasons to trust it (shown on green)
  const conflicts = parseJson(lead.conflicts, []);
  const sources = parseJson(lead.sources, {});
  const nToks = confNameTokens(lead.name);
  const hasName = nToks.length >= 1;
  const hasFullName = nToks.length >= 2;
  const nameSrc = sources?.name?.tool;

  // ── Evidence: how much identity we actually hold. This is the base — an
  //    empty lead has NOTHING to be confident about, so it starts near zero
  //    (the old model started at 100 and only subtracted for contradictions,
  //    which is why a blank profile read 100%).
  let score = 0;
  if (hasFullName) score += 28;
  else if (hasName) score += 13;
  if (lead.linkedin) score += 20;
  if (lead.company)  score += 12;
  if (lead.position) score += 8;
  if (lead.email)    score += 8;

  // ── Consistency: recorded source conflicts. The enrichers log a name
  //    conflict exactly when e.g. WhatsApp and PDL/Twilio disagree — the case
  //    the operator described. A hard conflict caps the dot at yellow.
  let hardConflict = false;
  for (const c of (Array.isArray(conflicts) ? conflicts : [])) {
    if (!c || !c.value) continue;
    if (c.field === 'name') {
      hardConflict = true; score -= 40;
      flags.push({ severity: 'high', label: 'Name mismatch',
        detail: `On file "${lead.name || '?'}", but ${prettyTool(c.tool)} says "${c.value}".` });
    } else if (c.field === 'company') {
      score -= 16;
      flags.push({ severity: 'medium', label: 'Company mismatch',
        detail: `On file "${lead.company || '?'}", but ${prettyTool(c.tool)} says "${c.value}".` });
    } else {
      score -= 6;
      flags.push({ severity: 'low', label: `${c.field} mismatch`,
        detail: `${prettyTool(c.tool)} says "${c.value}".` });
    }
  }

  // ── LinkedIn slug vs name: corroboration when it matches, contradiction
  //    when it doesn't (the "this profile is someone else" check).
  let liMatchesName = false;
  if (lead.linkedin && hasName) {
    const slug = linkedinSlug(lead.linkedin);
    if (slug) {
      const slugToks = slug.split(/[-_.]/)
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^[0-9a-f]{6,}$/.test(t));
      if (slugToks.length >= 1) {
        const overlap = slugToks.filter((t) => nToks.some((n) => n === t || n.startsWith(t) || t.startsWith(n)));
        if (overlap.length) { liMatchesName = true; score += 12; }
        else {
          hardConflict = true; score -= 35;
          flags.push({ severity: 'high', label: 'LinkedIn does not match name',
            detail: `The linked profile /in/${slug} does not match the name "${lead.name}".` });
        }
      }
    }
  }

  // ── Low-evidence notices — the reasons a thin lead is NOT trustworthy yet.
  if (!hasName) {
    flags.push({ severity: 'high', label: 'No identity yet',
      detail: 'Only a phone number so far — nothing to verify. Run enrich to try to identify the person.' });
  } else if (!lead.linkedin && !lead.email && !lead.company) {
    flags.push({ severity: 'medium', label: 'Thin, unconfirmed profile',
      detail: `Name from ${prettyTool(nameSrc)} with no LinkedIn, company, or email to confirm it belongs to this number.` });
  }

  // ── Non-mobile line — a landline/VOIP often carries a business name.
  if (lead.line_type && !/mobile|wireless/i.test(lead.line_type)) {
    score -= 5;
    flags.push({ severity: 'low', label: `${lead.line_type} line`,
      detail: `Twilio reports a ${lead.line_type} line${lead.carrier ? ` (${lead.carrier})` : ''}; the name may be a business, not the person.` });
  }

  // ── Positive corroboration — why a clean lead earns its green.
  if (!hardConflict) {
    if (liMatchesName) positives.push('LinkedIn profile matches the name');
    if (hasFullName && lead.company && lead.position) positives.push('Full name, company, and role on file');
    if (nameSrc === 'pdl_enrich' || nameSrc === 'manual') positives.push(`Name confirmed via ${prettyTool(nameSrc)}`);
  }

  score = Math.max(0, Math.min(100, score));
  // red   = no usable identity to judge (nothing to be confident about)
  // yellow = a flagged inconsistency, or partial/unconfirmed data
  // green  = well-corroborated and consistent
  const level = !hasName ? 'red'
    : hardConflict ? 'yellow'
    : score >= 75 ? 'green'
    : 'yellow';
  return { score, level, flags, positives };
}

// ── provenance helpers ───────────────────────────────────────────────────────

function mergeSources(lead, upd) {
  let s = {};
  try { s = lead.sources ? JSON.parse(lead.sources) : {}; } catch { s = {}; }
  const at = new Date().toISOString();
  for (const [field, tool] of Object.entries(upd || {})) s[field] = { tool, at };
  return JSON.stringify(s);
}

function mergeConflicts(lead, adds) {
  let c = [];
  try { c = lead.conflicts ? JSON.parse(lead.conflicts) : []; } catch { c = []; }
  const at = new Date().toISOString();
  // dedupe on field+value — re-running an enricher must not stack the same
  // conflict (the rejected-linkedin path re-fires on every serp pass)
  for (const a of adds) {
    if (c.some((x) => x.field === a.field && x.value === a.value)) continue;
    c.push({ ...a, at });
  }
  return JSON.stringify(c);
}

function parseJson(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } }

// ── import: phone list → lead rows ──────────────────────────────────────────

async function toNumbers(env, { text, url }) {
  if (url && String(url).trim()) {
    const r = await webFetchText(env, { url, max_bytes: 2_000_000 });
    if (!r.ok) throw new Error(`url fetch HTTP ${r.status}`);
    text = r.text;
  }
  return parsePhoneList(text || '');
}

export async function importLeads(env, { text, url, source } = {}) {
  const via = url && String(url).trim() ? 'url' : 'paste';
  const batch_id = gid('gb');
  const numbers = await toNumbers(env, { text, url });
  let valid = 0, invalid = 0, duplicates = 0, created = 0;
  for (const number of numbers) {
    const n = normalizePhone(number);
    if (!n.valid) { invalid++; continue; }
    valid++;
    if (await findByPhone(env, n.normalized)) { duplicates++; continue; }
    const g = locatePhone(n.normalized);
    await env.DB.prepare(`
      INSERT INTO gtm_leads (id, phone, normalized_phone, status, source, batch_id, country, region, created_at, updated_at)
      VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)
    `).bind(gid('gl'), number, n.normalized, source || null, batch_id, g.country, g.region, now(), now()).run();
    created++;
  }
  const summary = { total: numbers.length, valid, invalid, duplicates, created, batch_id: created > 0 ? batch_id : null, via, source: source || null };
  if (created > 0) {
    await env.DB.prepare('INSERT INTO gtm_batches (id, source, via, total, created, duplicates, invalid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(batch_id, source || null, via, numbers.length, created, duplicates, invalid, now()).run();
  }
  await logEvent(env, { kind: 'gtm_leads_imported', actor: 'operator', payload: summary });
  return summary;
}

// ── SaaS clients (direct, optional secrets; degrade gracefully) ─────────────

export async function pdlEnrich(env, { phone, name, region, country, profile, company } = {}) {
  if (!env.PDL_API_KEY) return { skipped: 'PDL not configured (set the PDL_API_KEY secret)' };
  const qs = new URLSearchParams();
  // profile (a LinkedIn URL) is PDL's strongest match key — LI prospects have it
  for (const [k, v] of Object.entries({ phone, name, region, country, profile, company })) if (v) qs.set(k, v);
  const r = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${qs}`, {
    headers: { 'X-Api-Key': env.PDL_API_KEY },
    signal: AbortSignal.timeout(30000),
  });
  // usage meter: count the billable call + capture PDL's credit headers (its
  // own remaining-quota truth). Both are fire-safe no-ops on failure.
  await bumpUsage(env, 'pdl');
  const pdlQuota = pdlQuotaFromHeaders(r.headers);
  if (pdlQuota) await cacheQuota(env, 'pdl', pdlQuota);
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) return { matched: false };
  if (!r.ok) return { error: `PDL ${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
  const d = j.data || {};
  const profiles = (d.profiles || []).map((p) => ({ type: p.network, url: p.url && (p.url.startsWith('http') ? p.url : 'https://' + p.url) })).filter((p) => p.url);
  return {
    matched: true,
    likelihood: j.likelihood,
    // phone fields ride through untouched — the LI find-number tool reads
    // these; dropping them here made that tool structurally blind (2026-08-20)
    mobile_phone: d.mobile_phone || null,
    phone_numbers: Array.isArray(d.phone_numbers) ? d.phone_numbers : [],
    name: d.full_name || null,
    job_title: d.job_title || null,
    company: d.job_company_name || null,
    email: (d.emails || [])[0]?.address || d.recommended_personal_email || null,
    region: d.location_region || null,
    country: d.location_country || null,
    profiles,
  };
}

export async function twilioLookup(env, number) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return { skipped: 'Twilio not configured (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN secrets)' };
  const e164 = String(number || '').startsWith('+') ? number : '+' + String(number || '').replace(/\D/g, '');
  const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence,caller_name`, {
    headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) },
    signal: AbortSignal.timeout(20000),
  });
  await bumpUsage(env, 'twilio'); // usage meter (lookup count; balance is checked live)
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `Twilio ${r.status}: ${JSON.stringify(j).slice(0, 140)}` };
  return {
    valid: j.valid !== false,
    line_type: j.line_type_intelligence?.type || null,
    carrier: j.line_type_intelligence?.carrier_name || null,
    caller_name: j.caller_name?.caller_name || null,
    country_code: j.country_code || null,
  };
}

export async function serpSearch(env, { q, engine = 'google', num = 10, url } = {}) {
  if (!env.SERPAPI_KEY) return { skipped: 'SerpApi not configured (set the SERPAPI_KEY secret)' };
  const qs = new URLSearchParams({ engine, api_key: env.SERPAPI_KEY });
  if (q) qs.set('q', q);
  if (url) qs.set('url', url);
  if (num) qs.set('num', String(num));
  const r = await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(30000) });
  await bumpUsage(env, 'serpapi'); // usage meter (the /account check refines it with SerpApi's own numbers)
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return { error: `SerpApi: ${j.error || r.status}` };
  const results = (j.organic_results || []).map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
  return { results, data: j };
}

// ── small shared LLM helper (Anthropic; same pattern as digest.js) ──────────

export async function gtmLLM(env, { system, prompt, model = null, maxTokens = 4000, heavy = false } = {}) {
  // Delegates to the single LLM boundary (lib/openai.js): provider switch,
  // circuit breaker (light calls fall back local; heavy:true throws LlmDownError
  // so outreach drafting pauses rather than running on a 3B), and retry all
  // live there. Signature kept so GTM call sites stay untouched.
  return callOpenAIText(env, { system, prompt, model, max_tokens: maxTokens, heavy });
}

export function extractJson(txt) {
  const s = String(txt || '');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

// ── socials extraction (regex over known hosts; optional website fetch) ─────

const SOCIAL = [
  ['linkedin', /(?:[\w.-]*\.)?linkedin\.com\/[^\s"'<>)]+/ig],
  ['twitter', /(?:[\w.-]*\.)?(?:twitter\.com|x\.com)\/[^\s"'<>)]+/ig],
  ['instagram', /(?:[\w.-]*\.)?instagram\.com\/[^\s"'<>)]+/ig],
  ['facebook', /(?:[\w.-]*\.)?(?:facebook\.com|fb\.com)\/[^\s"'<>)]+/ig],
  ['github', /(?:[\w.-]*\.)?github\.com\/[^\s"'<>)]+/ig],
  ['youtube', /(?:[\w.-]*\.)?(?:youtube\.com|youtu\.be)\/[^\s"'<>)]+/ig],
  ['tiktok', /(?:[\w.-]*\.)?tiktok\.com\/[^\s"'<>)]+/ig],
  ['telegram', /t\.me\/[^\s"'<>)]+/ig],
];
const SOCIAL_HOST = /(linkedin|twitter|x|instagram|facebook|fb|github|youtube|youtu|tiktok)\.|t\.me/i;

export async function extractSocials(env, { text, website } = {}) {
  let corpus = String(text || '');
  const urls = corpus.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  const site = website || urls.find((u) => !SOCIAL_HOST.test(u)) || null;
  if (site) {
    try {
      const r = await webFetchText(env, { url: site, max_bytes: 200000 });
      if (r.ok) corpus += ' ' + r.text;
    } catch { /* site down — fine */ }
  }
  const found = new Map();
  for (const [type, re] of SOCIAL) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(corpus))) {
      let u = m[0].replace(/[).,'"]+$/, '');
      if (!/^https?:/i.test(u)) u = 'https://' + u;
      if (!found.has(u)) found.set(u, { type, url: u });
    }
  }
  return { socials: [...found.values()], website: site };
}

// ── photo storage: copy an expiring URL into R2 (public via ASSETS_BASE_URL) ─

export async function storeLeadPhoto(env, url, key) {
  try {
    const r = await webFetchBytes(env, { url });
    if (!r.ok) return null;
    await env.ASSETS.put(key, r.bytes, { httpMetadata: { contentType: r.content_type || 'image/jpeg' } });
    const { assetsBase } = await import('./self-origin.js');
    return `${assetsBase(env)}/${key}`;
  } catch { return null; }
}

// ── enrichment passes (each re-reads the lead; conflict-aware writes) ────────

export async function pdlEnrichOne(env, l) {
  if (l.name && l.company) return { skipped: 'name + company already present, PDL is paid' };
  await updateLead(env, l.id, { active_tool: 'pdl' });
  try {
    const res = await pdlEnrich(env, { phone: l.normalized_phone || l.phone, name: l.name || undefined, region: l.region || undefined, country: l.country || undefined });
    if (res.skipped || res.error || res.matched === false) { await updateLead(env, l.id, { active_tool: null }); return res; }
    const socials = parseJson(l.socials, []);
    const dismissed = new Set(parseJson(l.dismissed, []));
    const seen = new Set(socials.map((s) => s.url));
    const at = new Date().toISOString();
    for (const p of res.profiles || []) if (p.url && !seen.has(p.url) && !dismissed.has(p.url)) { socials.push({ ...p, src: 'pdl_enrich', at }); seen.add(p.url); }
    const srcUpd = {}, conflicts = [];
    const fields = { status: 'enriched', socials: JSON.stringify(socials), active_tool: null };
    if (res.name) { if (!l.name) { fields.name = res.name; srcUpd.name = 'pdl_enrich'; } else if (!eqCI(res.name, l.name)) conflicts.push({ field: 'name', value: res.name, tool: 'pdl_enrich' }); }
    if (res.company) { if (!l.company) { fields.company = res.company; srcUpd.company = 'pdl_enrich'; } else if (!eqCI(res.company, l.company)) conflicts.push({ field: 'company', value: res.company, tool: 'pdl_enrich' }); }
    if (res.job_title && !l.position) { fields.position = res.job_title; srcUpd.position = 'pdl_enrich'; }
    if (res.email && !l.email) { fields.email = res.email; srcUpd.email = 'pdl_enrich'; }
    if (res.region && !l.region) { fields.region = res.region; srcUpd.region = 'pdl_enrich'; }
    if (res.country && !l.country) { fields.country = res.country; srcUpd.country = 'pdl_enrich'; }
    fields.sources = mergeSources(l, srcUpd);
    if (conflicts.length) fields.conflicts = mergeConflicts(l, conflicts);
    await updateLead(env, l.id, fields);
    return { matched: res.matched, likelihood: res.likelihood, name: res.name, company: res.company };
  } catch (e) {
    await updateLead(env, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// Twilio pass: line type + carrier always; CNAM name only if still nameless.
export async function twilioEnrichOne(env, l) {
  await updateLead(env, l.id, { active_tool: 'twilio' });
  try {
    const r = await twilioLookup(env, l.normalized_phone || l.phone);
    if (r.skipped || r.error) { await updateLead(env, l.id, { active_tool: null }); return r; }
    const srcUpd = {}, conflicts = [];
    const fields = { line_type: r.line_type || null, carrier: r.carrier || null, active_tool: null };
    if (r.line_type) srcUpd.line_type = 'twilio_lookup';
    if (r.carrier)   srcUpd.carrier = 'twilio_lookup';
    if (r.caller_name) {
      if (!l.name) { fields.name = r.caller_name; srcUpd.name = 'twilio_lookup'; }
      else if (!eqCI(r.caller_name, l.name)) conflicts.push({ field: 'name', value: r.caller_name, tool: 'twilio_lookup' });
    }
    fields.sources = mergeSources(l, srcUpd);
    if (conflicts.length) fields.conflicts = mergeConflicts(l, conflicts);
    await updateLead(env, l.id, fields);
    return { valid: r.valid, line_type: r.line_type, carrier: r.carrier, caller_name: r.caller_name };
  } catch (e) {
    await updateLead(env, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// Google (SerpApi) pass. HARD-GATED: requires an already-sourced name — never
// search an invented name into a false identity.
export async function serpEnrichOne(env, l) {
  if (!l.name || !String(l.name).trim()) return { skipped: 'no sourced name yet — get a name from WhatsApp/PDL first' };
  await updateLead(env, l.id, { active_tool: 'google' });
  try {
    const where = [l.region, l.country].filter(Boolean).join(' ');
    const q = `"${l.name}"${where ? ' ' + where : ''} linkedin OR twitter OR instagram`;
    const res = await serpSearch(env, { q, num: 10 });
    if (res.skipped || res.error) { await updateLead(env, l.id, { active_tool: null }); return res; }
    const results = res.results || [];
    const corpus = results.map((r) => `${r.link} ${r.title} ${r.snippet || ''}`).join('\n');
    const soc = await extractSocials(env, { text: corpus });
    const socials = parseJson(l.socials, []);
    const dismissed = new Set(parseJson(l.dismissed, []));
    const seen = new Set(socials.map((s) => s.url));
    const at = new Date().toISOString();
    let added = 0;
    // LinkedIn URLs are handled separately below with identity verification —
    // never let the raw corpus scrape attach someone else's profile.
    for (const s of soc.socials) {
      if (!s.url || seen.has(s.url) || dismissed.has(s.url)) continue;
      if (s.type === 'linkedin') continue;
      socials.push({ ...s, src: 'serp_search', at }); seen.add(s.url); added++;
    }

    // ── LinkedIn: verified-only. Each /in/ RESULT is checked against the
    // lead's name (result title + URL slug). A profile whose name is wildly
    // different is a namesake or a stray link in the search page — attaching
    // it was the old behavior's cardinal sin (and the wrong company/title got
    // derived from it next). Now: 'yes' → attach; 'no'/'unknown' → NEVER
    // auto-attach; the best rejected candidate is recorded as a CONFLICT so
    // the operator sees it and can approve by hand (a manual edit clears the
    // conflict). Cross-script names (Hebrew name vs Latin profile) land in
    // 'unknown' — unverifiable is not verification.
    const liResults = results.filter((r) => /linkedin\.com\/in\//i.test(r.link || ''));
    const verdicts = liResults.map((r) => ({ url: r.link, title: r.title, verdict: linkedinBelongsTo(l.name, { url: r.link, title: r.title }) }));
    const verified = verdicts.filter((v) => v.verdict === 'yes' && !dismissed.has(v.url));
    const rejected = verdicts.filter((v) => v.verdict !== 'yes' && !dismissed.has(v.url));
    for (const v of verified) {
      if (seen.has(v.url)) continue;
      socials.push({ type: 'linkedin', url: v.url, src: 'serp_search', at }); seen.add(v.url); added++;
    }

    const fields = { socials: JSON.stringify(socials), active_tool: null };
    // Promote to the lead's linkedin field only from a verified or trusted
    // origin: serp entries above are pre-verified; wa/pdl entries came from the
    // person's own WhatsApp about or a phone-anchored PDL match. Even then, a
    // hard slug-vs-name mismatch blocks promotion.
    if (!l.linkedin) {
      const cand = socials.find((s) => s.type === 'linkedin' && /linkedin\.com\/in\//i.test(s.url)
        && ['serp_search', 'extract_socials', 'pdl_enrich'].includes(s.src)
        && slugNameCheck(l.name, s.url) !== 'mismatch');
      if (cand) fields.linkedin = cand.url;
      else if (rejected.length) {
        // surface the candidate we REFUSED to auto-attach — visible, reviewable
        fields.conflicts = mergeConflicts(l, [{ field: 'linkedin', value: rejected[0].url, tool: 'serp_search' }]);
        await logEvent(env, { kind: 'gtm_linkedin_rejected', payload: { id: l.id, name: l.name, url: rejected[0].url, verdict: rejected[0].verdict } });
      }
    }
    await updateLead(env, l.id, fields);
    return { query: q, found: soc.socials.length, added, linkedin_verified: verified.length, linkedin_rejected: rejected.length };
  } catch (e) {
    await updateLead(env, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// ── retroactive identity audit ──────────────────────────────────────────────
// Find every lead whose assigned linkedin does NOT match their name (the bad
// assignments made before the verification gate existed). fix:true cleans them:
// clears the linkedin, tombstones the URL (dismissed — can never be re-added),
// records a visible conflict, and ALSO clears company/position when they were
// derived FROM that wrong profile (sources.{field}.tool === company_from_linkedin
// — the poison spreads, so the cleanup must follow it).
export async function auditLinkedinIdentity(env, { fix = false } = {}) {
  const r = await env.DB.prepare(
    `SELECT * FROM gtm_leads WHERE linkedin IS NOT NULL AND name IS NOT NULL`,
  ).all();
  const leads = r.results || [];
  const report = { checked: leads.length, match: 0, unverifiable: 0, mismatch: [], fixed: 0 };
  for (const l of leads) {
    const verdict = slugNameCheck(l.name, l.linkedin);
    if (verdict === 'match') { report.match++; continue; }
    if (verdict === 'unverifiable') { report.unverifiable++; continue; }
    report.mismatch.push({ id: l.id, name: l.name, linkedin: l.linkedin, company: l.company });
    if (!fix) continue;
    const sources = parseJson(l.sources, {});
    const dismissed = [...new Set([...parseJson(l.dismissed, []), l.linkedin])];
    const fields = { linkedin: null, dismissed: JSON.stringify(dismissed) };
    for (const f of ['company', 'position']) {
      if (sources?.[f]?.tool === 'company_from_linkedin') { fields[f] = null; delete sources[f]; }
    }
    delete sources.linkedin;
    fields.sources = JSON.stringify(sources);
    fields.conflicts = mergeConflicts(l, [{ field: 'linkedin', value: l.linkedin, tool: 'identity_audit' }]);
    await updateLead(env, l.id, fields);
    await logEvent(env, { kind: 'gtm_linkedin_cleared', payload: { id: l.id, name: l.name, url: l.linkedin } });
    report.fixed++;
  }
  return report;
}

// Company (and title) off the person's LinkedIn search result — cheap,
// authoritative, kills confabulated companies. Regex first, LLM fallback.
//
// The guard covers BOTH fields it can fill. It used to bail on `l.company`
// alone, which meant a lead whose company arrived from PDL / WhatsApp / a manual
// edit could never have its TITLE read off LinkedIn — the function returned
// before fetching the profile, so the `job_title` branch below was unreachable
// and the title stayed empty however plainly it was on the page. That also made
// the operator's rerun button a no-op for exactly that case.
export async function companyFromLinkedinOne(env, l) {
  if (!l.linkedin) return { skipped: 'no linkedin' };
  if (l.company && l.position) return { skipped: 'company + title already on file' };
  await updateLead(env, l.id, { active_tool: 'linkedin' });
  try {
    const slug = (String(l.linkedin).match(/\/in\/([^/?#]+)/) || [])[1] || '';
    const q = l.name ? `${l.name} site:linkedin.com/in` : `site:linkedin.com/in/${slug}`;
    const res = await serpSearch(env, { q, num: 8 });
    if (res.skipped || res.error) { await updateLead(env, l.id, { active_tool: null }); return res; }
    const results = res.results || [];
    // Exact-slug hit = the lead's own (already verified) profile. The fallback
    // must ALSO pass identity verification — the old `any /in/ result` fallback
    // happily read the company/title off a total stranger's profile whenever the
    // slug didn't appear, poisoning company AND position in one shot.
    const hit = (slug && results.find((o) => (o.link || '').toLowerCase().includes('/in/' + slug.toLowerCase())))
      || results.find((o) => /linkedin\.com\/in\//i.test(o.link || '') && linkedinBelongsTo(l.name, { url: o.link, title: o.title }) === 'yes');
    if (!hit) { await updateLead(env, l.id, { active_tool: null }); return { company: null, note: 'no name-verified linkedin result found' }; }
    // "Name - Title at Company" parses with a regex; messy headlines fall to the LLM.
    const t = String(hit.title || '').replace(/\s*[|–-]\s*LinkedIn.*$/i, '').replace(/[.…]+\s*$/, '').trim();
    let company = null, job_title = null;
    const dash = t.indexOf(' - ');
    if (dash !== -1) {
      const rest = t.slice(dash + 3);
      const m = rest.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (m) { job_title = m[1].trim() || null; company = m[2].replace(/\s*\(.*?\)\s*$/, '').trim() || null; }
      else job_title = rest || null;
    }
    if (!company) {
      try {
        const txt = await gtmLLM(env, {
          system: 'Extract the person\'s CURRENT company and job title from a LinkedIn search result. Headlines are messy: "EIR @Notable, GTM Nerd!" means title "EIR", company "Notable". Return ONLY strict JSON {"company": string|null, "job_title": string|null}.',
          prompt: `Title: ${hit.title}\nSnippet: ${hit.snippet || ''}`,
          model: env.NYO_MODEL_MID || 'claude-sonnet-5',
          maxTokens: 300,
        });
        const o = extractJson(txt);
        company = o.company || company;
        job_title = o.job_title || job_title;
      } catch { /* keep regex result */ }
    }
    const srcUpd = {}, conflicts = [], fields = { active_tool: null };
    // Now that this can run with a company already on file, it must follow the
    // module's provenance rule like every other source does: fill an empty
    // field, but record a disagreement instead of overwriting one.
    if (company) {
      if (!l.company) { fields.company = company; srcUpd.company = 'company_from_linkedin'; }
      else if (!eqCI(company, l.company)) conflicts.push({ field: 'company', value: company, tool: 'company_from_linkedin' });
    }
    if (job_title && !l.position) { fields.position = job_title; srcUpd.position = 'company_from_linkedin'; }
    if (Object.keys(srcUpd).length) fields.sources = mergeSources(l, srcUpd);
    if (conflicts.length) fields.conflicts = mergeConflicts(l, conflicts);
    await updateLead(env, l.id, fields);
    return { company: company || null, position: job_title || null, from: hit.link };
  } catch (e) {
    await updateLead(env, l.id, { active_tool: null });
    return { error: String(e.message || e) };
  }
}

// The full chain for one lead, accuracy order. Each step re-reads the lead so a
// later step sees what an earlier one wrote (SERP needs the name; PDL skips
// itself once name+company exist).
export async function enrichFullOne(env, id) {
  env = await (await import('./gateway-config.js')).withResolvedCredentials(env);
  const at = now();
  let l = await getLead(env, id);
  // If a previous pass surfaced a linkedin, resolve the company off it before
  // paying for PDL.
  const liBefore = l.linkedin || null;
  const cfl = await companyFromLinkedinOne(env, l);
  const pdl = await pdlEnrichOne(env, await getLead(env, id));
  const twilio = await twilioEnrichOne(env, await getLead(env, id));
  const serp = await serpEnrichOne(env, await getLead(env, id));
  // Deterministic finalize: with a linkedin on file, the company read off it is
  // authoritative (kills "Elon University"-style confabulation). It exists to
  // catch the profile SERP just attached, which the earlier pass never saw.
  //
  // Skipped when the earlier pass already FETCHED this exact profile: that pass
  // reads company and title off the same result, so re-reading an unchanged URL
  // is the identical SerpApi query twice in one chain. (A step-2 that merely
  // self-skipped costs nothing to repeat — it returns before any search.)
  l = await getLead(env, id);
  const alreadyRead = !!liBefore && l.linkedin === liBefore && !cfl?.skipped;
  const confirm = alreadyRead
    ? { skipped: 'same LinkedIn profile already read earlier this run' }
    : await companyFromLinkedinOne(env, l);

  // Mark the chain as RUN unconditionally — even when every source failed or
  // was skipped. status means "attempted", the red/yellow/green state carries
  // quality. Without this, a lead whose sources all skip stays 'new' and
  // enrichBatchStep re-selects it forever (the UI loop never terminates).
  // Default: enriched ⇒ WATCHED (the operator curates by removing, not by
  // adding one-by-one). Only leads never watched before — an explicit
  // un-watch (watch=0 with a watch_started_at) is a curation decision that
  // enrichment must not overturn.
  const markFields = { status: 'enriched' };
  if (!l.watch_started_at) { markFields.watch = 1; markFields.watch_started_at = now(); }
  const cur = await updateLead(env, id, markFields);

  // Persist what each step DID, so "skipped on purpose" survives as a distinct
  // fact from "ran and found nothing". Wrapped: the `steps` column arrives by a
  // MANUAL migration (db:apply:remote), so if a deploy ever lands ahead of it, a
  // missing column must not take the whole enrichment chain down with it.
  // Non-chain verdicts (the manual ICP match) are carried forward, not wiped —
  // this pass replaces only what it actually re-ran.
  const results = { li: cfl, pdl, twilio, serp, confirm };
  const steps = [...ENRICH_STEPS.map((d) => stepVerdict(d, results[d.key], at)), ...foreignSteps(parseJson(cur?.steps, null))];
  try {
    await updateLead(env, id, { steps: JSON.stringify(steps) });
  } catch (e) {
    console.error('gtm: step verdicts not persisted (is migration 0056 applied?)', e?.message || e);
  }

  const done = await getLead(env, id);
  // the auto-watch flip must be reconstructable from gtm_watch_set events alone
  if (markFields.watch === 1) {
    await logEvent(env, { kind: 'gtm_watch_set', actor: 'system', payload: { id, on: true, auto: 'enriched-default', name: done?.name || null } });
  }
  await logEvent(env, {
    kind: 'gtm_lead_enriched',
    actor: 'operator',
    payload: { id, state: leadState(done), steps: steps.map((s) => `${s.key}:${s.status}`) },
  });
  return { id, state: leadState(done), steps, company_from_linkedin: cfl, pdl, twilio, serp, confirm };
}

// Resume the TAIL of the chain after the operator has typed something in by
// hand. Two steps gate themselves on fields a human most often supplies:
//   * SerpApi — hard-gated on already having a sourced NAME
//   * Confirm — the finalize LinkedIn pass, needs a linkedin and no company yet
// Typing a name or pasting a profile URL unblocks exactly those two, so this
// re-runs only them.
//
// It deliberately does NOT re-run WhatsApp / PDL / Twilio: Twilio bills per
// lookup and PDL is paid, and nothing the operator typed changes what either
// would return for the same phone number. Re-running the full chain to pick up
// one manual edit is how a "just refresh it" button quietly becomes expensive.
//
// Verdicts are MERGED over whatever is already recorded, so the steps this pass
// didn't touch keep their previous result instead of being reset to unknown.
export async function enrichResumeOne(env, id) {
  const at = now();
  const serp = await serpEnrichOne(env, await getLead(env, id));
  const confirm = await companyFromLinkedinOne(env, await getLead(env, id));

  const results = { serp, confirm };
  const current = await getLead(env, id);
  const prior = parseJson(current?.steps, null);
  const byKey = new Map((Array.isArray(prior) ? prior : []).map((s) => [s.key, s]));
  for (const d of ENRICH_STEPS) {
    if (!(d.key in results)) continue;
    byKey.set(d.key, stepVerdict(d, results[d.key], at));
  }
  // Only the keys we actually know about — a step with no record at all is left
  // OUT rather than written as 'idle', so a resume on a lead enriched before
  // 0056 doesn't claim its earlier steps never ran. The page infers those.
  // Non-chain verdicts (the manual ICP match) ride along untouched.
  const steps = [...ENRICH_STEPS.map((d) => byKey.get(d.key)).filter(Boolean), ...foreignSteps(prior)];
  try {
    await updateLead(env, id, { steps: JSON.stringify(steps) });
  } catch (e) {
    console.error('gtm: resume verdicts not persisted (is migration 0056 applied?)', e?.message || e);
  }

  const done = await getLead(env, id);
  await logEvent(env, {
    kind: 'gtm_lead_enriched',
    actor: 'operator',
    payload: { id, mode: 'resume', state: leadState(done), steps: steps.map((s) => `${s.key}:${s.status}`) },
  });
  return { id, mode: 'resume', state: leadState(done), steps, serp, confirm };
}

// Batch stepper: enrich the next `limit` un-enriched leads of a batch. The UI /
// Nyo calls this in a loop while remaining > 0 — keeps each Worker invocation
// well inside its budget instead of one long background chain.
export async function enrichBatchStep(env, { batch_id, limit = 2 } = {}) {
  const r = await env.DB.prepare("SELECT id FROM gtm_leads WHERE batch_id = ? AND status = 'new' ORDER BY created_at LIMIT ?")
    .bind(batch_id, Math.min(5, Math.max(1, limit))).all();
  const ids = (r.results || []).map((x) => x.id);
  const results = [];
  for (const id of ids) results.push(await enrichFullOne(env, id));
  const rem = await env.DB.prepare("SELECT COUNT(*) AS n FROM gtm_leads WHERE batch_id = ? AND status = 'new'").bind(batch_id).first();
  return { enriched: results.length, remaining: rem?.n ?? 0, results };
}

// Manual field edit: '' clears a field; removed social URLs are tombstoned into
// dismissed; a manual edit resolves (clears) matching conflicts.
export async function manualEditLead(env, id, body = {}) {
  const l = await getLead(env, id);
  if (!l) throw new Error('no such lead');
  const fields = {};
  const srcUpd = {};   // provenance to stamp
  const srcDrop = [];  // provenance to remove, for values we cleared
  for (const k of ['name', 'linkedin', 'email', 'company', 'position']) {
    if (body[k] !== undefined) {
      fields[k] = String(body[k] || '').trim() || null;
      if (fields[k]) srcUpd[k] = 'manual';
    }
  }
  if (body.socials !== undefined) {
    const next = Array.isArray(body.socials) ? body.socials : [];
    const prev = parseJson(l.socials, []);
    const nextUrls = new Set(next.map((s) => s.url));
    const dismissed = parseJson(l.dismissed, []);
    for (const s of prev) if (s.url && !nextUrls.has(s.url)) dismissed.push(s.url);
    fields.socials = JSON.stringify(next);
    fields.dismissed = JSON.stringify([...new Set(dismissed)]);
  }
  // Correcting the COMPANY's LinkedIn is a targeted key, never a whole-socials
  // rewrite: the browser holds a stale copy of that array, and replacing the
  // column with it would tombstone whatever an enrichment pass added in between.
  // The read-modify-write therefore happens here, against the current row.
  if (body.company_linkedin !== undefined) {
    const url = String(body.company_linkedin || '').trim();
    // Seeded from whatever the socials branch already staged, not straight from
    // the row: a request carrying BOTH keys must not have one silently dropped.
    const prev = fields.socials !== undefined ? parseJson(fields.socials, []) : parseJson(l.socials, []);
    const kept = prev.filter((s) => !isCompanyLinkedin(s.url));
    fields.socials = JSON.stringify(url ? [...kept, { type: 'linkedin_company', url, src: 'manual' }] : kept);
    // Blacklist only the company links we actually replaced, so enrichment can
    // never re-attach the wrong company. Other socials keep their state.
    const dismissed = fields.dismissed !== undefined ? parseJson(fields.dismissed, []) : parseJson(l.dismissed, []);
    for (const s of prev) if (isCompanyLinkedin(s.url) && s.url !== url) dismissed.push(s.url);
    fields.dismissed = JSON.stringify([...new Set(dismissed)]);
    // EVERYTHING the old link produced is now about the wrong company: the
    // resolve snapshot, the company id the jobs API is keyed on, the open roles
    // fetched with that id, and the recorded Company step describing them.
    // Leaving any of it means a surface confidently reporting another company's
    // facts — and resolveLiCompany skipping the re-resolve for a month, because
    // company_checked_at is still fresh.
    fields.company_context = null;
    fields.company_li_id = null;
    fields.company_checked_at = null;
    fields.open_positions = null;
    fields.positions_checked_at = null;
    // The headcount belonged to the wrong company too, and the resolve COALESCES
    // rather than clobbers, so leaving it would carry a wrong number forward
    // forever. A figure the operator typed by hand is theirs, and survives.
    const srcs = parseJson(l.sources, {});
    if (srcs?.company_staff_count?.tool !== 'manual') fields.company_staff_count = null;
    // Absent on a lead predating migration 0056 — parseJson yields null, so the
    // column is simply left out rather than written blind.
    const steps = parseJson(l.steps, null);
    if (Array.isArray(steps)) fields.steps = JSON.stringify(steps.filter((s) => s && s.key !== 'company'));
  }
  // Headcount is fetched, but correctable — LinkedIn matches the wrong company
  // often enough, and the ICP leans on this number harder than on any other
  // single fact. Stored as an integer so the ICP prompt and the Size column read
  // it the same way the resolve writes it; null clears it back to "not checked".
  if (body.company_staff_count !== undefined) {
    const raw = body.company_staff_count;
    const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (blank) {
      fields.company_staff_count = null;
      // Drop the provenance WITH the value it described, or the stamp outlives
      // it and mislabels whatever lands next.
      srcDrop.push('company_staff_count');
    } else {
      // Rejected, not coerced. Number([]) and Number(false) are both 0, which
      // would store a real "0 employees" — and the ICP prompt is told a number
      // is a fact while "not checked" is not. So only a number or a numeric
      // string is even considered; String(x) on anything else is not evidence.
      if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('company_staff_count must be a number');
      const n = typeof raw === 'number' ? raw : Number(raw.trim());
      if (!Number.isFinite(n) || n < 0) throw new Error('company_staff_count must be a non-negative number');
      fields.company_staff_count = Math.round(n);
      srcUpd.company_staff_count = 'manual';
    }
  }
  // Manual edit resolves conflicts on the fields it touched.
  const conflicts = parseJson(l.conflicts, []).filter((c) => !(c.field in fields));
  fields.conflicts = JSON.stringify(conflicts);
  if (Object.keys(srcUpd).length) fields.sources = mergeSources(l, srcUpd);
  // Applied AFTER the merge, which rebuilds from the stored row and would
  // otherwise resurrect a stamp we just dropped.
  if (srcDrop.length) {
    const s = parseJson(fields.sources !== undefined ? fields.sources : l.sources, {});
    for (const k of srcDrop) delete s[k];
    fields.sources = JSON.stringify(s);
  }
  await updateLead(env, id, fields);
  await logEvent(env, { kind: 'gtm_lead_updated', actor: 'operator', payload: { id, changed: Object.keys(fields).filter((k) => !['conflicts', 'sources', 'dismissed'].includes(k)) } });
  return getLead(env, id);
}
