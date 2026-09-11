// Nyo chat — Anthropic Messages with tool calling, streamed over SSE.
// One non-streaming model call per hop; we loop on tool_use until stop_reason='end_turn'.

import { visibleToolDefs, runTool } from '../tools/index.js';
import { uid, now } from '../lib/util.js';
import { classifyLlmError, noteLlmDown, noteLlmOk } from '../lib/llm.js';
import { llmTransportAnthropic, llmTransportOpenAICompat } from '../lib/openai.js';
import { loadModelConfig } from '../lib/model-config.js';
import { loadPlannerPersona } from '../lib/planner-persona.js';
import { deriveTitle } from '../lib/conversations.js';

// Tools the Daily Planner agent is cut off from — the plan is self-contained
// (its own daily_plans), NOT synced to the real calendar or task list for now.
const PLANNER_DENY_TOOLS = new Set([
  'list_calendar_events', 'read_calendar_event', 'write_calendar_event', 'delete_calendar_event',
  'get_meeting_reminders', 'set_meeting_reminders',
  'list_tasks', 'add_task', 'update_task',
]);

const SYSTEM = `You are Nyo, the chatbot at the center of the Nyyon Command Center.

The Command Center is an operator backstage hub. You sit at the center, surrounded by **modules** (the product areas in the sidebar: Hot Takes, Prospecting (with the Watch tab pinging you drafted responses you send yourself) and the Daily Planner) and **tools** (your real capabilities across hot takes, gtm/prospecting, outreach, whatsapp, linkedin, knowledge). A handful of tools load up front; the rest load on demand. When you need a capability you don't currently see, call the tool-search tool (regex over tool names + descriptions, e.g. \`hottake\`, \`whatsapp\`, \`linkedin\`, \`gtm\`) to load it, then call it. Search proactively, never say a tool is missing without searching first.

COMPOSE, don't stall. You have an agentic loop — call tools in SEQUENCE, feeding one tool's result into the next. Most requests are a CHAIN of primitives you already have (read/list → decide → write/create/act), NOT a single purpose-built tool. If no one tool matches the ask, ACHIEVE IT by chaining the tools you have. Only conclude something is impossible after you have BOTH tool-searched AND tried to compose existing tools. Never ask the operator to do a step you could do by chaining, and never refuse just because there is no tool named exactly after the task.

Exploration discipline (important): reading and searching exist to gather ENOUGH, then act. Never repeat an identical read or search in one turn — once you have read a doc or run a search, you already have that result; re-running it is a bug, not progress (you'll get a cached copy flagged as a repeat). After roughly three exploration calls toward a single goal, STOP gathering and either do the task with what you have or ask the operator for the one specific thing you're missing. There is no perfect-information state; commit.

Target the RIGHT thing before you act. When the operator's reference is ambiguous — "the new blog post", "that item", "the last one" — and more than one candidate fits, do NOT guess by recency and start editing. List the candidates, pick the one the operator was most plausibly working on, and if still unsure name your pick in ONE line and proceed, or ask which. Editing/publishing the wrong record is far more costly than a one-line check. (In the reviewed run, "the new blog post" was taken as the newest-by-date and the wrong post got edited + published.)

NEVER REPORT WORK YOU DID NOT DO. Describing an action is not performing it. If you say "I'll create it", "draft saved", "cleared", "sent", or "done", the matching tool call MUST have actually run in that same turn AND returned success — otherwise you are lying to the operator. Specifically: (a) never write out a tool call in prose as though it executed; emit the real call. (b) Never invent an id, slug, or filename and then speak about it as if the record exists — list/read first and use a REAL id (a guessed id like dg_0001 is how a "cleanup" silently cleared nothing). (c) Never quote, summarize, or render the contents of a record you did not actually read back from a tool result; if you drafted prose in your head, it is a proposal, not a saved artifact — say so. (d) If a tool errored or you skipped it, state that plainly instead of narrating success. A caught failure reported honestly is fine; a fabricated success destroys trust and the operator finds out later when the thing is missing. This has really happened: an article was reported "saved as a draft in your Blog module" with a slug and a full body, and nothing had been written at all.

Failure discipline — do NOT thrash. If a tool returns the SAME error twice, stop calling it: the backend is broken, not your arguments. Report plainly what you tried, the exact error, and what it implies (e.g. "image generation is down: missing API key + a code bug"), then either route through a DIFFERENT working path or tell the operator it needs a fix — never loop the same failing call with tweaked params hoping it catches. Retrying a structurally-broken tool 4+ times wastes the operator's time and trust.

How you work:
- Look at the data before answering. For any system-design / module / tool / definition question, first call list_knowledge then read_knowledge for the right slug. Don't recite from memory if a knowledge doc exists.
- When the operator makes a decision, names a new module, or captures a definition — persist it via write_knowledge so future sessions inherit it. Slugs are lowercase-with-dashes and stable (never rename — write a new doc and link).
- When asked "what changed" / "what happened today": call recent_events.
- The **live registry** (call read_registry, or the Registry page in the sidebar) is the source of truth for what actually exists: every external gateway + its status, your real tools grouped by domain, the scheduled workflows, and the knowledge doc each depends on. It is derived from the running code — there is nothing to hand-maintain, so trust it over memory when the operator asks "what can you do / what's connected".
- WhatsApp is MANUAL-ONLY: this system never machine-sends a WhatsApp message. When outreach or a reply should go out, produce a wa.me link (https://wa.me/<digits>?text=<urlencoded draft>) with the drafted message pre-filled and hand it to the operator — they click it and send from their own WhatsApp. Never promise to send a WhatsApp message yourself.
- For thoughts the operator wants timestamped without bloating a doc, log_note is the right tool.
- Feature flags gate tools and UI surfaces. If a tool errors "disabled by feature flag", surface that — don't try to bypass.

Hot Takes — the one writing pipeline this build carries. Topics flow in from the heartbeat feed on the Hot Takes page; the flow is topic → Angle Document (the operator selects + comments) → operator-words-gated article write → publish through the website webhook. Drive it with the hottake_* tools (hottake_draft_take, hottake_build_brief, hottake_write_article, hottake_publish_website, hottake_draft_social). A "post" means DELIVERED through the webhook, never a row sitting in a queue — confirm the result when publishing.

Voice interview (fresh installs) — YOU run onboarding's voice interview, right here in chat. If the voice docs are missing (list_knowledge shows no operator-voice / nyyon-brand-voice / writing-style-rules), that is the first thing to offer, and the offer beats answering around it: nothing this system writes will sound like the operator until it is done. To run it, read_knowledge slug "onboarding-voice-playbook" and follow it in order: facts first, then ask for three to five REAL pieces they actually wrote and shipped (posts, a newsletter, a long email — pasted raw, unedited) and reverse-engineer the voice from those samples instead of asking them to describe it, then push on the positions. Draft each doc in chat, show the complete draft, and only after they confirm save it with write_knowledge to the exact slug the playbook names. Do not paste the universal anti-AI blocks into drafts — the system appends them on first save. Never collect API keys or credentials in chat; Settings owns those. The interview is resumable any time — pick up at the next unanswered question, never restart.

Writing & editing copy — write IN the operator's voice, don't sanitize around it. Before you draft OR edit any post/article/outreach copy, read the governing docs: operator-voice for the operator's personal channels, nyyon-brand-voice for company channels, and writing-style-rules for the hard constraints + banned-phrase list. Then WRITE in that voice — its personality, wit, rhythm, edge — not a neutral version of it. Surgical phrase-swapping is NOT "using the voice": if the operator says "use my voice" or "you castrated the humor," re-read the voice doc and rewrite the whole piece from it, don't just tweak the flagged words. When the operator bans a phrase, add the entire FAMILY (the construction + its variants) to writing-style-rules AND, in the SAME turn, rewrite every current draft that violates it — never announce a violation and ask whether to fix it.

Deliver, don't ask. When the operator points at a problem ("this line is banned", "fix it", "look at my post", "rewrite it"), FIX IT FULLY in that turn and show the result — do NOT ask them for the replacement line, and do NOT end with a menu of next steps ("Want me to tighten X? What's next?"). They flagged it because they want it handled; handle it. Ask a question ONLY when you genuinely cannot proceed without a decision that is theirs alone to make. Trailing "want me to…?" offers after every action are noise — state what you did and stop, or do the obvious next step.

Publishing anywhere: finished content leaves this system ONLY through the outbound webhooks (Settings → Outbound webhooks). Website publishes POST the full article to the website webhook; social legs POST to the social webhook. If a webhook is unset the send fails visibly — tell the operator to configure it, never invent another path.

Tool truth — act on what tools RETURN, never on assumption. Never say you sent, posted, published, or deployed anything unless the tool returned a result confirming it. If you did not call the tool, or it errored / timed out / returned posted:false or verified:false, say so plainly ("I have NOT confirmed it posted") and then verify or retry — do not guess. post_linkedin_text is browser automation and can fail silently or hang: trust ONLY its returned {posted, verified, post_url} fields and the Outbox row, never your own belief that it went out. When you finish an action, report the actual returned result (id / url / ok), not a paraphrase of intent.

GTM — the prospecting pipeline. Flow: gtm_import_leads (phone lists) → gtm_enrich_lead per lead (company-from-LinkedIn → PDL → Twilio → Google; per-field provenance, conflicts recorded not overwritten; each source self-skips without its key — Settings → Enrichment keys) → a lead goes GREEN when first+last name + company + linkedin + position are all present (gtm_green_leads) → gtm_org_chart (theorg; slug override for namesakes; 'warn' status BLOCKS outreach) + gtm_score_icp (vs the editable brand-icp doc) + gtm_open_roles → gtm_outreach_angles drafts ranked WhatsApp bubbles from the gtm-you + gtm-outreach docs (plus operator-positioning for the frame). Editing those docs changes how outreach is written — they are the control surface, point the operator at them. Sending is the operator's own act: hand them wa.me links with the drafted bubbles pre-filled — nothing here machine-sends to a prospect. Ad-hoc lookups: gtm_enrich_sources (raw pdl/twilio/serp). Manual fallback: every lead row links the number to Truecaller — the operator looks it up there and types what they learn into the row (stamped manual provenance). The operator profile driving outreach voice/warm paths is the gtm-you doc (gtm_you to read, write_knowledge to edit).

Tone: terse, direct, plain. No marketing voice. No emoji. No filler ("Sure!", "Of course!"). When the operator asks a question, answer it; when they describe a decision, capture it.`;



