// Thin REST client + Nyo chat SSE helper.

export type Event = { id: string; kind: string; actor: string; payload: any; created_at: number };

// Nyo conversation history. `messages` on the detail mirrors the Msg shape the
// Chat component renders, so a resumed thread drops straight into state.
export type ConversationSummary = {
  // `turns` counts operator messages, not raw persisted rows (one exchange
  // writes an assistant row per model hop plus a row per tool call).
  id: string; title: string; turns: number; created_at: number; updated_at: number;
};
export type ConversationDetail = {
  id: string; title: string; created_at: number; updated_at: number; truncated?: boolean;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    tool_events?: Array<{ name: string; input?: unknown; result?: unknown; error?: string }>;
    ts?: number;
  }>;
};

export type SystemHealthLevel = 'green' | 'yellow' | 'red';
export type SystemHealthCheck = {
  name: string;
  status: SystemHealthLevel;
  severity: 'critical' | 'degraded';
  note: string | null;
};
export type SystemHealth = {
  overall: SystemHealthLevel;
  checks: SystemHealthCheck[];
  ts: number;
};

export type KnowledgeDoc = {
  slug: string; title: string; body: string;
  scope: 'global' | 'module';
  module: string | null;
  // Tree parent. Null for the root doc (`nyyon-root`). Forms the "context
  // route" — walk parents up to root for the breadcrumb chain.
  parent_slug: string | null;
  updated_at: number;
};
// One step in the breadcrumb chain root → … → self. Returned by
// `/api/knowledge/:slug/path`. Used by the Knowledge page header and by
// Nyo when answering "what context do I need to understand X".
export type KnowledgePathStep = { slug: string; title: string };

export type ContentBlock = {
  slug: string;
  title: string;
  body: string;
  kind: 'text' | 'markdown' | 'html';
  page: string | null;
  section: string | null;
  updated_at: number;
  updated_by: string | null;
  published_at: number | null;
};

// ─── Digest (morning brief — actionable summary) ────────────
export type DigestKind = 'wa_message' | 'wa_group' | 'osint_mention' | 'osint_insight' | 'content_opportunity' | 'email' | 'note' | 'opportunity' | 'li_signal' | 'attention';

// Source-row-enriched payload returned by GET /api/digest/:id/context.
// Lets the "Discuss with Nyo" handoff prime the chat with the *actual* message
// body + thread, not just the LLM summary.
export type DigestContextParticipant = {
  id: string;
  full_name: string | null;
  email: string | null;
  linkedin_url: string | null;
};

export type DigestContext = {
  item: DigestItem;
  message: {
    id: string;
    chat_id: string;
    from_me: number;
    sender_id: string | null;
    sender_name: string | null;
    body: string | null;
    timestamp: number;
  } | null;
  chat: { id: string; name: string | null; is_group: number } | null;
  thread: Array<{
    id: string;
    from_me: number;
    sender_id: string | null;
    sender_name: string | null;
    body: string | null;
    timestamp: number;
  }>;
  mention: Record<string, unknown> | null;
  // Map keyed by sender_id (e.g. `972508425412@c.us`) → matched contact.
  // The drawer uses this to swap raw ids for real names + LinkedIn badges.
  participants: Record<string, DigestContextParticipant>;
};

// Outbox — unified outbound send log. Every outbound surface (WA reply/text/
// image/document/reaction, LI direct message, blog publish from local → prod,
// future email/SMS) inserts a row here in the `queued` state, then flips to
// `sent` or `failed`. The Outbox surface reads these rows and exposes a
// retry button on failures.
//
// "Blog" is a channel in the same sense as WhatsApp: it has a destination
// (nyyon.com, behind the prod D1), a delivery attempt that can fail mid-
// flight (prod PUT, deploy sidecar), and an audit row with retry semantics.
export type OutboxChannel = 'wa' | 'li' | 'blog' | 'email' | 'sms';
export type OutboxStatus  = 'queued' | 'sent' | 'failed';
export type OutboxKind    = 'text' | 'reply' | 'image' | 'document' | 'reaction' | 'post' | 'aeo';
export type OutboxRow = {
  id: string;
  channel: OutboxChannel;
  kind: OutboxKind | string;
  to_id: string | null;
  to_name: string | null;
  body: string | null;
  payload: Record<string, unknown> | null;
  payload_json?: string | null;
  status: OutboxStatus;
  message_id: string | null;
  error: string | null;
  attempt: number;
  parent_id: string | null;
  source: string | null;
  source_ref: string | null;
  created_at: number;
  updated_at: number;
};

export type DigestItem = {
  id: string;
  kind: DigestKind;
  meta_json?: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  title: string;
  summary: string | null;
  source_label: string | null;
  source_url: string | null;
  urgency: 1 | 2 | 3;           // 1 = high, 3 = low
  actionable: number;           // 0 | 1
  suggested_action: string | null;
  starred: number;              // 0 | 1
  read_at: number | null;
  created_at: number;
  meta: unknown;
};

export type DigestActionType = 'reply_wa' | 'discuss' | 'dismiss' | 'add_to_wishlist' | 'draft_blog' | 'draft_social' | 'draft_take';
// Recipient modes:
//   'group'         — post into the recipient's chat as a fresh message.
//   'private'       — DM the sender (WA reply path).
//   'reply_to_ask'  — quote-reply to a specific recent open question in
//                     the recipient's group. Carries `quotedMessageId`
//                     so the executor can route to wa-gateway /messages/reply.
//                     OSINT items can surface multiple of these — one per
//                     ask the news answers.
export type DigestRecipientMode = 'group' | 'private' | 'reply_to_ask';
export type DigestRecipient = {
  kind: 'wa_chat';
  mode: DigestRecipientMode;
  id: string;
  name: string;
  label: string;
  // For 'reply_to_ask' mode, the WA message id of the question being
  // answered. The executor uses it to call wa-gateway's /messages/reply so
  // the response lands as an in-thread quote.
  quotedMessageId?: string;
  // Optional bookkeeping for OSINT→ask routing.
  source_digest_id?: string;
  source_ask_summary?: string;
  match_reason?: string;
};
export type DigestAction = {
  type: DigestActionType;
  label: string;
  description: string;
  draft?: string;
  recipient?: DigestRecipient;
  recipients?: DigestRecipient[];
  recommended_mode?: DigestRecipientMode;
  recommended_reason?: string | null;
  // Name the server believes is the target person (LLM-extracted at digest
  // time OR regex'd out of the title/action). Used by the drawer to
  // pre-fill the contact picker when no auto-resolved private recipient
  // exists yet.
  recommended_target_name?: string | null;
  metadata?: {
    full_name?: string | null;
    phone?: string | null;
    sender_id?: string | null;
    chat_name?: string | null;
    linkedin_url?: string | null;
    email?: string | null;
    [k: string]: unknown;
  };
};
export type DigestActionsResponse = {
  item: DigestItem | null;
  context?: DigestContext;
  actions: DigestAction[];
};

export type DigestStats = {
  total: number;
  unread: number;
  high: number;
  action_count: number;
  starred: number;
  // ms-epoch of the most recent successful generate() run, or null if the
  // log has none. Sourced from the events row generate() writes.
  last_generated_at: number | null;
};

// Daily outreach KPI — today's LI + WA outreach vs the goal (kpi-outreach doc).
export type OutreachKpi = {
  target: number;
  done: number;
  remaining: number;
  pct: number;                          // 0..1
  status: 'off_day' | 'behind' | 'on_track' | 'done';
  expected_by_now: number;
  is_work_day: boolean;
  by_channel: { linkedin: number; whatsapp: number };
  scheduled?: number;
  manual?: number;
  tz: string;
  day_start_ms: number;
  computed_at: number;
};

// One real outreach send today — the itemized rows behind the KPI count.
export type OutreachAttempt = {
  channel: 'linkedin' | 'whatsapp';
  name: string;
  company: string | null;
  kind: string;              // 'connect' | 'message'
  body: string;              // the exact copy that went out
  at: number;                // ms epoch
  // conversation enrichment (may be absent on older payloads)
  replied?: boolean;
  uncaught?: boolean;        // they replied and you haven't responded since
  sentiment?: 'positive' | 'neutral' | 'negative' | null;
  sentiment_reason?: string | null;
  msgs_in?: number;
  msgs_out?: number;
  reply_text?: string | null; // their latest inbound message
};
export type OutreachLog = {
  day_start_ms: number;
  total: number;
  by_channel: { linkedin: number; whatsapp: number };
  attempts: OutreachAttempt[];
};

export type DigestChannelSource = 'whatsapp' | 'calendar' | 'osint' | 'osint_insights' | 'heartbeat' | 'email';
export type DigestChannel = {
  source: DigestChannelSource;
  label: string;
  enabled: number;          // 1 | 0
  cadence: 'manual' | 'daily' | 'hourly';
  notes: string | null;
  last_run_at: number | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  total_runs: number;
  total_added: number;
  created_at: number;
  updated_at: number;
};

// ─── OSINT (mention scrapers, port of inrepute) ──────────────
export type OsintTarget = {
  id: string;
  name: string;
  domain: string | null;
  app_id: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
  mentions_count?: number;
  last_mention_at?: number | null;
};

export type OsintSource = 'hn' | 'reddit' | 'stackoverflow' | 'github' | 'appstore' | 'website' | 'duckduckgo';

export type OsintMention = {
  id: string;
  target_id: string;
  target_name?: string | null;
  source: OsintSource;
  source_url: string | null;
  reviewer: string | null;
  rating: number | null;
  text: string;
  posted_at: number | null;
  confidence: number | null;
  kind: 'mention' | 'review';
  raw: unknown;
  raw_json?: string | null;
  created_at: number;
};

export type OsintScrapeResult = {
  target_id: string;
  total: number;
  results: { source: OsintSource; count: number; error: string | null }[];
};

export type HeartbeatSource = {
  id: string; kind: 'rss' | 'gnews'; name: string; url: string;
  theme: string | null; enabled: number;
  last_fetched_at: number | null; last_status: string | null; last_error: string | null;
};
// Score gates — what survives each stage of the sweep. Stored in the editable
// `heartbeat-priorities` knowledge note, never hardcoded; these are 0-100.
export type HeartbeatGates = {
  digest_min_content: number;
  topics_min_content: number;
  enrich_min_relevance: number;
};
export type OsintListener = {
  source: OsintSource;
  label: string;
  enabled: number;          // 1 | 0
  cadence: 'manual' | 'daily' | 'hourly';
  notes: string | null;
  last_run_at: number | null;
  last_status: 'ok' | 'error' | 'running' | null;
  last_error: string | null;
  total_runs: number;
  total_added: number;
  created_at: number;
  updated_at: number;
};

// ─── contacts (operator-curated layer on top of identities) ──
export type ContactStatus = 'prospect' | 'lead' | 'client' | 'past_client' | 'partner' | 'do_not_contact';
export type ContactSource = 'referral' | 'inbound_form' | 'inbound_wa' | 'inbound_email' | 'paid_ad' | 'event' | 'cold_outreach' | 'social' | 'other';

export type Contact = {
  id: string;
  identity_id: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  client_id: string | null;
  status: ContactStatus;
  source: ContactSource | null;
  owner: string | null;
  tags: string[] | null;
  notes: string | null;
  starred: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
};

export type ContactTaxonomy = {
  statuses: ContactStatus[];
  sources:  ContactSource[];
  owners:   string[];
  tags:     string[];
};

export type ContactFilters = {
  status?:  ContactStatus | '';
  source?:  ContactSource | '';
  owner?:   string;
  tag?:     string;
  search?:  string;
  starred?: boolean;
  client_id?: string;
  limit?:   number;
};

// ─── clients (companies / accounts — the CRM layer above contacts) ──
export type ClientStatus = 'active' | 'past' | 'prospect' | 'partner';

export type Client = {
  id: string;
  name: string;
  status: ClientStatus;
  industry: string | null;
  website: string | null;
  engagement: string | null;
  owner: string | null;
  tags: string[] | null;
  notes: string | null;
  starred: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
  contact_count?: number;   // present on list rows
  contacts?: Contact[];     // present on the read-one (detail) shape
};

export type ClientTaxonomy = {
  statuses: ClientStatus[];
  owners:   string[];
  tags:     string[];
};

export type ClientFilters = {
  status?:  ClientStatus | '';
  tag?:     string;
  search?:  string;
  starred?: boolean;
  limit?:   number;
};

// ─── Workflows (named stitched pipelines + run history) ─────
export type WorkflowSource = 'system' | 'nyo' | 'manual';
export type WorkflowStatus = 'active' | 'draft' | 'disabled';
export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed';

export type WorkflowTrigger = { kind: string; [k: string]: unknown };
export type WorkflowStep    = { type: string; name?: string; [k: string]: unknown };

export type Workflow = {
  slug: string;
  name: string;
  description: string | null;
  trigger: WorkflowTrigger;
  steps:   WorkflowStep[];
  source:  WorkflowSource;
  status:  WorkflowStatus;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
};

export type WorkflowRun = {
  id: string;
  workflow_slug: string;
  status: WorkflowRunStatus;
  trigger_kind: string | null;
  trigger_payload: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

// ─── blog (analytics overlay on top of blog_posts) ──────────
export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  tags: string | null;          // JSON-encoded string[] in DB; parsed below
  published_at: number | null;
  published: number;
  updated_at: number;
  updated_by: string | null;
  views: number;
  unique_visitors: number;
  last_view: number | null;
  avg_scroll: number;           // 0-100
  cta_clicks: number;
  // Featured image (populated by lib/blog-images.js via Workers AI → R2).
  // URL is same-origin (/assets/blog/<slug>.png).
  featured_image_url: string | null;
  featured_image_prompt: string | null;
  featured_image_model: string | null;
  featured_image_generated_at: number | null;
};

export type BlogImageResult = {
  url: string;
  key: string;
  model: string;
  prompt: string;
  generated_at: number;
  size_bytes: number;
  width: number;
  height: number;
  slug: string;
};

export type BlogPostWithTags = Omit<BlogPost, 'tags'> & { tags: string[] };

// ─── finance (monthly cashflow calculator) ──────────────────
export type FinanceKind = 'income' | 'expense' | 'draw';
export type FinanceEntry = {
  id: string;
  year: number;
  month: number;
  position: number;
  kind: FinanceKind;
  status: string;              // '' | 'V' | 'X' | '!' | '?'
  item: string;
  income_pretax: number | null;
  income_net: number | null;   // amount that hits the balance (pretax*1.18 or entered directly)
  expense: number | null;      // amount subtracted (expense / draw)
  note: string | null;
  created_at: number;
  updated_at: number;
};

// ─── AEO module (writer backlog + cron) ─────────────────────
export type AeoStatus = 'pending' | 'drafted' | 'published' | 'skipped' | 'failed';

