// GTM (gtm-builder folded in — read the `module-gtm` doc first) — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import {
  importLeads as gtmImportLeads, listLeads as gtmListLeads, listBatches as gtmListBatches, getLead as gtmGetLead, manualEditLead as gtmManualEdit, enrichFullOne as gtmEnrichFull, enrichBatchStep as gtmEnrichBatchStep, leadState as gtmLeadState, pdlEnrich as gtmPdl, twilioLookup as gtmTwilio, serpSearch as gtmSerp, auditLinkedinIdentity,
} from '../lib/gtm.js';
import {
  orgChartForLead as gtmOrgChart, scoreIcpFit as gtmScoreIcp, openRolesForLead as gtmOpenRoles, companyContextForLead as gtmCompanyContext, greenLeads as gtmGreenLeads, readYou as gtmReadYou, listOrgPeople as gtmListOrgPeople,
} from '../lib/gtm-context.js';
import {
  generateAngles as gtmGenerateAngles, saveAngles as gtmSaveAngles, readAngles as gtmReadAngles, readAnglesMany as gtmReadAnglesMany, contactStatuses as gtmContactStatuses, leadThread } from '../lib/gtm-outreach.js';
import { promoteLeadToPipeline } from '../lib/pipeline.js';
import { gtmApiUsage, saveLimits as gtmSaveLimits } from '../lib/gtm-usage.js';
import { setWatch, setWatchMany, checkLeadNow, markSignal, listWatchState } from '../lib/gtm-watch.js';