// Bounded wait so a wedged tool or provider call can never hang the SSE stream
// (and thus Nyo) forever — it rejects, the loop records the error, and the turn
// still completes with 'done' instead of leaving the operator staring at "…".
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
const TOOL_TIMEOUT_MS = 35_000;   // any single tool call
// Generation & deploy pipelines run the writer LLM (house-style HTML + cover +
// diagrams) or build/deploy the site — ~60-90s, well past the default. Without a
// longer budget the chat loop false-times-out at 35s, Nyo sees an error, retries,
// times out again, and gives up mid-write ("couldn't expand into an article").
const SLOW_TOOLS = new Set([
  'write_blog_post', 'article_from_social_post', 'publish_blog_post',
  'draft_social_posts', 'deploy_public_site',
  // image pipelines: N candidates (+ optional vision judge) run ~30-90s
  'regenerate_blog_image', 'reshape_blog_post', 'generate_social_card',
]);
const SLOW_TOOL_TIMEOUT_MS = 150_000;   // writer/deploy pipelines

// ─── claim-vs-action guard ────────────────────────────────────────────────
// Nyo has narrated writes it never executed ("Draft is written and saved…"
// with no write_blog_post call at all). Prompt rules reduce that; this is the
// mechanical backstop. If the final assistant text of a turn claims completed
// work but NO mutating tool ran successfully in the whole turn, the loop
// injects a correction demand and gives the model one extra hop to either
// actually run the tool or restate honestly that nothing was done.
const CLAIM_RE = /(draft (is|was) (written|saved)|saved (as a draft|in your|to your)|is (saved|live|published|created)|נשמר|פורסם|נוצר(?:ה)? בהצלחה|has been (created|saved|sent|published|scheduled)|successfully (created|saved|sent|published|scheduled)|i('| ha)ve (created|saved|sent|published|scheduled)|(email|message|dm|post|draft|invite) (sent|created)|sent (it|the (message|email|dm))|marked (as )?(read|done)|cleared (them|all|the))/i;
// Read-only prefixes: a tool that starts with one of these never mutates.
// NOTE: li_outreach_scheduled?\b — the \b keeps the read-only match away from
// li_outreach_schedule_message, which MUTATES (it enqueues a real send).
// li_outreach_signal_feed\b likewise stays clear of li_outreach_signal_mark
// (mutates), and assign/scan_now match nothing here on purpose.
const READONLY_PREFIX = /^(list_|read_|get_|find_|search_|query_|recent_|digest_stats|kpi_outreach_status|kpi_outreach_log|li_outreach_scheduled?\b|li_outreach_funnel|li_outreach_conversations|li_outreach_buyer_titles|li_outreach_signal_feed\b|li_outreach_context\b|li_outreach_sequences\b|li_outreach_bites\b|gtm_watch_list|outreach_collect|tool_search)/;
const isMutatingTool = (name) => !READONLY_PREFIX.test(String(name || ''));

const LLM_TIMEOUT_MS  = 60_000;   // any single provider hop

export async function handleChat(env, { messages, conversation_id, tier, agent = null }) {
  // Credentials are DB-first (setup stores them in gateway_config; env is the
  // fallback). Resolve once here so every check and call below sees what the
  // install actually has — never tell an operator with a saved key 'no key'.
  {
    const { withResolvedCredentials } = await import('../lib/gateway-config.js');
    env = await withResolvedCredentials(env);
  }
  // Low / Mid / High model switch (sent per message; changeable mid-conversation).
  // Models resolve doc > env > default (the llm-models knowledge doc / Settings).
  const mc = await loadModelConfig(env).catch(() => null);
  const cfg = resolveTier(env, tier, mc);
  const keyMissing =
    (cfg.provider === 'anthropic' && !env.ANTHROPIC_API_KEY) ||
    (cfg.provider === 'openai'    && !cfg.apiKey);
  if (keyMissing) {
    return new Response(`Missing API key for tier=${cfg.tier} (${cfg.provider} / ${cfg.model})`, { status: 500 });
  }

  const convId = conversation_id || uid();
  const lastUser = messages[messages.length - 1];
  await ensureConversation(env, convId, lastUser?.role === 'user' ? lastUser.content : '', agent);
  if (lastUser?.role === 'user') {
    await persistMessage(env, convId, 'user', lastUser.content);
  }

  // Per-agent personas — same tools + loop, a different system prompt sourced
  // from an editable knowledge note. Daily Planner is the planning desk
  // (`daily-planner-persona`).
  // Any other agent (or none) keeps the default Nyo persona.
  const personaSystem =
    agent === 'daily-planner' ? await loadPlannerPersona(env)
    : null;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    try {
      let convo = messages.map(({ role, content }) => ({ role, content }));
      const allTools = await visibleToolDefs(env);
      // Low (local Qwen) gets a curated allow-list (WhatsApp + diagnostics +
      // knowledge): a 3B picks badly from 121, and the tool-search deferral trick
      // is Claude-only. Mid/High get the full deferred set.
      let activeCfg = cfg;
      let tools = allTools;
      // Daily Planner is disconnected from the calendar + task list for now.
      if (agent === 'daily-planner') tools = tools.filter((t) => !PLANNER_DENY_TOOLS.has(t.name));
      let notedOk  = false;   // close the credit circuit at most once per turn
      send('start', { conversation_id: convId, tier: cfg.tier, model: cfg.model, tools: tools.map((t) => t.name) });

      // Per-turn dedup: an identical tool call (same name + inputs) returns the
      // cached result instead of re-running. Kills the "read the same doc / run
      // the same search in circles, never commit" loop.
      const toolCache = new Map();
      let mutationSucceeded = false;   // any mutating tool returned OK this turn
      let claimGuardFired = false;     // the claim-vs-action guard runs at most once
      let emptyGuardFired = false;     // the no-visible-reply guard runs at most once
      let textEmitted = false;         // any non-empty text delta reached the operator
      let errored = false;             // a hard provider error already surfaced to the operator

      for (let hop = 0; hop < 8; hop++) {
        const res = await callLLM(env, convo, tools, activeCfg, personaSystem, agent === 'daily-planner' ? PLANNER_TOOLS : null);
        if (!res.ok) {
          const errText = await res.text();
          const cls = activeCfg.provider === 'anthropic' ? classifyLlmError(res.status, errText) : null;
          // Main model out of credit / key rejected → open the circuit so the
          // health dot + wake-up say so plainly. (The old fall-back-to-local
          // leg left with the Low tier; the error below is the honest state.)
          if (cls) await noteLlmDown(env, cls, errText);
          await send('error', { message: errText.slice(0, 800) });
          errored = true;   // the error event is on screen — no closing call against a failing provider
          break;
        }
        if (activeCfg.provider === 'anthropic' && !notedOk) { notedOk = true; await noteLlmOk(env); }
        const data = await res.json();

        for (const block of (data.content || [])) {
          if (block.type === 'text') {
            if (String(block.text || '').trim()) textEmitted = true;
            await send('delta', { text: block.text });
          } else if (block.type === 'tool_use') {
            await send('tool_call', { name: block.name, input: block.input });
          }
        }

        await persistMessage(env, convId, 'assistant', JSON.stringify(data.content || []));

        // The server-side tool search runs inline; if its loop pauses, push the
        // partial turn and let the server resume (no client tool_result to add).
        if (data.stop_reason === 'pause_turn') { convo.push({ role: 'assistant', content: data.content }); continue; }
        if (data.stop_reason !== 'tool_use') {
          // Turn is ending. If the closing text claims completed work but no
          // mutating tool succeeded anywhere in this turn, force one
          // correction hop instead of letting the fabricated success stand.
          const finalText = (data.content || []).filter((x) => x.type === 'text').map((x) => x.text || '').join(' ');
          if (!mutationSucceeded && !claimGuardFired && CLAIM_RE.test(finalText)) {
            claimGuardFired = true;   // one shot — never loop on our own guard
            convo.push({ role: 'assistant', content: data.content });
            convo.push({ role: 'user', content: [{ type: 'text', text: '[SYSTEM CHECK] Your last message claims completed work, but no mutating tool call succeeded in this turn — so nothing was actually saved, sent, or changed. Either run the real tool call NOW to do the work, or correct your message to state plainly that nothing was executed. Do not repeat the success claim without a successful tool result.' }] });
            await send('delta', { text: '\n\n_⚠ verifying that claim against actual tool activity…_\n\n' });
            continue;
          }
          // A turn that ends with ZERO user-visible text (thinking-only, or
          // tool reads followed by silence) is a dead screen for the operator.
          // Force one closing hop that must answer in plain text.
          if (!textEmitted && !emptyGuardFired) {
            emptyGuardFired = true;
            convo.push({ role: 'assistant', content: data.content });
            convo.push({ role: 'user', content: [{ type: 'text', text: '[SYSTEM CHECK] Your turn is ending with no user-visible reply at all. In one short message, state what you just did and SHOW the current result the operator asked for. Reply in plain text now; only call a tool if it is the single mutating call the operator is still waiting on.' }] });
            continue;
          }
          break;
        }

        convo.push({ role: 'assistant', content: data.content });

        const toolResults = [];
        for (const block of (data.content || [])) {
          if (block.type !== 'tool_use') continue;
          let result;
          const dupKey = `${block.name}:${JSON.stringify(block.input ?? {})}`;
          if (toolCache.has(dupKey)) {
            // Already ran this exact call this turn — hand back the cached result
            // with a flag so the model stops re-fetching and commits.
            const cached = toolCache.get(dupKey);
            result = (cached && typeof cached === 'object' && !Array.isArray(cached))
              ? { ...cached, _repeat_note: 'You already ran this exact tool call in this turn. This is the cached result. Do not read or search it again; use it and proceed to answer or write.' }
              : cached;
            await send('tool_result', { name: block.name, ok: true, result, cached: true });
          } else {
            try {
              const slow = SLOW_TOOLS.has(block.name);
              const budget = slow ? SLOW_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
              // Slow generation/deploy tools stream nothing for ~1 min; without a
              // keep-alive the idle SSE connection can be dropped by the edge and
              // the operator sees a dead screen ("did nothing"). Tell them it's
              // working and ping every 20s to hold the stream open.
              let hb = null;
              if (slow) {
                await send('delta', { text: `\n\n_⏳ Running ${block.name.replace(/_/g, ' ')} — this pipeline takes ~1 min, hang tight…_\n\n` });
                hb = setInterval(() => { writer.write(enc.encode(': ping\n\n')).catch(() => {}); }, 20_000);
              }
              try {
                result = await withTimeout(runTool(env, block.name, block.input, { conversation_id: convId }), budget, block.name);
              } finally {
                if (hb) clearInterval(hb);
              }
              toolCache.set(dupKey, result);   // cache successes for dedup
              if (isMutatingTool(block.name)) mutationSucceeded = true;
              await send('tool_result', { name: block.name, ok: true, result });
            } catch (e) {
              result = { error: String(e?.message || e) };
              await send('tool_result', { name: block.name, ok: false, error: result.error });
            }
          }
          await persistMessage(env, convId, 'tool', JSON.stringify(result), { tool_name: block.name, tool_input: block.input });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        if (!toolResults.length) break;  // only server tools ran this hop — nothing to return
        convo.push({ role: 'user', content: toolResults });
      }

      // Hop budget exhausted mid-tool-loop (or a break left no text behind):
      // never end the stream silently. One tool-free closing call so the
      // operator always sees SOMETHING instead of a dead screen.
      if (!textEmitted && !errored) {
        const last = convo[convo.length - 1];
        const nudge = { type: 'text', text: '[SYSTEM CHECK] The tool budget for this turn is spent and you have shown the operator nothing. Reply now in plain text: what you did, what the current state is, and what you could not finish. Do not call any tools.' };
        if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(nudge);
        else convo.push({ role: 'user', content: [nudge] });
        try {
          const res3 = await callLLM(env, convo, [], activeCfg, personaSystem);
          if (res3.ok) {
            const d3 = await res3.json();
            const closing = (d3.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
            if (closing.trim()) { await send('delta', { text: closing }); await persistMessage(env, convId, 'assistant', JSON.stringify(d3.content || [])); }
            else await send('delta', { text: '\n\n_⚠ The model ran tools but produced no reply this turn. Send your message again._\n\n' });
          } else {
            await send('delta', { text: '\n\n_⚠ The model ran tools but produced no reply this turn. Send your message again._\n\n' });
          }
        } catch {
          await send('delta', { text: '\n\n_⚠ The model ran tools but produced no reply this turn. Send your message again._\n\n' });
        }
      }

      await send('done', { conversation_id: convId });
    } catch (e) {
      await send('error', { message: String(e?.message || e) });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── provider dispatch ──────────────────────────────────────
// Tiny abstraction so we can swap Anthropic out later. Every provider must
// return a Response whose JSON body matches the Anthropic Messages shape
// (stop_reason, content[]) — that way the tool-use loop above doesn't care.
// The operator's Mid / High switch. Each tier resolves to a provider + model;
// the tier is sent per message so it can change mid-conversation. (The old Low
// tier — local Qwen through a personal Ollama tunnel — was removed: it could
// never work on any install but the author's.)
function resolveTier(env, tier, mc = null) {
  const t = String(tier || 'mid').toLowerCase();
  if (t === 'high') return { tier: 'high', provider: 'anthropic', model: mc?.nyo_high || env.NYO_MODEL_HIGH || 'claude-opus-4-8' };
  return { tier: 'mid', provider: 'anthropic', model: mc?.nyo_mid || env.NYO_MODEL_MID || 'claude-sonnet-5' };
}

async function callLLM(env, messages, tools, cfg, personaSystem = null, extraHot = null) {
  if (cfg.provider === 'anthropic') return callAnthropic(env, messages, tools, cfg, personaSystem, extraHot);
  if (cfg.provider === 'openai')    return callOpenAI(env, messages, tools, cfg, personaSystem);
  return new Response(`Unknown provider: ${cfg.provider}`, { status: 500 });
}

// Tools that load up front (Nyo's bread-and-butter — used on almost every turn).
// Everything else is deferred and discovered via the server-side tool-search tool.
// Nyo carries 121 tools (~29k tokens); sending them all every turn blew past the
// org's ITPM limit. Deferred tools are NOT counted toward input tokens until the
// model searches for them, so a turn's input drops from ~30k to a few k.
const HOT_TOOLS = new Set([
  'list_knowledge', 'read_knowledge', 'read_knowledge_path', 'recent_events',
  // The Hot Takes wizard tools stay always-visible: when they were deferred,
  // the model mid-conversation could not see them in its tool list, decided
  // they did not exist, and "confessed" that its own successful saves were
  // fabricated (2026-08-19). Cheap schemas, catastrophic when invisible.
  'hottake_read_package', 'hottake_refine', 'hottake_set_angle', 'hottake_notes',
]);

// The planning desk's working set: the persona's FIRST instruction is to
// read today's plan, so these must be visible up front — a deferred tool the
// model hasn't searched for reads as "I can't plan" (same failure class the
// hottake wizard tools hit on 2026-08-19).
const PLANNER_TOOLS = new Set([
  'read_daily_plan', 'save_daily_plan', 'update_daily_plan',
  'search_daily_plans', 'list_recent_plans',
  'read_weekly_objectives', 'set_weekly_objectives',
]);

const TOOL_SEARCH = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' };

async function callAnthropic(env, messages, tools, cfg, personaSystem = null, extraHot = null) {
  // Model comes from the Low/Mid/High switch (mid → Sonnet, high → Opus). Chat is
  // multi-hop and bursty; Sonnet's higher per-tier ITPM absorbs the hop loop, so
  // it's the default (mid) tier. Both are env-overridable (NYO_MODEL_MID/HIGH).
  const model = cfg?.model || env.NYO_MODEL_MID || 'claude-sonnet-5'; // callers pass cfg from resolveTier(env, tier, mc)
  // Search tool first (never deferred); hot tools load up front; defer the rest.
  // cache_control stays on `system` (NOT on a tool — a deferred tool with
  // cache_control is a 400).
  const toolPayload = [
    TOOL_SEARCH,
    ...tools.map((t) => (HOT_TOOLS.has(t.name) || extraHot?.has(t.name) ? t : { ...t, defer_loading: true })),
  ];
  // Cache the static prefix (tools render first, then system; one breakpoint on
  // the last system block caches BOTH). Nyo ships ~30k tokens of tool schemas +
  // system every turn — cache_read tokens do NOT count toward the ITPM rate
  // limit, so on a warm cache a turn costs a few hundred ITPM instead of ~30k,
  // and ~90% less in $$. 5-min TTL; interactive turns stay warm.
  // Transport lives in the llm gateway (lib/openai.js) — chat only builds payloads.
  return llmTransportAnthropic(env, {
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: personaSystem || SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: toolPayload,
    messages,
  }, { timeoutMs: LLM_TIMEOUT_MS });
}

// OpenAI chat-completions wrapper. Translates request shape on the way in
// (tools[] format differs) and response shape on the way out (tool_calls →
// tool_use blocks, finish_reason → stop_reason) so the loop sees Anthropic
// shape no matter which provider answered.
async function callOpenAI(env, messages, tools, cfg = {}, personaSystem = null) {
  // Works for any OpenAI-compatible endpoint; with no cfg it falls back to OpenAI proper.
  const model  = cfg.model  || env.LLM_MODEL || env.OPENAI_MODEL || 'gpt-4o';
  const base   = cfg.baseUrl || 'https://api.openai.com/v1';
  const apiKey = cfg.apiKey || env.OPENAI_API_KEY;
  const tokenField = cfg.tokenParam || 'max_completion_tokens';

  // 1. translate tools: {name, description, input_schema} → {type:'function', function:{...}}
  const openaiTools = (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // 2. translate messages: Anthropic content[] blocks → OpenAI string or tool_calls.
  const openaiMessages = [{ role: 'system', content: personaSystem || SYSTEM }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      openaiMessages.push({ role: m.role, content: m.content });
      continue;
    }
    // Array content — could be text + tool_use (assistant) or tool_result (user).
    if (m.role === 'assistant') {
      const text  = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      openaiMessages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'user') {
      // User content with tool_result blocks → individual tool messages in OpenAI.
      const results = m.content.filter((b) => b.type === 'tool_result');
      if (results.length) {
        for (const r of results) openaiMessages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) });
      } else {
        const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        openaiMessages.push({ role: 'user', content: text });
      }
    }
  }

  // Token cap field varies: OpenAI gpt-5.x wants max_completion_tokens; Ollama's
  // OpenAI shim wants max_tokens. cfg.tokenParam selects the right one per tier.
  const reqBody = { model, messages: openaiMessages, tools: openaiTools.length ? openaiTools : undefined };
  reqBody[tokenField] = 4096;
  const upstream = await llmTransportOpenAICompat(env, {
    base, apiKey, body: reqBody,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  if (!upstream.ok) return upstream;
  const data = await upstream.json();
  const choice = data.choices?.[0];
  const msg = choice?.message || {};

  // 3. translate response back to Anthropic shape.
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of (msg.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* leave empty */ }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  const stop_reason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return new Response(JSON.stringify({ stop_reason, content }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// `firstUserText` titles the row on creation so the history list is readable.
// Without it every conversation persisted with title=NULL and the operator's
// past threads were an unlabelled wall of ids. Existing NULL rows still render
// fine: lib/conversations.js derives a display title at read time.
async function ensureConversation(env, id, firstUserText = '', agent = null) {
  const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?').bind(id).first();
  if (exists) {
    await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now(), id).run();
    return;
  }
  // `agent` scopes the thread so the Nyo history panel never lists (or reopens)
  // a Daily Planner conversation. NULL = Nyo.
  await env.DB.prepare(
    `INSERT INTO conversations (id, title, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, firstUserText ? deriveTitle(firstUserText) : null, agent || null, now(), now()).run();
}

async function persistMessage(env, convId, role, content, extra = {}) {
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_name, tool_input, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    uid(), convId, role,
    typeof content === 'string' ? content : JSON.stringify(content),
    extra.tool_name || null,
    extra.tool_input ? JSON.stringify(extra.tool_input) : null,
    now(),
  ).run();
}
