// Live system registry — the honest answer to "what's actually wired up".
//
// This REPLACES the old hand-maintained `modules` + `tools` D1 tables (which
// drifted out of sync with reality). Everything here is derived from the
// running system:
//   • gateways  — the external-service boundaries (code-defined list, finite +
//                 stable, with a live "configured?" flag from env)
//   • tools     — Nyo's REAL tool registry (visibleToolDefs), grouped by domain
//   • workflows — the scheduled + on-demand orchestrations
// plus, for each, the knowledge_docs it reads at runtime (the "edit this doc →
// changes this behaviour" map).
//
// Add a gateway/workflow row here when a new external dependency or orchestration
// is wired in. The tool list needs no maintenance — it is the live registry.

import { listGateways } from '../gateways/index.js';
import { listWorkflows } from './db.js';

// ── Gateways ────────────────────────────────────────────────────────────────
// The gateway LIST is live — derived from the code registry in
// gateways/index.js (one slug per external service). This META map only adds
// what the code registry doesn't carry: kind, the env keys behind the
// "configured?" flag, and the knowledge docs each gateway reads.
// kind: tunnel = self-hosted service behind a Cloudflare tunnel; saas = a paid
// external API; public-api = keyless external API; binding = Cloudflare binding.
const GATEWAY_META = {
  llm:      { kind: 'saas',       config: ['ANTHROPIC_API_KEY'], knowledge: ['llm-models'] },
  // linkedin: cookie mode (LI_AT_COOKIE, db-stored) OR the daemon (LI_BASE_URL secret) — either satisfies it.
  linkedin: { kind: 'saas', config: [['LI_AT_COOKIE', 'LI_BASE_URL']], knowledge: [] },
  image:    { kind: 'binding',    config: ['AI'], knowledge: [] },
  assets:   { kind: 'binding',    config: ['ASSETS'], knowledge: [] },
  web:      { kind: 'public-api', config: [], knowledge: [] },
  pdl:      { kind: 'saas',       config: ['PDL_API_KEY'], knowledge: [] },
  twilio:   { kind: 'saas',       config: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], knowledge: [] },
  serp:     { kind: 'saas',       config: ['SERPAPI_KEY'], knowledge: [] },
  theorg:   { kind: 'public-api', config: [], knowledge: [] },
  hf:       { kind: 'saas',       config: ['HF_TOKEN'], knowledge: ['llm-models'] },
  github:   { kind: 'saas',       config: ['PLUGINS_GH_REPO', 'PLUGINS_GH_TOKEN'], knowledge: [] },
};

