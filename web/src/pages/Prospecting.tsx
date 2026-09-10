// Prospecting — a second surface over the SAME GTM lead store, tuned for the
// list-first way of working: upload a phone list, watch the enrichment chain
// fill it in, and read the whole sheet at a glance. It reuses GTM's shared
// endpoints wholesale (api.gtm*) — no private tools, no new routes — and only
// re-visualizes what they already return:
//   • List Enrichment  — a tight, compact table of one batch. Columns run
//     Phone → Name → Company → Title → LinkedIn → Email; a dot-strip marks the
//     enrichment steps already run; the identity-confidence popover floats the
//     uncertainty; and the whole row is painted on a traffic-light scale —
//     GREEN only when the profile is both fully enriched (state) AND identity
//     holds together (confidence). A Truecaller button per row is the fast lane
//     for a manual identity check.
//   • Qualification — the SAME table, but consolidating the verified (green)
//     contacts from ALL lists, with multiselect + a manually-triggered "ICP
//     match" step (the shared scoreIcpFit ability GTM's Enrich tab uses) and a
//     strong/medium/weak qualification column.
//
// state (completeness) + confidence (identity) + truecaller_url all come back
// on every lead from api.gtmLeads / api.gtmGreen — this page derives nothing the
// backend doesn't already own.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  api, type GtmLead, type GtmBatch, type GtmGreenLead, type GtmConfidence,
  type OutreachCohort, type OutreachAddResult,
} from '../lib/api';
import { WatchTab } from '../components/WatchTab';
import {
  Target, Sparkle, Refresh, Truecaller, X, Send,
  LinkedIn, User, Users, Twilio, Octopus, CheckSquare,
} from '../components/Icons';

type Tab = 'list' | 'qualification' | 'watch';
const TAB_KEY = 'nyyon.prospecting.tab.v1';

const btn = 'h-8 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] transition bg-card text-mute hover:text-ink disabled:opacity-40';
const btnPrimary = 'h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] transition bg-ink text-paper hover:opacity-90 disabled:opacity-40';

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function parseJson<T>(s: string | null | undefined, dflt: T): T {
  try { return s ? (JSON.parse(s) as T) : dflt; } catch { return dflt; }
}
const digits = (p: string | null) => String(p || '').replace(/\D/g, '');
const waHref = (phone: string | null) => `https://wa.me/${digits(phone)}`;
// Display names in a consistent Title Case regardless of how a source stamped
// them ("DANA LEVIN" / "dana levin" → "Dana Levin"). Presentation only — the
// stored value is never rewritten. Each letter-run is capitalized (so
// "jean-pierre" → "Jean-Pierre", "o'brien" → "O'Brien"); an already mixed-case
// word (McDonald, DeVito) keeps its inner caps, and non-cased scripts (Hebrew)
// pass through untouched.
const titleCase = (s: string | null) =>
  String(s || '').replace(/\p{L}+/gu, (w) =>
    (w === w.toUpperCase() || w === w.toLowerCase())
      ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1));
// A linkedin.com/company/ page is the COMPANY, never the person — and it can
// arrive in EITHER place a profile is read from (the `linkedin` column or a
// socials entry typed 'linkedin'). Mirrors leadState's definition server-side,
// so the dot, the "needs" list and this link can never disagree.
const isCompanyLi = (u: string | null | undefined) => /linkedin\.com\/company\//i.test(String(u || ''));
const linkedinOf = (l: GtmLead) =>
  (l.linkedin && !isCompanyLi(l.linkedin) ? l.linkedin : null)
  || parseJson<{ type: string; url: string }[]>(l.socials, [])
       .find((s) => s.type === 'linkedin' && !isCompanyLi(s.url))?.url
  || null;

// ── traffic light ────────────────────────────────────────────────────────────
// The row tone is the WORSE of the two independent signals the backend derives:
// `state` (are all the fields present) and `confidence.level` (does the identity
// hold together). Green needs both green — exactly "fully enriched AND high
// confidence regarding identity". A missing confidence never drags a row down.
type Tone = 'green' | 'yellow' | 'red';
const RANK: Record<Tone, number> = { green: 2, yellow: 1, red: 0 };
const DOT: Record<Tone, string> = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-rose-500' };
const ROW_TINT: Record<Tone, string> = {
  green:  'border-l-emerald-500 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.10]',
  yellow: 'border-l-amber-400 bg-amber-400/[0.07] hover:bg-amber-400/[0.11]',
  red:    'border-l-rose-400 bg-rose-500/[0.05] hover:bg-rose-500/[0.09]',
};
function rowTone(l: GtmLead): Tone {
  const s: Tone = (l.state as Tone) || 'red';
  const c: Tone = l.confidence?.level ?? 'green'; // absent → don't penalize
  const r = Math.min(RANK[s], RANK[c]);
  return r === 2 ? 'green' : r === 1 ? 'yellow' : 'red';
}

// ── enrichment steps ─────────────────────────────────────────────────────────
// Which stages of the chain (locate → LinkedIn → PDL → Twilio →
// Google) actually ran, read off the per-field provenance the backend records
// in leads.sources ({field:{tool,at}}). Locate leaves no provenance row, so it
// is inferred from the phone metadata it writes (region/country/carrier/line).
// The chain as enrichFullOne actually runs it (gtm.js), in order. Locate is NOT
// here: it runs once at import off the phone prefix, not per enrichment.
const STEP_DEFS: { key: string; label: string; hint: string; Icon: (p: { size?: number; className?: string }) => ReactNode }[] = [
  { key: 'li',      label: 'LinkedIn', Icon: LinkedIn,    hint: 'Company + title read off the verified LinkedIn profile. Runs BEFORE PDL because it is cheap and authoritative. Skipped when there is no linkedin on file, or the company is already known.' },
  { key: 'pdl',     label: 'PDL',      Icon: User,        hint: 'People Data Labs — phone-anchored identity (name, company, title, email, location). PAID, so it is hard-skipped whenever name AND company are already present.' },
  { key: 'twilio',  label: 'Twilio',   Icon: Twilio,      hint: 'Line type + carrier, always. Caller-ID name only if the lead is still nameless.' },
  { key: 'serp',    label: 'SerpApi',  Icon: Octopus,     hint: 'Google search for socials. Hard-gated on already having a sourced name — it will never search an invented name into a false identity. LinkedIn hits must pass identity verification to attach.' },
  { key: 'confirm', label: 'Confirm',  Icon: CheckSquare, hint: 'Final LinkedIn reconciliation: with a linkedin on file, the company read off it is authoritative. Only applies when a linkedin exists.' },
];
const STEP_TOOLS: Record<string, string[]> = {
  li:     ['company_from_linkedin'],
  pdl:    ['pdl_enrich'],
  twilio: ['twilio_lookup'],
  serp:   ['serp_search'],
};
// Three states per step, because "no data" and "never ran" are different facts:
//   done  — the step ran and wrote something
//   empty — the step ran and came back with nothing (or its provider has no key)
//   idle  — the chain has not reached this lead yet
// There is no per-step attempt log, but `status` flips to 'enriched' only after
// the WHOLE chain has run (gtm.js enrichFullOne), so on an enriched lead a step
// with no trace is one that genuinely found nothing.
type StepState = 'done' | 'empty' | 'skipped' | 'idle';
// Per-step verdict + the reason behind it. The API now records this at enrich
// time (lead.steps); everything below the first branch is the legacy fallback
// for leads enriched before migration 0056, which can only infer from
// provenance and therefore cannot see a skip.
type StepRead = { state: StepState; reason: string | null; recorded: boolean };

// Merged PER KEY, not all-or-nothing: a "resume" writes verdicts for only the
// steps it re-ran, so a lead enriched before 0056 ends up with a partial record.
// Each step therefore prefers its own recorded verdict and falls back to the
// provenance inference individually — otherwise resuming a legacy lead would
// claim its four untouched steps had never run.
function readSteps(l: GtmLead): Record<string, StepRead> {
  const recorded = new Map((l.steps || []).map((s) => [s.key, s]));
  const legacy = stepStates(l);
  const out: Record<string, StepRead> = {};
  for (const d of STEP_DEFS) {
    const r = recorded.get(d.key);
    if (r) {
      const state: StepState =
        r.status === 'found'     ? 'done'
        : r.status === 'skipped' ? 'skipped'
        : 'empty';   // 'error' is still "we got nothing", with the reason attached
      out[d.key] = { state, reason: r.reason, recorded: true };
    } else {
      out[d.key] = { state: legacy[d.key], reason: null, recorded: false };
    }
  }
  return out;
}

