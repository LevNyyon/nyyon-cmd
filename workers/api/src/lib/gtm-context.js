// GTM · Context Enrich — org chart (theorg.com GraphQL, public, no key), ICP
// fit (LLM vs the brand-baseline `brand-icp` doc — single source), open roles (linkedin-gateway:
// one throttled Voyager company-id resolve, cached on the lead, then the public
// guest-jobs API from the gateway's residential IP), and warm-path detection
// (fuzzy-match the operator's connections from `gtm-you` against org people).

import { readKnowledge, writeKnowledge, logEvent } from './db.js';
import { getLiCompany, getLiCompanyJobs, getProfile } from './linkedin.js';
import { getLead, updateLead, listLeads, gtmLLM, extractJson, storeLeadPhoto } from './gtm.js';

const now = () => Date.now();
const gid = (p) => `${p}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── knowledge doc helpers (the control surfaces live in knowledge_docs) ─────

export async function gtmDoc(env, slug, fallback = '') {
  const d = await readKnowledge(env, slug);
  return d?.body || fallback;
}

// ── gtm policy (editable, seeded on first read) ─────────────────────────────
// How stale a cached company fact may get before the bulk action re-fetches it.
// Operator-facing: the Qualification tab's button copy promises this window, so
// it must be tunable by editing a note rather than by a deploy.
const GTM_POLICY_DEFAULTS = Object.freeze({
  company_context_max_age_days: 30,   // a good headcount is re-checked this rarely
  company_retry_after_hours: 2,       // a FAILED resolve retries this soon — a dead
                                      // LinkedIn session is usually fixed in minutes,
                                      // so failures must not be cached for 30 days
});
function polNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function loadGtmPolicy(env) {
  try {
    const row = await env.DB.prepare("SELECT body FROM knowledge_docs WHERE slug = 'gtm-policy'").first();
    if (!row?.body) {
      await writeKnowledge(env, {
        slug: 'gtm-policy',
        title: 'GTM policy — company-context cache windows',
        body: JSON.stringify(GTM_POLICY_DEFAULTS, null, 2),
      }).catch(() => {});
      return { ...GTM_POLICY_DEFAULTS };
    }
    const m = String(row.body).match(/\{[\s\S]*\}/);
    const src = m ? JSON.parse(m[0]) : {};
    const out = {};
    for (const [k, dflt] of Object.entries(GTM_POLICY_DEFAULTS)) out[k] = polNum(src[k], dflt);
    return out;
  } catch {
    return { ...GTM_POLICY_DEFAULTS };
  }
}

export async function readYou(env) {
  try { return JSON.parse(await gtmDoc(env, 'gtm-you', '{}')); } catch { return {}; }
}

export async function writeYou(env, patch = {}) {
  const cur = await readYou(env);
  const ALLOW = ['name', 'role', 'business', 'phone', 'email', 'linkedin', 'location', 'about', 'groups', 'connections'];
  const next = { ...cur };
  for (const k of ALLOW) if (patch[k] !== undefined) next[k] = patch[k];
  await writeKnowledge(env, { slug: 'gtm-you', title: 'GTM · You — operator profile', body: JSON.stringify(next, null, 0), parent_slug: undefined });
  return next;
}

// ── theorg org chart ─────────────────────────────────────────────────────────

const GQL = 'https://prod-graphql-api.theorg.com/graphql';
const FRAG = `fragment P on OrgChartStructureNode {
  id title node {
    ... on Position { position { fullName role slug profileImage { endpoint uri ext versions __typename } __typename } __typename }
    __typename
  } reportCount parentId __typename
}`;
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function theorgImageUrl(img) {
  if (!img) return null;
  const ver = img.versions?.includes('medium') ? 'medium' : (img.versions?.[0] ?? 'thumb');
  return `${img.endpoint}/${img.uri}_${ver}.${img.ext}`;
}

async function theorgGql(op, query, variables) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/json', 'x-org-client': 'web', 'x-operation-name': op },
    body: JSON.stringify({ operationName: op, variables, query }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(String(JSON.stringify(j.errors)).slice(0, 200));
  return j.data;
}

export async function fetchTheorg(env, { company, slug } = {}) {
  const useSlug = (slug && String(slug).trim()) || slugify(company);
  if (!useSlug) return { error: 'no company' };
  try {
    const c = (await theorgGql('GetCompany', 'query GetCompany($slug:String!){company(slug:$slug){id name}}', { slug: useSlug })).company;
    if (!c) return { error: `not found on theorg (tried slug "${useSlug}")`, people: [] };
    const nodes = (await theorgGql('OrgChartPreview', `query OrgChartPreview($companyId:UUID!){nodes(companyId:$companyId,mode:{}){...P}}${FRAG}`, { companyId: c.id })).nodes || [];
    const people = nodes
      .filter((n) => n.node?.position)
      .map((n) => {
        const p = n.node.position;
        return { nodeId: n.id, parentId: n.parentId, name: p.fullName, role: p.role, photo: theorgImageUrl(p.profileImage), reportCount: n.reportCount };
      });
    return { company: c.name, people };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

export async function listOrgPeople(env, leadId) {
  const r = await env.DB.prepare('SELECT * FROM gtm_org_people WHERE lead_id = ? ORDER BY created_at').bind(leadId).all();
  return r.results || [];
}

async function replaceOrgPeople(env, leadId, company, people) {
  await env.DB.prepare('DELETE FROM gtm_org_people WHERE lead_id = ?').bind(leadId).run();
  for (const p of people) {
    await env.DB.prepare(`
      INSERT INTO gtm_org_people (id, lead_id, company, node_id, parent_node_id, name, role, photo_url, report_count, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'theorg', ?)
    `).bind(gid('gp'), leadId, company || null, p.nodeId || null, p.parentId || null, p.name || null, p.role || null, p.photo || null, p.reportCount ?? null, now()).run();
  }
}

// Fetch (or serve the persisted) org chart for a lead. theorg is hit only on
// first check or explicit refresh/slug override — the outcome is cached on the
// lead as org_status (saved | warn | none) + org_note. A CEO-mismatch heuristic
// (the lead claims a top title but theorg's root is someone else) sets 'warn',
// which BLOCKS outreach generation until the operator confirms the slug.
export async function orgChartForLead(env, { id, refresh = false, slug = null } = {}) {
  const lead = await getLead(env, id);
  if (!lead) return { error: 'no lead' };
  if (!refresh && !slug && lead.org_status) {
    const people = await listOrgPeople(env, id);
    if (people.length || lead.org_status === 'none') {
      return { company: lead.company, people, status: lead.org_status, note: lead.org_note, fromDb: true };
    }
  }
  if (!lead.company && !slug && !lead.theorg_slug) {
    await updateLead(env, id, { org_status: 'none', org_note: 'no company on the lead yet' });
    return { error: 'no company on the lead yet', people: [], status: 'none' };
  }
  const useSlug = (slug && String(slug).trim()) || lead.theorg_slug || null;
  // Accept a pasted theorg URL as the slug override.
  const cleanSlug = useSlug ? (useSlug.match(/theorg\.com\/org\/([^/?#]+)/) || [null, useSlug])[1] : null;
  const r = await fetchTheorg(env, { company: lead.company, slug: cleanSlug });
  if (r.error) {
    await updateLead(env, id, { org_status: 'none', org_note: r.error, theorg_slug: cleanSlug || lead.theorg_slug });
    return { ...r, status: 'none' };
  }
  // Localize photos into R2 (theorg URLs expire / hotlink-block).
  const localized = [];
  for (const p of r.people) {
    let photo = p.photo;
    if (photo && /^https?:/i.test(photo)) {
      const stored = await storeLeadPhoto(env, photo, `gtm/org/${id}/${p.nodeId}.jpg`);
      if (stored) photo = stored;
    }
    localized.push({ ...p, photo });
  }
  await replaceOrgPeople(env, id, r.company, localized);
  // CEO-mismatch heuristic: lead has a top title but the org root is someone else.
  const topTitle = /\b(ceo|founder|co-?founder|president|owner)\b/i.test(String(lead.position || ''));
  const roots = localized.filter((p) => !p.parentId);
  const leadIsRoot = roots.some((p) => namesMatch(p.name, lead.name));
  let status = 'saved', note = null;
  if (topTitle && roots.length && !leadIsRoot) {
    status = 'warn';
    note = `${lead.name} reads as a top exec but theorg's chart for "${r.company}" is headed by ${roots[0]?.name}. Possible namesake company — confirm the theorg slug.`;
  }
  await updateLead(env, id, { org_status: status, org_note: note, theorg_slug: cleanSlug || lead.theorg_slug });
  // Copy the prospect's theorg photo onto the lead if it has none.
  if (!(await getLead(env, id)).photo) {
    const self = localized.find((p) => namesMatch(p.name, lead.name));
    if (self?.photo) await updateLead(env, id, { photo: self.photo });
  }
  await logEvent(env, { kind: 'gtm_org_chart', actor: 'operator', payload: { id, company: r.company, people: localized.length, status } });
  const people = await listOrgPeople(env, id);
  return { company: r.company, people, status, note };
}