// ── Workflows — the real orchestrations, grounded in code (handleScheduled in
// index.js, the event hooks, the client pollers, and the multi-step endpoints).
// kind orders them: automated (fires itself) → continuous (runs while the app is
// open) → event (fires on a trigger) → on-demand (operator/Nyo starts it).
// `has_last_run` = has an observable last-run timestamp (attached below).
const WORKFLOWS = [
  // ── automated (cron) ──
  { name: 'Hourly awareness sweep', kind: 'automated', trigger: 'cron · :00 / :15 / :30',
    steps: 'OSINT scrape (targets untouched >3h, max 5/tick) at :00 → heartbeat scoring at :15 → regenerate the digest at :30 — one leg per invocation (each gets its own subrequest budget), digest still reads this hour\'s fresh signals',
    touches: 'osint_targets, osint_mentions, osint_signals, digest_items, digest_channels',
    knowledge: ['prompt-wa-reply', 'industry-pulse', 'heartbeat-priorities'], run_slug: 'hourly-awareness-sweep' },
  { name: 'Meeting reminders', kind: 'automated', trigger: 'cron · 0 * * * *',
    steps: 'scan calendar_events, WhatsApp the operator a reminder N minutes before a meeting (no-op until a reminder chat is set)',
    touches: 'calendar_events, wa (via outbox)', knowledge: [], run_slug: 'meeting-reminders' },
  { name: 'Daily AEO publish', kind: 'automated', trigger: 'cron · 0 6 * * *',
    steps: 'publish any AEO article whose interview is captured + scheduled straight to the website (readyOnly — never auto-interviews or nags, never double-posts)',
    touches: 'aeo_questions, blog_posts',
    knowledge: ['nyyon-brand-voice', 'operator-voice', 'nyyon-aeo-playbook', 'nyyon-brand'], run_slug: 'aeo-daily-writer' },

  { name: 'Hot Takes scheduler', kind: 'automated', trigger: 'cron · :00 hourly',
    steps: 'scan due scheduled releases → publish the website leg (blog pipeline — REAL, same trust as the Blog Approve button) + fire due LinkedIn legs (social gateway → outbox; DRY-RUN unless the hottakes.live feature flag is true — dry runs log hottake_dryrun events only)',
    touches: 'hot_take_packages, hot_take_posts, blog_posts, outbound_log, calendar_events',
    knowledge: ['hottakes-timing'], run_slug: 'hottake-scheduler' },

  // ── continuous (client, while the app is open) ──
  { name: 'Nyo pending poller', kind: 'continuous', trigger: 'client · every 30s',
    steps: 'poll /api/nyo/pending, inject any queued Nyo message into the chat, mark it delivered',
    touches: 'nyo_messages', knowledge: [] },
  { name: 'Nyo wake-up', kind: 'continuous', trigger: 'client · on mount + tab focus',
    steps: 'pull WhatsApp from the gateway → survey pending / failed / missed publishes → queue a morning briefing (idempotent; skips if nothing changed)',
    touches: 'wa_messages, nyo_messages, aeo_questions', knowledge: [], run_slug: 'nyo-wake-up' },

  // ── event-driven ──
  { name: 'WhatsApp inbound', kind: 'event', trigger: 'event · per inbound message (webhook)',
    steps: 'persist the message, identify the sender (embedded author → CRM contacts → live group roster), stitch to a person',
    touches: 'wa_messages, contacts, identities', knowledge: [] },
  { name: 'Blog → Calendar mirror', kind: 'event', trigger: 'event · on blog publish',
    steps: 'on every post saved published=1, upsert a matching calendar_event (kind=blog_publish, done if past / confirmed if future)',
    touches: 'calendar_events', knowledge: [], run_slug: 'blog-to-calendar-mirror' },
  { name: 'Outbox (unified send)', kind: 'event', trigger: 'event · per outbound send',
    steps: 'every send wrapper queues an outbox row → calls the provider → flips it sent (with message id) or failed (with error + a fail event) — the permanent audit trail',
    touches: 'outbound_log', knowledge: [] },
  { name: 'Web session + identity stitching', kind: 'event', trigger: 'event · public-site tracker',
    steps: 'ingest a session + page events → identify by email/phone on a form submit → merge duplicate person ids into one identity',
    touches: 'web_sessions, web_events, identities, contacts', knowledge: [] },

  // ── on-demand (operator / Nyo) ──
  { name: 'Digest generate', kind: 'on-demand', trigger: 'on-demand · Generate button (also the hourly cron)',
    steps: 'for each enabled channel: LLM-extract WhatsApp asks + judge OSINT mentions + surface calendar events → dedupe → digest_items + per-channel run stats',
    touches: 'digest_items, digest_channels', knowledge: ['prompt-wa-reply'], run_slug: 'hourly-awareness-sweep' },
  { name: 'Digest item → action', kind: 'on-demand', trigger: 'on-demand · open an item → approve',
    steps: 'load the full thread, draft a WhatsApp reply (group-vs-DM router), send via outbox; or add-to-wishlist / discuss / dismiss',
    touches: 'digest_items, wa_messages, contacts', knowledge: ['prompt-wa-reply'] },
  { name: 'GTM intake enrichment', kind: 'on-demand', trigger: 'on-demand · per lead (batch stepper)',
    steps: 'WhatsApp identity → company-from-LinkedIn → PDL → Twilio → Google → reconcile (provenance + conflicts kept)',
    touches: 'gtm_leads', knowledge: [] },
  { name: 'AEO interview & write', kind: 'on-demand', trigger: 'on-demand · Interview & Write button',
    steps: 'ask the 4 interview questions → draft the article in Nyyon voice → publish live + mirror to calendar',
    touches: 'aeo_questions, blog_posts, calendar_events', knowledge: ['nyyon-brand-voice', 'nyyon-aeo-playbook'] },
  { name: 'Sunday editorial brain', kind: 'on-demand', trigger: 'on-demand · Sunday (Nyo offers) / Brain start',
    steps: 'ask the weekly questions → derive the week\'s article slate → schedule each across the week + create calendar events',
    touches: 'brain_sessions, aeo_questions, calendar_events', knowledge: ['nyyon-brand-voice'] },
  { name: 'Blog publish → prod', kind: 'on-demand', trigger: 'on-demand · Publish button / Nyo',
    steps: 'render the article + deliver it through the website webhook, then mirror it to the calendar',
    touches: 'blog_posts, calendar_events', knowledge: [] },
];