function stepStates(l: GtmLead): Record<string, StepState> {
  // A step stamps itself in one of THREE places, not just one: per-field
  // provenance (sources), the origin of a social link it attached
  // (socials[].src), and the tool that raised a disagreement (conflicts[].tool).
  // Google/SERP only ever writes the latter two — reading `sources` alone left
  // its dot dark no matter how many times it ran.
  const tools = new Set<string>([
    ...Object.values(parseJson<Record<string, { tool: string; at: string }>>(l.sources, {})).map((s) => s.tool),
    ...parseJson<{ src?: string }[]>(l.socials, []).map((s) => s.src || ''),
    ...parseJson<{ tool?: string }[]>(l.conflicts, []).map((c) => c.tool || ''),
  ]);
  // 'dead_end' also means the chain was attempted (we tried, then gave up), so a
  // step with no trace on such a lead reads as "ran, found nothing", not "idle".
  const ran = l.status !== 'new';
  const out: Record<string, StepState> = {};
  for (const s of STEP_DEFS) {
    if (s.key === 'confirm') {
      // The finalize pass writes the SAME company_from_linkedin provenance as the
      // first LinkedIn pass, so the two runs are indistinguishable in the stored
      // data. What this reports is therefore the OUTCOME the pass exists to
      // guarantee: given a linkedin on file, did we end up with a company off it.
      out.confirm = !l.linkedin ? 'idle' : l.company ? 'done' : ran ? 'empty' : 'idle';
      continue;
    }
    out[s.key] = (STEP_TOOLS[s.key] || []).some((t) => tools.has(t)) ? 'done' : ran ? 'empty' : 'idle';
  }
  return out;
}
// The same three colours the dots carried, as text tones so each glyph inherits
// its state through currentColor.
const STEP_TONE: Record<StepState, string> = {
  done:    'text-sky-600 dark:text-sky-400',  // blue = this step actually landed data
  empty:   'text-amber-500',
  skipped: 'text-mute/55',   // deliberately not called — a saving, not a failure
  idle:    'text-mute/20',
};
const STEP_WORD: Record<StepState, string> = {
  done:    'found data',
  empty:   'ran — nothing found',
  skipped: 'skipped on purpose',
  idle:    'not run yet',
};

// ── the manual steps (Qualification tab) ─────────────────────────────────────
// Two more steps that never run inside the enrichment chain — only from the
// Qualification tab's multiselect — so they live outside STEP_DEFS and are
// appended per-surface. Order is the order you'd run them: gather the company
// facts, then judge against them.
const COMPANY_STEP: (typeof STEP_DEFS)[number] = {
  key: 'company', label: 'Company', Icon: Users,
  hint: 'The company behind the lead, in one pass: theorg org chart + LinkedIn headcount + LinkedIn open roles. Manual — select rows and run it. The ICP is mostly a statement about COMPANIES (size band, geography), so this is what turns a fit verdict from a guess about the brand name into a judgement on real data.',
};
const ICP_STEP: (typeof STEP_DEFS)[number] = {
  key: 'icp', label: 'ICP match', Icon: Target,
  hint: 'Match against the brand ICP (the editable brand-icp knowledge doc): strong / medium / weak + reason and gap tags. Manual — select rows and run it. Reads whatever company facts are on file, so run Company first for a grounded verdict.',
};
const MANUAL_STEPS = [COMPANY_STEP, ICP_STEP];
// Their keys, so anything reading the chain's own record can exclude them.
const MANUAL_KEYS = new Set(MANUAL_STEPS.map((d) => d.key));
// The precondition: the scorer judges name + title + company, so a row missing
// any of them would burn an LLM call on a meaningless verdict. The AUTHORITY on
// this rule is scoreIcpFit server-side (it rejects such leads); this mirror only
// drives the disabled-checkbox affordance.
const icpEligible = (l: GtmLead) => !!(String(l.name || '').trim() && l.company && l.position);
// Same tones the Verified Contacts cards already use for the fit chip.
const FIT_TONE: Record<'strong' | 'medium' | 'weak', string> = {
  strong: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  weak:   'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
};
function icpTitle(l: GtmLead): string {
  const r = parseJson<{ reasons?: string[]; gaps?: string[] }>(l.icp_reasons, {});
  const lines = [`${l.icp_fit} fit — vs the brand ICP`];
  if (r.reasons?.length) lines.push(`reasons: ${r.reasons.join(' · ')}`);
  if (r.gaps?.length) lines.push(`gaps: ${r.gaps.join(' · ')}`);
  return lines.join('\n');
}