// ── warm-path detection: You.connections × org people ───────────────────────

// Levenshtein-tolerant name match (<=2 edits, first+last token match).
function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

export function namesMatch(a, b) {
  const ta = String(a || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const tb = String(b || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const first = lev(ta[0], tb[0]) <= 2 && Math.min(ta[0].length, tb[0].length) >= 3 ? true : ta[0] === tb[0];
  const la = ta[ta.length - 1], lb = tb[tb.length - 1];
  const last = ta.length < 2 || tb.length < 2 ? true : (lev(la, lb) <= 2 && Math.min(la.length, lb.length) >= 3 ? true : la === lb);
  return first && last;
}

// Which of a lead's org people match the operator's warm connections.
export async function contactsInOrg(env, leadId) {
  const you = await readYou(env);
  const conns = you.connections || [];
  if (!conns.length) return [];
  const people = await listOrgPeople(env, leadId);
  return people.filter((p) => conns.some((c) => namesMatch(c, p.name))).map((p) => ({ name: p.name, role: p.role }));
}

// Green leads for the Enrich/Outreach tabs, with has_contact flags.
// BATCHED on purpose: the old shape called contactsInOrg per lead (a knowledge
// read + an org query each — ~2 subrequests/lead). At ~10 greens that was fine;
// the first big import pushed it past the Worker's 50-subrequest budget, the
// invocation died with error 1102, and the Enrich tab rendered blank. Now it is
// one knowledge read + one IN() query regardless of lead count.
export async function greenLeads(env) {
  const leads = await listLeads(env, { stage: 'green' });
  if (!leads.length) return [];
  const you = await readYou(env);
  const conns = you.connections || [];

  // all org people for all green leads, chunked to stay under D1's bind limit
  const byLead = new Map();
  const ids = leads.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const r = await env.DB.prepare(
      `SELECT lead_id, name, role FROM gtm_org_people WHERE lead_id IN (${chunk.map(() => '?').join(',')}) ORDER BY created_at`,
    ).bind(...chunk).all();
    for (const p of r.results || []) {
      if (!byLead.has(p.lead_id)) byLead.set(p.lead_id, []);
      byLead.get(p.lead_id).push(p);
    }
  }

  return leads.map((l) => {
    const people = byLead.get(l.id) || [];
    const contacts = conns.length
      ? people.filter((p) => conns.some((c) => namesMatch(c, p.name))).map((p) => ({ name: p.name, role: p.role }))
      : [];
    return { ...l, has_contact: contacts.length > 0, contacts };
  });
}

// ── ICP fit ──────────────────────────────────────────────────────────────────

export async function scoreIcpFit(env, leadId) {
  const lead = await getLead(env, leadId);
  if (!lead) return { error: 'no lead' };
  // The scorer judges name + title + company; without them the verdict is
  // noise. Enforced here — not just in a surface — so every caller (GTM
  // Enrich, Prospecting Qualification, the Nyo tool) shares one definition
  // and no LLM call is spent on a meaningless prospect.
  if (!String(lead.name || '').trim() || !lead.company || !lead.position) {
    return { error: 'needs a name, company and title before ICP match' };
  }
  const people = await listOrgPeople(env, leadId);
  // Single source of truth: the brand-baseline ICP (brand-icp). No gtm-specific
  // ICP copy — the ICP is the ICP, defined once in the brand tree.
  const icp = await gtmDoc(env, 'brand-icp', 'ICP not written yet — judge loosely by seniority + reachability.');
  const org = people.map((p) => `${p.name} - ${p.role}`).join('\n') || '(no org on file)';
  // Company facts gathered by companyContextForLead. The ICP is mostly a
  // statement about COMPANIES (size band, geography, technology-dependence), so
  // without these the model was inferring headcount from a brand name it may
  // never have heard of.
  const size = Number.isFinite(Number(lead.company_staff_count)) ? Number(lead.company_staff_count) : null;
  let openRoles = [];
  try { openRoles = JSON.parse(lead.open_positions || '[]') || []; } catch { openRoles = []; }
  const rolesLine = openRoles.length
    ? openRoles.slice(0, 12).map((p) => p.title).filter(Boolean).join(' · ')
    : (lead.positions_checked_at ? '(checked — none open)' : '(not checked)');
  const system = `Score how well a prospect fits this Ideal Customer Profile.

ICP:
${icp}

Return STRICT JSON only:
{"fit":"strong|medium|weak","reasons":["1-2 word tag"],"gaps":["1-2 word tag"]}
Each reason and gap is a 1 to 2 word tag, ultra glanceable, NOT a sentence and NOT a phrase (e.g. "Israeli founder", "reachable exec", "enterprise", "wrong stage", "no build need"). At most 3 of each. Judge only against the ICP. If a disqualifier applies, fit is weak.
Company facts come from LinkedIn and theorg. "unknown" or "not checked" means we have not looked it up — treat it as missing evidence, NEVER as a zero and never as a disqualifier on its own.`;
  const prompt = `PROSPECT: ${lead.name} - ${lead.position || '?'} at ${lead.company || '?'} (${[lead.region, lead.country].filter(Boolean).join(', ') || 'location unknown'})
COMPANY: ${lead.company || '?'} — ${size !== null ? `${size} employees (LinkedIn)` : 'headcount unknown'}
OPEN ROLES: ${rolesLine}
ORG CHART:
${org}

Produce the JSON.`;
  try {
    const out = extractJson(await gtmLLM(env, { system, prompt, model: env.ANTHROPIC_MODEL }));
    const fit = ['strong', 'medium', 'weak'].includes(out.fit) ? out.fit : 'weak';
    const fresh = await updateLead(env, leadId, { icp_fit: fit, icp_reasons: JSON.stringify({ reasons: out.reasons || [], gaps: out.gaps || [] }) });
    // Record the run in the lead's step history so a surface can show WHEN the
    // ICP match ran, not just its result. Merged over the row updateLead just
    // returned — NOT the pre-LLM read — so an enrich that finished during the
    // multi-second LLM call keeps its verdicts. A separate write on purpose:
    // the `steps` column arrives by a MANUAL migration (0056), and a missing
    // column must not take the scoring — already persisted above — down with it.
    try {
      let prior = [];
      try { prior = JSON.parse(fresh?.steps) || []; } catch { prior = []; }
      const steps = (Array.isArray(prior) ? prior : []).filter((s) => s && s.key !== 'icp');
      steps.push({ key: 'icp', label: 'ICP match', status: 'found', reason: fit, at: now() });
      await updateLead(env, leadId, { steps: JSON.stringify(steps) });
    } catch (e) {
      console.error('gtm: icp step verdict not persisted (is migration 0056 applied?)', e?.message || e);
    }
    await logEvent(env, { kind: 'gtm_icp_scored', actor: 'operator', payload: { id: leadId, fit } });
    return { fit, reasons: out.reasons || [], gaps: out.gaps || [] };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ── the company behind the lead (LinkedIn) ───────────────────────────────────

// Resolve the lead's company on LinkedIn once and KEEP what comes back.
// getLiCompany answers { company_id, name, universal_name, staff_count, url }:
// company_id is what the jobs API needs, and staff_count is the size band the
// ICP is largely written in ("50 employees or fewer", "200 to 500"). Before the
// company_* columns existed this function's caller took the id and dropped the
// rest, so the most load-bearing ICP criterion was never on the lead.
//
// Cached on the lead behind company_checked_at: a bulk pass over a list re-pays
// the throttled Voyager call only for leads never checked (or gone stale), which
// is what makes "fetch company context" safe to run on 50 rows.
//
// FAILURES are cached too, on a much shorter clock. Stamping only successes
// meant a lead whose resolve failed — an expired session, a private page, a bad
// name-slug — was re-attempted in full on every pass, so the exact rows that
// cost the most were the ones the cache never covered. The short retry window
// keeps a transient outage from being remembered for a month.
// The person's own LinkedIn names their current employer, and that beats
// slugifying the company NAME: "Entrio" -> "entrio" is a guess that lands on
// whichever company happens to own the slug, which is exactly how a namesake
// gets attached. The profile is what LinkedIn itself links to.
//
// Deliberately tolerant about shape. The daemon hands back the raw voyager blob
// and the useful key sits in different places across versions, so this reads the
// likely ones and returns null rather than guessing. Null just falls through to
// the old name-slug path, so a shape we do not recognise costs nothing.
const personPublicId = (lead) =>
  (String(lead?.linkedin || '').match(/linkedin\.com\/in\/([^/?#]+)/i) || [])[1] || null;

function companySlugFromProfile(profile) {
  const exp = Array.isArray(profile?.experience) ? profile.experience[0] : null;
  for (const c of [profile?.current_company, exp?.company, exp]) {
    if (!c || typeof c !== 'object') continue;
    const direct = c.universal_name || c.universalName || c.public_id || c.publicIdentifier;
    if (direct) return String(direct);
    const m = String(c.url || c.companyUrl || c.company_url || c.link || '').match(/\/company\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}

async function resolveLiCompany(env, lead, { refresh = false } = {}) {
  const pol = await loadGtmPolicy(env);
  let prevCtx = null;
  try { prevCtx = JSON.parse(lead.company_context || 'null'); } catch { prevCtx = null; }
  const lastFailed = !!prevCtx?.error;
  const ttl = lastFailed
    ? pol.company_retry_after_hours * 60 * 60 * 1000
    : pol.company_context_max_age_days * 24 * 60 * 60 * 1000;
  const checkedRecently = lead.company_checked_at && (now() - lead.company_checked_at) < ttl;
  if (!refresh && checkedRecently && (lead.company_li_id || lastFailed)) {
    return lastFailed
      ? { error: `${prevCtx.error} (cached — retried at most every ${pol.company_retry_after_hours}h)`, cached: true }
      : { company_id: lead.company_li_id, staff_count: lead.company_staff_count ?? null, cached: true };
  }
  // Company slug, in order of trust:
  //   1. a /company/ URL the OPERATOR pasted by hand (src:'manual') — a
  //      deliberate correction, so it outranks everything.
  //   2. the contact's own mapped LinkedIn profile — LinkedIn's own answer to
  //      "where does this person work", which beats a guess from the name.
  //   3. today's fallback: any /company/ URL already on file (including one a
  //      prior resolve auto-saved), then the company NAME slugified.
  //
  // Reaching the company THROUGH the person is what un-sticks the old trap: a
  // successful resolve writes the page URL back into socials (below), so a
  // name-slug guess that once landed on a namesake used to win at step 1 on
  // every later run and the profile was never consulted again. Now only a manual
  // paste pre-empts the profile; a stored AUTO url (src:'linkedin') is demoted to
  // a fallback, so a fresh resolve can correct it.
  let socialList = [];
  try { socialList = JSON.parse(lead.socials || '[]') || []; } catch { socialList = []; }
  const companySlugWhere = (pred) => {
    const hit = socialList.find((x) => /linkedin\.com\/company\//i.test(x?.url || '') && pred(x));
    return hit ? (String(hit.url).match(/\/company\/([^/?#]+)/) || [])[1] : null;
  };

  // Candidate slugs in trust order, resolved LAZILY: each source is only computed
  // when the loop reaches it, and getLiCompany is tried against each until one
  // resolves. This is the crucial difference from committing to a single top
  // slug — the profile now leads, but if its company slug is stale / renamed /
  // private and 404s, a proven stored URL still saves the lead. "A dead session
  // must never cost a headcount we already hold" applies to a dead SLUG too.
  //
  // Laziness also keeps the throttled getProfile read off the fast path: a manual
  // URL that resolves first means the profile is never fetched at all.
  const attempts = [
    { source: 'manual-url', get: () => companySlugWhere((x) => x?.src === 'manual') },       // 1. operator paste
    { source: 'profile',    get: async () => {                                               // 2. the mapped profile
      const pid = personPublicId(lead);
      if (!pid) return null;
      try { return companySlugFromProfile(await getProfile(env, pid)); }
      catch { return null; } // best effort — the fallbacks below still apply
    } },
    { source: 'stored-url', get: () => companySlugWhere(() => true) },                        // 3a. any stored /company/ url
    { source: 'name-slug',  get: () => lead.company                                           // 3b. name slug (the namesake risk)
      ? String(lead.company).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null },
  ];
  let c = null, slug = null, slugSource = null, lastErr = null;
  const tried = new Set();
  for (const a of attempts) {
    const s = await a.get();
    if (!s || tried.has(s)) continue; // dedup: manual==stored, profile==stored, etc.
    tried.add(s);
    try { c = await getLiCompany(env, s); slug = s; slugSource = a.source; break; }
    catch (e) { lastErr = e; /* try the next, less-trusted candidate */ }
  }
  if (!c) {
    if (tried.size === 0) return { error: 'no company name or LinkedIn /company/ url on the lead' };
    const error = `LinkedIn company resolve failed for slug(s) "${[...tried].join('", "')}": ${String(lastErr?.message || lastErr)}. Paste the company's linkedin.com/company/ URL into the lead's socials and retry.`;
    // Remember the FAILURE (not the values) so the retry window applies. The
    // value columns are deliberately untouched: a dead session must never cost
    // a headcount we already hold.
    try {
      await updateLead(env, lead.id, { company_context: JSON.stringify({ error, at: now() }), company_checked_at: now() });
      await logEvent(env, { kind: 'gtm_company_resolved', actor: 'operator', payload: { id: lead.id, ok: false, error: error.slice(0, 200) } });
    } catch { /* the column may predate migration 0057 — the error still returns */ }
    return { error };
  }
  // COALESCE, never clobber: getLiCompany can answer 200 with no staff_count
  // (private page, incomplete profile), and overwriting a good headcount with
  // null would make a checked row render as "not checked" — a lie about data we
  // already had. Same reasoning as the company id just below.
  const fresh = Number.isFinite(Number(c?.staff_count)) ? Number(c.staff_count) : null;
  const staff = fresh ?? (lead.company_staff_count ?? null);
  const cid = c?.company_id || lead.company_li_id || null;
  const answered = !!(c?.name || fresh !== null);
  const snapshot = answered
    ? { name: c?.name ?? null, universal_name: c?.universal_name ?? null, url: c?.url ?? null, staff_count: staff, at: now() }
    : { ...(prevCtx && !prevCtx.error ? prevCtx : {}), staff_count: staff, at: now() };
  // The company_* columns arrive by a MANUAL migration (0057). If a deploy ever
  // lands ahead of it, still persist the company id — the jobs fetch depends on
  // it — and lose only the size snapshot.
  // Stamp provenance whenever LinkedIn actually answered with a figure. The
  // 'manual' marker is load-bearing — manualEditLead preserves a hand-entered
  // headcount across a company correction — so a fetched number must overwrite
  // the marker too, or it inherits protection it did not earn. A coalesced
  // value (LinkedIn had none) leaves the existing stamp alone, because the
  // number it describes has not changed.
  let srcs = {};
  try { srcs = JSON.parse(lead.sources || '{}') || {}; } catch { srcs = {}; }
  if (fresh !== null) srcs.company_staff_count = { tool: 'linkedin_company', at: new Date().toISOString() };

  // Keep the company PAGE, not just its numeric id — it is what the prospect
  // card links to, and until now a lead could carry a resolved company with no
  // way to open it. Rules, in order:
  //   - never touch a url the OPERATOR pasted (src:'manual') — their link wins;
  //   - never re-add one sitting in `dismissed` (they corrected it away);
  //   - if the PROFILE just resolved a DIFFERENT company than a stale AUTO url on
  //     file, REPLACE it — the point of going through the person is that the card
  //     link and the headcount end up describing the same company;
  //   - otherwise append only when the lead has no company url yet (unchanged).
  let socialsPatch = null;
  const pageUrl = c?.url || (c?.universal_name ? `https://www.linkedin.com/company/${c.universal_name}/` : null);
  if (pageUrl) {
    let dismissed = [];
    try { dismissed = JSON.parse(lead.dismissed || '[]') || []; } catch { dismissed = []; }
    const isCompany = (s) => /linkedin\.com\/company\//i.test(s?.url || '');
    const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
    const hasManual = socialList.some((s) => isCompany(s) && s?.src === 'manual');
    const already = socialList.some((s) => isCompany(s) && norm(s.url) === norm(pageUrl));
    const hasAuto = socialList.some((s) => isCompany(s) && s?.src !== 'manual');
    if (!hasManual && !already && !dismissed.includes(pageUrl)) {
      if (slugSource === 'profile' && hasAuto) {
        // Un-stick: drop the (non-manual) company url the profile just corrected
        // away, keep everything else, add the resolved page.
        const kept = socialList.filter((s) => !(isCompany(s) && s?.src !== 'manual'));
        socialsPatch = JSON.stringify([...kept, { type: 'linkedin_company', url: pageUrl, src: 'linkedin' }]);
      } else if (!hasAuto) {
        // No company url on file — append (today's behavior). A non-profile source
        // that merely DIFFERS from a stored url is left alone: it is less trusted
        // than the url already there.
        socialsPatch = JSON.stringify([...socialList, { type: 'linkedin_company', url: pageUrl, src: 'linkedin' }]);
      }
    }
  }
  try {
    await updateLead(env, lead.id, {
      company_li_id: cid,
      company_staff_count: staff,
      company_context: JSON.stringify(snapshot),
      company_checked_at: now(),
      ...(fresh !== null ? { sources: JSON.stringify(srcs) } : {}),
      ...(socialsPatch ? { socials: socialsPatch } : {}),
    });
    await logEvent(env, { kind: 'gtm_company_resolved', actor: 'operator', payload: { id: lead.id, ok: true, company_id: cid, staff_count: staff, slug, slug_source: slugSource } });
  } catch (e) {
    console.error('gtm: company context not persisted (is migration 0057 applied?)', e?.message || e);
    try { await updateLead(env, lead.id, { company_li_id: cid }); } catch { /* id is best-effort too */ }
  }
  return { company_id: cid, staff_count: staff, name: c?.name || null, url: c?.url || null };
}

export async function openRolesForLead(env, leadId) {
  const lead = await getLead(env, leadId);
  if (!lead) return { error: 'no lead' };
  const c = await resolveLiCompany(env, lead);
  if (c.error) return { error: c.error };
  if (!c.company_id) return { error: 'could not resolve a LinkedIn company id' };
  try {
    const r = await getLiCompanyJobs(env, c.company_id);
    const positions = r.positions || [];
    await updateLead(env, leadId, { open_positions: JSON.stringify(positions), positions_checked_at: now() });
    await logEvent(env, { kind: 'gtm_open_roles', actor: 'operator', payload: { id: leadId, count: positions.length } });
    return { positions, company_id: c.company_id, count: positions.length, staff_count: c.staff_count ?? null };
  } catch (e) {
    return { error: `jobs fetch: ${String(e.message || e)}`, company_id: c.company_id };
  }
}

// Everything we can learn about the COMPANY behind a lead, in one pass: theorg's
// org chart, LinkedIn's headcount, LinkedIn's open roles. Exists so qualification
// can be run in bulk against real company facts instead of the model's guess
// about a brand name — see scoreIcpFit, which reads all three back.
//
// PARTIAL BY DESIGN: theorg and LinkedIn fail independently (a namesake company,
// an expired LI session, a private page). A lead that ends up with an org chart
// but no headcount is strictly better off than one with neither, so a failed leg
// is collected and reported, never fatal.
export async function companyContextForLead(env, leadId, { refresh = false } = {}) {
  const at = now();
  const lead = await getLead(env, leadId);
  if (!lead) return { error: 'no lead' };
  if (!lead.company) return { error: 'no company on the lead yet' };

  const org = await orgChartForLead(env, { id: leadId, refresh });
  // Re-read: orgChartForLead may have written to the lead (photo, org_status).
  const company = await resolveLiCompany(env, await getLead(env, leadId), { refresh });
  // Cheap after the resolve above — openRolesForLead's own resolve is a cache hit.
  // Skipped without an id: the jobs API is keyed on it, and re-reporting the
  // resolve failure here would surface one root cause as two separate problems.
  const roles = company.company_id ? await openRolesForLead(env, leadId) : { skipped: true };

  // Report the lead's ACTUAL state, not just what this run resolved. A failed
  // leg leaves the previously-stored facts in place on purpose, so reporting the
  // run's own (empty) result would tell every caller — including the sheet that
  // paints the Size column — that a known headcount is unknown.
  const after = await getLead(env, leadId);
  let storedRoles = [];
  try { storedRoles = JSON.parse(after?.open_positions || '[]') || []; } catch { storedRoles = []; }

  const out = {
    company: org.company || lead.company,
    org_people: (org.people || []).length,
    org_status: org.status ?? null,
    org_note: org.note ?? null,
    staff_count: after?.company_staff_count ?? null,
    open_roles: storedRoles.length,
    // Deduped: the legs share failure modes (one dead LinkedIn session breaks
    // both the resolve and the jobs fetch) and the operator needs the distinct
    // causes, not a tally.
    errors: [...new Set([org.error, company.error, roles.error].filter(Boolean))],
  };

  const found = out.org_people > 0 || out.staff_count !== null || out.open_roles > 0;
  const summary = [
    out.staff_count !== null ? `${out.staff_count} employees` : null,
    out.org_people ? `${out.org_people} org people` : null,
    out.open_roles ? `${out.open_roles} open roles` : null,
  ].filter(Boolean).join(' · ');
  // Same tolerant, merged-per-key step write the ICP match uses (migration 0056).
  try {
    let prior = [];
    try { prior = JSON.parse(after?.steps) || []; } catch { prior = []; }
    const steps = (Array.isArray(prior) ? prior : []).filter((s) => s && s.key !== 'company');
    steps.push({ key: 'company', label: 'Company', status: found ? 'found' : 'empty', reason: found ? summary : (out.errors[0] || 'nothing found'), at });
    await updateLead(env, leadId, { steps: JSON.stringify(steps) });
  } catch (e) {
    console.error('gtm: company step verdict not persisted (is migration 0056 applied?)', e?.message || e);
  }

  await logEvent(env, {
    kind: 'gtm_company_context',
    actor: 'operator',
    payload: { id: leadId, staff_count: out.staff_count, org_people: out.org_people, open_roles: out.open_roles, errors: out.errors.length },
  });
  return out;
}

// Health probe — empty POST answers 400, which still proves theorg is up,
// and no real query means health probes never hit quota.
export async function probeTheorg(env) {
  try {
    const r = await fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-org-client': 'web' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    return { ok: true, http: r.status };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}