export const tools = {
  // ── GTM (gtm-builder folded in — read the `module-gtm` doc first) ──────────
  gtm_import_leads: {
    def: {
      name: 'gtm_import_leads',
      description: 'GTM intake: import a phone list (pasted text — one number per line or CSV with a phone column — or a URL to fetch). Normalizes to E.164, dedupes, geo-locates offline, creates lead rows. Returns {created, duplicates, invalid, batch_id}. Enrich afterwards with gtm_enrich_lead per lead.',
      input_schema: { type: 'object', properties: { text: { type: 'string' }, url: { type: 'string' }, source: { type: 'string', description: 'where the list came from' } }, required: [] },
    },
    run: async (env, input) => gtmImportLeads(env, input),
  },
  gtm_list_leads: {
    def: {
      name: 'gtm_list_leads',
      description: "List GTM leads. Filters: batch_id, status (new|enriched), stage ('green' = fully identified: first+last name + company + linkedin + position; 'yellow'; 'red'), q (name/company/phone search). Also gtm_list_batches via this tool with list_batches:true.",
      input_schema: { type: 'object', properties: { batch_id: { type: 'string' }, status: { type: 'string' }, stage: { type: 'string' }, q: { type: 'string' }, list_batches: { type: 'boolean' } }, required: [] },
    },
    run: async (env, input) => {
      if (input.list_batches) return { batches: await gtmListBatches(env) };
      return { leads: await gtmListLeads(env, input) };
    },
  },
  gtm_read_lead: {
    def: {
      name: 'gtm_read_lead',
      description: 'Read one GTM lead in full: fields + provenance (sources/conflicts) + org chart people + outreach angles.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const lead = await gtmGetLead(env, input.id);
      if (!lead) return { error: 'not found' };
      return {
        lead: { ...lead, state: gtmLeadState(lead) },
        org: await gtmListOrgPeople(env, input.id),
        angles: await gtmReadAngles(env, input.id),
      };
    },
  },
  gtm_update_lead: {
    def: {
      name: 'gtm_update_lead',
      description: "Manually edit a GTM lead's fields: identity (name, linkedin — the PERSON's profile, email, company, position), plus company_linkedin (the COMPANY's linkedin.com/company/ page) and company_staff_count (headcount). '' clears a field. A manual edit resolves recorded conflicts on that field. Correcting company_linkedin also forgets what the old link resolved to, so the next gtm_company_context re-resolves against the new page instead of serving a cached match.",
      input_schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, linkedin: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' }, position: { type: 'string' }, company_linkedin: { type: 'string' }, company_staff_count: { type: 'number' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const { id, ...patch } = input;
      const lead = await gtmManualEdit(env, id, patch);
      return { lead: { ...lead, state: gtmLeadState(lead) } };
    },
  },
  gtm_enrich_lead: {
    def: {
      name: 'gtm_enrich_lead',
      description: 'Run the full enrichment chain on one GTM lead (accuracy order: WhatsApp identity → company-from-LinkedIn → PDL (paid, auto-skipped when name+company present) → Twilio line-type → Google socials). Takes ~15-30s. Returns per-source results + the resulting stage.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => gtmEnrichFull(env, input.id),
  },
  gtm_enrich_batch: {
    def: {
      name: 'gtm_enrich_batch',
      description: 'Drain the enrichment queue for a whole intake batch — a handful of leads per call, returning {enriched, remaining}. If a big list was just imported (or the operator says enrichment "stopped"/"stalled"/"got stuck"), CALL THIS REPEATEDLY (loop it yourself) until remaining is 0 — do not stop after one call and report partial progress as done. The module UI also drives this from the browser; if the operator says it stalled, that almost certainly means the browser-side loop died (tab switched, browser closed) while leads were still \'new\' — this tool finishes the job independent of any tab.',
      input_schema: { type: 'object', properties: { batch_id: { type: 'string' } }, required: ['batch_id'] },
    },
    run: async (env, input) => gtmEnrichBatchStep(env, { batch_id: input.batch_id }),
  },
  gtm_api_usage: {
    def: {
      name: 'gtm_api_usage',
      description: 'Usage meters for the paid enrichment APIs: PDL (used/limit + remaining credits from its own headers), SerpApi (live account numbers), Twilio (account balance). Each row carries pct, renews_in_days, and warning:true when close to the cap. Use when the operator asks "how much PDL/SerpApi do we have left", before enriching a BIG list (check there is budget), or when enrichment results start failing with quota errors. Limits config lives in the gtm-api-limits knowledge doc (update it via gtm_api_limits_update when the operator states their real plan numbers or renewal day).',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => gtmApiUsage(env),
  },
  gtm_api_limits_update: {
    def: {
      name: 'gtm_api_limits_update',
      description: 'Update the GTM API limits config (the gtm-api-limits knowledge doc): per provider monthly_limit / renewal_day (day of month the plan resets, 1-28) / warn_at_pct, and twilio.balance_warn_usd. Pass only the fields to change, e.g. {"pdl":{"monthly_limit":100,"renewal_day":22}}. Use when the operator states their real plan caps or renewal dates.',
      input_schema: {
        type: 'object',
        properties: {
          pdl:     { type: 'object', properties: { monthly_limit: { type: 'number' }, renewal_day: { type: 'number' }, warn_at_pct: { type: 'number' } } },
          serpapi: { type: 'object', properties: { monthly_limit: { type: 'number' }, renewal_day: { type: 'number' }, warn_at_pct: { type: 'number' } } },
          twilio:  { type: 'object', properties: { balance_warn_usd: { type: 'number' } } },
        },
        required: [],
      },
    },
    run: async (env, input) => gtmSaveLimits(env, input || {}),
  },
  gtm_org_chart: {
    def: {
      name: 'gtm_org_chart',
      description: "Fetch (or read the cached) org chart for a GTM lead's company from theorg.com — real names, titles, hierarchy. refresh:true refetches; slug overrides the company slug (paste a theorg.com/org/... URL for namesake companies). org_status 'warn' = possible wrong company, which BLOCKS outreach until confirmed.",
      input_schema: { type: 'object', properties: { id: { type: 'string' }, refresh: { type: 'boolean' }, slug: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => gtmOrgChart(env, input),
  },
  gtm_score_icp: {
    def: {
      name: 'gtm_score_icp',
      description: "Score a GTM lead against the ICP (the editable `brand-icp` knowledge doc): strong/medium/weak + reason/gap tags. Stored on the lead. Reads the company facts gtm_company_context gathers (headcount, open roles, org chart) — run that first for a verdict grounded in real company data instead of an inference from the brand name.",
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => gtmScoreIcp(env, input.id),
  },
  gtm_company_context: {
    def: {
      name: 'gtm_company_context',
      description: "Gather everything about the COMPANY behind a GTM lead in one pass: theorg org chart, LinkedIn headcount (staff_count — the ICP's size band), and LinkedIn open roles. Cached per lead; refresh:true refetches. Partial by design — a failed leg is reported, not fatal. Feeds gtm_score_icp.",
      input_schema: { type: 'object', properties: { id: { type: 'string' }, refresh: { type: 'boolean' } }, required: ['id'] },
    },
    run: async (env, input) => gtmCompanyContext(env, input.id, { refresh: !!input.refresh }),
  },
  gtm_open_roles: {
    def: {
      name: 'gtm_open_roles',
      description: "Fetch a GTM lead company's open roles from LinkedIn (company id resolved once via the throttled linkedin-gateway, cached; jobs via the public guest API from the gateway's residential IP). Stored on the lead.",
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => gtmOpenRoles(env, input.id),
  },
  gtm_outreach_angles: {
    def: {
      name: 'gtm_outreach_angles',
      description: "Generate ranked outreach angles + draft WhatsApp bubbles for a GREEN GTM lead (one Opus call driven by the gtm-you / gtm-outreach-playbook / -rules / -examples knowledge docs + the verified org chart). Blocked while org_status='warn'. Drafts persist; read them back with gtm_read_lead.",
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => gtmGenerateAngles(env, input.id),
  },
  gtm_save_angles: {
    def: {
      name: 'gtm_save_angles',
      description: 'Persist an edited outreach angles payload for a GTM lead (whole payload replace — read it first with gtm_read_lead, edit the bubbles, save it back).',
      input_schema: { type: 'object', properties: { id: { type: 'string' }, payload: { type: 'object' } }, required: ['id', 'payload'] },
    },
    run: async (env, input) => gtmSaveAngles(env, input.id, input.payload),
  },
  gtm_lead_thread: {
    def: {
      name: 'gtm_lead_thread',
      description: "A GTM lead's WhatsApp conversation, honestly sourced: engine sends (sent/failed), manual outbound from the operator's own WhatsApp, and the lead's replies — each message with dir in/out, status (sent | confirmed = WhatsApp accepted it | failed | received) and time. Read-only.",
      input_schema: { type: 'object', properties: { id: { type: 'string' }, refresh: { type: 'boolean', description: 'true = pull the chat\'s live history from WhatsApp into the store first (slower, complete)' } }, required: ['id'] },
    },
    run: async (env, input) => leadThread(env, input.id, { refresh: !!input.refresh }),
  },
  gtm_lead_to_pipeline: {
    def: {
      name: 'gtm_lead_to_pipeline',
      description: "Promote a GTM lead into the Pipeline CRM: creates a linked contact + client row at stage 'target' (idempotent — re-running returns the existing client_id).",
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => promoteLeadToPipeline(env, input.id, 'nyo'),
  },
  gtm_enrich_sources: {
    def: {
      name: 'gtm_enrich_sources',
      description: 'Run ONE raw enrichment source directly (no lead required): pdl {phone,name,region,country}, twilio {phone}, or serp {q}. Use gtm_enrich_lead for the full chain on a lead. Sources degrade to {skipped} when their secret is not configured.',
      input_schema: { type: 'object', properties: { source: { type: 'string', enum: ['pdl', 'twilio', 'serp'] }, phone: { type: 'string' }, name: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' }, q: { type: 'string' } }, required: ['source'] },
    },
    run: async (env, input) => {
      if (input.source === 'pdl') return gtmPdl(env, input);
      if (input.source === 'twilio') return gtmTwilio(env, input.phone);
      if (input.source === 'serp') return gtmSerp(env, { q: input.q });
      return { error: 'unknown source' };
    },
  },
  gtm_green_leads: {
    def: {
      name: 'gtm_green_leads',
      description: 'List the GREEN (fully identified) GTM leads ready for context enrichment + outreach. Each row carries warm-contact flags, any stored angles, AND its contact_status: not_contacted | contacted (first/last_contacted_at, sends) | replied (replied_at — an inbound WhatsApp message after our outreach). Use to answer "who did I contact", "who replied", "who is still untouched".',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const leads = await gtmGreenLeads(env);
      const [angles, statuses] = await Promise.all([
        gtmReadAnglesMany(env, leads.map((l) => l.id)),
        gtmContactStatuses(env, leads.map((l) => l.id)),
      ]);
      return { leads: leads.map((l) => ({ ...l, angles: angles.get(l.id) ?? null, ...(statuses.get(l.id) || {}) })) };
    },
  },
  gtm_identity_audit: {
    def: {
      name: 'gtm_identity_audit',
      description: 'Audit every GTM lead whose assigned LinkedIn profile does NOT match their name (the wrong-person / namesake bug). Reports match / unverifiable / mismatch lists. With fix:true it CLEANS each mismatch: clears the linkedin, tombstones the URL so it can never be re-attached, records a visible conflict for operator review, and also clears company/position when they were derived from that wrong profile. Run after big imports, or whenever the operator doubts a linkedin assignment.',
      input_schema: { type: 'object', properties: { fix: { type: 'boolean', description: 'actually clean the mismatches (default false = report only)' } }, required: [] },
    },
    run: async (env, input) => auditLinkedinIdentity(env, { fix: !!input?.fix }),
  },
  gtm_you: {
    def: {
      name: 'gtm_you',
      description: "Read the GTM operator profile (gtm-you doc: name/role/business/location + WhatsApp groups + warm connections — drives outreach positioning and warm-path matching). Edit it with write_knowledge on slug 'gtm-you' (JSON body).",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ you: await gtmReadYou(env) }),
  },
  gtm_watch_set: {
    def: {
      name: 'gtm_watch_set',
      description: 'Start or stop WATCHING GTM leads\' LinkedIn for signals (company hiring a relevant role, job change). Enriched leads are watched BY DEFAULT — this is mainly the curation tool for removing irrelevant ones (pass ids + on:false). Watched leads are checked on a bounded hourly cycle; a NEW signal pings the operator (Digest + his own WhatsApp) with a drafted response he sends by hand — watching NEVER messages a lead. Leads without a LinkedIn profile or company are held out of rotation until enrichment finds one.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'one gtm_leads id (gl_...)' },
          ids: { type: 'array', items: { type: 'string' }, description: 'bulk: many lead ids at once' },
          on: { type: 'boolean', description: 'true = watch, false = stop (default true)' },
        },
        required: [],
      },
    },
    run: async (env, input) => (Array.isArray(input?.ids) && input.ids.length
      ? setWatchMany(env, input.ids, input?.on !== false)
      : setWatch(env, input?.id, input?.on !== false)),
  },
  gtm_watch_list: {
    def: {
      name: 'gtm_watch_list',
      description: 'The GTM Watch surface: every watched lead (with last-check time and headline baseline) and the signal feed — detected signals with kind, status (new | pinged | responded | dismissed), the drafted WhatsApp response, and a wa.me link that opens the lead\'s chat pre-filled. Read-only. Use to answer "any signals?", "who am I watching?".',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => listWatchState(env),
  },
  gtm_watch_check: {
    def: {
      name: 'gtm_watch_check',
      description: 'Force a signal check on ONE watched lead right now (LinkedIn headline diff + company open-roles match), bypassing the check interval. New signals are drafted and pinged exactly like the hourly tick. Costs LinkedIn reads — use for "check X now", not in bulk.',
      input_schema: { type: 'object', properties: { id: { type: 'string', description: 'gtm_leads id' } }, required: ['id'] },
    },
    run: async (env, input) => checkLeadNow(env, input.id),
  },
  gtm_signal_mark: {
    def: {
      name: 'gtm_signal_mark',
      description: 'Resolve a GTM Watch signal: responded (the operator sent something), dismissed (not acting on it), or new (reopen). Keeps the signal feed honest — the deterministic signal id already prevents the same finding from ever re-firing.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'signal id (sig_...)' }, status: { type: 'string', enum: ['responded', 'dismissed', 'new'] } },
        required: ['id', 'status'],
      },
    },
    run: async (env, input) => markSignal(env, input.id, input.status),
  },
};
