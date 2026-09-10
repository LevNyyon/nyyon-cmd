-- Nyyon Command Center — consolidated schema for a FRESH install.

-- Generated from a live database (tables + indexes, no data).

-- Applied by scripts/bootstrap.mjs via `wrangler d1 execute --file`.



CREATE TABLE IF NOT EXISTS aeo_feedback (
  id            TEXT PRIMARY KEY,
  question_slug TEXT,                          
  idea_title    TEXT,                          
  reaction      TEXT NOT NULL,                 
  note          TEXT,                          
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aeo_questions (
  slug              TEXT PRIMARY KEY,
  question          TEXT NOT NULL,
  target_keyword    TEXT,
  priority          INTEGER NOT NULL DEFAULT 5,   
  status            TEXT NOT NULL DEFAULT 'pending',
  scheduled_for     INTEGER,
  drafted_blog_slug TEXT,
  last_error        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
, expert_context_json TEXT, interview_status TEXT, voice TEXT NOT NULL DEFAULT 'house');

CREATE TABLE IF NOT EXISTS aeo_suggestions (
  id             TEXT PRIMARY KEY,
  signal_id      TEXT REFERENCES osint_signals(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,             -- proposed article title / question
  angle          TEXT NOT NULL,             -- Nyyon's developed take (becomes the pre-filled "interview answer")
  rationale      TEXT,                      -- why this is worth writing, one line
  target_keyword TEXT,
  source_name    TEXT,
  source_url     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | drafted | failed
  question_slug  TEXT,                      -- set once promoted to aeo_questions
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER,
  decided_by     TEXT
);

CREATE TABLE IF NOT EXISTS blog_posts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  excerpt TEXT,
  body TEXT,
  tags TEXT,                     
  published_at INTEGER,          
  published INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
, featured_image_url          TEXT, featured_image_prompt       TEXT, featured_image_model        TEXT, featured_image_generated_at INTEGER);

CREATE TABLE IF NOT EXISTS brain_sessions (
  id             TEXT PRIMARY KEY,
  week_of        INTEGER NOT NULL,            
  status         TEXT NOT NULL DEFAULT 'open',
  questions_json TEXT,                         
  answers_text   TEXT,                         
  derived_json   TEXT,                         
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id               TEXT PRIMARY KEY,                      
  kind             TEXT NOT NULL DEFAULT 'meeting',
  title            TEXT NOT NULL,
  description      TEXT,
  starts_at        INTEGER NOT NULL,                      
  ends_at          INTEGER,                               
  all_day          INTEGER NOT NULL DEFAULT 0,            
  status           TEXT NOT NULL DEFAULT 'confirmed',
  source           TEXT NOT NULL DEFAULT 'manual',        
  source_ref       TEXT,                                  
  link_url         TEXT,                                  
  location         TEXT,
  attendees        TEXT,                                  
  body             TEXT,                                  
  platform         TEXT,                                  
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  created_by       TEXT,
  updated_by       TEXT
, reminded_at INTEGER);

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | past | prospect | partner
  industry    TEXT,
  website     TEXT,
  engagement  TEXT,                            -- what Nyyon does for them (PPC, website, SEO, deck, content…)
  owner       TEXT,
  tags        TEXT,                            -- JSON array, nullable
  notes       TEXT,                            -- markdown
  starred     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_by  TEXT
, stage TEXT, deal_value INTEGER, mrr_value INTEGER);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  identity_id TEXT,              
  full_name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'prospect',
  source TEXT,
  owner TEXT,
  tags TEXT,                      
  notes TEXT,                     
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT,
  updated_by TEXT
, linkedin_url TEXT, client_id TEXT);

CREATE TABLE IF NOT EXISTS content_blocks (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',    
  page TEXT,                            
  section TEXT,                         
  updated_at INTEGER NOT NULL,
  updated_by TEXT,                      
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, agent TEXT);

CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  identity_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,            -- 'signup' | 'lead' | 'sale' | 'demo' | ...
  value REAL,
  currency TEXT,
  source TEXT,
  payload TEXT,                  -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_plans (date TEXT PRIMARY KEY, plan TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'wing_it', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS digest_channels (
  source        TEXT PRIMARY KEY,      
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  cadence       TEXT NOT NULL DEFAULT 'manual',  
  notes         TEXT,
  last_run_at   INTEGER,
  last_status   TEXT,                            
  last_error    TEXT,
  total_runs    INTEGER NOT NULL DEFAULT 0,
  total_added   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_items (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,          
  ref_kind         TEXT,                   
  ref_id           TEXT,                   
  title            TEXT NOT NULL,
  summary          TEXT,
  source_label     TEXT,                   
  source_url       TEXT,
  urgency          INTEGER NOT NULL DEFAULT 2,  
  actionable       INTEGER NOT NULL DEFAULT 0,  
  suggested_action TEXT,                   
  starred          INTEGER NOT NULL DEFAULT 0,  
  read_at          INTEGER,                
  created_at       INTEGER NOT NULL,
  meta_json        TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,           
  actor TEXT,                   
  payload TEXT,                 
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  scope TEXT NOT NULL,           
  description TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_entries (
  id            TEXT PRIMARY KEY,
  year          INTEGER NOT NULL,
  month         INTEGER NOT NULL,            
  position      INTEGER NOT NULL,            
  kind          TEXT    NOT NULL DEFAULT 'expense',  
  status        TEXT    NOT NULL DEFAULT '', 
  item          TEXT    NOT NULL DEFAULT '',
  income_pretax REAL,                        
  income_net    REAL,                        
  expense       REAL,                        
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_attempts (ip TEXT, ts INTEGER);

CREATE TABLE IF NOT EXISTS gtm_api_quota (
  provider    TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,            -- JSON: whatever the provider reported
  captured_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gtm_api_usage (
  provider   TEXT NOT NULL,
  period     TEXT NOT NULL,             -- ISO date of the period's renewal anchor
  used       INTEGER NOT NULL DEFAULT 0,
  warned_at  INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, period)
);

CREATE TABLE IF NOT EXISTS gtm_batches (
  id         TEXT PRIMARY KEY,                -- 'gb_...'
  source     TEXT,
  via        TEXT,                            -- paste | csv | url
  total      INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  invalid    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gtm_leads (
  id               TEXT PRIMARY KEY,          -- 'gl_...'
  phone            TEXT NOT NULL,             -- as pasted
  normalized_phone TEXT,                      -- E.164, dedupe key
  status           TEXT NOT NULL DEFAULT 'new', -- new | enriched
  source           TEXT,                      -- operator note: where the list came from
  batch_id         TEXT,                      -- gtm_batches.id
  country          TEXT,
  region           TEXT,
  name             TEXT,
  photo            TEXT,                      -- R2 public URL
  socials          TEXT NOT NULL DEFAULT '[]',-- [{type,url,src,at}]
  linkedin         TEXT,
  email            TEXT,
  company          TEXT,
  position         TEXT,                      -- job title
  line_type        TEXT,                      -- twilio
  carrier          TEXT,                      -- twilio
  sources          TEXT NOT NULL DEFAULT '{}',-- per-field provenance {field:{tool,at}}
  conflicts        TEXT NOT NULL DEFAULT '[]',-- [{field,value,tool,at}] never overwrite
  dismissed        TEXT NOT NULL DEFAULT '[]',-- tombstoned social URLs, never re-add
  active_tool      TEXT,                      -- transient: live enrich badge
  org_status       TEXT,                      -- null | saved | warn | none
  org_note         TEXT,
  theorg_slug      TEXT,                      -- operator override for namesakes
  icp_fit          TEXT,                      -- strong | medium | weak
  icp_reasons      TEXT,                      -- JSON {reasons:[],gaps:[]}
  company_li_id    TEXT,                      -- cached numeric LinkedIn company id
  open_positions   TEXT,                      -- JSON [{title,location,url,posted_at}]
  positions_checked_at INTEGER,
  outreach_lang    TEXT,                      -- per-lead override, e.g. 'en'
  client_id        TEXT,                      -- link into clients (Pipeline CRM)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
, steps TEXT, company_staff_count INTEGER, company_context TEXT, company_checked_at INTEGER, watch INTEGER NOT NULL DEFAULT 0, watch_started_at INTEGER, watch_checked_at INTEGER, headline_snapshot TEXT);

CREATE TABLE IF NOT EXISTS gtm_org_people (
  id             TEXT PRIMARY KEY,            -- 'gp_...'
  lead_id        TEXT NOT NULL,
  company        TEXT,
  node_id        TEXT,
  parent_node_id TEXT,
  name           TEXT,
  role           TEXT,
  photo_url      TEXT,
  report_count   INTEGER,
  source         TEXT NOT NULL DEFAULT 'theorg',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gtm_outreach_angles (
  lead_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gtm_sends (
  id         TEXT PRIMARY KEY,                -- 'gs_...'
  lead_id    TEXT NOT NULL,
  chat_id    TEXT,
  bubble     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'sent',    -- sent | failed
  error      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gtm_signals (
  id          TEXT PRIMARY KEY,          -- 'sig_' + hash(lead_id|kind|key)
  lead_id     TEXT NOT NULL,             -- gtm_leads.id
  kind        TEXT NOT NULL,             -- open_role | job_change
  title       TEXT NOT NULL,             -- one-line human label
  detail      TEXT,                      -- JSON: role/url/old/new/company...
  draft       TEXT,                      -- suggested WA response, operator's voice
  status      TEXT NOT NULL DEFAULT 'new', -- new | pinged | responded | dismissed
  detected_at INTEGER NOT NULL,
  pinged_at   INTEGER,
  resolved_at INTEGER                    -- when marked responded/dismissed
);

CREATE TABLE IF NOT EXISTS home_sections (
  id TEXT PRIMARY KEY,          
  page TEXT NOT NULL DEFAULT 'home',
  label TEXT NOT NULL,
  position INTEGER NOT NULL,    
  visible INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS hot_take_packages (
  id                TEXT PRIMARY KEY,                    
  status            TEXT NOT NULL DEFAULT 'topic',       
  title             TEXT,
  summary           TEXT,
  why_it_matters    TEXT,
  source_name       TEXT,
  source_url        TEXT,
  published_at      INTEGER,                             
  origin            TEXT,                                
  origin_ref        TEXT,                                
  multi_source_json TEXT,                                
  pinned            INTEGER NOT NULL DEFAULT 0,
  take              TEXT,
  believe           TEXT,                                
  misunderstood     TEXT,
  who_cares         TEXT,
  reader_action     TEXT,
  brief_json        TEXT,                                
  blog_slug         TEXT,
  headline          TEXT,
  intro             TEXT,
  review_json       TEXT,                                
  company_notes     TEXT,
  author_notes      TEXT,
  website_status    TEXT NOT NULL DEFAULT 'not_planned', 
  website_url       TEXT,
  scheduled_at      INTEGER,                             
  actor             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hot_take_posts (
  id           TEXT PRIMARY KEY,                         
  package_id   TEXT NOT NULL,                            
  channel      TEXT NOT NULL,                            
  body         TEXT,
  notes        TEXT,
  image_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',            
  scheduled_at INTEGER,
  posted_at    INTEGER,
  outbox_id    TEXT,
  error        TEXT,
  actor        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  cookie_id TEXT,
  email TEXT,
  phone TEXT,
  handle TEXT,                   -- reddit / wa / etc
  channel TEXT,                  -- 'web' | 'reddit' | 'whatsapp' | ...
  display_name TEXT,
  meta TEXT,                     -- JSON
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_links (
  id TEXT PRIMARY KEY,
  cookie_id        TEXT,
  person_id        TEXT NOT NULL,
  identifier_type  TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  method           TEXT,
  source_event_id  TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS install_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      created_at INTEGER,
      admin_user TEXT, admin_hash TEXT, admin_salt TEXT, admin_set_at INTEGER,
      setup_token TEXT, setup_completed_at INTEGER, setup_deferred_at INTEGER,
      onboarded_at INTEGER, ephemeral_ack INTEGER, updated_at INTEGER
    );

CREATE TABLE IF NOT EXISTS knowledge_docs (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  module TEXT,
  updated_at INTEGER NOT NULL
, parent_slug TEXT);

CREATE TABLE IF NOT EXISTS li_activity (
  id          TEXT PRIMARY KEY,            -- 'lact_' + hash(urn)
  prospect_id TEXT NOT NULL,
  post_urn    TEXT NOT NULL UNIQUE,
  text        TEXT,
  posted_at   INTEGER,
  reactions   INTEGER,
  comments    INTEGER,
  is_repost   INTEGER NOT NULL DEFAULT 0,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS li_prospects (
  id             TEXT PRIMARY KEY,             -- lp_<rand>
  urn_id         TEXT UNIQUE,                  -- voyager urn id (search result; DM target)
  public_id      TEXT,                         -- profile slug (connect target; resolved lazily at send time)
  name           TEXT NOT NULL,
  role           TEXT,                         -- jobtitle from search / profile
  company        TEXT,
  circle         INTEGER,                      -- connection degree 1/2/3 (search `distance`)
  location       TEXT,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | paused | done | stalled
  step_index     INTEGER NOT NULL DEFAULT 0,   -- next ACTION step in the sequence doc
  next_action_at INTEGER,                      -- ms epoch; NULL = due now
  fail_count     INTEGER NOT NULL DEFAULT 0,   -- consecutive failures at the current step
  source_search  TEXT,                         -- the pasted search this came from
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
, sequence_json TEXT, accepted_at INTEGER, replied_at INTEGER, company_slug TEXT, company_id   TEXT, judge_json   TEXT, theme TEXT, outreach_mode TEXT NOT NULL DEFAULT 'signal', sequence_slug TEXT, sequence_step INTEGER NOT NULL DEFAULT 0, next_step_at INTEGER, headline_snapshot TEXT, signal_checked_at INTEGER);

CREATE TABLE IF NOT EXISTS li_scheduled_messages (
  id           TEXT PRIMARY KEY,            -- lsm_<rand>
  prospect_id  TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'first',  -- first | reply
  body         TEXT NOT NULL,
  send_at      INTEGER NOT NULL,            -- ms epoch; the tick sends the first due
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | canceled
  error        TEXT,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER
);

CREATE TABLE IF NOT EXISTS li_sent_messages (
  id               TEXT PRIMARY KEY,   -- stable hash of conversation_urn + at
  conversation_urn TEXT,
  recipient_urn    TEXT,
  name             TEXT,               -- participant display name (best-effort; may be null)
  body             TEXT,
  at               INTEGER,            -- ms epoch (deliveredAt)
  is_outreach      INTEGER,            -- 1 genuine outreach, 0 not, NULL = unclassified
  reason           TEXT,
  synced_at        INTEGER
);

CREATE TABLE IF NOT EXISTS li_signals (
  id          TEXT PRIMARY KEY,            -- 'lsig_' + hash
  prospect_id TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- open_role | job_change | post | news
  title       TEXT NOT NULL,
  detail      TEXT,                        -- JSON
  draft       TEXT,                        -- suggested message, operator's voice
  status      TEXT NOT NULL DEFAULT 'new', -- new | actioned | dismissed
  detected_at INTEGER NOT NULL,
  resolved_at INTEGER
, feedback TEXT, feedback_at INTEGER, feedback_used INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS li_touches (
  id          TEXT PRIMARY KEY,                -- lt_<rand>
  prospect_id TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  kind        TEXT NOT NULL,                   -- connect | message
  body        TEXT,                            -- the rendered note / message actually sent
  status      TEXT NOT NULL,                   -- sent | failed
  error       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_health (
  id         TEXT PRIMARY KEY,        -- always 'primary'
  status     TEXT NOT NULL DEFAULT 'ok',   -- ok | down
  reason     TEXT,                    -- credit | auth
  since      INTEGER,                 -- ms epoch the circuit opened
  last_error TEXT,
  last_check INTEGER,                 -- ms epoch of the last probe
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  lead_minutes INTEGER NOT NULL DEFAULT 10,
  chat_id TEXT,                            
  kinds TEXT NOT NULL DEFAULT 'meeting',   
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,           
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nyo_messages (
  id           TEXT PRIMARY KEY,        
  content      TEXT NOT NULL,           
  kind         TEXT,                    
  ref_kind     TEXT,                    
  ref_id       TEXT,                    
  payload_json TEXT,                    
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER                  
);

CREATE TABLE IF NOT EXISTS osint_listeners (
  source        TEXT PRIMARY KEY,                 
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,       
  cadence       TEXT NOT NULL DEFAULT 'manual',   
  notes         TEXT,
  last_run_at   INTEGER,
  last_status   TEXT,                             
  last_error    TEXT,
  total_runs    INTEGER NOT NULL DEFAULT 0,
  total_added   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS osint_mentions (
  id           TEXT PRIMARY KEY,        
  target_id    TEXT NOT NULL,
  source       TEXT NOT NULL,           
  source_url   TEXT,
  reviewer     TEXT,
  rating       INTEGER,                 
  text         TEXT NOT NULL,           
  posted_at    INTEGER,                 
  confidence   REAL,                    
  kind         TEXT NOT NULL DEFAULT 'mention',  
  raw_json     TEXT,                    
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS osint_signals (
  id              TEXT PRIMARY KEY,
  source_id       TEXT,
  source_name     TEXT,                       
  theme           TEXT,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,        
  summary         TEXT,
  published_at    INTEGER,
  
  relevance       INTEGER,                     
  why             TEXT,                        
  content_score   INTEGER,                     
  formats         TEXT,                        
  suggested_angle TEXT,                        
  status          TEXT NOT NULL DEFAULT 'new', 
  created_at      INTEGER NOT NULL
, full_text TEXT, content_fetched_at INTEGER);

CREATE TABLE IF NOT EXISTS osint_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,              
  name            TEXT NOT NULL,              
  url             TEXT NOT NULL,              
  theme           TEXT,                       
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  last_status     TEXT,                       
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS osint_targets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  domain       TEXT,            
  app_id       TEXT,            
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT,
  updated_by   TEXT
);

CREATE TABLE IF NOT EXISTS osint_topics (
       id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT, why_now TEXT, angle TEXT,
       format TEXT, heat INTEGER, sources_json TEXT,
       status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL );

CREATE TABLE IF NOT EXISTS outbound_log (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,                 
  kind         TEXT NOT NULL,                 
  to_id        TEXT,                          
  to_name      TEXT,                          
  body         TEXT,                          
  payload_json TEXT,                          
  status       TEXT NOT NULL,                 
  message_id   TEXT,                          
  error        TEXT,                          
  attempt      INTEGER NOT NULL DEFAULT 1,    
  parent_id    TEXT,                          
  source       TEXT,                          
  source_ref   TEXT,                          
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "outreach_cohort_members" (
  lead_id        TEXT PRIMARY KEY,               
  chat_id        TEXT,                           
  status         TEXT NOT NULL DEFAULT 'active', 
  step           INTEGER NOT NULL DEFAULT 0,     
  next_send_at   INTEGER,                        
  last_sent_at   INTEGER,
  last_sent_text TEXT,
  answered_at    INTEGER,                        
  stop_reason    TEXT,                           
  last_error     TEXT,
  enrolled_at    INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
, cohort_id TEXT, approved_at INTEGER, approved_step INTEGER, approved_step_at INTEGER, override_text TEXT, override_step INTEGER);

CREATE TABLE IF NOT EXISTS "outreach_cohorts" (
  id          TEXT PRIMARY KEY,        
  name        TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
, sequence TEXT, status TEXT NOT NULL DEFAULT 'active', timezone TEXT, send_days TEXT, languages TEXT, start_hour INTEGER, end_hour INTEGER, send_windows TEXT, daily_target INTEGER);

CREATE TABLE IF NOT EXISTS outreach_conversation_state (
  lead_id     TEXT PRIMARY KEY,
  dead_at     INTEGER,                           
  dead_reason TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outreach_threads (
  key               TEXT PRIMARY KEY,   -- wa chat_id | li conversation_urn
  channel           TEXT NOT NULL,      -- 'whatsapp' | 'linkedin'
  name              TEXT,
  replied           INTEGER DEFAULT 0,  -- 1 = they sent at least one inbound after our first outreach
  uncaught          INTEGER DEFAULT 0,  -- 1 = they replied and the LATEST message is theirs (you haven't responded)
  msgs_in           INTEGER DEFAULT 0,
  msgs_out          INTEGER DEFAULT 0,
  last_inbound_text TEXT,
  last_inbound_at   INTEGER,
  sentiment         TEXT,               -- 'positive' | 'neutral' | 'negative' | NULL
  sentiment_reason  TEXT,
  sentiment_at      INTEGER,            -- last_inbound_at the sentiment was scored for (dedupe)
  updated_at        INTEGER
);

CREATE TABLE IF NOT EXISTS plugin_web_headline_log (id TEXT PRIMARY KEY, url TEXT, title TEXT, at INTEGER);

CREATE TABLE IF NOT EXISTS plugins (
  name          TEXT PRIMARY KEY,   -- kebab-case install namespace
  version       TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,      -- imported|bound|materialized|active|blocked|removed
  manifest_json TEXT NOT NULL,
  binding_json  TEXT,               -- gateway binding decisions, verbatim
  report_json   TEXT,               -- last step's report (errors when blocked)
  installed_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  bubbles       TEXT NOT NULL,             -- JSON array of message strings
  content_hash  TEXT NOT NULL,             -- normalized hash of bubbles
  send_at       INTEGER NOT NULL,          -- ms epoch
  status        TEXT NOT NULL DEFAULT 'scheduled',
                -- scheduled | claimed | sent | partial | failed | cancelled
  claim_token   TEXT,
  claimed_at    INTEGER,
  sent_at       INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cookie_id TEXT,
  person_id TEXT,
  ip TEXT,
  ua TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  fbclid TEXT,
  msclkid TEXT,
  ttclid TEXT,
  browser TEXT,
  os TEXT,
  device TEXT,
  referrer TEXT,
  landing_path TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_snoozes (
  key        TEXT PRIMARY KEY,
  until      INTEGER NOT NULL,   -- ms epoch; past = expired, no cleanup needed
  label      TEXT,               -- who this is, for the UI/log
  reason     TEXT,
  created_at INTEGER NOT NULL
, engaged_count INTEGER NOT NULL DEFAULT 0, last_engaged_at INTEGER);

CREATE TABLE IF NOT EXISTS social_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT,                
  template    TEXT NOT NULL,       
  url         TEXT NOT NULL,       
  r2_key      TEXT NOT NULL,
  slots_json  TEXT,                
  width       INTEGER,
  height      INTEGER,
  actor       TEXT,                
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS social_posts (
  id          TEXT PRIMARY KEY,
  blog_slug   TEXT NOT NULL,
  channel     TEXT NOT NULL,                 
  status      TEXT NOT NULL DEFAULT 'draft', 
  content     TEXT NOT NULL,
  image_url   TEXT,
  error       TEXT,
  outbox_id   TEXT,                          
  posted_at   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
, blog_title TEXT);

CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  day        TEXT NOT NULL,                         -- YYYY-MM-DD
  title      TEXT NOT NULL,
  detail     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',       -- pending | doing | done | drafted | skipped
  ord        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_chats (
  id TEXT PRIMARY KEY,                
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  auto_listen INTEGER NOT NULL DEFAULT 0,   
  can_send INTEGER NOT NULL DEFAULT 0,      
  last_message_at INTEGER,
  last_snippet TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_lid_map (
  lid         TEXT PRIMARY KEY,          -- '<digits>@lid'
  phone       TEXT,                      -- E.164 ('+972...') or NULL when WhatsApp won't share
  pn          TEXT,                      -- raw '<digits>@c.us' wid from the gateway
  resolved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,                
  chat_id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  sender_id TEXT,                     
  sender_name TEXT,
  body TEXT,
  timestamp INTEGER NOT NULL,         
  raw_json TEXT,                      
  person_id TEXT,                     
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_outreach_class (
  msg_id        TEXT PRIMARY KEY,     -- wa_messages.id
  chat_id       TEXT,
  is_outreach   INTEGER NOT NULL,     -- 1 = genuine outreach pitch, 0 = not
  reason        TEXT,                 -- short model rationale (for auditing)
  classified_at INTEGER
);

CREATE TABLE IF NOT EXISTS wa_send_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lane       TEXT NOT NULL DEFAULT 'main',   -- 'ops' = to the operator himself (no pacing window) | 'main' = lead-facing, paced
  burst_key  TEXT,                           -- rows sharing it are one multi-bubble send: served back-to-back with short gaps
  chat_id    TEXT NOT NULL,                  -- '<digits>@c.us' (phone-backed chats only; groups/@lid are rejected at enqueue)
  phone      TEXT NOT NULL,                  -- bare digits for the extension's /send URL
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'approved', -- approved | leased | sent | failed | cancelled
  outbox_id  TEXT,                           -- outbound_log row opened at enqueue, settled on report
  source     TEXT,                           -- who asked: gtm-outreach | gtm-watch | meeting-reminder | digest | nyo | wa-test | retry...
  source_ref TEXT,
  error      TEXT,
  leased_at  TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, not_before TEXT, sender_id TEXT);

CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  cookie_id  TEXT,
  person_id  TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT,
  page_path  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_objectives (week_start TEXT PRIMARY KEY, objectives TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY,                 
  workflow_slug   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',  
  trigger_kind    TEXT,
  trigger_payload TEXT,                             
  output          TEXT,                             
  error           TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id            TEXT PRIMARY KEY,                   
  run_id        TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  step_name     TEXT,
  step_type     TEXT,                               
  input         TEXT,                               
  output        TEXT,                               
  status        TEXT NOT NULL DEFAULT 'running',
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS workflows (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  trigger      TEXT NOT NULL,                       
  steps        TEXT NOT NULL,                       
  source       TEXT NOT NULL DEFAULT 'nyo',         
  status       TEXT NOT NULL DEFAULT 'active',      
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT,
  updated_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_aeo_feedback_created ON aeo_feedback(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aeo_feedback_slug    ON aeo_feedback(question_slug);

CREATE INDEX IF NOT EXISTS idx_aeo_questions_priority   ON aeo_questions(priority);

CREATE INDEX IF NOT EXISTS idx_aeo_questions_status     ON aeo_questions(status);

CREATE INDEX IF NOT EXISTS idx_aeo_questions_updated_at ON aeo_questions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_aeo_suggestions_created ON aeo_suggestions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aeo_suggestions_status  ON aeo_suggestions(status);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published    ON blog_posts(published);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_brain_status ON brain_sessions(status);

CREATE INDEX IF NOT EXISTS idx_brain_week   ON brain_sessions(week_of DESC);

CREATE INDEX IF NOT EXISTS idx_calendar_events_kind       ON calendar_events(kind);

CREATE INDEX IF NOT EXISTS idx_calendar_events_source     ON calendar_events(source);

CREATE INDEX IF NOT EXISTS idx_calendar_events_starts_at  ON calendar_events(starts_at);

CREATE INDEX IF NOT EXISTS idx_calendar_events_status     ON calendar_events(status);

CREATE INDEX IF NOT EXISTS idx_clients_name       ON clients(name);

CREATE INDEX IF NOT EXISTS idx_clients_starred    ON clients(starred);

CREATE INDEX IF NOT EXISTS idx_clients_status     ON clients(status);

CREATE INDEX IF NOT EXISTS idx_clients_updated_at ON clients(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cohort_members_approval
  ON outreach_cohort_members (status, next_send_at, approved_step);

CREATE INDEX IF NOT EXISTS idx_cohort_members_cohort ON outreach_cohort_members (cohort_id, status);

CREATE INDEX IF NOT EXISTS idx_cohorts_status ON outreach_cohorts (status);

CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(client_id);

CREATE INDEX IF NOT EXISTS idx_contacts_email       ON contacts(email);

CREATE INDEX IF NOT EXISTS idx_contacts_identity    ON contacts(identity_id);

CREATE INDEX IF NOT EXISTS idx_contacts_linkedin ON contacts(linkedin_url);

CREATE INDEX IF NOT EXISTS idx_contacts_owner       ON contacts(owner);

CREATE INDEX IF NOT EXISTS idx_contacts_phone       ON contacts(phone);

CREATE INDEX IF NOT EXISTS idx_contacts_source      ON contacts(source);

CREATE INDEX IF NOT EXISTS idx_contacts_starred     ON contacts(starred);

CREATE INDEX IF NOT EXISTS idx_contacts_status      ON contacts(status);

CREATE INDEX IF NOT EXISTS idx_contacts_updated_at  ON contacts(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_blocks_page    ON content_blocks(page);

CREATE INDEX IF NOT EXISTS idx_content_blocks_section ON content_blocks(section);

CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations (agent, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

CREATE INDEX IF NOT EXISTS idx_conversions_created  ON conversions(created_at);

CREATE INDEX IF NOT EXISTS idx_conversions_identity ON conversions(identity_id);

CREATE INDEX IF NOT EXISTS idx_conversions_kind     ON conversions(kind);

CREATE INDEX IF NOT EXISTS idx_daily_plans_updated ON daily_plans (updated_at);

CREATE INDEX IF NOT EXISTS idx_digest_items_created   ON digest_items(created_at);

CREATE INDEX IF NOT EXISTS idx_digest_items_kind      ON digest_items(kind);

CREATE INDEX IF NOT EXISTS idx_digest_items_read      ON digest_items(read_at);

CREATE INDEX IF NOT EXISTS idx_digest_items_urgency   ON digest_items(urgency);

CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE INDEX IF NOT EXISTS idx_events_kind    ON events(kind);

CREATE INDEX IF NOT EXISTS idx_feature_flags_scope ON feature_flags(scope);

CREATE INDEX IF NOT EXISTS idx_finance_entries_ym ON finance_entries(year, month, position);

CREATE INDEX IF NOT EXISTS idx_gtm_leads_batch  ON gtm_leads(batch_id);

CREATE INDEX IF NOT EXISTS idx_gtm_leads_phone  ON gtm_leads(normalized_phone);

CREATE INDEX IF NOT EXISTS idx_gtm_leads_status ON gtm_leads(status);

CREATE INDEX IF NOT EXISTS idx_gtm_org_people_lead ON gtm_org_people(lead_id);

CREATE INDEX IF NOT EXISTS idx_gtm_sends_lead ON gtm_sends(lead_id);

CREATE INDEX IF NOT EXISTS idx_gtm_signals_lead   ON gtm_signals (lead_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_gtm_signals_status ON gtm_signals (status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_home_sections_page_pos ON home_sections(page, position);

CREATE INDEX IF NOT EXISTS idx_hot_take_packages_origin  ON hot_take_packages (origin_ref);

CREATE INDEX IF NOT EXISTS idx_hot_take_packages_pinned  ON hot_take_packages (pinned);

CREATE INDEX IF NOT EXISTS idx_hot_take_packages_slug    ON hot_take_packages (blog_slug);

CREATE INDEX IF NOT EXISTS idx_hot_take_packages_status  ON hot_take_packages (status);

CREATE INDEX IF NOT EXISTS idx_hot_take_packages_updated ON hot_take_packages (updated_at);

CREATE INDEX IF NOT EXISTS idx_hot_take_posts_package ON hot_take_posts (package_id);

CREATE INDEX IF NOT EXISTS idx_hot_take_posts_sched   ON hot_take_posts (scheduled_at);

CREATE INDEX IF NOT EXISTS idx_hot_take_posts_status  ON hot_take_posts (status);

CREATE INDEX IF NOT EXISTS idx_identities_channel ON identities(channel);

CREATE INDEX IF NOT EXISTS idx_identities_cookie  ON identities(cookie_id);

CREATE INDEX IF NOT EXISTS idx_identities_email   ON identities(email);

CREATE INDEX IF NOT EXISTS idx_identities_handle  ON identities(handle);

CREATE INDEX IF NOT EXISTS idx_identity_links_cookie ON identity_links(cookie_id);

CREATE INDEX IF NOT EXISTS idx_identity_links_person ON identity_links(person_id);

CREATE INDEX IF NOT EXISTS idx_identity_links_type   ON identity_links(identifier_type);

CREATE INDEX IF NOT EXISTS idx_identity_links_value  ON identity_links(identifier_value);

CREATE INDEX IF NOT EXISTS idx_knowledge_module ON knowledge_docs(module);

CREATE INDEX IF NOT EXISTS idx_knowledge_parent ON knowledge_docs(parent_slug);

CREATE INDEX IF NOT EXISTS idx_knowledge_scope  ON knowledge_docs(scope);

CREATE INDEX IF NOT EXISTS idx_li_activity_prospect ON li_activity (prospect_id, posted_at DESC);

CREATE INDEX IF NOT EXISTS idx_li_prospects_due    ON li_prospects (status, next_action_at);

CREATE INDEX IF NOT EXISTS idx_li_prospects_status ON li_prospects (status);

CREATE INDEX IF NOT EXISTS idx_li_sched_due ON li_scheduled_messages (status, send_at);

CREATE INDEX IF NOT EXISTS idx_li_sent_messages_at ON li_sent_messages (at);

CREATE INDEX IF NOT EXISTS idx_li_sent_messages_outreach ON li_sent_messages (is_outreach, at);

CREATE INDEX IF NOT EXISTS idx_li_signals_prospect ON li_signals (prospect_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_li_signals_status   ON li_signals (status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_li_touches_day      ON li_touches (status, kind, created_at);

CREATE INDEX IF NOT EXISTS idx_li_touches_prospect ON li_touches (prospect_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_created     ON messages(created_at);

CREATE INDEX IF NOT EXISTS idx_nyo_messages_created ON nyo_messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nyo_messages_pending ON nyo_messages(delivered_at);

CREATE INDEX IF NOT EXISTS idx_osint_mentions_posted_at ON osint_mentions(posted_at);

CREATE INDEX IF NOT EXISTS idx_osint_mentions_source    ON osint_mentions(source);

CREATE INDEX IF NOT EXISTS idx_osint_mentions_target    ON osint_mentions(target_id);

CREATE INDEX IF NOT EXISTS idx_osint_signals_published ON osint_signals(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_osint_signals_score     ON osint_signals(content_score DESC);

CREATE INDEX IF NOT EXISTS idx_osint_signals_status    ON osint_signals(status);

CREATE INDEX IF NOT EXISTS idx_osint_sources_enabled ON osint_sources(enabled);

CREATE INDEX IF NOT EXISTS idx_osint_targets_domain ON osint_targets(domain);

CREATE INDEX IF NOT EXISTS idx_osint_targets_name   ON osint_targets(name);

CREATE INDEX IF NOT EXISTS idx_osint_topics_heat ON osint_topics(heat DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_channel  ON outbound_log(channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_created  ON outbound_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_parent   ON outbound_log(parent_id);

CREATE INDEX IF NOT EXISTS idx_outbox_source   ON outbound_log(source, source_ref);

CREATE INDEX IF NOT EXISTS idx_outbox_status   ON outbound_log(status);

CREATE INDEX IF NOT EXISTS idx_outreach_queue_due    ON "outreach_cohort_members" (status, next_send_at);

CREATE INDEX IF NOT EXISTS idx_outreach_queue_queue ON "outreach_cohort_members" (cohort_id, status);

CREATE INDEX IF NOT EXISTS idx_outreach_queue_status ON "outreach_cohort_members" (status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_queues_name ON "outreach_cohorts" (name);

CREATE INDEX IF NOT EXISTS idx_outreach_threads_uncaught ON outreach_threads (uncaught, updated_at);

CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status);

CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_sends (status, send_at);

CREATE INDEX IF NOT EXISTS idx_sched_lead ON scheduled_sends (lead_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_live_dup
  ON scheduled_sends (lead_id, content_hash)
  WHERE status IN ('scheduled', 'claimed');

CREATE INDEX IF NOT EXISTS idx_sessions_cookie  ON sessions(cookie_id);

CREATE INDEX IF NOT EXISTS idx_sessions_gclid   ON sessions(gclid);

CREATE INDEX IF NOT EXISTS idx_sessions_person  ON sessions(person_id);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE INDEX IF NOT EXISTS idx_signal_snoozes_until ON signal_snoozes(until);

CREATE INDEX IF NOT EXISTS idx_social_cards_slug ON social_cards(slug);

CREATE INDEX IF NOT EXISTS idx_social_posts_slug   ON social_posts(blog_slug);

CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);

CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day);

CREATE INDEX IF NOT EXISTS idx_wa_chats_auto_listen ON wa_chats(auto_listen);

CREATE INDEX IF NOT EXISTS idx_wa_chats_last_msg    ON wa_chats(last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_wa_messages_chat      ON wa_messages(chat_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_wa_messages_person    ON wa_messages(person_id);

CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp ON wa_messages(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_wa_outreach_class_chat ON wa_outreach_class (chat_id, is_outreach);

CREATE INDEX IF NOT EXISTS idx_wa_send_queue_sender ON wa_send_queue (status, sender_id, id);

CREATE INDEX IF NOT EXISTS idx_wa_send_queue_sent ON wa_send_queue (status, sent_at);

CREATE INDEX IF NOT EXISTS idx_wa_send_queue_status ON wa_send_queue (status, lane, id);

CREATE INDEX IF NOT EXISTS idx_web_events_cookie  ON web_events(cookie_id);

CREATE INDEX IF NOT EXISTS idx_web_events_created ON web_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_events_person  ON web_events(person_id);

CREATE INDEX IF NOT EXISTS idx_web_events_session ON web_events(session_id);

CREATE INDEX IF NOT EXISTS idx_web_events_type    ON web_events(event_type);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_slug       ON workflow_runs(workflow_slug);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at ON workflow_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status     ON workflow_runs(status);

CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_run ON workflow_step_runs(run_id);

CREATE INDEX IF NOT EXISTS idx_workflows_source ON workflows(source);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_events_source_ref
  ON calendar_events(source, source_ref)
  WHERE source_ref IS NOT NULL;