export type AeoQuestion = {
  slug: string;
  question: string;
  target_keyword: string | null;
  priority: number;
  status: AeoStatus;
  scheduled_for: number | null;
  drafted_blog_slug: string | null;
  last_error: string | null;
  attempts: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

// ─── Calendar (central event store) ─────────────────────────
export type CalendarKind   = 'meeting' | 'social_post' | 'blog_publish' | 'campaign' | 'deadline' | 'other';
export type CalendarStatus = 'pending' | 'confirmed' | 'done' | 'cancelled';

export type CalendarEvent = {
  id: string;
  kind: CalendarKind;
  title: string;
  description: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;          // 1 | 0
  status: CalendarStatus;
  source: string;           // manual | nyo | blog | aeo | social | external
  source_ref: string | null;
  link_url: string | null;
  location: string | null;
  attendees: { name?: string; email?: string }[] | null;
  body: string | null;
  platform: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
};

export type CalendarTaxonomy = { kinds: CalendarKind[]; statuses: CalendarStatus[] };

export type CalendarFilters = {
  from?:   number;
  to?:     number;
  kind?:   CalendarKind;
  source?: string;
};

export type AeoSuggestion = {
  id: string;
  signal_id: string | null;
  title: string;
  angle: string;
  rationale: string | null;
  target_keyword: string | null;
  source_name: string | null;
  source_url: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'drafted' | 'failed';
  question_slug: string | null;
  last_error: string | null;
  created_at: number;
};

export type AeoDraftResult =
  | { ok: true; question_slug: string; blog_slug: string; title: string }
  | { ok: false; error: string; question_slug?: string };

export type HomeSection = {
  id: string;
  page: string;
  label: string;
  position: number;
  visible: number; // 1 | 0
  updated_at: number;
  updated_by: string | null;
};

// ─── funnel surface ──────────────────────────────────────────
export type WebSession = {
  id: string;
  cookie_id: string | null;
  person_id: string | null;
  person_email: string | null;
  events_count: number;
  ip: string | null;
  ua: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  msclkid: string | null;
  ttclid: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  referrer: string | null;
  landing_path: string | null;
  started_at: number;
  last_seen_at: number;
};

export type WebEvent = {
  id: string;
  session_id: string | null;
  cookie_id: string | null;
  person_id: string | null;
  person_email: string | null;
  event_type: string;
  event_data: unknown;
  page_path: string | null;
  created_at: number;
};

export type WebIdentity = {
  id: string;
  cookie_id: string | null;
  email: string | null;
  phone: string | null;
  channel: string | null;
  display_name: string | null;
  meta: unknown;
  first_seen_at: number;
  last_seen_at: number;
  sessions_count: number;
  events_count: number;
  conversions_count: number;
};

export type WebConversion = {
  id: string;
  identity_id: string | null;
  session_id: string | null;
  person_email: string | null;
  kind: string;
  value: number | null;
  currency: string | null;
  source: string | null;
  payload: unknown;
  created_at: number;
};

export type IdentityLink = {
  id: string;
  cookie_id: string | null;
  person_id: string;
  identifier_type: string;
  identifier_value: string;
  method: string | null;
  source_event_id: string | null;
  created_at: number;
};

export type IdentityDetail = {
  identity: WebIdentity & { phone?: string | null; handle?: string | null };
  cookies: string[];
  sessions: WebSession[];
  events: WebEvent[];
  conversions: WebConversion[];
  links: IdentityLink[];
};

// ─── WhatsApp listener ───────────────────────────────────────
export type WaChat = {
  id: string;
  name: string | null;
  is_group: number;
  auto_listen: number;
  can_send: number;
  last_message_at: number | null;
  last_snippet: string | null;
  first_seen_at: number;
  updated_at: number;
  messages_count: number;
};
export type WaMessage = {
  id: string;
  chat_id: string;
  from_me: number;
  sender_id: string | null;
  sender_name: string | null;
  body: string | null;
  timestamp: number;
  raw_json: unknown;
  person_id: string | null;
  created_at: number;
};

export type StageKey = 'lead' | 'mql' | 'sql' | 'negotiations' | 'deal' | 'contract' | 'client' | 'dropped' | 'disqualified';
export type StageDef = { key: StageKey; label: string; channel: 'website' | 'offline'; tone?: 'negative' };
export type StagePerson = {
  person_id: string | null;
  email: string | null;
  display_name: string | null;
  reached_at: number;
  last_touch_at: number;
  touches: number;
  total_value: number | null;
};

export type StatsWindow = '24h' | '7d' | '30d' | 'all';

export type FunnelStats = {
  since: StatsWindow;
  since_ts: number;
  generated_at: number;
  sessions: number;
  identities: number;
  visits: number;
  preq_submits: number;
  leads: number;
  mqls: number;
  booked: number;
  disqualified: number;
  rates: {
    visit_to_preq:  number;
    preq_to_lead:   number;
    lead_to_mql:    number;
    mql_to_booked:  number;
  };
  events_by_type: Record<string, number>;
  conversions_by_kind: Record<string, { n: number; total_value: number }>;
};

export type FunnelOverviewKpi = { n: number; delta_pct: number | null };
export type FunnelBar = {
  key: string;
  label: string;
  n: number;
  conv_pct: number;
  dev_pp: number;
  avg_pct: number;
};
export type CampaignRow = {
  name: string;
  source: string;
  landing: string | null;
  visits: number;
  visits_delta_pct: number | null;
  leads: number;
  leads_delta_pct: number | null;
  mqls: number;
  mqls_delta_pct: number | null;
  sqls: number;
  sqls_delta_pct: number | null;
};
export type OverviewStage = {
  key: StageKey;
  label: string;
  channel: 'website' | 'offline';
  tone: 'negative' | null;
  n: number;
  prev_n: number;
  delta_pct: number | null;
};
export type FunnelOverview = {
  since: StatsWindow;
  generated_at: number;
  has_prev: boolean;
  kpis: {
    visitors: FunnelOverviewKpi;
    leads:    FunnelOverviewKpi;
    mqls:     FunnelOverviewKpi;
    sqls:     FunnelOverviewKpi;
  };
  funnel: FunnelBar[];
  stages: OverviewStage[];
  campaigns: CampaignRow[];
};

export type SankeyColumn = { key: string; label: string };
export type SankeyNode   = {
  id: string;
  column: number;
  label: string;
  side: 'top' | 'bottom' | null;
  value: number;
  color: string;
};
export type SankeyLink   = { source: string; target: string; value: number; campaign: string };
export type SankeyData   = {
  since: StatsWindow;
  generated_at: number;
  cohort_total: number;
  cohort_in_funnel: number;
  campaigns: string[];
  columns: SankeyColumn[];
  nodes: SankeyNode[];
  links: SankeyLink[];
};

export type FeatureFlag = {
  key: string;
  value: number;
  scope: 'surface' | 'tool' | 'module';
  description: string | null;
  updated_at: number;
};

async function j<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const r = await fetch(input, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// Prod worker URL — all funnel READ endpoints route here. The marketing
// site's tracker.js posts session/event/conversion beacons to this host
// in production, so this is where real funnel data lives. Local D1 has
// none. Operator-initiated writes (logConversion) stay on the relative
// path so they land wherever the dev worker is bound.
export const PROD_API_BASE = 'https://nyyon-cmd-api.lev-f6b.workers.dev';

function webApi(path: string): string {
  return PROD_API_BASE + path;
}

// ─── Overview breakdowns (deep drill into the sessions table) ─
export type BreakdownDim = 'source' | 'referrer' | 'landing' | 'campaign';
export type BreakdownRow = {
  value: string;
  visits: number;
  visitors: number;
  leads: number;
  mqls: number;
  sqls: number;
  last_visit_at: number | null;
};
export type BreakdownSession = {
  id: string;
  started_at: number;
  last_seen_at: number | null;
  cookie_id: string | null;
  person_id: string | null;
  referrer: string | null;
  landing_path: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  gclid: string | null;
  fbclid: string | null;
  events_count: number;
  person_email: string | null;
  conversion_kinds: string | null;  // comma-joined, e.g. "lead,mql"
};

export type NyoModelMap = {
  nyo_mid: string; nyo_high: string;
  writer: string; writer_small: string; vision: string;
  writer_fallback: string;
  wizard_tier: string;
  source?: 'doc' | 'defaults';
};
export type BrainInfo = {
  provider: 'anthropic' | 'openai' | string;
  model: string | null;
  key_set: boolean;
  models: NyoModelMap;
  defaults: Omit<NyoModelMap, 'source'>;
};

export type Deal = {
  id: string; name: string; status: string;
  stage: string | null; deal_value: number | null; mrr_value: number | null;
  engagement: string | null;
};

export type Task = {
  id: string; day: string; title: string; detail: string | null; status: string; ord: number;
};

// ─── Social (auto-drafted posts from published blog articles) ─────
export type SocialChannel = 'linkedin-company' | 'linkedin-personal' | 'facebook-company';
export type SocialStatus  = 'draft' | 'posted' | 'failed' | 'skipped';
export type SocialPost = {
  id: string;
  blog_slug: string;
  blog_title: string | null;
  channel: SocialChannel;
  status: SocialStatus;
  content: string;
  image_url: string | null;
  error: string | null;
  outbox_id: string | null;
  posted_at: number | null;
  created_at: number;
  updated_at: number;
};
export type SocialConnection = { connection: SocialChannel; label: string; network: string; kind: string; configured: boolean };

// ─── GTM (gtm-builder folded in: intake → enrich → outreach) ─────────
export type GtmLeadStage = 'red' | 'yellow' | 'green';
export type GtmLead = {
  id: string;
  phone: string;
  normalized_phone: string | null;
  status: 'new' | 'enriched' | 'dead_end';   // 'dead_end' = operator gave up enriching it
  source: string | null;
  batch_id: string | null;
  country: string | null;
  region: string | null;
  name: string | null;
  photo: string | null;
  socials: string;            // JSON [{type,url,src,at}]
  linkedin: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  line_type: string | null;
  carrier: string | null;
  sources: string;            // JSON {field:{tool,at}}
  conflicts: string;          // JSON [{field,value,tool,at}]
  dismissed: string;          // JSON [url]
  active_tool: string | null;
  org_status: 'saved' | 'warn' | 'none' | null;
  org_note: string | null;
  theorg_slug: string | null;
  icp_fit: 'strong' | 'medium' | 'weak' | null;
  icp_reasons: string | null; // JSON {reasons:[],gaps:[]}
  company_li_id: string | null;
  open_positions: string | null; // JSON [{title,location,url,posted_at}]
  positions_checked_at: number | null;
  // Company facts from companyContextForLead (migration 0057). null = never
  // checked, NOT zero — the ICP scorer is told to read it that way too.
  company_staff_count: number | null;
  company_context: string | null;    // JSON {name,universal_name,url,staff_count,at}
  company_checked_at: number | null;
  outreach_lang: string | null;
  client_id: string | null;
  created_at: number;
  updated_at: number;
  state?: GtmLeadStage;
  confidence?: GtmConfidence;
  truecaller_url?: string | null;
  // What each enrichment step actually did, in chain order. null on leads
  // enriched before migration 0056 (the page falls back to inferring from
  // provenance for those).
  steps?: GtmStep[] | null;
};
// One step's verdict, recorded by enrichFullOne. `skipped` is a first-class
// outcome, not a failure: PDL skips itself when name+company are already known,
// LinkedIn without a linkedin on file, SerpApi without a sourced name.
export type GtmStepStatus = 'found' | 'empty' | 'skipped' | 'error';
export type GtmStep = { key: string; label: string; status: GtmStepStatus; reason: string | null; at: number };
// Identity-consistency signal, derived on read (re-evaluated on every enrich /
// manual edit). Distinct from `state`, which measures completeness.
export type GtmConfidenceFlag = { severity: 'high' | 'medium' | 'low'; label: string; detail: string };
export type GtmConfidence = { score: number; level: 'green' | 'yellow' | 'red'; flags: GtmConfidenceFlag[]; positives: string[] };
export type GtmBatch = { id: string; source: string | null; via: string; total: number; created: number; duplicates: number; invalid: number; created_at: number; new_count?: number };

export type GtmApiProvider = {
  provider: 'pdl' | 'serpapi' | 'twilio';
  configured: boolean;
  kind?: 'balance';
  used: number;
  limit?: number;
  remaining?: number;
  pct?: number;
  renews_in_days?: number;
  warn_at_pct?: number;
  balance?: number | null;
  currency?: string;
  balance_warn_usd?: number;
  warning: boolean;
  source: 'provider' | 'provider-cached' | 'counted';
};
export type GtmApiUsage = { now: number; providers: GtmApiProvider[]; limits_source: string };
export type GtmImportResult = { total: number; valid: number; invalid: number; duplicates: number; created: number; batch_id: string | null; via: string };
export type GtmOrgPerson = { id: string; lead_id: string; company: string | null; node_id: string | null; parent_node_id: string | null; name: string | null; role: string | null; photo_url: string | null; report_count: number | null };
export type GtmPosition = { title: string; location: string | null; url: string; posted_at: string | null };
export type GtmAngle = { rank: number; target: string; type: string; rationale: string; messages: string[]; confidence: 'low' | 'medium' | 'high'; missing?: string };
export type GtmAngles = { playbook_fit: { language?: string; channel?: string; why?: string } | null; connection_points: { type: string; detail: string; strength: string }[]; angles: GtmAngle[]; blocked?: string; angles_at?: number };
export type GtmContactStatus = 'not_contacted' | 'contacted' | 'replied';
export type GtmGreenLead = GtmLead & {
  has_contact: boolean; contacts: { name: string; role: string }[]; angles: GtmAngles | null;
  contact_status?: GtmContactStatus;
  first_contacted_at?: number | null;
  last_contacted_at?: number | null;
  sends?: number;
  replied_at?: number | null;
};
export type GtmSend = { id: string; lead_id: string; chat_id: string | null; bubble: string; status: 'sent' | 'failed'; error: string | null; created_at: number };
export type GtmYou = { name?: string; role?: string; business?: string; phone?: string; email?: string; linkedin?: string; location?: string; about?: string; groups?: string[]; connections?: string[] };

export type GtmWaPerson = {
  wa_id: string; name: string | null; phone: string | null;
  kind: 'chat' | 'group-sender' | 'participant';
  last_seen?: number | null; messages?: number | null; is_admin?: boolean;
  already_lead: boolean; is_contact: boolean;
};
export type GtmWaGroup = { id: string; name: string | null; last_message_at: number | null };

// Watch — hiring/job-change signals on watched leads. The hourly tick checks
// bounded batches; signals ping the OPERATOR (Digest + WhatsApp), never a lead.
export type GtmWatchLead = {
  id: string; name: string | null; phone: string; normalized_phone: string | null;
  company: string | null; position: string | null; linkedin: string | null;
  headline_snapshot: string | null; watch_started_at: number | null;
  watch_checked_at: number | null; icp_fit: string | null;
};
export type GtmSignal = {
  id: string; lead_id: string; kind: 'open_role' | 'job_change'; title: string;
  detail: { role?: string; url?: string | null; location?: string | null; old?: string; new?: string; company?: string } | null;
  draft: string | null; status: 'new' | 'pinged' | 'responded' | 'dismissed';
  detected_at: number; pinged_at: number | null; resolved_at: number | null;
  lead_name: string | null; lead_company: string | null; lead_phone: string | null;
  wa_link: string | null;
};
export type GtmWatchState = {
  config: {
    leads_per_tick: number; check_interval_hours: number; role_patterns: string[];
    ping_digest: boolean; source: string;
  };
  leads: GtmWatchLead[];
  signals: GtmSignal[];
};

// ─── Registry (live: gateways / tools / workflows + knowledge deps) ──
export type RegistryGateway = { name: string; service: string; kind: 'tunnel' | 'saas' | 'public-api' | 'binding'; ops: string; config: string[]; knowledge: string[]; configured: boolean; missing: string[] };
export type RegistryToolGroup = { group: string; count: number; knowledge: string[]; tools: { name: string; description: string }[] };
export type RegistryWorkflow = { name: string; kind: 'automated' | 'continuous' | 'event' | 'on-demand'; trigger: string; steps: string; touches: string; knowledge: string[]; last_run_at: number | null };
export type RegistryModule = { key: string; title: string; area: 'module' | 'system'; description: string };
export type Registry = {
  gateways: RegistryGateway[];
  tools: RegistryToolGroup[];
  workflows: RegistryWorkflow[];
  modules: RegistryModule[];
  counts: { gateways: number; gateways_configured: number; tools: number; tool_groups: number; workflows: number; modules: number };
  generated_at: number;
};

// ─── Daily Planner (per-day plan + weekly objectives) ──────────
export type PlanBlock = { id: string; start: string | null; end: string | null; title: string; deliverable: string | null; done: boolean; focus?: boolean };
export type PlanTodo  = { id: string; text: string; done: boolean; priority: number; star?: boolean };
export type DailyPlan = {
  date: string;
  mode: 'strategic' | 'wing_it';
  summary: string;
  weekly_ref: string | null;
  schedule: PlanBlock[];
  todos: PlanTodo[];
  created_at: number;
  updated_at: number;
};
export type WeeklyObjective  = { id: string; text: string; done: boolean };
export type WeeklyObjectives = { week_start: string; objectives: WeeklyObjective[]; created_at: number; updated_at: number };

// ─── Hot Takes — editorial command center (topic → take → brief → article → distribute) ─
export type HotTakePackage = {
  id: string;
  status: string;
  title: string | null;
  summary: string | null;
  why_it_matters: string | null;
  source_name: string | null;
  source_url: string | null;
  published_at: number | null;
  origin: string | null;
  origin_ref: string | null;
  multi_source: { title?: string; url?: string }[];
  pinned: boolean;
  take: string | null;
  believe: string | null;
  misunderstood: string | null;
  who_cares: string | null;
  reader_action: string | null;
  brief: Record<string, unknown> | null;
  blog_slug: string | null;
  headline: string | null;
  intro: string | null;
  review: Record<string, unknown> | null;
  company_notes: string | null;
  author_notes: string | null;
  website_status: string;
  website_url: string | null;
  scheduled_at: number | null;
  actor: string | null;
  created_at: number;
  updated_at: number;
};
// Who appears as the poster in a channel's post preview — from the editable
// `hottakes-social-identities` note.
export type SocialIdentity = { name: string; headline: string; avatar_url: string | null };
export type HotTakePost = {
  id: string;
  package_id: string;
  channel: string;
  body: string | null;
  notes: string | null;
  image_url: string | null;
  status: string;
  scheduled_at: number | null;
  posted_at: number | null;
  outbox_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
export type HotTakeTopicCard = {
  origin: string;
  origin_ref: string;
  title: string;
  summary: string;
  why_it_matters: string;
  source_name: string;
  source_url: string | null;
  published_at: number | null;
  heat: number | null;
  multi_source: number;
  kind: string;
  already_selected: boolean;
};
// One page of Topics of the Day. `has_more` is authoritative for paging —
// the server drops already-selected cards, so page length alone says nothing.
export type TopicsOfTheDayPage = {
  topics: HotTakeTopicCard[];
  generated_at: number;
  offset: number;
  limit: number;
  has_more: boolean;
};
export type HotTakeClaim = { text: string; support: string; source?: string; status: 'needs_confirmation' | 'confirmed' };
export type HotTakeFlag = { kind: string; section?: string; note?: string; severity?: string; resolved?: boolean };
export type HotTakeArticle = {
  slug: string; title: string; excerpt: string | null; body: string | null;
  tags: string[]; featured_image_url: string | null; published: boolean; published_at: number | null;
};
export type HotTakeView = {
  package: HotTakePackage; posts: HotTakePost[]; article: HotTakeArticle | null; next_action: string;
};
export type HotTakePipeline = {
  in_flight: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  needs_review: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  ready: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  scheduled: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
  published: (HotTakePackage & { posts: HotTakePost[]; next_action: string })[];
};
export type HotTakeMarker = { state: string; at: number | null; url?: string | null; error?: string };
export type HotTakeRelease = {
  id: string; title: string | null; blog_slug: string | null; status: string;
  scheduled_at: number | null; website_url: string | null;
  markers: Record<string, HotTakeMarker>; overall: string; posts: HotTakePost[]; next_action: string;
};
export type HotTakeScheduleView = {
  releases: HotTakeRelease[];
  attention: { kind: string; id: string; title: string | null; note: string }[];
  live: boolean; channels: string[]; window_days: number; now: number;
};
export type HotTakeSource = HeartbeatSource & { last_signal_at: number | null; signals_14d: number; useful_14d: number };
export type HotTakeSearchResults = {
  query: string;
  packages: { id: string; title: string | null; headline: string | null; status: string; summary: string | null }[];
  posts: { id: string; package_id: string; channel: string; status: string; snippet: string }[];
  notes: { slug: string; title: string }[];
};

export type TrackedOrigin = 'all' | 'prospecting' | 'li-outreach';
export type TrackedSignal = {
  id: string; signal_id: string | null; prospect_id: string | null;
  signal_kind: string | null;
  name: string | null; role: string | null; company: string | null;
  profile_url: string | null; post_url: string | null; post_text: string | null;
  reactions: number | null; comments: number | null;
  title: string; origin: string | null;
  // null = the priority sweep has not reached this card yet. Not a zero.
  score: number | null; score_reason: string | null;
  contacted: { why?: string; at?: number } | null;
  urgency: number; starred: boolean; read_at: number | null; created_at: number;
};
export type TrackedPerson = {
  id: string; public_id: string | null; name: string | null;
  role: string | null; company: string | null; status: string;
  source_search: string | null; signal_checked_at: number | null;
  signals: number; last_activity: number | null;
};

// Plugins — capabilities traded between nyyon systems (docs/plugin-format.md).
export type PluginRow = {
  name: string; version: string; title: string; status: string;
  // Derived server-side, never stored: a v1 row carrying code cannot run under
  // the capability contract, so it is deliberately absent from the tool pool
  // whatever its status column says.
  format?: number | null;
  needs_reauthoring?: boolean;
  // `modes` is the mode list the operator approved for that slug — the runtime
  // refuses any other mode, not just any other slug.
  binding: Record<string, { via: string; target: string; modes?: string[] }>;
  report: { step?: string; errors?: string[]; error?: string | null; warnings?: string[]; retired_workflows?: string[] };
  installed_at: number; updated_at: number;
};
export type PluginImportResult = {
  ok: boolean; status?: string; errors?: string[]; error?: string;
  // import-url only: where the manifest actually came from, recorded with it.
  source?: { source_url?: string; ref?: string };
};
export type PluginMaterializeResult = {
  ok: boolean; error?: string; note?: string;
  committed?: string[]; cleaned?: string[]; failed?: { name: string; error: string }[];
};
// The registry entry: everything one plugin put into this system, with paths.
export type PluginReg = {
  name: string; title: string; version: string; status: string;
  // The manifest format the row was installed under (2 = capability contract).
  format?: number | null;
  needs_reauthoring?: boolean;
  origin: { system?: string } | null; path: string;
  tools: { name: string; path: string; description: string }[];
  // `in_use` is false for a bundled gateway the host superseded — it is
  // declared by the manifest but never materialized or registered.
  gateways: { slug: string; installed_as: string; in_use?: boolean; path: string; service: string }[];
  gateway_bindings: { slug: string; via: string; target: string; modes?: string[] }[];
  requires_gateways: { slug: string; modes: string[] }[];
  workflows: { slug: string; name: string; steps: string[] }[];
  knowledge: { slug: string; title: string }[];
  tables: string[];
  surfaces: { slug: string; title?: string; tabs?: number }[];
};

// One installed plugin's surface, as the sidebar + renderer consume it.
export type { PluginSurfaceDef } from '../components/PluginSurface';
import type { PluginSurfaceDef } from '../components/PluginSurface';

export const api = {
  health: () => j<{ ok: boolean }>('/health'),

  // Plugins — import/export signed manifests; materialize = commit code to
  // the repo through the GitHub gateway (CI redeploys, then verify flips active).
  listPlugins: () => j<{ plugins: PluginRow[] }>('/api/plugins').then((r) => r.plugins),
  pluginRegistry: () => j<{ plugins: PluginReg[] }>('/api/plugins/registry').then((r) => r.plugins),
  importPlugin: (manifest: object) =>
    j<PluginImportResult>('/api/plugins/import', { method: 'POST', body: JSON.stringify({ manifest }) }),
  exportPlugin: (name: string) => j<object>(`/api/plugins/${encodeURIComponent(name)}/export`),
  removePlugin: (name: string) => j<{ ok: boolean; note?: string }>(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  materializePlugins: () => j<PluginMaterializeResult>('/api/plugins/materialize', { method: 'POST' }),
  verifyPlugin: (name: string) =>
    j<{ ok: boolean; error?: string }>('/api/plugins/verify', { method: 'POST', body: JSON.stringify({ name }) }),
  // The primary install path: a SOURCE URL (GitHub repo, .zip, or manifest.json).
  importPluginUrl: (url: string, ref?: string) =>
    j<PluginImportResult>('/api/plugins/import-url', { method: 'POST', body: JSON.stringify({ url, ref }) }),
  // A package is the authoring form: manifest.json plus real .mjs/.md files.
  importPluginPackage: (file: File) =>
    j<PluginImportResult>('/api/plugins/import-package', {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
    }),
  // Installed plugins' pages. A surface is data, so it appears the moment the
  // plugin is active — no rebuild, no restart.
  pluginSurfaces: () => j<{ surfaces: PluginSurfaceDef[] }>('/api/plugins/surfaces'),

  // Pipeline board — clients with a stage. Writable by Nyo (update_deal tool)
  // or any agent via POST /api/pipeline/:id.
  listPipeline: () => j<{ deals: Deal[] }>('/api/pipeline').then((r) => r.deals),
  updateDeal: (id: string, patch: Partial<Pick<Deal, 'stage' | 'deal_value' | 'mrr_value'>>) =>
    j<{ deal: Deal }>(`/api/pipeline/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.deal),

  // Daily Tasks module. Writable by Nyo (list_tasks/update_task/add_task) or any agent.
  listTasks: (day: string) => j<{ tasks: Task[] }>(`/api/tasks?day=${encodeURIComponent(day)}`).then((r) => r.tasks),
  updateTask: (id: string, patch: Partial<Pick<Task, 'status' | 'title' | 'detail' | 'ord'>>) =>
    j<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.task),
  addTask: (body: { day: string; title: string; detail?: string }) =>
    j<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.task),

  // Daily Planner — per-day plan + weekly objectives (operator + planner chat).
  dailyPlan: (date?: string) =>
    j<{ date: string; plan: DailyPlan | null }>(`/api/daily-plan${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  saveDailyPlan: (plan: Partial<DailyPlan>) =>
    j<{ plan: DailyPlan }>('/api/daily-plan', { method: 'PUT', body: JSON.stringify({ plan }) }).then((r) => r.plan),
  searchDailyPlans: (q: string, limit = 30) =>
    j<{ query: string; results: DailyPlan[] }>(`/api/daily-plan/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.results),
  recentDailyPlans: (days = 3) =>
    j<{ days: number; results: DailyPlan[] }>(`/api/daily-plan/recent?days=${days}`).then((r) => r.results),
  // `week` = a literal week_start; `date` = any day, anchored to its workweek
  // server-side (the convention lives there, never re-derived in the client).
  weeklyObjectives: ({ week, date }: { week?: string; date?: string } = {}) => {
    const p = new URLSearchParams();
    if (week) p.set('week', week);
    if (date) p.set('date', date);
    const qs = p.toString();
    return j<{ week_start: string; objectives: WeeklyObjectives | null }>(`/api/weekly-objectives${qs ? `?${qs}` : ''}`);
  },
  saveWeeklyObjectives: (objectives: WeeklyObjective[], week_start?: string) =>
    j<{ objectives: WeeklyObjectives }>('/api/weekly-objectives', { method: 'PUT', body: JSON.stringify({ objectives, week_start }) }).then((r) => r.objectives),

  // Hot Takes — editorial command center (topic → take → brief → article → distribute).
  hotTakePackages: (status?: string) =>
    j<{ packages: HotTakePackage[] }>(`/api/hot-takes/packages${status ? `?status=${encodeURIComponent(status)}` : ''}`).then((r) => r.packages),
  hotTakePackage: (id: string) =>
    j<{ package: HotTakePackage; posts: HotTakePost[]; next_action: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}`),
  // Returns the full envelope (not just the cards) because `has_more` is what
  // drives the Load more button — a short page is not proof of exhaustion.
  // `history` widens the lookback to everything retained; Load more grows
  // `limit` with it set rather than paging by offset (see topicsOfTheDay).
  hotTakeTopicsOfTheDay: (
    { limit = 12, q = '', history = false }: { limit?: number; q?: string; history?: boolean } = {},
  ) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (q.trim()) p.set('q', q.trim());
    if (history) p.set('history', '1');
    return j<TopicsOfTheDayPage>(`/api/hot-takes/topics-of-the-day?${p}`);
  },
  hotTakeAddTopic: (body: { title: string; summary?: string; why_it_matters?: string; note?: string }) =>
    j<{ package: HotTakePackage }>('/api/hot-takes/packages', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.package),
  hotTakeAddLink: (url: string) =>
    j<{ package?: HotTakePackage; error?: string }>('/api/hot-takes/add-link', { method: 'POST', body: JSON.stringify({ url }) }),
  hotTakePinTopic: (card: Partial<HotTakeTopicCard>) =>
    j<{ package: HotTakePackage }>('/api/hot-takes/topics/pin', { method: 'POST', body: JSON.stringify(card) }).then((r) => r.package),
  hotTakeDismissTopic: (card: Partial<HotTakeTopicCard>) =>
    j<{ package: HotTakePackage }>('/api/hot-takes/topics/dismiss', { method: 'POST', body: JSON.stringify(card) }).then((r) => r.package),
  hotTakePatchPackage: (id: string, patch: Partial<HotTakePackage>) =>
    j<{ package: HotTakePackage }>(`/api/hot-takes/packages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.package),
  hotTakeDismiss: (id: string) =>
    j<{ package: HotTakePackage }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }).then((r) => r.package),
  // Closing the drafting wizard mid-take or mid-angle returns the topic to the
  // pool: status back to 'topic', editorial fields cleared server-side. The
  // route 400s once the package is past the brief (an article exists).
  hotTakeAbandon: (id: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/abandon`, { method: 'POST' }),
  hotTakeDraftTake: (id: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/draft-take`, { method: 'POST' }),
  // The wizard's ONE prep pass: drafts the whole angle document (take + brief)
  // in a single call; the package lands at status 'brief'.
  hotTakeDraftAngle: (id: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/draft-angle`, { method: 'POST' }),
  hotTakeBuildBrief: (id: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/build-brief`, { method: 'POST' }),
  // Directed refinement: redraft ONE stage (take or brief) following the
  // operator's own instruction instead of a blind regenerate.
  hotTakeRefine: (id: string, stage: 'take' | 'brief', direction: string) =>
    j<{ package?: HotTakePackage; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/refine`, { method: 'POST', body: JSON.stringify({ stage, direction }) }),
  hotTakeWriteArticle: (id: string, voice?: 'lev' | 'house') =>
    j<{ ok?: boolean; slug?: string; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/write-article`, { method: 'POST', body: JSON.stringify({ voice }) }),
  hotTakeReviewScan: (id: string) =>
    j<{ package?: HotTakePackage; open_claims?: number; flags?: number; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/review-scan`, { method: 'POST' }),
  // Pass channel to redraft ONE leg (the unit's Redraft button); omit for both.
  hotTakeDraftSocial: (id: string, channel?: 'linkedin-company' | 'linkedin-personal') =>
    j<{ posts?: HotTakePost[]; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/draft-social`, {
      method: 'POST', body: JSON.stringify(channel ? { channel } : {}),
    }),
  hotTakeSchedule: (id: string, times: { website_at?: number; company_at?: number; personal_at?: number } = {}) =>
    j<HotTakeView & { error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify(times) }),
  hotTakeCancelSchedule: (id: string) =>
    j<HotTakeView & { error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/cancel-schedule`, { method: 'POST' }),
  // Plain blog drafts (no package yet) — the worker adopts them into the
  // release pipeline, so scheduling and social legs work on any article.
  hotTakeScheduleBlog: (slug: string, times: { website_at?: number; company_at?: number; personal_at?: number } = {}) =>
    j<HotTakeView & { error?: string }>(`/api/hot-takes/blog/${encodeURIComponent(slug)}/schedule`, { method: 'POST', body: JSON.stringify(times) }),
  hotTakeDraftSocialBlog: (slug: string) =>
    j<{ posts?: HotTakePost[]; package_id?: string; error?: string }>(`/api/hot-takes/blog/${encodeURIComponent(slug)}/draft-social`, { method: 'POST' }),
  hotTakePublishWebsite: (id: string) =>
    j<{ ok?: boolean; url?: string; error?: string }>(`/api/hot-takes/packages/${encodeURIComponent(id)}/publish-website`, { method: 'POST' }),
  hotTakeSendPost: (postId: string) =>
    j<{ ok?: boolean; dry_run?: boolean; would?: Record<string, unknown>; error?: string }>(`/api/hot-takes/posts/${encodeURIComponent(postId)}/send`, { method: 'POST' }),
  hotTakePatchPost: (postId: string, patch: Partial<HotTakePost>) =>
    j<{ post: HotTakePost }>(`/api/hot-takes/posts/${encodeURIComponent(postId)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.post),
  hotTakeView: (id: string) => j<HotTakeView>(`/api/hot-takes/article/${encodeURIComponent(id)}`),
  hotTakeSaveArticle: (id: string, patch: { title?: string; excerpt?: string; body?: string }) =>
    j<HotTakeView>(`/api/hot-takes/article/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  hotTakePipeline: () => j<HotTakePipeline>('/api/hot-takes/pipeline'),
  hotTakeScheduleView: (days = 30) => j<HotTakeScheduleView>(`/api/hot-takes/schedule?days=${days}`),
  hotTakeSources: () => j<{ channels: HotTakeSource[]; topics: HotTakeSource[] }>('/api/hot-takes/sources'),
  hotTakeSearch: (q: string) => j<HotTakeSearchResults>(`/api/hot-takes/search?q=${encodeURIComponent(q)}`),
  hotTakeNotes: () => j<Record<string, KnowledgeDoc>>('/api/hot-takes/notes'),
  hotTakeState: () => j<{ live: boolean }>('/api/hot-takes/state'),
  // Poster identities for the social-post previews (editable knowledge note).
  hotTakeSocialIdentities: () =>
    j<{ identities: Record<string, SocialIdentity> }>('/api/hot-takes/social-identities').then((r) => r.identities),
  hotTakeSetLive: (live: boolean) =>
    j<{ ok: boolean }>('/api/feature-flags/hottakes.live', { method: 'PUT', body: JSON.stringify({ value: live }) }),
  hotTakeSaveNote: (slug: string, title: string, body: string) =>
    j<{ doc: KnowledgeDoc }>(`/api/knowledge/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify({ title, body }) }).then((r) => r.doc),
  systemHealth: () => j<SystemHealth>('/api/system/health'),
  brain:  () => j<BrainInfo>('/api/nyo/brain'),
  saveNyoModels: (patch: Partial<NyoModelMap>) =>
    j<{ models: NyoModelMap }>('/api/nyo/models', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.models),

  // Nyo pending-message queue — background workers (AEO cron, image gen, etc)
  // queue assistant turns; Chat polls + injects them.
  listNyoPending: () =>
    j<{ messages: Array<{ id: string; content: string; kind: string | null; ref_kind: string | null; ref_id: string | null; payload: unknown; created_at: number }> }>(
      '/api/nyo/pending',
    ).then((r) => r.messages),
  deliverNyoMessage: (id: string) =>
    j<{ ok: boolean }>(`/api/nyo/pending/${encodeURIComponent(id)}/deliver`, { method: 'POST' }),

  // Conversation history — browse past Nyo threads and reopen one. The server
  // has always persisted every turn; these read it back so a finished thread
  // can be resumed instead of lost when the drawer closes.
  listConversations: (limit = 40) =>
    j<{ conversations: ConversationSummary[]; total: number }>(`/api/chat/conversations?limit=${limit}`),
  readConversation: (id: string) =>
    j<ConversationDetail>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  renameConversation: (id: string, title: string) =>
    j<{ id: string; title: string }>(`/api/chat/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) =>
    j<{ ok: boolean; id: string }>(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Proactive wake-up — surveys state, autofires missed AEO publish, queues a
  // morning briefing as a Nyo message. Idempotent server-side (skips when
  // nothing changed since last wake-up).
  systemWakeUp: (autofire = true) =>
    j<{ queued: boolean; message_id?: string; fired?: unknown; summary?: string; reason?: string }>(
      '/api/system/wake-up',
      { method: 'POST', body: JSON.stringify({ autofire }) },
    ),
  deployPublicSite: () =>
    j<{ ok: boolean; queued?: boolean; reason?: string; error?: string }>(
      '/api/system/deploy',
      { method: 'POST' },
    ),
  deployStatus: () =>
    j<{ ok: boolean; deploying: boolean; lastDeploy?: unknown; error?: string }>(
      '/api/system/deploy/status',
    ),

  events: (limit = 100) =>
    j<{ events: Event[] }>(`/api/events?limit=${limit}`).then((r) => r.events),

  listKnowledge: () => j<{ docs: KnowledgeDoc[] }>('/api/knowledge').then((r) => r.docs),
  readKnowledge: (slug: string) => j<{ doc: KnowledgeDoc }>(`/api/knowledge/${slug}`).then((r) => r.doc),
  readKnowledgePath: (slug: string) =>
    j<{ path: KnowledgePathStep[] }>(`/api/knowledge/${slug}/path`).then((r) => r.path),
  writeKnowledge: (slug: string, patch: Partial<KnowledgeDoc> & { title: string; body: string }) =>
    j<{ doc: KnowledgeDoc }>(`/api/knowledge/${slug}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.doc),
  deleteKnowledge: (slug: string) =>
    j<{ ok: boolean }>(`/api/knowledge/${slug}`, { method: 'DELETE' }),

  listContent: (page?: string) => {
    const q = page ? `?page=${encodeURIComponent(page)}` : '';
    return j<{ blocks: ContentBlock[] }>(`/api/content${q}`).then((r) => r.blocks);
  },
  readContent: (slug: string) => j<{ block: ContentBlock }>(`/api/content/${encodeURIComponent(slug)}`).then((r) => r.block),
  writeContent: (slug: string, patch: Partial<ContentBlock> & { title: string; body: string }) =>
    j<{ block: ContentBlock }>(`/api/content/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.block),
  deleteContent: (slug: string) =>
    j<{ ok: boolean }>(`/api/content/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // contacts — operator-curated list
  listContacts: (f: ContactFilters = {}) => {
    const qs = new URLSearchParams();
    if (f.status)        qs.set('status', f.status);
    if (f.source)        qs.set('source', f.source);
    if (f.owner)         qs.set('owner',  f.owner);
    if (f.tag)           qs.set('tag',    f.tag);
    if (f.search)        qs.set('search', f.search);
    if (f.starred)       qs.set('starred', '1');
    return j<{ contacts: Contact[] }>(`/api/contacts?${qs.toString()}`).then((r) => r.contacts);
  },
  contactTaxonomy: () => j<ContactTaxonomy>('/api/contacts/taxonomy'),
  readContact:    (id: string) => j<{ contact: Contact }>(`/api/contacts/${encodeURIComponent(id)}`).then((r) => r.contact),
  writeContact:   (id: string, patch: Partial<Contact>) =>
    j<{ contact: Contact }>(`/api/contacts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.contact),
  createContact:  (patch: Partial<Contact>) =>
    j<{ contact: Contact }>('/api/contacts', { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.contact),
  deleteContact:  (id: string) =>
    j<{ ok: boolean }>(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // clients — companies / accounts (the CRM layer above contacts)
  listClients: (f: ClientFilters = {}) => {
    const qs = new URLSearchParams();
    if (f.status)  qs.set('status', f.status);
    if (f.tag)     qs.set('tag',    f.tag);
    if (f.search)  qs.set('search', f.search);
    if (f.starred) qs.set('starred', '1');
    return j<{ clients: Client[] }>(`/api/clients?${qs.toString()}`).then((r) => r.clients);
  },
  clientTaxonomy: () => j<ClientTaxonomy>('/api/clients/taxonomy'),
  readClient:   (id: string) => j<{ client: Client }>(`/api/clients/${encodeURIComponent(id)}`).then((r) => r.client),
  writeClient:  (id: string, patch: Partial<Client>) =>
    j<{ client: Client }>(`/api/clients/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.client),
  createClient: (patch: Partial<Client>) =>
    j<{ client: Client }>('/api/clients', { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.client),
  deleteClient: (id: string) =>
    j<{ ok: boolean }>(`/api/clients/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Digest — morning brief (actionable summary across sources)
  listDigest: (opts: { unread?: boolean; starred?: boolean; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.unread)  qs.set('unread', '1');
    if (opts.starred) qs.set('starred', '1');
    if (opts.limit)   qs.set('limit', String(opts.limit));
    return j<{ items: DigestItem[] }>(`/api/digest?${qs.toString()}`).then((r) => r.items);
  },
  digestStats: () => j<DigestStats>('/api/digest/stats'),
  digestKpi: () => j<OutreachKpi>('/api/digest/kpi'),
  digestKpiAttempts: () => j<OutreachLog>('/api/digest/kpi/attempts'),
  generateDigest: (since_ms?: number) =>
    j<{
      generated: number;
      // Count of stale items archived by the prune-pass that runs before
      // the new generation. "Stale" = older than 7 days AND not starred
      // AND not urgency=1.
      pruned?: number;
      since_ms: number;
      per_source?: Record<string, { count: number; error: string | null; skipped?: string }>;
    }>('/api/digest/generate', {
      method: 'POST',
      body: JSON.stringify({ since_ms: since_ms || null }),
    }),
  patchDigestItem: (id: string, patch: { read?: boolean; starred?: boolean; draft?: string }) =>
    j<{ item: DigestItem }>(`/api/digest/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.item),
  clearReadDigest: () => j<{ cleared: number }>('/api/digest/clear-read', { method: 'POST' }),
  digestSnooze: (id: string) =>
    j<{ ok?: boolean; days?: number; until?: number; archived?: number; error?: string }>(
      `/api/digest/${encodeURIComponent(id)}/snooze`, { method: 'POST', body: '{}' },
    ),
  digestActed: (id: string) =>
    j<{ ok?: boolean; days?: number; until?: number; archived?: number; error?: string }>(
      `/api/digest/${encodeURIComponent(id)}/acted`, { method: 'POST', body: '{}' },
    ),
  digestPriorityFeedback: (id: string, comment: string) =>
    j<{ ok?: boolean; rules?: number; rescored?: { ok?: boolean; score?: number; urgency?: number; reason?: string }; error?: string }>(
      `/api/digest/${encodeURIComponent(id)}/priority-feedback`, { method: 'POST', body: JSON.stringify({ comment }) },
    ),
  digestContext: (id: string) => j<DigestContext>(`/api/digest/${encodeURIComponent(id)}/context`),
  digestActions: (id: string) => j<DigestActionsResponse>(`/api/digest/${encodeURIComponent(id)}/actions`),
  executeDigestAction: (id: string, body: { type: DigestActionType; text?: string; recipient?: DigestAction['recipient']; metadata?: DigestAction['metadata']; note?: string; full_name?: string; phone?: string; send_at?: number }) =>
    j<{
      ok: boolean; sent?: unknown; contact?: Contact; error?: string;
      // draft_blog / draft_social results
      slug?: string; title?: string; drafted?: number; skipped?: boolean; reason?: string;
    }>(`/api/digest/${encodeURIComponent(id)}/execute`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listDigestChannels: () => j<{ channels: DigestChannel[] }>('/api/digest/channels').then((r) => r.channels),
  patchDigestChannel: (source: DigestChannelSource, patch: Partial<Pick<DigestChannel,'enabled'|'cadence'|'notes'>>) =>
    j<{ channel: DigestChannel }>(`/api/digest/channels/${encodeURIComponent(source)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.channel),

  // WhatsApp chats + per-chat listening policy. The Digest UI uses these to
  // surface "which chats are we actually following" right inside the
  // Channels tab, and Nyo's tools (list_wa_chats / set_wa_chat_listening)
  // call the same routes so chat policy can be flipped from the chat
  // surface OR the conversation.
  patchWaChat:  (id: string, patch: { auto_listen?: 0 | 1 | boolean; can_send?: 0 | 1 | boolean; name?: string }) =>
    j<{ chat: WaChat }>(`/api/wa/chats/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }).then((r) => r.chat),

  // Outbox — unified send log across channels (wa, li, ...). Every outbound
  // attempt (success or failure) lands here so the operator can inspect what
  // happened and one-click retry the failures.
  listOutbox: (opts: { channel?: OutboxChannel; status?: OutboxStatus; source?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.channel) qs.set('channel', opts.channel);
    if (opts.status)  qs.set('status',  opts.status);
    if (opts.source)  qs.set('source',  opts.source);
    if (opts.limit)   qs.set('limit',   String(opts.limit));
    return j<{ rows: OutboxRow[] }>(`/api/outbox?${qs.toString()}`).then((r) => r.rows);
  },
  outboxStats: () => j<{ stats: Record<OutboxChannel, { sent: number; failed: number; queued: number }> }>('/api/outbox/stats').then((r) => r.stats),
  retryOutboxRow: (id: string) =>
    j<{ ok: boolean; result: unknown }>(`/api/outbox/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  // Social — auto-drafted LinkedIn/Facebook posts from published articles.
  listSocialPosts: (opts: { status?: SocialStatus; slug?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.slug)   qs.set('slug',   opts.slug);
    return j<{ posts: SocialPost[] }>(`/api/social/posts?${qs.toString()}`).then((r) => r.posts);
  },
  socialSettings: () => j<{ connections: SocialConnection[] }>('/api/social/settings').then((r) => r.connections),
  editSocialPost: (id: string, content: string) =>
    j<{ post: SocialPost }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content }) }).then((r) => r.post),
  approveSocialPost: (id: string) =>
    j<{ ok: boolean; error?: string; channel?: string; outbox_id?: string }>(`/api/social/posts/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  skipSocialPost: (id: string) =>
    j<{ post: SocialPost }>(`/api/social/posts/${encodeURIComponent(id)}/skip`, { method: 'POST' }).then((r) => r.post),
  deleteSocialPost: (id: string) =>
    j<{ ok: boolean }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteSocialGroup: (slug: string) =>
    j<{ ok: boolean; deleted: number | null }>(`/api/social/group/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  generateSocialPosts: (slug: string, force = false) =>
    j<{ ok: boolean; drafted?: number; skipped?: boolean; reason?: string; run_id?: string }>(`/api/social/generate/${encodeURIComponent(slug)}`, { method: 'POST', body: JSON.stringify({ force }) }),

  // OSINT — review/mention scrapers (port of inrepute)
  listOsintTargets: () => j<{ targets: OsintTarget[] }>('/api/osint/targets').then((r) => r.targets),
  readOsintTarget:  (id: string) => j<{ target: OsintTarget }>(`/api/osint/targets/${encodeURIComponent(id)}`).then((r) => r.target),
  createOsintTarget: (patch: Partial<OsintTarget>) =>
    j<{ target: OsintTarget }>('/api/osint/targets', { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.target),
  writeOsintTarget: (id: string, patch: Partial<OsintTarget>) =>
    j<{ target: OsintTarget }>(`/api/osint/targets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.target),
  deleteOsintTarget: (id: string) =>
    j<{ ok: boolean }>(`/api/osint/targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scrapeOsintTarget: (id: string, sources?: OsintSource[]) =>
    j<OsintScrapeResult>(`/api/osint/targets/${encodeURIComponent(id)}/scrape`, {
      method: 'POST',
      body: JSON.stringify({ sources: sources || null }),
    }),
  osintSources: () => j<{ sources: OsintSource[] }>('/api/osint/sources').then((r) => r.sources),
  // Heartbeat feed sources (OSINT module · Sources tab): RSS + Google News queries.
  heartbeatSources: () => j<{ sources: HeartbeatSource[] }>('/api/heartbeat/sources').then((r) => r.sources),
  writeHeartbeatSource: (body: Partial<HeartbeatSource> & { query?: string }) =>
    j<{ source: HeartbeatSource }>('/api/heartbeat/sources', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.source),
  patchHeartbeatSource: (id: string, patch: Partial<HeartbeatSource>) =>
    j<{ source: HeartbeatSource }>(`/api/heartbeat/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.source),
  deleteHeartbeatSource: (id: string) =>
    j<{ ok: boolean }>(`/api/heartbeat/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  heartbeatGates: () => j<{ gates: HeartbeatGates }>('/api/heartbeat/gates').then((r) => r.gates),
  saveHeartbeatGates: (patch: Partial<HeartbeatGates>) =>
    j<{ gates: HeartbeatGates }>('/api/heartbeat/gates', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.gates),
  listOsintListeners: () => j<{ listeners: OsintListener[] }>('/api/osint/listeners').then((r) => r.listeners),
  patchOsintListener: (source: OsintSource, patch: Partial<Pick<OsintListener,'enabled'|'cadence'|'notes'>>) =>
    j<{ listener: OsintListener }>(`/api/osint/listeners/${encodeURIComponent(source)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.listener),
  listOsintMentions: (filters: { target_id?: string; source?: OsintSource; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filters.target_id) qs.set('target_id', filters.target_id);
    if (filters.source)    qs.set('source', filters.source);
    if (filters.limit)     qs.set('limit', String(filters.limit));
    return j<{ mentions: OsintMention[] }>(`/api/osint/mentions?${qs.toString()}`).then((r) => r.mentions);
  },

  // Workflows — visibility into stitched pipelines + runs
  listWorkflows: (opts: { source?: WorkflowSource; status?: WorkflowStatus } = {}) => {
    const qs = new URLSearchParams();
    if (opts.source) qs.set('source', opts.source);
    if (opts.status) qs.set('status', opts.status);
    return j<{ workflows: Workflow[] }>(`/api/workflows?${qs.toString()}`).then((r) => r.workflows);
  },
  readWorkflow: (slug: string) =>
    j<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(slug)}`).then((r) => r.workflow),
  listWorkflowRuns: (slug?: string, limit = 50) => {
    const path = slug
      ? `/api/workflows/${encodeURIComponent(slug)}/runs?limit=${limit}`
      : `/api/workflows/runs?limit=${limit}`;
    return j<{ runs: WorkflowRun[] }>(path).then((r) => r.runs);
  },
  writeWorkflow: (slug: string, patch: Partial<Workflow> & { name: string; trigger: WorkflowTrigger; steps: WorkflowStep[] }) =>
    j<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(slug)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    }).then((r) => r.workflow),
  deleteWorkflow: (slug: string) =>
    j<{ ok: boolean }>(`/api/workflows/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // Calendar — central event store
  listCalendarEvents: (f: CalendarFilters = {}) => {
    const qs = new URLSearchParams();
    if (f.from !== undefined)   qs.set('from',   String(f.from));
    if (f.to   !== undefined)   qs.set('to',     String(f.to));
    if (f.kind)                 qs.set('kind',   f.kind);
    if (f.source)               qs.set('source', f.source);
    return j<{ events: CalendarEvent[] }>(`/api/calendar?${qs.toString()}`).then((r) => r.events);
  },
  calendarTaxonomy: () => j<CalendarTaxonomy>('/api/calendar/taxonomy'),
  readCalendarEvent: (id: string) =>
    j<{ event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`).then((r) => r.event),
  createCalendarEvent: (patch: Partial<CalendarEvent> & { title: string; starts_at: number }) =>
    j<{ event: CalendarEvent }>('/api/calendar/events', {
      method: 'POST', body: JSON.stringify(patch),
    }).then((r) => r.event),
  updateCalendarEvent: (id: string, patch: Partial<CalendarEvent>) =>
    j<{ event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    }).then((r) => r.event),
  deleteCalendarEvent: (id: string) =>
    j<{ ok: boolean }>(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // AEO — question backlog + manual draft trigger
  listAeoQuestions: (status?: AeoStatus) => {
    const qs = status ? `?status=${status}` : '';
    return j<{ questions: AeoQuestion[] }>(`/api/aeo/questions${qs}`).then((r) => r.questions);
  },
  aeoQueue: () => j<{ pending_count: number; next: AeoQuestion | null }>('/api/aeo/queue'),
  writeAeoQuestion: (slug: string, patch: Partial<AeoQuestion> & { question: string }) =>
    j<{ question: AeoQuestion }>(`/api/aeo/questions/${encodeURIComponent(slug)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    }).then((r) => r.question),
  addAeoQuestion: (body: { question: string; target_keyword?: string; notes?: string; priority?: number }) =>
    j<{ question: AeoQuestion; error?: string }>('/api/aeo/add', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.question),
  createAeoQuestion: (patch: Partial<AeoQuestion> & { slug: string; question: string }) =>
    j<{ question: AeoQuestion }>('/api/aeo/questions', {
      method: 'POST', body: JSON.stringify(patch),
    }).then((r) => r.question),
  aeoDraftNow: () => j<AeoDraftResult>('/api/aeo/draft-now', { method: 'POST' }),
  // OSINT-sourced article suggestions awaiting approval.
  aeoSuggestions: (status?: AeoSuggestion['status']) =>
    j<{ suggestions: AeoSuggestion[] }>(`/api/aeo/suggestions${status ? `?status=${status}` : ''}`).then((r) => r.suggestions),
  generateAeoSuggestions: (limit?: number) =>
    j<{ ok: boolean; created: number; reason?: string; error?: string }>('/api/aeo/suggestions/generate', { method: 'POST', body: JSON.stringify(limit ? { limit } : {}) }),
  approveAeoSuggestion: (id: string) =>
    j<{ ok: boolean; status: string; slug: string; writing?: boolean; last_error?: string | null }>(`/api/aeo/suggestions/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  rejectAeoSuggestion: (id: string) =>
    j<{ ok: boolean }>(`/api/aeo/suggestions/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  deleteAeoQuestion: (slug: string) =>
    j<{ ok: boolean; error?: string }>(`/api/aeo/questions/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // blog — analytics-joined list
  listBlogAnalytics: async (publishedOnly = true): Promise<BlogPostWithTags[]> => {
    const qs = publishedOnly ? '?published_only=1' : '';
    const r = await j<{ posts: BlogPost[] }>(`/api/blog/analytics${qs}`);
    return r.posts.map((p) => {
      let tags: string[] = [];
      if (p.tags) { try { const x = JSON.parse(p.tags); if (Array.isArray(x)) tags = x; } catch { /* ignore */ } }
      return { ...p, tags };
    });
  },
  // One post row (no analytics decoration) — the editor's post-draft fetch.
  // Tags come JSON-encoded from the DB; normalize to the array shape every
  // consumer of BlogPostWithTags expects.
  getBlogPost: (slug: string) =>
    j<{ post: BlogPost }>(`/api/blog/${encodeURIComponent(slug)}`).then((r): BlogPostWithTags => {
      let tags: string[] = [];
      try { const t = JSON.parse(r.post.tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* raw string */ }
      return { ...r.post, tags };
    }),
  generateBlogImage: (slug: string, opts: { prompt_override?: string; model?: string } = {}) =>
    j<{ image: BlogImageResult }>(`/api/blog/${encodeURIComponent(slug)}/generate-image`, {
      method: 'POST', body: JSON.stringify(opts),
    }).then((r) => r.image),
  // Redesign ONE in-article chart (the editor's per-chart Change button). The
  // src can be the dev-rewritten URL — the server matches by its blog-figures/
  // path segment. Instructions, when given, lead the drafter's prompt.
  regenerateBlogFigure: (slug: string, body: { src: string; instructions?: string | null }) =>
    j<{ ok: boolean; url: string; alt: string; template: string; figure_html: string; error?: string }>(
      `/api/blog/${encodeURIComponent(slug)}/regenerate-figure`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // Live-edit a post's body/title/excerpt. Sends the full row so the PUT
  // (which overwrites) preserves published/tags/published_at — editing a draft
  // keeps it a draft; publishing stays a separate step.
  updateBlogPost: (
    slug: string,
    patch: { title: string; excerpt: string | null; body: string | null; tags: string[]; published: number; published_at: number | null },
  ) =>
    j<{ post: BlogPost }>(`/api/blog/${encodeURIComponent(slug)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    }).then((r) => r.post),

  // Is the post actually served on the public site yet? Polled after publish to
  // flip the UI to "live" once the rebuild + CDN have caught up.
  blogLiveStatus: (slug: string) =>
    j<{ live: boolean; status: number; url: string }>(`/api/blog/${encodeURIComponent(slug)}/live-status`),

  // Mirror this slug from local D1 to prod and trigger the marketing-site
  // rebuild. Every attempt logs to the Outbox (channel='blog'). The
  // response's `deploy.ok` reflects whether the sidecar acknowledged.
  publishBlogPost: (slug: string, opts: { deploy?: boolean } = {}) =>
    j<{
      ok: boolean;          // === live: the edge worker actually serves the post
      slug: string;
      live: boolean;
      url: string;
      prod: BlogPost | null;
      mirrored?: boolean;
      mirror_error?: string | null;
      edge?: { live: boolean; status: number } | null;
      outbox_id: string;
    }>(`/api/blog/${encodeURIComponent(slug)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ deploy: opts.deploy !== false }),
    }),

  // Delete a blog post from local D1 (draft or published). Does NOT unpublish
  // from prod — for a live post, take it down at the source separately.
  deleteBlogPost: (slug: string) =>
    j<{ ok: boolean }>(`/api/blog/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  // finance — monthly cashflow calculator
  listFinance: (year: number) =>
    j<{ year: number; entries: FinanceEntry[] }>(`/api/finance?year=${year}`).then((r) => r.entries),
  addFinanceEntry: (body: Partial<FinanceEntry> & { year: number; month: number; kind: FinanceKind }) =>
    j<{ entry: FinanceEntry }>('/api/finance', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.entry),
  updateFinanceEntry: (id: string, patch: Partial<FinanceEntry>) =>
    j<{ entry: FinanceEntry }>(`/api/finance/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.entry),
  deleteFinanceEntry: (id: string) =>
    j<{ ok: boolean }>(`/api/finance/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // home_sections — layout control for the public site
  listSections: (page = 'home') => j<{ sections: HomeSection[] }>(`/api/sections?page=${page}`).then((r) => r.sections),
  patchSection: (id: string, patch: { visible?: boolean; position?: number; label?: string }) =>
    j<{ section: HomeSection }>(`/api/sections/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }).then((r) => r.section),
  reorderSections: (order: string[], page = 'home') =>
    j<{ sections: HomeSection[] }>('/api/sections/reorder', {
      method: 'POST', body: JSON.stringify({ page, order }),
    }).then((r) => r.sections),

  // funnel
  //
  // All funnel READ endpoints hit PROD directly. The marketing site's
  // tracker.js posts to the prod worker, so LOCAL D1 has no real
  // session/event/conversion data — pointing reads at local would only
  // ever show zero. Writes (logConversion below) stay on the relative
  // path so operator-fired conversions still land in whichever D1 the
  // dev worker is bound to. Toggling this back to local for offline
  // testing is a one-line change to `webApi` → drop the prefix.
  webSessions:    (limit = 100) => j<{ sessions:    WebSession[]    }>(webApi(`/api/web/sessions?limit=${limit}`)).then((r) => r.sessions),
  webEvents:      (limit = 200) => j<{ events:      WebEvent[]      }>(webApi(`/api/web/events?limit=${limit}`)).then((r) => r.events),
  webIdentities:  (limit = 100) => j<{ identities:  WebIdentity[]   }>(webApi(`/api/web/identities?limit=${limit}`)).then((r) => r.identities),
  webIdentityDetail: (id: string) => j<IdentityDetail>(webApi(`/api/web/identities/${encodeURIComponent(id)}`)),
  webConversions: (limit = 100) => j<{ conversions: WebConversion[] }>(webApi(`/api/web/conversions?limit=${limit}`)).then((r) => r.conversions),
  funnelStats:    (since: StatsWindow = '24h') => j<FunnelStats>(webApi(`/api/web/stats?since=${since}`)),
  funnelOverview: (since: StatsWindow = '7d')  => j<FunnelOverview>(webApi(`/api/web/overview?since=${since}`)),
  funnelSankey:   (since: StatsWindow = '7d')  => j<SankeyData>(webApi(`/api/web/sankey?since=${since}`)),
  // Overview breakdowns — ALL rows for a dimension (no top-N cap), then the raw
  // sessions (ids included) behind any row.
  funnelBreakdown: (since: StatsWindow, by: BreakdownDim) =>
    j<{ since: string; by: BreakdownDim; rows: BreakdownRow[] }>(webApi(`/api/web/breakdown?since=${since}&by=${by}`)),
  funnelBreakdownSessions: (since: StatsWindow, by: BreakdownDim, value: string, limit = 200) =>
    j<{ sessions: BreakdownSession[] }>(webApi(`/api/web/breakdown/sessions?since=${since}&by=${by}&value=${encodeURIComponent(value)}&limit=${limit}`)).then((r) => r.sessions),
  pipelineStages: () => j<{ stages: StageDef[] }>(webApi('/api/web/stages')).then((r) => r.stages),
  peopleAtStage:  (kind: StageKey, since: StatsWindow = '24h') =>
    j<{ kind: string; since: string; people: StagePerson[] }>(webApi(`/api/web/stage/${kind}?since=${since}`)).then((r) => r.people),
  logConversion:  (kind: StageKey, body: { person_id?: string | null; session_id?: string | null; value?: number; source?: string; payload?: unknown }) =>
    j<{ conversion_id: string; kind: string }>('/api/web/conversion', {
      method: 'POST',
      body: JSON.stringify({ kind, ...body }),
    }),

  // channels (WhatsApp listener)
  // wa-gateway connection management (ops Settings → WhatsApp)

  waSetChatPolicy: (id: string, patch: { auto_listen?: boolean; can_send?: boolean; name?: string }) =>
    j<{ chat: WaChat }>(`/api/wa/chats/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.chat),
  waMessages: (opts: { chat_id?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.chat_id) qs.set('chat_id', opts.chat_id);
    if (opts.limit)   qs.set('limit', String(opts.limit));
    return j<{ messages: WaMessage[] }>(`/api/wa/messages?${qs.toString()}`).then((r) => r.messages);
  },

  // ── Outreach · WA — the prospect inbox (module: outreach) ────────────────
  outreachWaThreads: (opts: { q?: string; limit?: number; status?: OutreachStatus | 'all' | 'working' } = {}) => {
    const qs = new URLSearchParams();
    if (opts.q) qs.set('q', opts.q);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.status) qs.set('status', opts.status);
    return j<{ threads: OutreachThread[]; total: number; counts: OutreachCounts }>(`/api/outreach/wa/threads?${qs.toString()}`);
  },
  outreachMarkDead: (lead_id: string, dead = true, reason?: string) =>
    j<{ lead_id: string; dead: boolean; error?: string }>('/api/outreach/wa/dead', {
      method: 'POST', body: JSON.stringify({ lead_id, dead, reason }),
    }),

  // ── Outreach · Queue — the automated ladder ─────────────────────────────
  outreachCohortMembers: (status?: string, cohort_id?: string) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (cohort_id) qs.set('cohort_id', cohort_id);
    return j<{ members: OutreachCohortMember[]; cohorts: OutreachCohort[]; counts: Record<string, number> }>(
      `/api/outreach/cohort?${qs.toString()}`);
  },
  outreachCohorts: () => j<{ cohorts: OutreachCohort[] }>('/api/outreach/cohorts').then((r) => r.cohorts),
  outreachCohortCreate: (name: string, note?: string) =>
    j<{ cohort?: { id: string; name: string }; created?: boolean; error?: string }>('/api/outreach/cohorts', {
      method: 'POST', body: JSON.stringify({ name, note }),
    }),
  // Waterfall the cohort across its eligible windows. Send TIMES only — a
  // per-person rewrite of the words is never read and never overwritten.
  outreachCohortSpread: (cohort_id: string, opts: { only_unscheduled?: boolean } = {}) =>
    j<OutreachSpreadResult>(`/api/outreach/cohorts/${encodeURIComponent(cohort_id)}/spread`,
      { method: 'POST', body: JSON.stringify(opts) }),
  outreachCohortUpdate: (cohort_id: string, patch: Partial<Pick<OutreachCohort,
    'name' | 'status' | 'timezone' | 'start_hour' | 'end_hour' | 'send_days' | 'send_windows' | 'languages' | 'daily_target'>>) =>
    // `warning` = the save landed, but one field was dropped because its
    // migration has not been applied to this database yet.
    j<{ ok?: boolean; warning?: string; error?: string }>(`/api/outreach/cohorts/${encodeURIComponent(cohort_id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
  // Drafts one step for the operator to read — never saves, never sends.
  // With lead_id the draft comes back RENDERED for that person — {first_name}
  // and friends already filled in — with `raw` keeping the variable form and
  // `unfilled` naming any variable they have no value for.
  outreachDraftStep: (cohort_id: string, body: { step_index: number; language: string; instruction?: string; lead_id?: string }) =>
    j<{ draft?: string; raw?: string; unfilled?: string[]; based_on?: number; error?: string }>(
      `/api/outreach/cohorts/${encodeURIComponent(cohort_id)}/draft-step`,
      { method: 'POST', body: JSON.stringify(body) }),
  outreachCohortDelete: (cohort_id: string) =>
    j<{ deleted?: boolean; error?: string }>(`/api/outreach/cohorts/${encodeURIComponent(cohort_id)}`, { method: 'DELETE' }),
  // Bulk add from Prospecting. A resolved promise does NOT mean everyone was
  // added — read `conflicts` (already in another cohort) and `skipped`.
  outreachCohortAddMany: (lead_ids: string[], cohort_id: string, override = false) =>
    j<OutreachAddResult>('/api/outreach/cohort/add-many', {
      method: 'POST', body: JSON.stringify({ lead_ids, cohort_id, override }),
    }),
  outreachCohortEnroll: (lead_id: string, cohort_id?: string) =>
    j<{ added?: boolean; step?: number; ladder_length?: number; reason?: string; error?: string }>(
      '/api/outreach/cohort/enroll', { method: 'POST', body: JSON.stringify({ lead_id, cohort_id }) }),
  // Move one prospect's next send. `outside_window` comes back true when the
  // chosen moment falls outside the cohort's sending hours — it still stands,
  // it just waits for the window.
  outreachReschedule: (lead_id: string, send_at: number) =>
    j<{ lead_id?: string; next_send_at?: number; went_live?: boolean; outside_window?: boolean;
        label?: string; zone?: string; error?: string }>(
      `/api/outreach/cohort/${encodeURIComponent(lead_id)}/schedule`,
      { method: 'PUT', body: JSON.stringify({ send_at }) }),
  outreachCohortControl: (lead_id: string, action: 'pause' | 'resume' | 'stop' | 'unschedule') =>
    j<{ lead_id: string; status?: string; error?: string }>('/api/outreach/cohort/control', {
      method: 'POST', body: JSON.stringify({ lead_id, action }),
    }),
  outreachCohortRemove: (lead_id: string) =>
    j<{ removed: boolean }>(`/api/outreach/cohort/${encodeURIComponent(lead_id)}`, { method: 'DELETE' }),
  outreachCohortTick: (opts: { force?: boolean } = {}) =>
    j<OutreachTickResult>('/api/outreach/cohort/tick', { method: 'POST', body: JSON.stringify(opts) }),
  outreachCohortSettings: () => j<OutreachCadence>('/api/outreach/cohort/settings'),
  // The cohort's copy — written once for the queue, personalised per recipient.
  outreachSequence: (cohort_id: string) =>
    j<OutreachSequenceInfo>(`/api/outreach/cohorts/${encodeURIComponent(cohort_id)}/sequence`),
  // scope: 'new_only' keeps hand-written per-person messages; 'everyone' replaces
  // them with the cohort copy. Approvals are re-armed either way.
  outreachSaveSequence: (cohort_id: string, sequence: OutreachSequence, scope: SequenceScope = 'new_only') =>
    j<{ ok?: boolean; error?: string; steps?: number; languages?: string[]; unknown_variables?: string[];
        scope?: SequenceScope; edits_replaced?: number; edits_kept?: number; approvals_withdrawn?: number }>(
      `/api/outreach/cohorts/${encodeURIComponent(cohort_id)}/sequence`,
      { method: 'PUT', body: JSON.stringify({ sequence, scope }) }),
  // Approve the next message for these people. Per message, not per person: it
  // lapses on send, so the following one needs approving again.
  outreachApprove: (lead_ids: string[], approve = true) =>
    j<OutreachApproveResult>('/api/outreach/cohort/approve', {
      method: 'POST', body: JSON.stringify({ lead_ids, approve }),
    }),
  // Rewrite one prospect's next message, for that prospect only. Saving
  // withdraws any approval — the approved text has changed.
  outreachEditMessage: (lead_id: string, text: string, clear = false) =>
    j<{ lead_id?: string; step?: number; text?: string; cleared?: boolean; error?: string }>(
      `/api/outreach/cohort/${encodeURIComponent(lead_id)}/message`,
      { method: 'PUT', body: JSON.stringify({ text, clear }) }),
  // The only call that schedules anything.
  outreachGoLive: (lead_ids: string[]) =>
    j<OutreachGoLiveResult>('/api/outreach/cohort/go-live', { method: 'POST', body: JSON.stringify({ lead_ids }) }),
  outreachWaThread: (opts: { chat_id?: string; lead_id?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts.chat_id) qs.set('chat_id', opts.chat_id);
    if (opts.lead_id) qs.set('lead_id', opts.lead_id);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return j<OutreachThreadDetail>(`/api/outreach/wa/thread?${qs.toString()}`);
  },
  outreachDraft: (body: { chat_id?: string; lead_id?: string; force_llm?: boolean }) =>
    j<OutreachDraft>('/api/outreach/wa/draft', { method: 'POST', body: JSON.stringify(body) }),
  outreachWaSettings: () => j<OutreachWaSettings>('/api/outreach/wa/settings'),
  outreachSaveWaSettings: (patch: { rules?: string; limits?: Partial<OutreachWaSettings['limits']> }) =>
    j<OutreachWaSettings>('/api/outreach/wa/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  listFlags: () => j<{ flags: FeatureFlag[] }>('/api/feature-flags').then((r) => r.flags),
  setFlag:   (key: string, value: boolean) =>
    j<{ ok: boolean }>(`/api/feature-flags/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  // ── GTM (gtm-builder folded in: intake → enrich → outreach) ──────────────
  gtmBatches: () => j<{ batches: GtmBatch[] }>('/api/gtm/batches').then((r) => r.batches),
  gtmApiUsage: () => j<GtmApiUsage>('/api/gtm/usage'),
  gtmLeads: (opts: { batch_id?: string; status?: string; stage?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v) qs.set(k, String(v));
    return j<{ leads: GtmLead[] }>(`/api/gtm/leads?${qs.toString()}`).then((r) => r.leads);
  },
  // WhatsApp intake picker — people from DM chats / group senders / group rosters.
  gtmWaPeople: (q = '') =>
    j<{ people: GtmWaPerson[] }>(`/api/gtm/wa/people${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.people),
  gtmWaGroups: () => j<{ groups: GtmWaGroup[] }>('/api/gtm/wa/groups').then((r) => r.groups),
  gtmWaParticipants: (groupId: string) =>
    j<{ group: { id: string; name: string | null; participant_count: number }; participants: GtmWaPerson[] }>(
      `/api/gtm/wa/groups/${encodeURIComponent(groupId)}/participants`),
  gtmWaResolve: (limit = 50) =>
    j<{ attempted: number; resolved: number; remaining: number }>('/api/gtm/wa/resolve', { method: 'POST', body: JSON.stringify({ limit }) }),
  gtmWaImport: (people: { phone: string; name?: string | null }[], source?: string) =>
    j<GtmImportResult>('/api/gtm/wa/import', { method: 'POST', body: JSON.stringify({ people, source }) }),
  gtmImport: (body: { text?: string; url?: string; source?: string }) =>
    j<GtmImportResult>('/api/gtm/import', { method: 'POST', body: JSON.stringify(body) }),
  gtmEnrichBatch: (batch_id: string, limit = 2) =>
    j<{ enriched: number; remaining: number }>('/api/gtm/enrich', { method: 'POST', body: JSON.stringify({ batch_id, limit }) }),
  gtmReadLead: (id: string) =>
    j<{ lead: GtmLead; org: GtmOrgPerson[]; angles: GtmAngles | null; sends: GtmSend[] }>(`/api/gtm/leads/${encodeURIComponent(id)}`),
  gtmEditLead: (id: string, patch: Partial<Pick<GtmLead, 'name' | 'linkedin' | 'email' | 'company' | 'position'>> & { socials?: { type: string; url: string }[]; company_staff_count?: number | null; company_linkedin?: string | null }) =>
    j<{ lead: GtmLead }>(`/api/gtm/leads/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.lead),
  // 'resume' re-runs only the steps a manual edit can unblock (SerpApi + the
  // finalize LinkedIn pass), leaving the paid per-lookup legs alone.
  gtmEnrichLead: (id: string, kind?: 'wa' | 'full' | 'resume') =>
    j<Record<string, unknown>>(`/api/gtm/leads/${encodeURIComponent(id)}/enrich`, { method: 'POST', body: JSON.stringify({ kind: kind || 'full' }) }),
  // Mark (dead=true) or revive (dead=false) a lead we couldn't enrich.
  gtmSetDeadEnd: (id: string, dead: boolean) =>
    j<GtmLead>(`/api/gtm/leads/${encodeURIComponent(id)}/dead-end`, { method: 'POST', body: JSON.stringify({ dead }) }),
  // Rename a list (its batch + all its leads' denormalized source).
  gtmRenameBatch: (id: string, source: string) =>
    j<{ id: string; source: string | null }>(`/api/gtm/batches/${encodeURIComponent(id)}/rename`, { method: 'POST', body: JSON.stringify({ source }) }),
  gtmOrgChart: (id: string, opts: { refresh?: boolean; slug?: string } = {}) =>
    j<{ company?: string; people: GtmOrgPerson[]; status: string; note?: string | null; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/theorg`, { method: 'POST', body: JSON.stringify(opts) }),
  gtmScoreIcp: (id: string) =>
    j<{ fit?: string; reasons?: string[]; gaps?: string[]; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/icp`, { method: 'POST', body: '{}' }),
  // Org chart + LinkedIn headcount + open roles in one pass. Partial by design:
  // `errors` lists the legs that failed while the rest still landed.
  gtmCompanyContext: (id: string, opts: { refresh?: boolean } = {}) =>
    j<{
      company?: string; org_people?: number; org_status?: string | null; org_note?: string | null;
      staff_count?: number | null; open_roles?: number; errors?: string[]; error?: string;
    }>(`/api/gtm/leads/${encodeURIComponent(id)}/company-context`, { method: 'POST', body: JSON.stringify(opts) }),
  gtmOpenRoles: (id: string) =>
    j<{ positions?: GtmPosition[]; count?: number; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/positions`, { method: 'POST', body: '{}' }),
  gtmGreen: () => j<{ leads: GtmGreenLead[] }>('/api/gtm/green').then((r) => r.leads),
  gtmAngles: (id: string) =>
    j<GtmAngles & { blocked?: string; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/angles`, { method: 'POST', body: '{}' }),
  gtmSaveAngles: (id: string, payload: GtmAngles) =>
    j<{ ok: boolean }>(`/api/gtm/leads/${encodeURIComponent(id)}/angles/save`, { method: 'POST', body: JSON.stringify({ payload }) }),
  // NOTE: these routes return the tool output FLAT (runTool adds no envelope).
  gtmThread: (id: string, refresh = false) =>
    j<{ messages?: { dir: 'in' | 'out'; text: string; at: number; status: 'sent' | 'confirmed' | 'failed' | 'received'; error?: string | null; source: string }[] }>(
      `/api/gtm/leads/${encodeURIComponent(id)}/thread${refresh ? '?refresh=1' : ''}`).then((r) => r.messages || []),
  gtmSchedule: (id: string, bubbles: string[], send_at: number) =>
    j<{ ok?: boolean; id?: string; send_at?: number; error?: string }>(
      `/api/gtm/leads/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify({ bubbles, send_at }) }),
  gtmSchedules: (lead?: string) =>
    j<{ schedules?: { id: string; lead_id: string; bubbles: string[]; send_at: number; status: string; error?: string | null }[]; defaults?: { default_send_hour?: number; default_days_ahead?: number; timezone?: string } }>(
      `/api/gtm/schedules${lead ? `?lead=${encodeURIComponent(lead)}` : ''}`),
  gtmCancelSchedule: (id: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/gtm/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  gtmSend: (id: string, bubbles: string[]) =>
    j<{ ok?: boolean; sent?: number; error?: string; failed_at?: number }>(`/api/gtm/leads/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ bubbles }) }),
  gtmYou: () => j<{ you: GtmYou }>('/api/gtm/you').then((r) => r.you),
  gtmSaveYou: (patch: Partial<GtmYou>) =>
    j<{ you: GtmYou }>('/api/gtm/you', { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.you),
  gtmPullGroups: () => j<{ you: GtmYou }>('/api/gtm/you/pull-groups', { method: 'POST', body: '{}' }).then((r) => r.you),
  gtmToPipeline: (id: string) =>
    j<{ ok?: boolean; client_id?: string; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/to-pipeline`, { method: 'POST', body: '{}' }),
  // Watch — config + watched leads + signal feed in one read.
  gtmWatch: () => j<GtmWatchState>('/api/gtm/watch'),
  gtmWatchSet: (id: string, on: boolean) =>
    j<{ id: string; watch: boolean; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/watch`, { method: 'POST', body: JSON.stringify({ on }) }),
  gtmWatchBulk: (ids: string[], on: boolean) =>
    j<{ updated: number; error?: string }>('/api/gtm/watch/bulk', { method: 'POST', body: JSON.stringify({ ids, on }) }),
  gtmWatchCheck: (id: string) =>
    j<{ checked: number; signals: number; pinged: number; error?: string }>(`/api/gtm/leads/${encodeURIComponent(id)}/watch-check`, { method: 'POST', body: '{}' }),
  gtmSignalMark: (id: string, status: 'responded' | 'dismissed' | 'new') =>
    j<{ id?: string; status?: string; error?: string }>(`/api/gtm/signals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ status }) }),

  // ─── LI Outreach — connect-first (queued invites, judged contacts,
  //     operator-scheduled messages) ────────────────────────────────
  liIntake: (paste: string, limit = 20, theme?: string) =>
    j<{ keywords: string; circles: number[] | null; candidates: LiCandidate[]; errors?: { slug: string; error: string }[] }>(
      '/api/li/intake', { method: 'POST', body: JSON.stringify({ paste, limit, theme }) }),
  liBuyerTitles: () => j<{ titles: string[] }>('/api/li/buyer-titles'),
  liAddProspects: (candidates: LiCandidate[], source_search?: string, theme?: string) =>
    j<{ added: number; skipped: number }>(
      '/api/li/prospects', { method: 'POST', body: JSON.stringify({ candidates, source_search, theme }) }),
  liProspects: (status?: LiProspect['status']) =>
    j<{ prospects: LiProspect[]; global_paused: boolean; sent_today: { connect: number; message: number }; max_retries?: number }>(
      `/api/li/prospects${status ? `?status=${status}` : ''}`),
  liProspect: (id: string) =>
    j<{ prospect: LiProspect; touches: LiTouch[]; scheduled: LiScheduledMessage[]; judge: LiJudge | null; default_message: string }>(
      `/api/li/prospects/${encodeURIComponent(id)}`),
  liJudge: (id: string) =>
    j<LiJudge & { error?: string }>(`/api/li/prospects/${encodeURIComponent(id)}/judge`, { method: 'POST', body: '{}' }),
  liScheduleMessage: (id: string, opts: { body: string; send_at: number; kind: 'first' | 'reply' | 'open' }) =>
    j<{ id?: string; prospect_id?: string; kind?: string; send_at?: number; status?: string; error?: string }>(
      `/api/li/prospects/${encodeURIComponent(id)}/schedule-message`, { method: 'POST', body: JSON.stringify(opts) }),
  liScheduled: (prospect_id?: string) =>
    j<{ scheduled: LiScheduledMessage[] }>(`/api/li/scheduled${prospect_id ? `?prospect=${encodeURIComponent(prospect_id)}` : ''}`),
  liCancelScheduled: (id: string) =>
    j<{ canceled: boolean }>(`/api/li/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  liSendScheduledNow: (id: string) =>
    j<{ ok: boolean; name?: string; error?: string }>(`/api/li/scheduled/${encodeURIComponent(id)}/send-now`, { method: 'POST', body: '{}' }),
  liConversationContacts: () =>
    j<{ contacts: LiConversationContact[] }>('/api/li/conversation-contacts'),
  // Raw thread read via the linkedin gateway; the daemon's payload shape
  // varies, so callers must stay defensive about the message objects.
  liConversationMessages: (urn: string, limit = 50) =>
    j<{ messages?: Record<string, unknown>[]; error?: string } & Record<string, unknown>>(
      `/api/li/conversations/${encodeURIComponent(urn)}/messages?limit=${limit}`),
  liControl: (action: 'play' | 'pause', id?: string) =>
    j<{ id?: string; status?: string; global_paused?: boolean; error?: string }>(
      id ? `/api/li/prospects/${encodeURIComponent(id)}/control` : '/api/li/control',
      { method: 'POST', body: JSON.stringify({ action }) }),
  liRemove: (id: string) =>
    j<{ removed: boolean }>(`/api/li/prospects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  liSettings: () => j<LiThrottle>('/api/li/settings'),
  liSaveSettings: (patch: Partial<LiThrottle>) =>
    j<LiThrottle>('/api/li/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  liVoice: () => j<{ body: string; source?: string }>('/api/li/voice'),
  liSaveVoice: (body: string) =>
    j<{ body: string; source?: string; error?: string }>('/api/li/voice', { method: 'PUT', body: JSON.stringify({ body }) }),
  liSchedule: () => j<LiSchedule>('/api/li/schedule'),
  liFunnel: () => j<LiFunnel>('/api/li/funnel'),
  liMarkReply: (id: string, replied = true) =>
    j<{ id: string; replied: boolean; status: LiProspect['status'] }>(`/api/li/prospects/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify({ replied }) }),
  liTick: (force = false) =>
    j<{ ok: boolean; sent: number; judged?: number; skipped?: string; results?: { name: string; action: string; reason?: string; ok?: boolean }[] }>('/api/li/tick', { method: 'POST', body: JSON.stringify({ force }) }),
  // Signals-first: the scan watches contacts for hiring / job-change / post /
  // news signals and prepares a draft; the OPERATOR actions each one.
  liSignals: (status?: LiSignal['status'], prospect?: string) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (prospect) q.set('prospect', prospect);
    const qs = q.toString();
    return j<{ signals: LiSignal[] }>(`/api/li/signals${qs ? `?${qs}` : ''}`);
  },
  liSignalMark: (id: string, status: 'actioned' | 'dismissed' | 'new') =>
    j<{ id?: string; status?: string; error?: string }>(
      `/api/li/signals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ status }) }),
  // Recent fetched activity + this person's signals — the "why now" panel.
  liContext: (id: string) =>
    j<{ activity: LiActivityPost[]; signals: LiSignalBase[] }>(
      `/api/li/prospects/${encodeURIComponent(id)}/context`),
  liAssign: (id: string, opts: { mode?: 'signal' | 'sequence'; sequence_slug?: string; theme?: string }) =>
    j<{ id?: string; mode?: 'signal' | 'sequence'; theme?: string | null; error?: string }>(
      `/api/li/prospects/${encodeURIComponent(id)}/assign`, { method: 'POST', body: JSON.stringify(opts) }),
  // May answer { sequences: [...] } or a bare array — normalize to the array.
  liSequences: () =>
    j<{ sequences?: LiSequence[] } | LiSequence[]>('/api/li/sequences')
      .then((r) => (Array.isArray(r) ? r : r.sequences || [])),
  liLikePost: (signalId: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/li/signals/${encodeURIComponent(signalId)}/like`, { method: 'POST', body: '{}' }),
  liDraftComment: (signalId: string) =>
    j<{ ok?: boolean; comment?: string; error?: string }>(`/api/li/signals/${encodeURIComponent(signalId)}/draft-comment`, { method: 'POST', body: '{}' }),
  liCommentPost: (signalId: string, text: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/li/signals/${encodeURIComponent(signalId)}/comment`, { method: 'POST', body: JSON.stringify({ text }) }),
  liEnrichPhone: (prospectId: string) =>
    j<{ found?: boolean; phone?: string; wa_url?: string; skipped?: string; error?: string }>(
      `/api/li/prospects/${encodeURIComponent(prospectId)}/enrich-phone`, { method: 'POST', body: '{}' }),
  liScanNow: () =>
    j<{ scanned: number; found: number; errors?: unknown }>('/api/li/scan', { method: 'POST', body: '{}' }),
  // Message anatomy: the ordered bites every draft is assembled from, plus
  // how many drafts carry operator feedback waiting to be distilled.
  liBites: () =>
    j<{ bites: LiBite[]; pending_feedback: number }>('/api/li/bites'),
  // Operator's "bad draft" note on one signal. The backend acts on it
  // IMMEDIATELY (regenerates the draft against the verdict and hands the
  // thread to Nyo); liLearn later distills it into the bite at fault.
  liSignalFeedback: (id: string, text: string) =>
    j<{ id?: string; feedback?: string; draft?: string; redrafted?: boolean; error?: string }>(
      `/api/li/signals/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify({ text }) }),
  liLearn: () =>
    j<{ applied?: number; feedback_items?: number; bites?: string[]; redrafted?: number; error?: string; note?: string }>(
      '/api/li/learn', { method: 'POST', body: '{}' }),

  // ── LinkedIn Signals module ──────────────────────────────────
  // Read-only over the digest's li_signal cards, re-sorted by the
  // signal-priority score. Drafting a take reuses liDraftComment /
  // liCommentPost above — this module adds no drafting of its own.
  liSignalsFeed: (opts: { origin?: TrackedOrigin; min_score?: number; unread?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.origin && opts.origin !== 'all') q.set('origin', opts.origin);
    if (typeof opts.min_score === 'number') q.set('min_score', String(opts.min_score));
    if (opts.unread) q.set('unread', '1');
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return j<{ items: TrackedSignal[]; count: number }>(`/api/li-signals/feed${qs ? `?${qs}` : ''}`);
  },
  liSignalsTracked: () =>
    j<{ people: TrackedPerson[]; count: number; untracked_prospecting: number }>('/api/li-signals/tracked'),
  liSignalsTrack: (linkedin: string, name?: string) =>
    j<{ id?: string; name?: string; status?: string; already?: boolean; error?: string }>(
      '/api/li-signals/track', { method: 'POST', body: JSON.stringify({ linkedin, name }) }),
  liSignalsUntrack: (id: string) =>
    j<{ id?: string; name?: string; removed?: boolean; error?: string }>(
      '/api/li-signals/untrack', { method: 'POST', body: JSON.stringify({ id }) }),
  liSignalsSync: () =>
    j<{ added?: number; candidates?: number; error?: string }>(
      '/api/li-signals/sync', { method: 'POST', body: '{}' }),
  // Regenerate signal drafts under the CURRENT bites. With id: exactly that
  // one draft (the per-card rewrite button); without: bulk over open signals.
  liRedraft: (limit = 8, id?: string) =>
    j<{ redrafted: number; open_signals: number; error?: string }>(
      '/api/li/redraft', { method: 'POST', body: JSON.stringify(id ? { id, limit } : { limit }) }),

  registry: () => j<Registry>('/api/registry'),
};

// ─── LI Outreach types ──────────────────────────────────────────
export type LiCandidate = {
  urn_id: string; public_id?: string | null; name: string;
  role?: string | null; company?: string | null; circle?: number | null;
  location?: string | null; already_in?: boolean;
};
export type LiProspect = {
  heat?: number; heat_band?: 'hot' | 'warm' | 'cold'; heat_factors?: string[];
  id: string; urn_id: string; public_id: string | null; name: string;
  role: string | null; company: string | null; circle: number | null; location: string | null;
  // queued = intake, waiting for its connection request; invited = request out;
  // connected = accepted (the Contacts surface, judged); replied = they wrote
  // back and sends to them stop; paused/stalled/done as before.
  status: 'queued' | 'invited' | 'connected' | 'replied' | 'paused' | 'stalled' | 'done';
  step_index: number; next_action_at: number | null; fail_count: number;
  judge_json?: string | null;      // persisted judge verdict (JSON string of LiJudge)
  company_slug?: string | null;    // LinkedIn company universal name, for the signal hunt
  company_id?: string | null;
  accepted_at?: number | null; replied_at?: number | null;
  invited_at?: number | null;      // when the connection request went out (if the read exposes it)
  stall_reason?: string | null;   // last failed touch error, present on stalled rows
  stall_class?: 'limits' | 'hard'; // server-side classification (engine's own failure taxonomy)
  // Signals-first assignment: how we work this person once connected.
  theme: string | null;                          // operator grouping label (intake batches carry it)
  outreach_mode: 'signal' | 'sequence' | null;   // wait-for-signal (default) vs cold sequence
  sequence_slug: string | null; sequence_step: number | null; next_step_at: number | null;
  signal_checked_at: number | null;              // last time the signal scan looked at them
  source_search: string | null; created_at: number; updated_at: number;
};
// One detected signal on a watched contact — the reason to reach out NOW.
// The scan writes these with a prepared draft; the operator actions them.
export type LiSignalBase = {
  id: string; prospect_id: string;
  kind: 'open_role' | 'job_change' | 'post' | 'news';
  title: string;
  detail: any;                     // kind-specific payload (post text, old→new role, role+url)
  draft: string | null;            // prepared message — sent only when the operator schedules it
  status: 'new' | 'actioned' | 'dismissed';
  detected_at: number; resolved_at: number | null;
  // Operator's "bad draft" note (liSignalFeedback). Distilled into the
  // message-anatomy bites by liLearn; rides in via SELECT s.*.
  feedback?: string | null;
  feedback_at?: number | null;
};
// One message-anatomy bite: an ordered slice every generated message is
// assembled from. `role` explains how this bite builds the total message;
// `content` is the live editable part of the backing knowledge doc.
export type LiBite = { key: string; slug: string; order: number; role: string; content: string };
// A feed row: the signal + the joined prospect facts.
export type LiSignal = LiSignalBase & {
  name: string; role: string | null; company: string | null; theme: string | null;
  prospect_status: LiProspect['status'];
  outreach_mode: 'signal' | 'sequence' | null;
};
export type LiSequence = { slug: string; title: string; steps: number };
// One fetched post from a contact's recent activity (the context panel).
export type LiActivityPost = {
  id: string; post_urn: string | null; text: string | null; posted_at: number | null;
  reactions: number | null; comments: number | null;
  is_repost: number | boolean | null; fetched_at: number | null;
};
// The judge's persisted verdict for one contact: the signal it found (or
// null), the prepared first message, scores, and the suggested next action.
export type LiJudge = {
  signal: { kind: string; role: string; link: string | null; company: string | null } | null;
  prepared: string;
  quality: number; interest: number; reason: string;
  action: 'schedule' | 'review' | 'improve_angle';
  source: 'signal' | 'default';
  judged_at: number;
};
// One row of li_scheduled_messages — the operator's send intent. The hourly
// tick delivers pending rows through the caps, gap floor, and RULE ONE.
export type LiScheduledMessage = {
  id: string; prospect_id: string; kind: 'first' | 'reply' | 'open'; body: string;
  send_at: number; status: 'pending' | 'sent' | 'failed' | 'canceled';
  error?: string | null; created_at: number; sent_at?: number | null;
  name?: string; // joined prospect name on the pending-list read
};
// A contact on the Conversations surface: their prospect row + thread facts.
export type LiConversationContact = LiProspect & {
  conversation_urn: string | null;
  last_inbound_text: string | null; last_inbound_at: number | null;
  uncaught: number | null; sentiment: string | null;
  msgs_in: number | null; msgs_out: number | null;
  last_outbound_at: number | null;
  pending_replies: number; next_reply_at: number | null;
};
export type LiTouch = {
  id: string; prospect_id: string; step_index: number;
  kind: 'connect' | 'message'; body: string | null;
  // deferred/skipped are NOT failures: deferred = engine intentionally waiting
  // (caps, acceptance, message-gap floor); skipped = step was unnecessary.
  status: 'sent' | 'failed' | 'deferred' | 'skipped'; error: string | null; created_at: number;
};
// ── Outreach · WA — the prospect inbox (module: outreach) ──────────────────
// A conversation row in the WA tab. `uncaught` = they spoke last, so the ball
// is in our court; those pin to the top of the list.
// active = they have answered at least once; unanswered = only our messages so
// far; dead = marked by the operator, or nothing has happened for
// dead_after_days (the cadence note owns that number).
// 'scheduled' = no conversation yet but a queued send is waiting to fire
export type OutreachStatus = 'active' | 'unanswered' | 'dead' | 'fresh' | 'scheduled';
export type OutreachCounts = Record<OutreachStatus, number>;
export type OutreachThread = {
  chat_id: string; lead_id: string;
  scheduled_text?: string | null; scheduled_at?: number | null;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; icp_fit: string | null;
  last_text: string | null; last_from_me: boolean | null; last_at: number | null;
  uncaught: boolean; never_messaged: boolean; answered: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  msgs_in: number | null; msgs_out: number | null;
  status: OutreachStatus;
  dead_marked: boolean; dead_reason: string | null;
  dead_by: 'marked' | 'stale' | null;
};

// A named queue (campaign) with how many prospects it holds.
// A cohort's run state. Anything other than 'active' stops the sender for
// everyone inside it, without moving anyone or losing their place.
export type CohortStatus = 'active' | 'paused' | 'finished' | 'canceled';
export const COHORT_STATUSES: CohortStatus[] = ['active', 'paused', 'finished', 'canceled'];
// Only WhatsApp actually sends; the rest are selectable so a flow can be
// designed ahead of the plumbing.
export const OUTREACH_CHANNELS = ['whatsapp', 'linkedin', 'email'] as const;
export const OUTREACH_WIRED_CHANNELS: readonly string[] = ['whatsapp'];
export const OUTREACH_TRIGGERS = ['no_reply', 'always'] as const;
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type OutreachCohort = {
  id: string; name: string; note: string | null; created_at: number;
  status: CohortStatus;
  // The cohort's own sending window. null = inherit the account default.
  timezone: string | null;
  start_hour: number | null;
  end_hour: number | null;
  send_days: number[] | null;   // 0=Sunday … 6=Saturday
  // Eligible sending times per weekday, to the minute, in `timezone`. A weekday
  // that is ABSENT sends nothing. Overrides start_hour/end_hour and send_days.
  // null = inherit the account default window.
  send_windows: Record<string, { start: string; end: string }> | null;
  languages: string[] | null;
  // How many of THIS cohort's messages the waterfall will put on one day.
  // null = no target, so it fills each window and rolls over only when the
  // window itself runs out. Never gates a send time set by hand.
  daily_target: number | null;
  has_sequence: boolean;
  total: number; active: number; answered: number;
};
export type OutreachSpreadResult = {
  scheduled: { lead_id: string; name: string | null; at: number; ymd: string }[];
  blocked: { lead_id: string; name?: string | null; reason: string }[];
  requested: number;
  daily_target: number | null;
  days: number;
  timezone?: string;
  // Non-English cohorts get a message written per prospect at scheduling time.
  // Capped per call, so `awaiting_copy` is how many still need one — nothing
  // sends without it.
  language?: string;
  copy_written?: number;
  awaiting_copy?: number;
  error?: string;
};
// Somebody already being worked in ANOTHER cohort. Nobody may be in two, so
// adding them needs explicit operator approval, which MOVES them.
export type OutreachConflict = {
  conflict: true; lead_id: string; name: string | null;
  current_cohort: { id: string; name: string | null };
  requested_cohort: { id: string; name: string | null };
  message: string;
};
export type OutreachAddResult = {
  cohort_id: string; cohort_name: string | null; requested: number;
  added: { lead_id: string; moved?: boolean }[];
  conflicts: OutreachConflict[];
  skipped: { lead_id: string; reason: string }[];
  error?: string;
};

// The cohort's message sequence. Written once for the whole queue; the only
// per-person variation is variable substitution and which language variant.
export type OutreachSequenceStep = {
  delay_hours: number;
  // Which surface it goes out on. Only 'whatsapp' actually sends today — the
  // others are selectable so a flow can be designed ahead of the plumbing.
  channel: string;
  // The condition deciding whether the step fires at all: 'no_reply' skips it
  // for anyone who has answered, 'always' sends regardless.
  trigger: string;
  bodies: Record<string, string>;   // language code -> text
};
export type OutreachSequence = {
  default_language: string;
  steps: OutreachSequenceStep[];
};
export type OutreachSequenceInfo = {
  cohort_id: string;
  sequence: OutreachSequence;
  steps: number;
  languages: string[];
  variables_used: string[];
  unknown_variables: string[];
  ok: boolean;
};
export type OutreachGoLiveResult = {
  requested: number;
  live: { lead_id: string; name: string | null; steps: number; first_text: string | null }[];
  blocked: { lead_id: string; name?: string | null; reason: string }[];
  error?: string;
};
// Variables a sequence body may use — mirrors VARIABLES in lib/outreach-sequence.js.
export const OUTREACH_VARIABLES = ['first_name', 'name', 'company', 'position', 'country'] as const;

// One enrolled prospect on the automated ladder.
export type OutreachCohortMember = {
  lead_id: string; chat_id: string | null;
  cohort_id: string; cohort_name: string | null;
  // Staged = in the cohort but NOT scheduled. Only go-live changes that.
  staged: boolean; approved_at: number | null;
  // Why this person cannot go live (missing variable, no sequence yet).
  blocked: string | null;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; icp_fit: string | null;
  status: 'staged' | 'active' | 'answered' | 'paused' | 'done' | 'stopped';
  answered: boolean; answered_at: number | null;
  step: number; ladder_length: number;
  // How many messages they have ACTUALLY received. Shows as sent_count/ladder,
  // so somebody with a message scheduled but nothing sent yet reads 0/3.
  sent_count: number;
  last_sent_text: string | null; last_sent_at: number | null;
  next_text: string | null; next_send_at: number | null;

  // The next message. draft = written, no send time yet; scheduled = it has one.
  next_state: 'draft' | 'scheduled' | null;
  next_step: number | null;
  // Named on the server in the cohort's own zone, so the browser never
  // re-derives it and the two cannot disagree.
  next_send_label: string | null; next_send_zone: string | null;
  next_send_ymd: string | null; timezone: string;
  due_today: boolean;

  // Approval is per (person, step) and lapses by itself when the step advances.
  // approved_step_at is when THIS message was signed off — distinct from
  // approved_at above, which is the go-live stamp for the person.
  approved: boolean; approved_step: number | null; approved_step_at: number | null;
  approval_required: boolean;
  // A per-person edit of this one message. The cohort's copy is untouched.
  edited: boolean; override_text: string | null; override_blocked: string | null;

  // Where their real WhatsApp conversation stands. Same derivation the
  // Conversations tab uses, so the two tabs cannot disagree about a prospect.
  conversation: 'untouched' | 'touched' | 'active' | 'dead';
  conversation_last_at: number | null;
  dead_by: 'marked' | 'stale' | null;
  msgs_in: number; msgs_out: number;

  exhausted: boolean; stop_reason: string | null; last_error: string | null;
};
// What a bulk edit does to people already in the cohort. 'new_only' leaves
// hand-written per-person messages alone; 'everyone' overwrites them.
export type SequenceScope = 'new_only' | 'everyone';
export type OutreachApproveResult = {
  approved: { lead_id: string; name?: string | null; step?: number; approved: boolean }[];
  refused: { lead_id: string; name?: string | null; reason: string }[];
  error?: string;
};
export type OutreachTickResult = {
  ran: boolean; reason?: string;
  due?: number; sent?: number; next_open?: number;
  results?: { lead_id: string; name?: string | null; action: string; text?: string; step?: number; error?: string }[];
};
export type OutreachCadence = {
  cadence: {
    step_delays_hours: number[]; max_sends_per_day: number; min_gap_minutes: number;
    quiet_start_hour: number; quiet_end_hour: number; weekdays_only: boolean;
    timezone: string; dead_after_days: number;
    // When true the sender refuses any message the operator has not approved.
    require_approval: boolean;
  };
  source: 'doc' | 'defaults';
};
// Everything the side panel shows about the person and their company.
export type OutreachProspect = {
  lead_id: string;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; phone: string | null; email: string | null;
  linkedin: string | null; company_linkedin: string | null;
  company_staff_count: number | null;
  country: string | null; region: string | null;
  icp_fit: string | null; icp_reasons: string[]; icp_gaps: string[];
  org_status: string | null; org_note: string | null;
  open_positions: { title?: string; location?: string; url?: string; posted_at?: string }[];
  socials: { type: string | null; url: string }[];
  status: string | null;
};
// status: 'sent' = we asked WhatsApp to send it (one tick); 'confirmed' =
// WhatsApp echoed it back, so it really went out (two ticks); 'received' =
// theirs, no tick.
export type OutreachMessage = {
  id: string; from_me: boolean; body: string; sender_name: string | null; at: number | null;
  status: 'sent' | 'confirmed' | 'received';
};
export type OutreachThreadDetail = {
  chat_id: string;
  // Every id this person's messages were merged from (a `@c.us` chat plus any
  // `@lid` privacy twin).
  chat_ids?: string[];
  prospect: OutreachProspect | null;
  messages: OutreachMessage[];
  count: number;
  stats: {
    replied: boolean; uncaught: boolean;
    msgs_in: number | null; msgs_out: number | null;
    sentiment: string | null; sentiment_reason: string | null;
  } | null;
  error?: string;
};
// source: 'angle' = the approved GTM bubble verbatim (first touch);
// 'llm' = composed from that angle + the thread; 'none' = nothing to suggest.
export type OutreachDraft = {
  draft: string | null;
  source: 'angle' | 'llm' | 'template' | 'none';
  lead_id?: string;
  reason?: string;
  // Which rung of the approved ladder this is (source 'angle' only).
  step?: number;
  first_touch?: boolean;
  angle?: { rank: number | null; type: string | null; rationale: string | null } | null;
  alternatives?: string[];
  based_on_messages?: number;
  at?: number;
  error?: string;
};
export type OutreachWaSettings = {
  rules: string;
  limits: {
    thread_limit: number; message_limit: number;
    draft_context_messages: number; draft_context_chars: number;
  };
  source: 'doc' | 'defaults';
};

export type LiThrottle = {
  max_connections_per_day: number; max_messages_per_day: number;
  per_tick_cap: number; jitter_max_seconds: number;
  active_hours_utc: number[]; active_days: number[]; retry_wait_days: number; max_retries: number;
  min_message_gap_days?: number; acceptance_deadline_days?: number;
  source?: string;
};
// type = which queue it came from (intake connect vs scheduled message);
// kind carries the message flavor (first/reply) for type 'message'.
export type LiUpcoming = {
  type: 'connect' | 'message'; kind: string; id: string; sched_id?: string;
  name: string; role: string | null; company: string | null; due: number; at: number | null;
};
export type LiSent = { id: string; kind: 'connect' | 'message'; body: string | null; status: 'sent' | 'failed' | 'deferred' | 'skipped'; error: string | null; at: number; name: string; role: string | null; company: string | null };
export type LiSchedule = {
  now: number; global_paused: boolean; active_hours_utc: number[]; per_tick_cap: number;
  caps: { connect: number; message: number };
  queued_count: number; scheduled_count: number;
  upcoming: LiUpcoming[]; sent: LiSent[];
};

export type LiFunnelEntry = { id: string; name: string; at: number | null };
export type LiFunnel = {
  now: number;
  live_check: boolean;                 // false = LinkedIn unreachable, persisted signals only
  pending_on_linkedin: number | null;  // size of the live pending-sent list
  counts: { requests: number; connections: number; messages: number; replies: number };
  stages: { requests: LiFunnelEntry[]; connections: LiFunnelEntry[]; messages: LiFunnelEntry[]; replies: LiFunnelEntry[] };
};

// Chat helper. Streams SSE events from /api/chat.
export type ChatEvent =
  | { kind: 'start'; conversation_id: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; name: string; input: any }
  | { kind: 'tool_result'; name: string; ok: boolean; result?: any; error?: string }
  | { kind: 'done'; conversation_id: string }
  | { kind: 'error'; message: string };

export async function chat(
  messages: { role: 'user' | 'assistant'; content: string | any[] }[],
  conversation_id: string | null,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
  tier?: 'mid' | 'high',
  agent?: string,
) {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, conversation_id, tier, agent }),
      signal,
    });
  } catch (e) {
    // Stop pressed before the response arrived — clean exit, not an error.
    if (signal?.aborted) return;
    onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!res.ok || !res.body) {
    onEvent({ kind: 'error', message: `${res.status} ${res.statusText}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let idx; (idx = buffer.indexOf('\n\n')) >= 0; ) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          onEvent({ kind: event as ChatEvent['kind'], ...parsed } as ChatEvent);
        } catch {
          /* swallow malformed sse frames */
        }
      }
    }
  } catch (e) {
    // Stop pressed mid-stream — the reader read() rejects; end cleanly.
    if (signal?.aborted) return;
    onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}