// ── Modules — the machine-readable product-area registry (mirrors the SPA
// sidebar; the page IS the module per nyyon-lite layer 4). area: module =
// day-to-day surface; system = operator plumbing.
const MODULES = [
  { key: 'nyo',       title: 'Nyo',       area: 'module', description: 'AI command chat — the tool pool\'s operator interface, wake-up briefings, voice mode' },
  { key: 'daily-planner', title: 'Daily Planner', area: 'module', description: 'planning workspace — a guided chat produces a persisted, editable day plan (schedule + to-dos); weekly objectives vs wing-it, history search, 3-day follow-ups' },
  { key: 'channels',  title: 'Channels',  area: 'module', description: 'WhatsApp chats/groups — policies, search, backfill' },
  { key: 'prospecting', title: 'Prospecting', area: 'module', description: 'list-first view over the GTM lead store: List Enrichment (compact table, traffic-light rows, per-row Truecaller) → Verified Contacts (cards of green, identity-confident leads)' },
  { key: 'outreach',  title: 'Outreach',  area: 'module', description: 'approach the prospects Prospecting surfaced — Conversations (a WhatsApp inbox filtered to prospects, split active / unanswered / dead, each thread opening beside the prospect card with a suggested reply offered alongside) + Queue (who is enrolled in the automated ladder, what we last said, what goes next and when; a reply removes them from automation permanently)' },
  { key: 'hot-takes', title: 'Hot Takes', area: 'module', description: 'editorial command center — topic → take → brief → article → review → social → schedule, one publication package; Publications tab carries the whole blog (any draft schedules into a release)' },
  { key: 'workflows', title: 'Workflows', area: 'module', description: 'authored workflows + run history (the generic runner\'s UI)' },
  { key: 'plugins',   title: 'Plugins',   area: 'system', description: 'trade capabilities between nyyon systems — import/export signed manifests; code travels verbatim, gateways bind mechanically, code materializes via a GitHub commit + CI deploy. Also carries the System map (the live gateways / tools / workflows / modules registry, folded in as a second view)' },
  { key: 'expand',    title: 'Expand',    area: 'system', description: 'plugin-building door for the operator\'s own LLM: a copyable builder prompt (contract + live gateway registry) plus the import box; the importer\'s errors are the iteration loop (plugin-format doc is the law)' },
  { key: 'knowledge', title: 'Knowledge', area: 'system', description: 'the editable rules layer — doc tree Nyo and the code read at runtime' },
  { key: 'activity',  title: 'Activity',  area: 'system', description: 'the event bus log — every mutation, live' },
  { key: 'settings',  title: 'Settings',  area: 'system', description: 'theme, Nyo brain provider, sidebar module toggles' },
];

// ── Tool grouping (ordered — first match wins) + per-group knowledge deps ────
const TOOL_GROUPS = [
  { group: 'GTM',                 re: /^gtm_/,                                             knowledge: ['gtm-outreach', 'gtm-you', 'gtm-watch', 'brand-icp', 'operator-positioning'] },
  // Before the WhatsApp group: outreach_wa_* would otherwise be swallowed by its
  // `wa_` pattern and split from the rest of the Outreach pool.
  { group: 'Outreach',            re: /^outreach_/,                                        knowledge: ['outreach-reply-drafting', 'outreach-promotion', 'outreach-sentiment', 'gtm-outreach'] },
  { group: 'WhatsApp',            re: /whatsapp|wa_|_wa$|restart_wa|backfill_wa|wa_chat|wa_group/, knowledge: ['prompt-wa-reply'] },
  // li-signal-scan governs the signal engine; li-sequence-* docs (one per cold
  // sequence, li-sequence-default seeded) hold the auto-send step copy.
  { group: 'LinkedIn',            re: /linkedin|_li$|^li_/,                                knowledge: [] },
  { group: 'Digest',             re: /digest/,                                            knowledge: [] },
  { group: 'OSINT',              re: /osint|heartbeat|mention/,                           knowledge: ['industry-pulse', 'heartbeat-priorities'] },
  { group: 'CRM & Pipeline',      re: /client|contact|pipeline|deal|crm|_stage/,          knowledge: [] },
  { group: 'Editorial (Blog / AEO)', re: /blog|aeo|article|brain|publish|interview|figure|cover/, knowledge: ['nyyon-brand-voice', 'operator-voice', 'nyyon-aeo-playbook', 'nyyon-brand'] },
  { group: 'Social',             re: /social|post_to|linkedin_text|_post$/,        knowledge: ['nyyon-brand-voice', 'operator-voice'] },
  { group: 'Calendar',           re: /calendar|meeting|reminder/,                         knowledge: [] },
  { group: 'Funnel & Web',        re: /funnel|identity|identities|web_|session|conversion|deploy|website/, knowledge: [] },
  { group: 'Finance',            re: /finance|cashflow/,                                  knowledge: [] },
  { group: 'Tasks',              re: /task/,                                              knowledge: [] },
  { group: 'Knowledge',          re: /knowledge|log_note|recent_events/,                  knowledge: [] },
  { group: 'System & Outbox',     re: /health|registry|restart|feature_flag|outbox|system|plugin/, knowledge: [] },
];