// The COMPANY's LinkedIn page (distinct from the person's profile in the
// LinkedIn column). Three sources, best first: the URL the resolve returned, the
// universal_name it matched, then any /company/ link already sitting in the
// lead's socials — which is the SAME link resolveLiCompany prefers when it goes
// looking for a slug, so a row showing one here is a row whose company legs have
// something better than a guess at the company name to work from.
function companyLinkedin(l: GtmLead): string | null {
  const ctx = parseJson<{ url?: string; universal_name?: string }>(l.company_context, {});
  // A failed resolve stores {error, at} here — neither field is present, so this
  // falls through to socials rather than rendering a broken link.
  if (ctx.url) return ctx.url;
  // Encoded like every other consumer of this value (linkedin.js encodes it,
  // gtm-context slugifies it): the origin is a literal so it cannot be
  // redirected, but an unescaped slug would still build a malformed href.
  if (ctx.universal_name) return `https://www.linkedin.com/company/${encodeURIComponent(ctx.universal_name)}`;
  // Scheme-anchored on purpose: manual edits persist socials verbatim, and an
  // unanchored substring test would put whatever was typed into an href.
  const social = parseJson<{ url?: string }[]>(l.socials, [])
    .find((s) => /^https:\/\/([\w.-]+\.)?linkedin\.com\/company\//i.test(s.url || ''));
  return social?.url || null;
}

// Headcount is the ICP's central criterion, so it gets its own column. null is
// "never looked it up", NEVER zero — the same distinction the scorer is told to
// make, so an unchecked row reads as a dash rather than a very small company.
function sizeTitle(l: GtmLead): string {
  const ctx = parseJson<{ name?: string; url?: string }>(l.company_context, {});
  const roles = parseJson<{ title?: string }[]>(l.open_positions, []);
  // Provenance, not a guess: manualEditLead stamps 'manual' on a typed-in
  // figure, so a corrected headcount must not claim to come from LinkedIn.
  const srcs = parseJson<Record<string, { tool?: string }>>(l.sources, {});
  const from = srcs.company_staff_count?.tool === 'manual' ? 'entered by hand' : 'LinkedIn';
  return [
    l.company_staff_count !== null && l.company_staff_count !== undefined
      ? `${l.company_staff_count} employees (${from})`
      : 'headcount not checked yet — run Company context',
    ctx.name ? `matched: ${ctx.name}` : null,
    roles.length ? `${roles.length} open roles` : (l.positions_checked_at ? 'no open roles' : null),
    l.company_checked_at ? `checked ${timeAgo(l.company_checked_at)}` : null,
  ].filter(Boolean).join('\n');
}

// When the enrichment chain last ran, best-effort: the per-step timestamps are
// the precise record; leads enriched before step recording (migration 0056)
// fall back to updated_at, which any later manual edit also bumps — close, not
// exact, and the tooltip says which one it is.
function enrichedInfo(l: GtmLead): { at: number; from: 'steps' | 'updated' } | null {
  // CHAIN steps only. The manual steps (Company context, ICP match) write into
  // the same array, and counting them would make this column report "just now"
  // after every bulk run — destroying the one fact it exists to show.
  const ats = (l.steps || []).filter((s) => !MANUAL_KEYS.has(s.key) && s.at).map((s) => s.at);
  if (ats.length) return { at: Math.max(...ats), from: 'steps' };
  return l.updated_at ? { at: l.updated_at, from: 'updated' } : null;
}

// ── enrichment engine (mirrors GTM's) ────────────────────────────────────────
// Drains one batch by looping api.gtmEnrichBatch until nothing remains. Lives at
// the page level so it survives the List/Verified tab switch, retries transient
// errors with backoff before giving up loudly, and single-flights on a ref so a
// re-render never starts a second loop. Same client-side control loop GTM runs —
// deliberately not shared across pages to keep the two surfaces decoupled.
function useEnrichEngine() {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const start = useCallback(async (id: string) => {
    if (running.current) return;
    running.current = true;
    setBatchId(id);
    setError(null);
    try {
      let rem = 1;
      let errs = 0;
      while (rem > 0 && running.current) {
        try {
          const r = await api.gtmEnrichBatch(id, 2);
          rem = r.remaining;
          setRemaining(rem);
          errs = 0;
        } catch (e) {
          if (++errs > 4) { setError(e instanceof Error ? e.message : String(e)); break; }
          await new Promise((res) => setTimeout(res, Math.min(1000 * 2 ** errs, 15000)));
        }
      }
    } finally {
      running.current = false;
      setBatchId(null);
      setRemaining(0);
    }
  }, []);

  // Halt the drain when the surface goes away. Without this the loop outlives
  // the page, and since GTM auto-resumes any batch with new_count > 0 on ITS
  // mount, hopping Prospecting → GTM mid-run put two loops on the same batch:
  // enrichBatchStep takes leads by status='new' with no lock and only flips the
  // status at the very end, so the same leads ran the paid PDL/Twilio/SerpApi
  // chain twice. One in-flight request can still overlap the handover; the
  // durable fix is a server-side claim, tracked separately.
  useEffect(() => () => { running.current = false; }, []);

  return { batchId, remaining, error, start, isRunning: () => running.current };
}
type EnrichEngine = ReturnType<typeof useEnrichEngine>;

// ─────────────────────────────────────────────────────────────────────────────

export function Prospecting() {
  const [tab, setTab] = useState<Tab>(() => {
    // A stored 'verified' (that tab was removed) or any unknown value → List.
    const t = localStorage.getItem(TAB_KEY); return t === 'qualification' || t === 'watch' ? (t as Tab) : 'list';
  });
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  const engine = useEnrichEngine();

  // Auto-resume a batch left half-enriched (closed tab, refresh, a blip that
  // outlasted the retry budget) — the operator shouldn't have to notice.
  useEffect(() => {
    if (engine.isRunning()) return;
    api.gtmBatches().then((batches) => {
      const stalled = batches.find((b) => (b.new_count ?? 0) > 0);
      if (stalled && !engine.isRunning()) engine.start(stalled.id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 sm:px-6 pt-5 shrink-0">
        <div className="flex items-center gap-2 mono text-[10px] uppercase tracking-[0.2em] text-mute mb-1">
          <Target size={12} />
          <span>Prospecting · list enrichment → qualification</span>
        </div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit">
            {([['list', 'List Enrichment'], ['qualification', 'Qualification'], ['watch', 'Watch']] as [Tab, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={
                  'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.18em] transition ' +
                  (tab === k ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
                }
              >
                {label}
              </button>
            ))}
          </div>
          {engine.batchId && (
            <span className="mono text-[10px] uppercase tracking-[0.15em] text-mute inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-ink animate-pulse" /> enriching · {engine.remaining} left
            </span>
          )}
          {engine.error && !engine.batchId && (
            <span className="mono text-[10px] uppercase tracking-[0.15em] text-rose-500 inline-flex items-center gap-1.5">
              enrichment stalled — {engine.error}
            </span>
          )}
        </div>
      </div>
      {tab === 'list'          && <ListEnrichment engine={engine} />}
      {tab === 'qualification' && <Qualification />}
      {tab === 'watch'         && <WatchTab />}
    </div>
  );
}

// ─── Tab 1 · List Enrichment ─────────────────────────────────────────────────

function ListEnrichment({ engine }: { engine: EnrichEngine }) {
  const [batches, setBatches] = useState<GtmBatch[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [leads, setLeads] = useState<GtmLead[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // A dead fetch must never read as "empty list": leaving `batches` null on a
  // 401 or a down worker renders "No leads in this list", which is a silent lie
  // about the state of the data. Failures are surfaced with a retry instead.
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const refresh = useCallback(async (batchId?: string) => {
    try {
      const b = await api.gtmBatches();
      setBatches(b);
      const use = batchId ?? selected ?? b[0]?.id ?? null;
      setSelected(use);
      setLeads(use ? await api.gtmLeads({ batch_id: use }) : []);
      setError(null);
    } catch (e) { fail(e); }
  }, [selected]);

  // Rename a list — committed on Enter only (blur and Esc cancel), so clicking
  // away never saves a half-typed name.
  async function saveRename() {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    try { await api.gtmRenameBatch(id, value); await refresh(); } catch (e) { fail(e); }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (selected) api.gtmLeads({ batch_id: selected }).then((l) => { setLeads(l); setError(null); }).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Poll while any lead is mid-enrichment or the engine is draining a batch.
  const busy = leads.some((l) => l.active_tool) || !!engine.batchId;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      if (selected) api.gtmLeads({ batch_id: selected }).then(setLeads);
      if (!engine.batchId) refresh(); // engine finished — pick up final batch counts
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, selected, engine.batchId]);

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? leads.filter((l) => [l.name, l.company, l.position, l.email, l.phone, l.normalized_phone]
        .some((v) => String(v || '').toLowerCase().includes(needle)))
    : leads;
  const newCount = leads.filter((l) => l.status === 'new').length;
  const tally = { green: 0, yellow: 0, red: 0 } as Record<Tone, number>;
  for (const l of leads) tally[rowTone(l)]++;
  // The shared endpoint hard-caps at 500 rows, so on a bigger list everything
  // here (count, tally) describes the loaded slice, not the whole batch. Say so
  // rather than let "500 leads" quietly contradict the rail's "2000 leads".
  const batch = (batches || []).find((b) => b.id === selected) || null;
  const total = batch?.created ?? leads.length;
  const capped = total > leads.length;

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0">
      {/* lists rail */}
      <aside className="w-full lg:w-56 shrink-0 border-b lg:border-b-0 lg:border-r border-line overflow-x-auto lg:overflow-x-visible lg:overflow-y-auto p-3 flex flex-row lg:flex-col gap-1 lg:gap-0 lg:space-y-1">
        <button onClick={() => setShowImport(true)} className={btnPrimary + ' w-full shrink-0'}>+ upload list</button>
        {(batches || []).map((b) => (
          <div
            key={b.id}
            role="button"
            tabIndex={0}
            onClick={() => { if (renaming?.id !== b.id) setSelected(b.id); }}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && renaming?.id !== b.id) setSelected(b.id); }}
            className={
              'shrink-0 lg:w-full text-left px-2.5 py-2 rounded-sm transition cursor-pointer ' +
              (selected === b.id ? 'bg-card hairline' : 'hover:bg-card/60')
            }
          >
            {renaming?.id === b.id ? (
              <input
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ id: b.id, value: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                }}
                onBlur={() => setRenaming(null)}
                placeholder="List name"
                title="Enter to save · Esc to cancel"
                className="w-full h-5 hairline rounded-sm bg-paper px-1.5 text-xs focus:outline-none mb-0.5"
              />
            ) : (
              <div
                className="text-xs font-medium truncate"
                onDoubleClick={(e) => { e.stopPropagation(); setRenaming({ id: b.id, value: b.source || '' }); }}
                title="Double-click to rename this list"
              >
                {b.source || b.id}
              </div>
            )}
            <div className="mono text-[10px] text-mute">{b.created} leads · {b.via} · {timeAgo(b.created_at)}</div>
          </div>
        ))}
        {batches && batches.length === 0 && <div className="text-[11px] text-mute px-2 py-4">No lists yet. Upload a phone list to start.</div>}
      </aside>

      {/* the sheet */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-4 sm:px-5 py-3 shrink-0 flex items-center gap-3 flex-wrap border-b border-line">
          <h2 className="text-sm font-semibold">
            {capped
              ? <>first {leads.length} of {total} leads</>
              : <>{leads.length} lead{leads.length === 1 ? '' : 's'}</>}
            {needle && <span className="text-mute font-normal"> · {visible.length} shown</span>}
          </h2>
          {leads.length > 0 && (
            <div
              className="flex items-center gap-2.5 mono text-[10px] text-mute"
              title={capped ? `green / amber / red across the ${leads.length} loaded rows (of ${total})` : 'green / amber / red across this list'}
            >
              {(['green', 'yellow', 'red'] as Tone[]).map((t) => (
                <span key={t} className="inline-flex items-center gap-1"><span className={'h-1.5 w-1.5 rounded-full ' + DOT[t]} />{tally[t]}</span>
              ))}
            </div>
          )}
          <div className="flex-1" />
          {leads.length > 0 && (
            <span className="mono text-[9px] uppercase tracking-[0.12em] text-mute/70 hidden md:inline">dbl-click a cell to edit</span>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter name / company / phone…"
            className="h-8 w-48 hairline rounded-sm bg-card px-2.5 text-xs focus:outline-none"
          />
          {engine.batchId && engine.batchId === selected ? (
            <span className="mono text-[10px] uppercase tracking-[0.15em] text-mute inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-ink animate-pulse" /> enriching · {engine.remaining} left
            </span>
          ) : newCount > 0 && selected ? (
            <button
              onClick={() => engine.start(selected)}
              disabled={!!engine.batchId}
              title={engine.batchId ? 'Another list is already enriching' : undefined}
              className={btnPrimary + ' inline-flex items-center gap-1'}
            >
              <Sparkle size={11} /> enrich {newCount} new
            </button>
          ) : null}
        </div>

        {/* Steps legend — reads left-to-right in the SAME order as the dots in
            every row, so the strip is the key to the column. */}
        {leads.length > 0 && <StepsLegend defs={STEP_DEFS} />}

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-4 hairline rounded-sm bg-rose-500/5 border-rose-400/60 p-3 max-w-2xl">
              <div className="text-xs text-rose-600">Couldn’t load this list: {error}</div>
              <button onClick={() => refresh()} className={btn + ' mt-2'}>retry</button>
            </div>
          )}
          {error ? null : leads.length === 0 ? (
            <div className="text-sm text-mute py-16 text-center">
              {batches && batches.length === 0 ? 'Upload a phone list to begin.' : 'No leads in this list.'}
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-paper/95 backdrop-blur">
                <tr className="mono text-[9px] uppercase tracking-[0.14em] text-mute border-b border-line">
                  <Th className="w-6 pl-2" title="Truecaller — look the number up for a manual identity check" />
                  <Th className="w-4" title="row colour: fully enriched AND identity holds together = green" />
                  <Th>Phone</Th>
                  <Th title="double-click to edit">Name</Th>
                  <Th title="double-click to edit">Company</Th>
                  <Th title="the COMPANY's LinkedIn page (the LinkedIn column is the person's) — double-click to correct it">Co. LI</Th>
                  <Th title="double-click to edit">Title</Th>
                  <Th title="double-click to edit">LinkedIn</Th>
                  <Th title="double-click to edit">Email</Th>
                  <Th className="text-center">Steps</Th>
                  <Th className="text-center" title="identity confidence — hover for what's uncertain">Identity</Th>
                  <Th className="w-12 pr-2 text-right" title="left: full re-enrich · right: rerun from where it stopped">Run</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => <LeadRow key={l.id} lead={l} onChanged={() => refresh()} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={async (batch_id, created) => {
            setShowImport(false);
            await refresh(batch_id ?? undefined);
            if (batch_id && created > 0) engine.start(batch_id);
          }}
        />
      )}
    </div>
  );
}

function Th({ children, className = '', title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return <th title={title} className={'font-normal py-1 px-1.5 whitespace-nowrap ' + className}>{children}</th>;
}

// The key to the Steps column — one entry per icon, in the same left-to-right
// order as every row's strip. Shared by both table tabs; Qualification appends
// the manual ICP-match step to the same list.
function StepsLegend({ defs }: { defs: typeof STEP_DEFS }) {
  return (
    <div className="px-4 sm:px-5 py-1.5 border-b border-line bg-card/40 shrink-0 flex items-center gap-x-3 gap-y-1 flex-wrap">
      <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">steps</span>
      {defs.map((s, i) => (
        <span key={s.key} title={`${i + 1}. ${s.label} — ${s.hint}`} className="inline-flex items-center gap-1 mono text-[9px] text-mute cursor-help">
          <s.Icon size={12} className="text-ink/70" />
          <span className="text-ink/70">{s.label}</span>
        </span>
      ))}
      <span className="ml-auto inline-flex items-center gap-2.5 mono text-[9px] text-mute">
        {(['done', 'empty', 'skipped', 'idle'] as StepState[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={'h-1.5 w-1.5 rounded-full bg-current ' + STEP_TONE[k]} />{STEP_WORD[k]}
          </span>
        ))}
      </span>
    </div>
  );
}

// Deliberately minimal: 3px pad + a pinned 14px line box = a 20px row, so a
// screen shows ~30 leads instead of ~12. The leading matters more than the
// padding here — a td inherits the 24px root line-height and holds a 24px line
// box even when its content is 14px tall, which is what made these rows thick.
// Every text utility in a row therefore pins its leading too (text-[Npx]/[14px]),
// because Tailwind pairs an arbitrary font-size with a 1.5 line-height.
// Nothing in a row may exceed 14px tall or every row grows with it.
const Td = 'py-[3px] px-1.5 align-middle leading-[14px]';

// Every cell's content is block-level and exactly 14px tall. An INLINE child
// would sit on the td's baseline and drag the line box past 14px (the strut's
// descender), which is worth ~3px on every row.
const DASH = <span className="block text-[11px]/[14px] text-mute/50">—</span>;

// A value that is ALSO a link, inside a cell you can edit.
//
// The text is deliberately NOT an anchor. An anchor consumes the FIRST click of
// a double-click and navigates — with target="_blank" the operator lands in a
// new tab and the editor never opens — so a link cell was simply uneditable.
// Splitting the two affordances fixes it without timers or popup-blocker
// roulette: the text reads and double-clicks, the trailing arrow is the only
// navigable part. Blue means clickable; plain text means editable.
function LinkedValue({ href, label, title, className = '' }: {
  href: string; label: React.ReactNode; title?: string; className?: string;
}) {
  return (
    <span className="flex items-center gap-1 min-w-0">
      <span className={'truncate ' + className} title={title}>{label}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        // Double-clicking the arrow must not ALSO open the editor behind it.
        onDoubleClick={(e) => e.stopPropagation()}
        className="shrink-0 mono text-[10px]/[14px] text-sky-600 dark:text-sky-400 hover:opacity-70"
        title={`Open ${href}`}
        aria-label={`Open ${href}`}
      >↗</a>
    </span>
  );
}

// Fields the shared endpoint accepts as a straight column patch (api.gtmEditLead).
type EditField = 'name' | 'company' | 'position' | 'linkedin' | 'email';

// How one cell reads and writes itself. Most cells are a plain column, but some
// of what an operator needs to correct is DERIVED — the company's LinkedIn lives
// inside the socials array, not in a column of its own — so a cell declares its
// own read/write instead of assuming a field name.
type EditSpec = {
  label: string;                                        // what the confirm popover calls it
  read: (l: GtmLead) => string;                         // current value, as text
  write: (l: GtmLead, next: string) => Promise<unknown>; // persist it
  placeholder?: string;
};
const fieldSpec = (field: EditField, label: string = field): EditSpec => ({
  label,
  read: (l) => String(l[field] || ''),
  // '' clears the field: manualEditLead maps an empty string to null.
  write: (l, next) => api.gtmEditLead(l.id, { [field]: next } as Partial<Pick<GtmLead, EditField>>),
});
const NAME_SPEC     = fieldSpec('name');
const COMPANY_SPEC  = fieldSpec('company');
const TITLE_SPEC    = fieldSpec('position', 'title');
const EMAIL_SPEC    = fieldSpec('email');
// The PERSON's profile — with the mirror of Co. LI's guard, since the two cells
// now sit in the same row and a company page pasted here would read as an
// identity we never verified.
const LINKEDIN_SPEC: EditSpec = {
  ...fieldSpec('linkedin'),
  placeholder: 'https://www.linkedin.com/in/…',
  write: (l, next) => {
    const url = next.trim();
    if (url && isCompanyLi(url)) throw new Error('that is a company page — put it in the Co. LI cell');
    return api.gtmEditLead(l.id, { linkedin: url });
  },
};

// The COMPANY's LinkedIn page. Stored in socials (there is no column for it)
// under its own type, so it can never be mistaken for the person's profile by
// the readers that scan socials for `type === 'linkedin'`. resolveLiCompany
// finds it by URL PATTERN, not type, so this is exactly the link the error
// message asks the operator to paste — editing it here unblocks the headcount
// and open-roles legs on the next company-context run.
const COMPANY_LI_RE = /^https:\/\/([\w.-]+\.)?linkedin\.com\/company\//i;
const companyLiSpec: EditSpec = {
  label: 'company linkedin',
  placeholder: 'https://www.linkedin.com/company/…',
  read: (l) => companyLinkedin(l) || '',
  // A targeted key, NOT a socials rewrite: the read-modify-write happens
  // server-side against the current row, so a social added between render and
  // confirm is not silently dropped. The server also forgets whatever the old
  // link resolved to, which is what makes the correction stick — otherwise the
  // cell would keep rendering the stale match and the resolve would skip it.
  write: (l, next) => {
    let url = next.trim();
    if (url) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
      url = url.replace(/^http:\/\//i, 'https://');
      // Validated here rather than saved-then-rendered-as-a-dash: read only ever
      // displays a company URL, so anything else would vanish on save and the
      // operator would have no idea where it went.
      if (!COMPANY_LI_RE.test(url)) throw new Error('paste a linkedin.com/company/… URL');
    }
    return api.gtmEditLead(l.id, { company_linkedin: url || null });
  },
};

// LinkedIn headcount. Fetched, but correctable: LinkedIn matches the wrong
// company often enough, and the ICP leans on this number harder than on any
// other single fact. A later company-context run still wins when LinkedIn
// answers with a real figure — and keeps this one when it answers with none.
const sizeSpec: EditSpec = {
  label: 'headcount',
  placeholder: 'employees, e.g. 34',
  read: (l) => (l.company_staff_count == null ? '' : String(l.company_staff_count)),
  write: (l, next) => {
    const n = Number(next.trim());
    if (next.trim() && (!Number.isFinite(n) || n < 0)) throw new Error('headcount must be a number');
    return api.gtmEditLead(l.id, { company_staff_count: next.trim() ? Math.round(n) : null });
  },
};

// Double-click a cell to edit it. The value is NEVER sent on Enter or on blur —
// it stages a confirm popover first, so a stray double-click plus a keystroke
// can't silently rewrite a lead. Escape aborts, and an unchanged value closes
// without prompting.
function EditableCell({
  lead, spec, children, onSaved,
}: {
  lead: GtmLead; spec: EditSpec;
  children: React.ReactNode; onSaved: () => void;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = spec.label;
  const original = spec.read(lead).trim();

  function begin() { setVal(original); setPending(null); setErr(null); setEditing(true); }
  function abort() { setEditing(false); setPending(null); setErr(null); }
  function propose() {
    const next = val.trim();
    if (next === original) { abort(); return; } // untouched — don't nag
    setPending(next);
  }
  async function commit() {
    if (pending === null) return;
    setBusy(true);
    try {
      await spec.write(lead, pending);
      abort();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const box = ref.current?.getBoundingClientRect();

  return (
    <td
      ref={ref}
      className={Td + ' cursor-text'}
      onDoubleClick={begin}
      title={editing ? undefined : `Double-click to edit ${label}`}
    >
      {editing && pending === null ? (
        <input
          autoFocus
          value={val}
          placeholder={spec.placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter')  { e.preventDefault(); propose(); }
            if (e.key === 'Escape') { e.preventDefault(); abort(); }
          }}
          onBlur={propose}
          className="w-full h-[15px] min-w-[6rem] hairline rounded-sm bg-paper px-1 text-[11px]/[14px] focus:outline-none"
        />
      ) : children}

      {pending !== null && box && createPortal(
        <div
          style={{
            position: 'fixed',
            left: Math.max(8, Math.min(box.left, window.innerWidth - 272)),
            top: Math.min(box.bottom + 4, window.innerHeight - 130),
            zIndex: 210, width: 264,
          }}
          className="rounded-sm bg-ink text-paper text-[11px] leading-snug px-3 py-2 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.55)]"
        >
          <div className="mono text-[9px] uppercase tracking-[0.15em] text-paper/60 mb-1">save {label}?</div>
          <div className="text-paper/50 line-through truncate">{original || '(empty)'}</div>
          <div className="text-paper truncate mb-2">{pending || '(clear it)'}</div>
          {err && <div className="text-rose-300 mb-1.5 break-words">{err}</div>}
          <div className="flex gap-1.5 justify-end">
            <button onClick={abort} className="h-6 px-2 rounded-sm mono text-[9px] uppercase tracking-[0.12em] bg-paper/10 hover:bg-paper/20 transition">cancel</button>
            <button onClick={commit} disabled={busy} className="h-6 px-2 rounded-sm mono text-[9px] uppercase tracking-[0.12em] bg-paper text-ink hover:opacity-90 disabled:opacity-40 transition">
              {busy ? 'saving…' : 'save'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </td>
  );
}

// The Qualification tab renders the SAME row plus its extra cells (checkbox ·
// list · enriched-at · ICP step · fit chip); the List tab passes no `qual` and
// stays pixel-identical. The cell order here must mirror the tab's header row.
type BulkKind = 'company' | 'icp';
type QualCells = {
  checked: boolean;
  disabled: boolean;      // row lacks name/company/title — ICP match can't run
  onToggle: () => void;
  listName: string | null;
  busy: BulkKind | null;  // which bulk action is in flight for this row
};

function LeadRow({ lead, onChanged, qual }: { lead: GtmLead; onChanged: () => void; qual?: QualCells }) {
  const [busy, setBusy] = useState<null | 'full' | 'resume' | 'dead'>(null);
  const deadEnd = lead.status === 'dead_end';
  const tone = rowTone(lead);
  const steps = readSteps(lead);
  const li = linkedinOf(lead);
  const co = companyLinkedin(lead);
  const phone = lead.normalized_phone || lead.phone;
  const where = [lead.region, lead.country].filter(Boolean).join(', ');
  const needs: string[] = [];
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) needs.push(parts.length < 1 ? 'name' : 'last name');
  if (!lead.company) needs.push('company');
  if (!li) needs.push('linkedin');
  if (!lead.position) needs.push('title');

  async function run(kind: 'full' | 'resume') {
    setBusy(kind);
    try { await api.gtmEnrichLead(lead.id, kind); onChanged(); }
    finally { setBusy(null); }
  }
  async function markDeadEnd(dead: boolean) {
    setBusy('dead');
    try { await api.gtmSetDeadEnd(lead.id, dead); onChanged(); }
    finally { setBusy(null); }
  }

  return (
    <tr className={'border-l-2 border-b border-line/60 transition-colors ' + (deadEnd ? 'opacity-45 grayscale border-l-stone-400 bg-stone-500/[0.04] hover:opacity-70' : ROW_TINT[tone])}>
      {/* multiselect (Qualification tab only) — feeds the bulk "Run ICP match" */}
      {qual && (
        <td className={Td + ' pl-2'}>
          <input
            type="checkbox"
            checked={qual.checked}
            disabled={qual.disabled}
            onChange={qual.onToggle}
            title={qual.disabled ? 'ICP match needs a name, company and title first' : undefined}
            className="block h-3 w-3 accent-current cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          />
        </td>
      )}
      {/* Truecaller — leftmost: the fast lane to a manual identity check */}
      <td className={Td + (qual ? '' : ' pl-2')}>
        {lead.truecaller_url ? (
          <a
            href={lead.truecaller_url}
            target="_blank"
            rel="noreferrer"
            title={`Look ${phone || 'this number'} up on Truecaller, then double-click a cell to fill it in`}
            className="block w-[14px] hover:opacity-75 transition-opacity"
          >
            <Truecaller size={14} />
          </a>
        ) : <span className="block w-[14px]" />}
      </td>
      {/* row paint / completeness */}
      <td className={Td}>
        <span
          className={'block h-1.5 w-1.5 rounded-full ' + DOT[tone]}
          title={`${tone}${needs.length ? ' · needs: ' + needs.join(', ') : ' · fully enriched'}`}
        />
      </td>
      {/* Phone — region/country moved into the tooltip; a second line here cost
          every row its height. */}
      <td className={Td}>
        {phone
          ? <a href={waHref(phone)} target="_blank" rel="noreferrer"
               className="block mono text-[10px]/[14px] text-mute hover:text-ink whitespace-nowrap"
               title={(where ? `${phone} · ${where}` : phone) + ' — open in WhatsApp'}>{phone}</a>
          : DASH}
      </td>
      <EditableCell lead={lead} spec={NAME_SPEC} onSaved={onChanged}>
        <span className="flex items-center gap-1 min-w-0">
          {lead.active_tool && <span className="text-ink animate-pulse mono text-[9px]/[14px] shrink-0" title={`enriching: ${lead.active_tool}`}>⟳</span>}
          <span className={'text-[11px]/[14px] truncate max-w-[10rem] ' + (lead.name ? 'font-medium' : 'text-mute/50')} title={lead.name ? titleCase(lead.name) : undefined}>
            {lead.name ? titleCase(lead.name) : '—'}
          </span>
          {deadEnd && <span className="shrink-0 mono text-[8px]/[14px] uppercase tracking-[0.1em] px-1 rounded-sm bg-stone-300/70 text-stone-600 dark:bg-stone-700 dark:text-stone-300" title="Marked a dead end — enrichment gave up on this one">dead end</span>}
        </span>
      </EditableCell>
      <EditableCell lead={lead} spec={COMPANY_SPEC} onSaved={onChanged}>
        {lead.company
          ? <span className="text-[11px]/[14px] truncate block max-w-[9rem]" title={lead.company}>{lead.company}</span>
          : DASH}
      </EditableCell>
      {/* the COMPANY's LinkedIn page, not the person's. In BOTH tables: it is
          the link the company-context resolve prefers, so correcting it here is
          how a wrong company gets fixed at the source. */}
      <EditableCell lead={lead} spec={companyLiSpec} onSaved={onChanged}>
        {co
          ? <LinkedValue
              href={co}
              label="co"
              className="mono text-[10px]/[14px] text-mute"
              title={`${co}\nThe company page. Double-click here to correct it; the arrow opens it.`}
            />
          : DASH}
      </EditableCell>
      {/* company headcount — the ICP's size band (Qualification only) */}
      {qual && (
        <EditableCell lead={lead} spec={sizeSpec} onSaved={onChanged}>
          {lead.company_staff_count !== null && lead.company_staff_count !== undefined
            ? <span className="block mono text-[10px]/[14px] tabular-nums text-mute text-right pr-1" title={sizeTitle(lead)}>{lead.company_staff_count}</span>
            : <span className="block text-[11px]/[14px] text-mute/50 text-right pr-1" title={sizeTitle(lead)}>—</span>}
        </EditableCell>
      )}
      <EditableCell lead={lead} spec={TITLE_SPEC} onSaved={onChanged}>
        {lead.position
          ? <span className="text-[11px]/[14px] text-mute truncate block max-w-[10rem]" title={lead.position}>{lead.position}</span>
          : DASH}
      </EditableCell>
      <EditableCell lead={lead} spec={LINKEDIN_SPEC} onSaved={onChanged}>
        {li
          ? <LinkedValue
              href={li}
              label="in"
              className="mono text-[10px]/[14px] text-mute"
              title={`${li}\nDouble-click here to correct it; the arrow opens the profile.`}
            />
          : DASH}
      </EditableCell>
      <EditableCell lead={lead} spec={EMAIL_SPEC} onSaved={onChanged}>
        {lead.email
          ? <LinkedValue
              href={`mailto:${lead.email}`}
              label={lead.email}
              className="text-[10px]/[14px] text-mute max-w-[11rem]"
              title={`${lead.email}\nDouble-click here to correct it; the arrow opens a draft.`}
            />
          : DASH}
      </EditableCell>
      {/* which list the row came from + when its enrichment ran (Qualification only) */}
      {qual && (
        <td className={Td}>
          {qual.listName
            ? <span className="text-[10px]/[14px] text-mute truncate block max-w-[8rem]" title={qual.listName}>{qual.listName}</span>
            : DASH}
        </td>
      )}
      {qual && (() => {
        const e = enrichedInfo(lead);
        return (
          <td className={Td}>
            {e
              ? <span
                  className="block mono text-[10px]/[14px] text-mute whitespace-nowrap"
                  title={new Date(e.at).toLocaleString() + (e.from === 'steps'
                    ? ' — from the step record'
                    : ' — last update (enriched before step recording, so edits bump it too)')}
                >{timeAgo(e.at)}</span>
              : DASH}
          </td>
        );
      })()}
      {/* Steps — same left-to-right order as the legend above the table */}
      <td className={Td}>
        <div className="flex items-center justify-center gap-[3px]">
          {STEP_DEFS.map((s, i) => {
            const r = steps[s.key];
            const why = r.reason ? `\n→ ${r.reason}` : '';
            const legacy = r.recorded ? '' : '\n(enriched before step recording — inferred from provenance)';
            return (
              <span
                key={s.key}
                title={`${i + 1}. ${s.label} — ${STEP_WORD[r.state]}${why}${legacy}\n${s.hint}`}
                className={'grid place-items-center h-3 w-3 ' + STEP_TONE[r.state]}
              >
                <s.Icon size={12} />
              </span>
            );
          })}
          {/* the manual steps — Company context, then ICP match (Qualification
              tab only). Each falls back to the durable column it writes when the
              step record is missing (a lead scored before migration 0056). */}
          {qual && MANUAL_STEPS.map((d, i) => {
            const rec = (lead.steps || []).find((s) => s.key === d.key);
            const ran = d.key === 'icp' ? !!lead.icp_fit : lead.company_checked_at != null;
            const state: StepState = rec
              ? (rec.status === 'found' ? 'done' : 'empty')
              : (ran ? 'done' : 'idle');
            const busyNow = qual.busy === d.key;
            const word = busyNow
              ? (d.key === 'icp' ? 'scoring…' : 'fetching…')
              : d.key === 'icp'
                ? (lead.icp_fit ? `${lead.icp_fit} fit` : STEP_WORD[state])
                : (rec?.reason || (ran ? 'fetched' : STEP_WORD[state]));
            const when = rec ? `\nran ${timeAgo(rec.at)}` : '';
            return (
              <span
                key={d.key}
                title={`${STEP_DEFS.length + i + 1}. ${d.label} — ${word}${when}\n${d.hint}`}
                className={'grid place-items-center h-3 w-3 ' + STEP_TONE[state]}
              >
                {busyNow
                  ? <span className="mono text-[9px]/[12px] text-ink animate-pulse">⟳</span>
                  : <d.Icon size={12} />}
              </span>
            );
          })}
        </div>
      </td>
      {/* Identity confidence — floats the uncertainty on hover */}
      <td className={Td}>
        <div className="flex justify-center"><Uncertainty confidence={lead.confidence} /></div>
      </td>
      {/* Qualification level — the ICP match verdict (Qualification tab only) */}
      {qual && (
        <td className={Td}>
          <div className="flex justify-center">
            {qual.busy === 'icp'
              ? <span className="mono text-[9px]/[14px] text-mute animate-pulse">scoring…</span>
              : lead.icp_fit
                ? <span className={'block mono text-[9px]/[14px] uppercase px-1.5 rounded-sm ' + FIT_TONE[lead.icp_fit]} title={icpTitle(lead)}>{lead.icp_fit}</span>
                : DASH}
          </div>
        </td>
      )}
      {/* actions: re-enrich · rerun · mark dead end — or, when dead, just revive.
          The enrich buttons are hidden on a dead end because re-running the chain
          would flip its status back to 'enriched' and un-mark it. */}
      <td className={Td + ' pr-2'}>
        <div className="flex items-center justify-end gap-1">
          {deadEnd ? (
            <button
              onClick={() => markDeadEnd(false)}
              disabled={busy === 'dead'}
              className="grid place-items-center h-[14px] px-1 rounded-sm text-mute hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-30 transition mono text-[8px]/[14px] uppercase tracking-wider"
              title="Revive — put this lead back in play so enrichment can run again"
            >
              {busy === 'dead' ? <span className="animate-pulse">⟳</span> : 'revive'}
            </button>
          ) : (
            <>
              <button
                onClick={() => run('full')}
                disabled={!!busy || !!lead.active_tool || !!qual?.busy}
                className="grid place-items-center h-[14px] w-[14px] rounded-sm text-mute hover:text-ink disabled:opacity-30 transition"
                title="Run the FULL enrichment chain again (includes the paid Twilio / PDL legs)"
              >
                {busy === 'full' || lead.active_tool ? <span className="mono text-[9px]/[14px] animate-pulse">⟳</span> : <Sparkle size={11} />}
              </button>
              <button
                onClick={() => run('resume')}
                disabled={!!busy || !!lead.active_tool || !!qual?.busy}
                className="grid place-items-center h-[14px] w-[14px] rounded-sm text-mute hover:text-sky-600 dark:hover:text-sky-400 disabled:opacity-30 transition"
                title={'Rerun from where it stopped — SerpApi + the LinkedIn confirm.\nUse after typing a name or pasting a profile URL: those are the two steps a manual edit unblocks.\nLeaves the paid Twilio / PDL lookups alone.'}
              >
                {busy === 'resume' ? <span className="mono text-[9px]/[14px] animate-pulse">⟳</span> : <Refresh size={11} />}
              </button>
              <button
                onClick={() => markDeadEnd(true)}
                disabled={!!busy || !!lead.active_tool || !!qual?.busy}
                className="grid place-items-center h-[14px] w-[14px] rounded-sm text-mute hover:text-rose-500 disabled:opacity-30 transition"
                title={'Mark as a dead end — we couldn’t enrich this one.\nStops it being re-tried and drops it from the “new” count. Reversible.'}
              >
                {busy === 'dead' ? <span className="mono text-[9px]/[14px] animate-pulse">⟳</span> : <X size={11} />}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// Identity-confidence indicator: a dot + score that floats the uncertainty
// (flags + positives) on hover. Rendered through a portal to <body> so the
// popover is never clipped by the table's own scroll container.
function Uncertainty({ confidence }: { confidence?: GtmConfidence }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  if (!confidence) return <span className="text-mute mono text-[10px]">—</span>;
  const { level, score, flags, positives = [] } = confidence;
  const sevDot: Record<string, string> = { high: 'bg-rose-400', medium: 'bg-amber-400', low: 'bg-stone-400' };
  const tone: Tone = level;
  const scoreTone = level === 'green' ? 'text-emerald-600 dark:text-emerald-400' : level === 'yellow' ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
  // Declared, not derived from scoreTone by string surgery: the popover sits on
  // the dark ink panel, so it needs its own light tone in both themes.
  const popTone = level === 'green' ? 'text-emerald-300' : level === 'yellow' ? 'text-amber-300' : 'text-rose-300';

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const half = 132;
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
    setPos({ left, top: r.bottom + 6 });
  }

  return (
    <button
      ref={ref}
      type="button"
      className="inline-flex items-center gap-1 cursor-help"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
    >
      <span className={'h-1.5 w-1.5 rounded-full ' + DOT[tone]} />
      <span className={'mono text-[10px]/[14px] tabular-nums ' + scoreTone}>{score}%</span>
      {pos && createPortal(
        <div
          style={{ position: 'fixed', left: pos.left, top: pos.top, transform: 'translateX(-50%)', zIndex: 200, width: 264 }}
          className="pointer-events-none rounded-sm bg-ink text-paper text-[11px] leading-snug px-3 py-2 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.5)] text-left"
        >
          <div className="mono text-[9px] uppercase tracking-[0.15em] text-paper/60">
            identity confidence · <span className={popTone}>{score}%</span>
          </div>
          {flags.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {flags.map((f, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className={'h-1.5 w-1.5 rounded-full mt-1 shrink-0 ' + (sevDot[f.severity] || 'bg-stone-400')} />
                  <span className="flex-1"><span className="font-semibold">{f.label}</span><span className="block text-paper/70">{f.detail}</span></span>
                </div>
              ))}
            </div>
          )}
          {positives.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {positives.map((p, i) => (
                <div key={i} className="flex items-start gap-1.5 text-paper/80">
                  <span className="h-1.5 w-1.5 rounded-full mt-1 shrink-0 bg-emerald-400" /><span className="flex-1">{p}</span>
                </div>
              ))}
            </div>
          )}
          {flags.length === 0 && positives.length === 0 && (
            <div className="mt-1 text-paper/85">Identity is consistent across the data on file.</div>
          )}
        </div>,
        document.body,
      )}
    </button>
  );
}

// ─── Upload / import ─────────────────────────────────────────────────────────
// Reuses api.gtmImport verbatim (paste numbers, a CSV with a "phone" column, or
// a URL to fetch). The file picker is a pure client-side convenience: read the
// file's text and drop it into the same box — no new backend.

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (batchId: string | null, created: number) => void }) {
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function loadFile(f: File) {
    if (!source) setSource(f.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.onerror = () => setErr('Could not read that file.');
    reader.readAsText(f);
  }

  async function doImport() {
    setBusy(true); setErr(null);
    try {
      const isUrl = /^https?:\/\/\S+$/.test(text.trim());
      const r = await api.gtmImport(isUrl ? { url: text.trim(), source } : { text, source });
      onImported(r.batch_id, r.created);
    } catch (e) { setErr('Import failed: ' + (e instanceof Error ? e.message : String(e))); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-ink/30 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-paper hairline rounded-sm p-5 w-[480px] max-w-[92vw] space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute">Upload phone list</div>
          <button onClick={onClose} className="text-mute hover:text-ink"><X size={14} /></button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'One number per line, a CSV with a "phone" column, or a URL to fetch.\n+972 50 123 4567\n+1 (415) 555-0134'}
          className="w-full h-40 hairline rounded-sm bg-card p-3 text-sm mono resize-none focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="hidden"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }} />
          <button onClick={() => fileRef.current?.click()} className={btn}>choose file…</button>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Source (where this list came from)"
            className="flex-1 h-9 hairline rounded-sm bg-card px-3 text-sm focus:outline-none"
          />
        </div>
        {err && <div className="text-xs text-rose-600">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={btn}>cancel</button>
          <button onClick={doImport} disabled={busy || !text.trim()} className={btnPrimary}>
            {busy ? 'uploading…' : 'upload + enrich'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add to Cohort ───────────────────────────────────────────────────
// Pick a cohort (or make one) for the selected prospects.
//
// Nobody may sit in two cohorts — that is the whole anti-spam guarantee, and it
// is enforced by the schema, not by this dialog. So the add comes back in three
// parts: added, skipped (no approved angle, no phone, already here), and
// CONFLICTS — people already being worked in another campaign. Conflicts are
// never resolved silently: they are listed by name with the cohort they are
// already in, and moving them takes a second, explicit press.
function AddToCohortModal({ leadIds, onClose, onDone }: {
  leadIds: string[];
  onClose: () => void;
  onDone: (r: OutreachAddResult) => void;
}) {
  const [cohorts, setCohorts] = useState<OutreachCohort[] | null>(null);
  const [cohortId, setCohortId] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OutreachAddResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.outreachCohorts()
      .then((qs) => { setCohorts(qs); setCohortId(qs[0]?.id || ''); if (!qs.length) setCreating(true); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  async function add(override: boolean, ids: string[]) {
    setBusy(true); setErr(null);
    try {
      let target = cohortId;
      if (creating) {
        const c = await api.outreachCohortCreate(newName.trim());
        if (c.error || !c.cohort) { setErr(c.error || 'could not create the cohort'); return; }
        target = c.cohort.id;
        setCohortId(target); setCreating(false);
        setCohorts(await api.outreachCohorts().catch(() => cohorts || []));
      }
      if (!target) { setErr('pick a cohort first'); return; }
      const r = await api.outreachCohortAddMany(ids, target, override);
      if (r.error) { setErr(r.error); return; }
      // Merge, so an override pass does not erase what the first pass added.
      setResult((prev) => (prev && override
        ? { ...r, added: [...prev.added, ...r.added], skipped: [...prev.skipped, ...r.skipped] }
        : r));
      onDone(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const canSubmit = !busy && (creating ? newName.trim().length > 0 : !!cohortId);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-lg hairline rounded-sm bg-card shadow-xl max-h-[85vh] flex flex-col">
        <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
          <Send size={12} />
          <span className="mono text-[10px] uppercase tracking-[0.2em]">Add to cohort</span>
          <span className="mono text-[10px] text-mute ml-auto">{leadIds.length} selected</span>
          <button type="button" onClick={onClose} className="text-mute hover:text-ink" aria-label="Close"><X size={13} /></button>
        </div>

        <div className="p-4 overflow-y-auto min-h-0">
          {err && <div className="mb-3 px-3 py-2 rounded-sm border border-rose-500/30 bg-rose-500/10 text-[12px] text-rose-600">{err}</div>}

          {!result && (
            <>
              {cohorts === null && <div className="text-[12px] text-mute">Loading cohorts…</div>}
              {cohorts !== null && !creating && (
                <label className="block">
                  <span className="mono text-[9px] uppercase tracking-[0.2em] text-mute">cohort</span>
                  <select
                    value={cohortId}
                    onChange={(e) => setCohortId(e.target.value)}
                    className="mt-1.5 w-full h-9 hairline rounded-sm bg-paper px-2 text-[13px] focus:outline-none"
                  >
                    {cohorts.map((qq) => (
                      <option key={qq.id} value={qq.id}>{qq.name} ({qq.total})</option>
                    ))}
                  </select>
                </label>
              )}
              {cohorts !== null && creating && (
                <label className="block">
                  <span className="mono text-[9px] uppercase tracking-[0.2em] text-mute">new cohort name</span>
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Fintech CTOs · August"
                    className="mt-1.5 w-full h-9 hairline rounded-sm bg-paper px-2 text-[13px] focus:outline-none"
                  />
                </label>
              )}
              {cohorts !== null && (
                <button
                  type="button"
                  onClick={() => { setCreating((v) => !v); setErr(null); }}
                  className="mt-2 mono text-[9px] uppercase tracking-[0.16em] text-mute hover:text-ink"
                >
                  {creating ? (cohorts.length ? '← pick an existing cohort' : '') : '+ new cohort'}
                </button>
              )}
              <p className="mt-4 text-[11px] text-mute leading-relaxed">
                A prospect can only be in one cohort — anyone already being worked elsewhere is held back
                for your approval rather than added twice.
              </p>
            </>
          )}

          {result && (
            <div className="space-y-4">
              <div className="text-[13px]">
                Added <span className="font-semibold">{result.added.length}</span> to{' '}
                <span className="font-semibold">{result.cohort_name}</span>.
              </div>

              {result.conflicts.length > 0 && (
                <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-3">
                  <div className="mono text-[9px] uppercase tracking-[0.16em] text-amber-700">
                    needs your approval · {result.conflicts.length}
                  </div>
                  <p className="text-[12px] mt-1.5 leading-relaxed">
                    {result.conflicts.length === 1 ? 'This prospect is' : 'These prospects are'} already in
                    another cohort. Overriding <span className="font-semibold">moves</span> them — they will
                    not be messaged by two campaigns.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {result.conflicts.map((c) => (
                      <li key={c.lead_id} className="text-[12px]">
                        <span className="font-semibold">{c.name || c.lead_id}</span>
                        <span className="text-mute"> — in “{c.current_cohort.name || c.current_cohort.id}”</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => add(true, result.conflicts.map((c) => c.lead_id))}
                    className="mt-3 h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] bg-amber-600 text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {busy ? 'moving…' : `override restriction · move ${result.conflicts.length}`}
                  </button>
                </div>
              )}

              {result.skipped.length > 0 && (
                <div>
                  <div className="mono text-[9px] uppercase tracking-[0.16em] text-mute">
                    not added · {result.skipped.length}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {result.skipped.slice(0, 12).map((s) => (
                      <li key={s.lead_id} className="text-[11px] text-mute">{s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-line)] flex items-center gap-2">
          <button type="button" onClick={onClose} className={btn}>{result ? 'done' : 'cancel'}</button>
          {!result && (
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => add(false, leadIds)}
              className={btnPrimary + ' ml-auto'}
            >
              {busy ? 'adding…' : `add ${leadIds.length}`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Tab 3 · Qualification ───────────────────────────────────────────────────
// The List Enrichment table, but consolidating the VERIFIED (green) contacts
// from ALL lists — the exact population the Verified Contacts cards show, in
// sheet form. Adds multiselect + a bulk, manually-triggered "ICP match" run
// (api.gtmScoreIcp — the same shared ability behind GTM → Enrich → "Check ICP
// Fit"), filters (text / list / qualification level), and three extra columns:
// the source list, when enrichment ran, and the strong/medium/weak verdict.

type FitFilter = 'all' | 'unscored' | 'strong' | 'medium' | 'weak';

function Qualification() {
  const [leads, setLeads] = useState<GtmGreenLead[] | null>(null);
  const [batches, setBatches] = useState<GtmBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [listFilter, setListFilter] = useState('all');
  const [fitFilter, setFitFilter] = useState<FitFilter>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<{ kind: BulkKind; done: number; total: number } | null>(null);
  const [busyIds, setBusyIds] = useState<Map<string, BulkKind>>(new Map());
  const [runIssues, setRunIssues] = useState<string[]>([]);
  const [addingToCohort, setAddingToCohort] = useState(false);
  const [cohortNote, setCohortNote] = useState<string | null>(null);
  const runningRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [g, b] = await Promise.all([api.gtmGreen(), api.gtmBatches()]);
      setLeads(g); setBatches(b); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Same bar as the Verified Contacts tab: green completeness AND green identity.
  const verified = (leads || []).filter((l) => rowTone(l) === 'green');

  // List name: the denormalized label on the lead, else the batch's label.
  const batchName = new Map(batches.map((b) => [b.id, b.source || b.id]));
  const listNameOf = (l: GtmLead) => l.source || (l.batch_id ? batchName.get(l.batch_id) || l.batch_id : null);
  const lists = [...new Map(verified.map((l) => [l.batch_id ?? '', listNameOf(l) || '(no list)'])).entries()];

  const needle = q.trim().toLowerCase();
  const visible = verified.filter((l) =>
    (listFilter === 'all' || (l.batch_id ?? '') === listFilter)
    && (fitFilter === 'all' || (fitFilter === 'unscored' ? !l.icp_fit : l.icp_fit === fitFilter))
    && (!needle || [l.name, l.company, l.position, l.email, l.phone, l.normalized_phone]
          .some((v) => String(v || '').toLowerCase().includes(needle))));

  const visibleEligible = visible.filter(icpEligible);
  const allChecked = visibleEligible.length > 0 && visibleEligible.every((l) => sel.has(l.id));
  // What the button will actually run: selected ∩ visible ∩ eligible — so a
  // filter change after selecting never silently scores hidden rows.
  const runnable = visible.filter((l) => sel.has(l.id) && icpEligible(l));

  function toggle(id: string) {
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSel((prev) => {
      const n = new Set(prev);
      if (allChecked) for (const l of visibleEligible) n.delete(l.id);
      else for (const l of visibleEligible) n.add(l.id);
      return n;
    });
  }

  // The two bulk actions share one runner: snapshot the selection, drain it with
  // a small worker pool, patch each row locally as results land so the sheet
  // fills in live, then one refresh at the end to pick up the recorded step
  // verdicts. Concurrency differs by action — ICP is one LLM call per lead, but
  // company context is up to three upstream calls of which two hit the THROTTLED
  // LinkedIn gateway, so it drains one at a time rather than racing the limiter.
  const CONCURRENCY: Record<BulkKind, number> = { icp: 2, company: 1 };

  async function runBulk(kind: BulkKind) {
    if (runningRef.current || !runnable.length) return;
    const targets = [...runnable];
    runningRef.current = true;
    setRunIssues([]);
    setRunning({ kind, done: 0, total: targets.length });
    setBusyIds(new Map(targets.map((t) => [t.id, kind])));
    const queue = [...targets];
    const issues: string[] = [];
    let done = 0;
    const worker = async () => {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        const who = t.name || t.phone;
        try {
          if (kind === 'icp') {
            const r = await api.gtmScoreIcp(t.id);
            if (r.error || !r.fit) {
              issues.push(`${who}: ${r.error || 'no verdict returned'}`);
            } else {
              const fit = r.fit as GtmLead['icp_fit'];
              const reasons = JSON.stringify({ reasons: r.reasons || [], gaps: r.gaps || [] });
              setLeads((prev) => prev ? prev.map((l) => (l.id === t.id ? { ...l, icp_fit: fit, icp_reasons: reasons } : l)) : prev);
            }
          } else {
            const r = await api.gtmCompanyContext(t.id);
            if (r.error) {
              issues.push(`${who}: ${r.error}`);
            } else {
              // Partial by design: a failed leg (theorg namesake, LinkedIn
              // session) is reported while whatever landed is still kept.
              if (r.errors?.length) issues.push(`${who}: ${r.errors.join(' · ')}`);
              const staff = r.staff_count ?? null;
              setLeads((prev) => prev ? prev.map((l) => (
                l.id === t.id ? { ...l, company_staff_count: staff, company_checked_at: Date.now() } : l
              )) : prev);
            }
          }
        } catch (e) {
          issues.push(`${who}: ${e instanceof Error ? e.message : String(e)}`);
        }
        done += 1;
        setRunning({ kind, done, total: targets.length });
        setBusyIds((prev) => { const n = new Map(prev); n.delete(t.id); return n; });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY[kind] }, worker));
    setRunIssues(issues);
    setRunning(null);
    setSel(new Set());
    runningRef.current = false;
    refresh();
  }

  const filtered = !!needle || listFilter !== 'all' || fitFilter !== 'all';
  const selStyle = 'h-8 hairline rounded-sm bg-card px-2 text-xs focus:outline-none';

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="px-4 sm:px-5 py-3 shrink-0 flex items-center gap-3 flex-wrap border-b border-line">
        <h2 className="text-sm font-semibold">
          {verified.length} verified contact{verified.length === 1 ? '' : 's'}
          {filtered && <span className="text-mute font-normal"> · {visible.length} shown</span>}
        </h2>
        <div className="flex-1" />
        {verified.length > 0 && (
          <span className="mono text-[9px] uppercase tracking-[0.12em] text-mute/70 hidden md:inline">dbl-click a cell to edit</span>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter name / company / phone…"
          className="h-8 w-44 hairline rounded-sm bg-card px-2.5 text-xs focus:outline-none"
        />
        <select value={listFilter} onChange={(e) => setListFilter(e.target.value)} className={selStyle} title="Only rows from one list">
          <option value="all">all lists</option>
          {lists.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={fitFilter} onChange={(e) => setFitFilter(e.target.value as FitFilter)} className={selStyle} title="Only rows at one qualification level — pick 'unscored' to bulk-run the new ones">
          <option value="all">any qualification</option>
          <option value="unscored">unscored</option>
          <option value="strong">strong</option>
          <option value="medium">medium</option>
          <option value="weak">weak</option>
        </select>
        {running ? (
          <span className="mono text-[10px] uppercase tracking-[0.15em] text-mute inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ink animate-pulse" />
            {running.kind === 'icp' ? 'scoring' : 'fetching company'} · {running.done}/{running.total}
          </span>
        ) : sel.size > 0 ? (
          runnable.length > 0 ? (
            <>
              {/* Optional and separate: gather the company facts, then judge. */}
              <button
                onClick={() => runBulk('company')}
                className={btn + ' inline-flex items-center gap-1'}
                title="theorg org chart + LinkedIn headcount + open roles for each selected row. Cached per the gtm-policy knowledge note — a row checked recently is skipped, and a row whose last check FAILED is retried on a much shorter clock. Feeds the ICP match."
              >
                <Users size={11} /> fetch company context ({runnable.length})
              </button>
              <button onClick={() => runBulk('icp')} className={btnPrimary + ' inline-flex items-center gap-1'}>
                <Target size={11} /> run ICP match ({runnable.length})
              </button>
            </>
          ) : null
        ) : null}
        {/* Approach them. Unlike the ICP actions this needs no eligibility beyond
            being selected — the cohort itself decides who it can take (a usable
            angle, a usable phone, not already in another campaign). */}
        {sel.size > 0 && !running && (
          <button
            onClick={() => setAddingToCohort(true)}
            className={btn + ' inline-flex items-center gap-1'}
            title="Put the selected prospects on an outreach queue. Nobody can be in two cohorts — anyone already in one is held back for your approval."
          >
            <Send size={11} /> add to cohort ({sel.size})
          </button>
        )}
        {/* Only about the ICP actions — the cohort button above takes any
            selection, so this must not read as "nothing can be done". */}
        {!running && sel.size > 0 && runnable.length === 0 && (
          <span className="mono text-[10px] uppercase tracking-[0.12em] text-mute" title="Selected rows are hidden by the filters or missing name / company / title — the ICP actions need those; adding to a cohort still works">
            not ICP-runnable
          </span>
        )}
      </div>

      {cohortNote && (
        <div className="mt-2 px-3 py-2 rounded-sm hairline bg-card text-[12px]">{cohortNote}</div>
      )}

      {addingToCohort && (
        <AddToCohortModal
          leadIds={visible.filter((l) => sel.has(l.id)).map((l) => l.id)}
          onClose={() => setAddingToCohort(false)}
          onDone={(r) => {
            const bits = [`${r.added.length} added to ${r.cohort_name}`];
            if (r.conflicts.length) bits.push(`${r.conflicts.length} already in another cohort`);
            if (r.skipped.length) bits.push(`${r.skipped.length} not eligible`);
            setCohortNote(bits.join(' · '));
          }}
        />
      )}

      {/* "Issues", not "failures": a company-context run reports a leg that
          failed (theorg namesake, LinkedIn session) while the rest still landed,
          so the row is not necessarily worse off. */}
      {runIssues.length > 0 && (
        <div className="mx-4 sm:mx-5 mt-2 hairline rounded-sm bg-amber-500/5 border-amber-400/60 p-2.5 shrink-0">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[11px] text-amber-700 dark:text-amber-400">
              {runIssues.length} row{runIssues.length === 1 ? '' : 's'} reported an issue on the last run:
              <ul className="mt-1 space-y-0.5">
                {runIssues.slice(0, 5).map((m, i) => <li key={i} className="mono text-[10px]">{m}</li>)}
                {runIssues.length > 5 && <li className="mono text-[10px]">…and {runIssues.length - 5} more</li>}
              </ul>
            </div>
            <button onClick={() => setRunIssues([])} className="text-mute hover:text-ink shrink-0"><X size={12} /></button>
          </div>
        </div>
      )}

      {verified.length > 0 && <StepsLegend defs={[...STEP_DEFS, ...MANUAL_STEPS]} />}

      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 hairline rounded-sm bg-rose-500/5 border-rose-400/60 p-3 max-w-2xl">
            <div className="text-xs text-rose-600">Couldn’t load verified contacts: {error}</div>
            <button onClick={refresh} className={btn + ' mt-2'}>retry</button>
          </div>
        )}
        {error ? null : leads && verified.length === 0 ? (
          <div className="text-sm text-mute py-16 text-center">
            No verified contacts yet — rows appear here once they read green in List Enrichment.
          </div>
        ) : verified.length > 0 ? (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-paper/95 backdrop-blur">
              <tr className="mono text-[9px] uppercase tracking-[0.14em] text-mute border-b border-line">
                <Th className="w-6 pl-2" title="Select all eligible rows in view — then run ICP match on them">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={visibleEligible.length === 0}
                    onChange={toggleAll}
                    className="block h-3 w-3 accent-current cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </Th>
                <Th className="w-6" title="Truecaller — look the number up for a manual identity check" />
                <Th className="w-4" title="row colour: fully enriched AND identity holds together = green" />
                <Th>Phone</Th>
                <Th title="double-click to edit">Name</Th>
                <Th title="double-click to edit">Company</Th>
                <Th title="the COMPANY's LinkedIn page (the LinkedIn column is the person's). Comes from the company-context resolve, or any /company/ link already on the lead — double-click to correct it.">Co. LI</Th>
                <Th className="text-right" title="LinkedIn headcount — the ICP's size band. Blank until you run Company context; a dash means not checked, not zero. Double-click to correct it.">Size</Th>
                <Th title="double-click to edit">Title</Th>
                <Th title="double-click to edit">LinkedIn</Th>
                <Th title="double-click to edit">Email</Th>
                <Th title="which uploaded list this contact came from">List</Th>
                <Th title="when the enrichment chain last ran on this row">Enriched</Th>
                <Th className="text-center">Steps</Th>
                <Th className="text-center" title="identity confidence — hover for what's uncertain">Identity</Th>
                <Th className="text-center" title="ICP match verdict — strong / medium / weak vs the brand ICP">Qualification</Th>
                <Th className="w-12 pr-2 text-right" title="left: full re-enrich · right: rerun from where it stopped">Run</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => (
                <LeadRow
                  key={l.id}
                  lead={l}
                  onChanged={refresh}
                  qual={{
                    checked: sel.has(l.id),
                    disabled: !icpEligible(l),
                    onToggle: () => toggle(l.id),
                    listName: listNameOf(l),
                    busy: busyIds.get(l.id) ?? null,
                  }}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