function groupOf(name) {
  for (const g of TOOL_GROUPS) if (g.re.test(name)) return g.group;
  return 'Other';
}

export async function buildRegistry(env) {
  // Live tools — dynamic import breaks the tools ↔ registry.js cycle.
  let toolDefs = [];
  try {
    const mod = await import('../tools/index.js');
    toolDefs = await mod.visibleToolDefs(env);
  } catch { /* tools registry unavailable — return the rest */ }

  const groupMap = new Map();
  for (const g of TOOL_GROUPS) groupMap.set(g.group, { group: g.group, knowledge: g.knowledge, tools: [] });
  groupMap.set('Other', { group: 'Other', knowledge: [], tools: [] });
  for (const d of toolDefs) {
    groupMap.get(groupOf(d.name)).tools.push({ name: d.name, description: d.description || '' });
  }
  const tools = [...groupMap.values()]
    .filter((g) => g.tools.length)
    .map((g) => ({ ...g, tools: g.tools.sort((a, b) => a.name.localeCompare(b.name)), count: g.tools.length }));

  // Gateways — the live code registry (one slug per external service) merged
  // with META. "configured?" checks the RESOLVED credentials (db-first, env
  // fallback — a cookie pasted in Settings counts), no live probe (health does
  // that). A config entry that is an ARRAY means any-of: e.g. LinkedIn is
  // satisfied by the li_at cookie OR the daemon URL.
  let resolved = env;
  try {
    const { withResolvedCredentials } = await import('./gateway-config.js');
    resolved = await withResolvedCredentials(env);
  } catch { /* env-only view is still honest */ }
  const has = (k) => resolved[k] != null && resolved[k] !== '';
  const ok = (k) => (Array.isArray(k) ? k.some(has) : has(k));
  const gateways = listGateways().map((g) => {
    const meta = GATEWAY_META[g.slug] || { kind: 'public-api', config: [], knowledge: [] };
    return {
      name: g.slug,
      service: g.service,
      kind: meta.kind,
      ops: `${g.description} · modes: ${g.modes.join(' / ')}`,
      config: meta.config,
      knowledge: meta.knowledge,
      configured: meta.config.every(ok),
      missing: meta.config.filter((k) => !ok(k)).map((k) => (Array.isArray(k) ? k.join(' | ') : k)),
    };
  });

  // Real last-run times per workflow_slug — every automated trigger now logs a
  // workflow_runs row, so the trail is live, not inferred.
  const lastRunBySlug = {};
  try {
    const r = await env.DB.prepare(
      'SELECT workflow_slug, MAX(COALESCE(finished_at, started_at)) AS t FROM workflow_runs GROUP BY workflow_slug',
    ).all();
    for (const row of r.results || []) lastRunBySlug[row.workflow_slug] = row.t;
  } catch { /* table may be absent */ }

  // Descriptive entries (real hardcoded pipelines) + the authored/runnable
  // workflows from D1 (skipping slugs a descriptive entry already covers).
  const described = WORKFLOWS.map(({ run_slug, ...w }) => ({
    ...w,
    last_run_at: run_slug ? (lastRunBySlug[run_slug] ?? null) : null,
  }));
  const coveredSlugs = new Set(WORKFLOWS.map((w) => w.run_slug).filter(Boolean));
  let authored = [];
  try {
    const rows = await listWorkflows(env);
    authored = rows
      .filter((w) => !coveredSlugs.has(w.slug) && w.status !== 'disabled')
      .map((w) => {
        const trig = w.trigger || {};
        const stepNames = (Array.isArray(w.steps) ? w.steps : [])
          .map((st) => (typeof st === 'string' ? st : st?.tool)).filter(Boolean);
        return {
          name: w.name || w.slug,
          kind: trig.kind === 'cron' ? 'automated' : trig.kind === 'event' ? 'event' : 'on-demand',
          trigger: `${w.source === 'system' ? 'system' : 'authored'} · run_workflow ${w.slug}`,
          steps: stepNames.length ? stepNames.join(' → ') : (w.description || 'observability-only (runs logged by code)'),
          touches: '',
          knowledge: [],
          last_run_at: lastRunBySlug[w.slug] ?? null,
        };
      });
  } catch { /* workflows table may be absent */ }
  const workflows = [...described, ...authored];

  return {
    gateways,
    tools,
    workflows,
    modules: MODULES,
    counts: {
      gateways: gateways.length,
      gateways_configured: gateways.filter((g) => g.configured).length,
      tools: toolDefs.length,
      tool_groups: tools.length,
      workflows: workflows.length,
      modules: MODULES.length,
    },
    generated_at: Date.now(),
  };
}
