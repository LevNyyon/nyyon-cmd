// Nyyon Command Center — Hono router + Nyo SSE chat.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  recentEvents,
  listKnowledge, readKnowledge, writeKnowledge, deleteKnowledge, readKnowledgePath,
  listContent, readContent, writeContent, deleteContent,
  listBlogPosts, readBlogPost, writeBlogPost, deleteBlogPost, listBlogAnalytics,
  listFinanceEntries, createFinanceEntry, updateFinanceEntry, deleteFinanceEntry,
  listAeoQuestions, readAeoQuestion, writeAeoQuestion, addAeoQuestion, deleteAeoQuestion, nextPendingAeoQuestion,
  queueNyoMessage, listPendingNyoMessages, markNyoMessageDelivered, recentNyoMessages,
  logEvent,
  listCalendarEvents, readCalendarEvent, upsertCalendarEvent, deleteCalendarEvent,
  listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, listWorkflowRuns, logWorkflowRun,
  listContacts, readContact, writeContact, deleteContact, listContactTaxonomy,
  listClients, readClient, readClientWithContacts, writeClient, deleteClient, listClientTaxonomy,
  listSections, patchSection, upsertSection, reorderSections, deleteSection,
  listFlags, setFlag,
} from './lib/db.js';
import { runWakeUp } from './lib/wake-up.js';
import { listPipeline, updateDeal, promoteLeadToPipeline } from './lib/pipeline.js';
import { noteSelfOrigin } from './lib/self-origin.js';
import { ensureSchema } from './lib/schema.js';
import { handleChat } from './chat/index.js';
import { todayLocal, weekAnchor, readPlan, savePlan, searchPlans, recentPlans, readWeeklyObjectives, saveWeeklyObjectives } from './lib/daily-planner.js';
import {
  listPackages as htListPackages, readPackage as htReadPackage, createPackage as htCreatePackage,
  patchPackage as htPatchPackage, dismissPackage as htDismissPackage, listPosts as htListPosts,
  computeNextAction as htNextAction, topicsOfTheDay as htTopicsOfTheDay, pinTopic as htPinTopic,
  dismissTopicCard as htDismissTopicCard,
  releaseChannels as htReleaseChannels,
  pipelineView as htPipelineView, articleView as htArticleView, saveArticleEdit as htSaveArticleEdit,
  patchPost as htPatchPost, scheduleView as htScheduleView, listApprovedSources as htListApprovedSources,
  searchHotTakes as htSearch, loadAllHotTakesNotes as htLoadNotes, runDueReleases as htRunDueReleases,
  hotTakesLive as htLive,
} from './lib/hot-takes.js';
import {
  importLeads as gtmImportLeads, listLeads as gtmListLeads, listBatches as gtmListBatches,
  getLead as gtmGetLead, manualEditLead as gtmManualEdit, enrichFullOne as gtmEnrichFull,
  enrichResumeOne as gtmEnrichResume,
  enrichBatchStep as gtmEnrichBatchStep, leadState as gtmLeadState,
  evaluateConfidence as gtmConfidence, renameBatch as gtmRenameBatch, setLeadDeadEnd as gtmSetDeadEnd,
} from './lib/gtm.js';
import {
  orgChartForLead, scoreIcpFit, openRolesForLead, companyContextForLead, greenLeads, listOrgPeople,
  probeTheorg,
} from './lib/gtm-context.js';
import {
  saveAngles, readAngles, readAnglesMany, contactStatuses, listSends,
} from './lib/gtm-outreach.js';
import { buildRegistry } from './lib/registry.js';
import { runTool } from './tools/index.js';
import { getLlmHealth } from './lib/llm.js';
import { regenerateBlogFeaturedImage } from './lib/blog-images.js';
import {
  probeLinkedIn, setLinkedInCookies,
  getMyProfile as liMyProfile, getProfile as liProfile,
  getFeed as liFeed, listConversations as liConversations, getConversationMessages as liConversationMessages,
  searchPeople as liSearchPeople,
  sendDirectMessage as liSendDm, sendConnectionRequest as liConnect,
  postText as liPostText, reactToPost as liReactPost,
} from './lib/linkedin.js';
import { listOsintListeners, readOsintListener, patchOsintListener } from './lib/osint.js';
import { listOutbox, getOutboxRow, outboxStats, retryOutboxRow } from './lib/outbox.js';
import { listConversations, readConversation, renameConversation, deleteConversation } from './lib/conversations.js';
import { gate, handleGateLogin, handleGateLogout } from './gate.js';
import { hasGateSession, issueGateSession } from './gate.js';
import { readInstallState, updateAdminCredentials, verifySetupAccess } from './lib/install.js';
import {
  onboardingState, saveAndVerifyLlmKey,
  createOperatorAccount, finishSetup,
  onboardingGateways, connectOnboardingGateway,
} from './lib/onboarding.js';
import { devListRegistry, devInvokeTool, devInvokeGateway, devInvokeWorkflow } from './lib/dev-invoke.js';

const app = new Hono();
// ─── first-run setup ──────────────────────────────────────────
// The sequence a new operator walks: their account (a form — it creates the
// login and signs them in), the model key, then Nyo's voice interview, then
// services. Only the FIRST of those happens before there is a session; the
// rest happen inside the app, signed in.
//
// gate.js decides who reaches this prefix at all (exempt before an account
// exists, cookie-gated after, 404 once setup is complete). Every handler then
// authorizes itself through verifySetupAccess, which applies the SAME rule
// from the other side, so a routing mistake in one file cannot open the other.
function setupToken(c) {
  // Header first. The query fallback exists only for a local `curl` and the
  // installer's own redirect; a token in a URL leaks into logs and history.
  return c.req.header('X-Setup-Token') || c.req.query('setup_token') || '';
}
async function hasSetupAccess(c) {
  return verifySetupAccess(c.env, {
    token: setupToken(c),
    host: c.req.header('Host') || new URL(c.req.url).host,
    // After step one this is the ONLY thing that counts. Before it, it is
    // false and irrelevant.
    session: await hasGateSession(c),
  }).catch(() => false);
}
// An install whose database will be erased on the next restart must never take
// an operator through setup. Someone spends an hour on their voice, their
// sources, their plan — and it is gone with no warning. That is the single
// worst thing this product could do to a person, so account creation is
// refused outright and the reason is stated where they will read it.
// NYYON_ALLOW_EPHEMERAL=1 is the deliberate opt-out for a throwaway demo.
async function ephemeralAcked(env) {
  // The acknowledgement lives in the SAME temporary database it is about, so
  // it disappears with the data — a restart re-asks, which is correct.
  try {
    const r = await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'ephemeral_ack'").first();
    return r?.value === '1';
  } catch { return false; }
}

async function ephemeralBlockAsync(c) {
  if (c.env.NYYON_STORAGE !== 'ephemeral') return null;
  if (c.env.NYYON_ALLOW_EPHEMERAL === '1') return null;
  if (await ephemeralAcked(c.env)) return null;
  return ephemeralBlock(c);
}

function ephemeralBlock(c) {
  if (c.env.NYYON_STORAGE !== 'ephemeral') return null;
  if (c.env.NYYON_ALLOW_EPHEMERAL === '1') return null;
  return c.json({
    ok: false,
    error: 'This instance has no permanent storage, so anything you set up here would be erased the next time it restarts. Setup is blocked on purpose.',
    fix: 'Attach a disk and point NYYON_STATE_DIR at it. On Render: switch to the Starter plan, add a 1GB disk mounted at /var/data, set NYYON_STATE_DIR=/var/data/wrangler, then redeploy.',
    detail: c.env.NYYON_STORAGE_WHY || null,
    storage: 'ephemeral',
  }, 409);
}

async function requireSetupAccess(c) {
  const blocked = await ephemeralBlockAsync(c); if (blocked) return blocked;
  const st = await readInstallState(c.env).catch(() => null);
  if (!st || st.setup_complete) return c.json({ error: 'not found' }, 404);
  if (!(await hasSetupAccess(c))) {
    // An account exists and the caller has no session: that is a sign-in
    // problem, not a "wrong machine" problem, and 401 is what makes the SPA
    // show the door instead of a dead end.
    return c.json({ error: 'setup access denied' }, st.has_admin ? 401 : 403);
  }
  return null;   // allowed
}

// Deliberately UNGUARDED: the SPA has to know which boot screen to render
// before anyone has proved anything. The unproven answer carries only how far
// this install has been claimed (account yet? setup finished?) — the
// interview's CONTENTS (company, audience, which gateways are wired) need
// setup access, because on a publicly reachable fresh deploy this endpoint is
// world-readable.
app.get('/api/onboarding/state', async (c) => c.json({
  ...(await onboardingState(c.env)),
  // The boot screen needs to KNOW when this install cannot keep data, so it can
  // say so instead of cheerfully asking for an account it will forget.
  storage: c.env.NYYON_STORAGE === 'ephemeral'
    ? {
        persistent: false,
        allowed: c.env.NYYON_ALLOW_EPHEMERAL === '1' || (await ephemeralAcked(c.env)),
        why: c.env.NYYON_STORAGE_WHY || null,
        host: c.env.NYYON_HOST || null,
        // Deep link straight to the settings page that fixes it.
        settings_url: c.env.NYYON_HOST_SERVICE_ID
          ? `https://dashboard.render.com/web/${c.env.NYYON_HOST_SERVICE_ID}`
          : (c.env.NYYON_HOST_APP ? `https://fly.io/apps/${c.env.NYYON_HOST_APP}` : null),
      }
    : { persistent: true },
}));

// "I know it will not be kept — let me look around anyway." An informed choice,
// recorded in the temporary database it concerns, so a restart asks again.
app.post('/api/onboarding/allow-ephemeral', async (c) => {
  if (c.env.NYYON_STORAGE !== 'ephemeral') return c.json({ ok: true, note: 'storage is persistent' });
  const st = await readInstallState(c.env).catch(() => null);
  // Only before this install belongs to anyone: afterwards it is not the
  // visitor's call to make.
  if (st?.has_admin) return c.json({ ok: false, error: 'this install already has an operator' }, 403);
  await c.env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('ephemeral_ack', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  ).bind(Date.now()).run();
  await logEvent(c.env, { kind: 'ephemeral_acknowledged', actor: 'operator', payload: {} });
  return c.json({ ok: true });
});

// STEP ONE, and the reason the whole sequence was reordered: the account, as a
// plain form, with no model and no interview in front of it. It creates the
// credential, burns the setup token, and signs them straight in — the rest of
// setup then runs as the signed-in operator.
//
// It does NOT finish setup. /api/onboarding/finish does.
app.post('/api/onboarding/account', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const r = await createOperatorAccount(c.env, { username: body?.username, password: body?.password });
    await issueGateSession(c, r.username);
    return c.json({ ok: true, username: r.username, signed_in: Boolean(c.env.GATE_SECRET) });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// Going BACK from a later setup step. The account itself cannot be un-created,
// so "back" means CHANGE it: an operator who mistyped their username on the
// first screen rewrites it here rather than living with it. Behind the session
// gate via requireSetupAccess, which after an account exists means the cookie
// and nothing else.
app.post('/api/onboarding/account/update', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    const r = await updateAdminCredentials(c.env, { username: body?.username, password: body?.password });
    // Re-issue the cookie: it carries the username, and the old one would name
    // an account that no longer exists.
    await issueGateSession(c, r.username);
    return c.json({ ok: true, username: r.username, signed_in: Boolean(c.env.GATE_SECRET) });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

// Step one of setup, and the only one that cannot be a conversation: the
// interview is itself an LLM call, so with no model key there is nothing to
// talk to. The key is verified with a real request before we accept it —
// letting a typo through would strand the operator on a chat that silently
// never answers.
app.post('/api/onboarding/llm-key', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const r = await saveAndVerifyLlmKey(c.env, { key: body?.key, provider: body?.provider || 'anthropic' });
  return r.ok ? c.json(r) : c.json(r, 400);
});

app.get('/api/onboarding/gateways', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  return c.json(await onboardingGateways(c.env));
});

app.post('/api/onboarding/gateways', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  if (!body?.slug) return c.json({ error: 'slug required' }, 400);
  try {
    return c.json(await connectOnboardingGateway(c.env, String(body.slug), body.config || {}));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// THE LAST STEP: setup is finished. This is the write that closes
// verifySetupAccess permanently, so every route in this section stops
// answering after it. The account already exists — nothing here touches a
// credential.
app.post('/api/onboarding/finish', async (c) => {
  const denied = await requireSetupAccess(c); if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await finishSetup(c.env, { reason: body?.reason, tz: body?.tz }));
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});

app.use('*', cors());

// Build stamp — surfaces the deployed build on every response (incl. the login
// page, pre-auth) as `X-Nyyon-Build`, so a GitHub push can be verified live via
// `curl -I https://your install`. Runs before the gate; only tags the response
// after the chain, so it has no effect on auth.
//   BUILD_SHA is injected at deploy time by the GitHub Action via
//   `wrangler deploy --define BUILD_SHA:'"<git-sha>"'` (esbuild replaces the
//   token in-bundle). The typeof-guard falls back to 'dev' for local `wrangler
//   dev`, where the token is never defined.
const BUILD = (typeof BUILD_SHA === 'string') ? BUILD_SHA : 'dev';
app.use('*', async (c, next) => { await next(); c.header('X-Nyyon-Build', BUILD); });

// Auth gate — must run before every route. Unauthenticated requests get the
// login page (navigations) or 401 (/api). The single credential + rate limit
// live in gate.js; the password is a Cloudflare secret, not in this repo.
app.use('*', gate());
app.post('/__gate/login', handleGateLogin);
app.post('/__gate/logout', handleGateLogout);

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

// Reachability probe for a local-service gateway (WhatsApp, LinkedIn, website…).
// The deployed worker runs in Cloudflare's cloud, so a gateway on localhost is
// UNREACHABLE — the real fix is a public tunnel. The note says that explicitly
// instead of telling the operator to "open localhost" (which never works here).
async function probeGateway(name, baseUrl, envVar, { headers = {}, deployed = false } = {}) {
  const url = (baseUrl || '').replace(/\/$/, '');
  if (!url) {
    return { name, status: 'yellow', severity: 'degraded',
      note: `not configured — give it a public tunnel and set ${envVar} to that URL` };
  }
  const isLocal = /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(url);
  const tunnelNote = `${envVar} is localhost (${url}) — the deployed worker can't reach it; expose it with a public tunnel and point ${envVar} there`;
  // A localhost gateway is unreachable from the DEPLOYED worker no matter what a
  // probe returns (Cloudflare may answer loopback fetches itself) — flag it up
  // front with the real fix rather than trusting a misleading response.
  if (deployed && isLocal) {
    return { name, status: 'yellow', severity: 'degraded', note: tunnelNote };
  }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (r.status < 500) return { name, status: 'green', severity: 'degraded', note: null };
    return { name, status: 'yellow', severity: 'degraded', note: `HTTP ${r.status} from ${url} — gateway up but erroring` };
  } catch {
    return { name, status: 'yellow', severity: 'degraded',
      note: isLocal ? tunnelNote : `unreachable at ${url} — the gateway or its tunnel is down` };
  }
}

// ─── Aggregated system health ─────────────────────────────────
// Used by the sidebar status dot. Returns an overall traffic-light status
// plus per-check breakdown so the operator can see what's wrong on hover.
//   green  — everything green
//   yellow — at least one non-critical check is degraded
//   red    — a mission-critical check is failing
app.get('/api/system/health', async (c) => {
  const checks = [];
  const env = c.env;
  // Deployed cloud worker (your install) vs local dev: localhost gateways are
  // reachable in dev but never from the deployed worker — the probe uses this.
  const deployed = !/^(localhost|127\.0\.0\.1)/.test((() => { try { return new URL(c.req.url).host; } catch { return ''; } })());

  // 1. DB — if we got here, the worker booted; assume reachable.
  let dbOk = false;
  try {
    const r = await env.DB.prepare('SELECT 1 AS ok').first();
    dbOk = r?.ok === 1;
  } catch (e) {
    checks.push({ name: 'D1 database', status: 'red', severity: 'critical', note: String(e?.message || e).slice(0, 200) });
  }
  if (dbOk) checks.push({ name: 'D1 database', status: 'green', severity: 'critical', note: null });

  // 2. LLM provider — needed for digest/Nyo/anything reasoning. Critical.
  // Beyond "is the key set?", read the circuit-breaker's health row: when the
  // primary (Anthropic) runs out of credit or rejects the key, the breaker
  // opens, chat + light jobs fall back to the local model, and heavy writers
  // pause. Surface that as a distinct degraded state so the operator sees the
  // outage here (not just via the one-time Nyo message).
  const provider = (env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const keySet =
    provider === 'anthropic' ? !!env.ANTHROPIC_API_KEY :
    provider === 'openai'    ? !!env.OPENAI_API_KEY    :
    false;
  if (!keySet) {
    checks.push({
      name: `LLM provider · ${provider}`,
      status: 'red',
      severity: 'critical',
      note: `${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} secret not set — run: wrangler secret put ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`,
    });
  } else {
    const h = await getLlmHealth(env);
    const down = h.status === 'down';
    const mins = down && h.since ? Math.max(1, Math.round((Date.now() - h.since) / 60000)) : null;
    const why = h.reason === 'auth' ? 'rejecting the API key' : 'out of credit';
    // Real, live model data (the llm-models doc / Settings editor — not the
    // static provider name) so this actually says which model is running.
    const { loadModelConfig } = await import('./lib/model-config.js');
    const models = await loadModelConfig(env);
    const usingFallback = down && !!models.writer_fallback;
    checks.push({
      name: `LLM · ${down ? (usingFallback ? models.writer_fallback : models.nyo_mid) : models.nyo_mid}`,
      status: down ? (usingFallback ? 'yellow' : 'yellow') : 'green',
      severity: 'critical',
      note: down
        ? `Primary (${models.nyo_mid}) ${why}${mins ? ` (~${mins} min)` : ''} — chat is DOWN with it. ${usingFallback ? `Heavy writers (AEO, GTM outreach) are running on the fallback writer ${models.writer_fallback}.` : 'Heavy writers (AEO, GTM outreach) are PAUSED — set a Fallback writer in Settings to keep them running.'} ${h.reason === 'auth' ? 'Fix ANTHROPIC_API_KEY' : 'Top up Anthropic credit'} and it recovers automatically.`
        : `Nyo tiers: mid=${models.nyo_mid} · high=${models.nyo_high}. Writers: ${models.writer}${models.writer_fallback ? ` (fallback: ${models.writer_fallback})` : ' (no fallback set)'}.`,
    });
  }

  // 4. LinkedIn — checked only when this install configured access (daemon
  //    URL or li_at cookie). Unconfigured is a choice, not a degradation.
  let liConfigured = !!env.LI_BASE_URL;
  if (!liConfigured) {
    try { const { resolveCredential } = await import('./lib/gateway-config.js'); liConfigured = !!(await resolveCredential(env, 'LI_AT_COOKIE')); } catch { /* stays false */ }
  }
  if (liConfigured) {
    try {
      const li = await probeLinkedIn(env);
      const ok = li?.reachable ?? li?.ok;
      checks.push({
        name: li?.mode === 'cookie' ? 'LinkedIn session (cookie)' : 'LinkedIn gateway', severity: 'degraded',
        status: ok && li?.ready !== false ? 'green' : 'yellow',
        note: ok && li?.ready !== false ? null : (li?.error || 'session not ready — paste a fresh li_at cookie in Settings'),
      });
    } catch (e) {
      checks.push({ name: 'LinkedIn gateway', status: 'yellow', severity: 'degraded',
        note: `unreachable (${String(e?.message || e).slice(0, 80)})` });
    }
  }

  // 5. Website — the live marketing site (https://your website), served by the
  //    Cloudflare Pages project `nyyon-lp` from its own
  //    repo. Publicly reachable, so a straight fetch works from the deployed
  //    worker — no tunnel needed.
  if (env.WEBSITE_BASE_URL) checks.push(await probeGateway('Website', env.WEBSITE_BASE_URL, 'WEBSITE_BASE_URL', { deployed }));

  // 6. Digest channels — any enabled channel whose last_status is 'error'
  //    is degraded. Skipped channels (disabled) don't count.
  try {
    const rows = await env.DB.prepare(
      "SELECT source, enabled, last_status FROM digest_channels WHERE enabled = 1",
    ).all();
    const bad = (rows.results || []).filter((r) => r.last_status === 'error');
    if (bad.length) {
      checks.push({
        name: `Digest channels (${bad.length} erroring)`,
        status: 'yellow',
        severity: 'degraded',
        note: bad.map((b) => b.source).join(', ') + ' — clears once the source gateway/session is live (fix the matching gateway check above)',
      });
    } else if ((rows.results || []).length === 0) {
      checks.push({ name: 'Digest channels', status: 'yellow', severity: 'degraded', note: 'no channels enabled' });
    } else {
      checks.push({ name: `Digest channels (${rows.results.length} on)`, status: 'green', severity: 'degraded', note: null });
    }
  } catch { /* digest_channels table may not exist yet — skip */ }

  // 7. OSINT sources (DuckDuckGo, Reddit, HN, GitHub, …) — surface per-source
  //    failures, and when the recorded error looks like rate-limiting, say so
  //    and what to do about it (rather than a bare "error").
  try {
    const rows = await env.DB.prepare(
      "SELECT source, last_status, last_error FROM osint_listeners WHERE enabled = 1",
    ).all();
    const results = rows.results || [];
    const bad = results.filter((r) => r.last_status === 'error');
    const isThrottle = (e) => /\b(429|403)\b|rate.?limit|throttl|too many|quota|blocked/i.test(String(e || ''));
    if (bad.length) {
      const detail = bad.map((b) => {
        const err = String(b.last_error || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return isThrottle(b.last_error) ? `${b.source}: throttled${err ? ` (${err})` : ''}` : `${b.source}: ${err || 'error'}`;
      }).join('; ');
      const throttled = bad.some((b) => isThrottle(b.last_error));
      checks.push({
        name: `OSINT sources (${bad.length} failing)`,
        status: 'yellow',
        severity: 'degraded',
        note: throttled
          ? `${detail} — being rate-limited; slow that source's throttle or pause it for a while`
          : detail,
      });
    } else if (results.length) {
      checks.push({ name: `OSINT sources (${results.length} on)`, status: 'green', severity: 'degraded', note: null });
    }
  } catch { /* osint_listeners table may not exist yet — skip */ }

  // 8. GTM gateways — the module's own external dependencies. WhatsApp +
  //    LinkedIn ride the shared gateway checks above (same servers — the GTM
  //    contact-lookup and company/jobs endpoints live on them). What's GTM-
  //    specific: theorg (org charts, public GraphQL, the Enrich tab's hard
  //    dependency) and the three OPTIONAL paid enrichment keys.
  try {
    // Through the theorg gateway probe — reachability only, never burns quota.
    const r = await probeTheorg(env);
    if (!r.ok) throw new Error(r.error || 'probe failed');
    checks.push({
      name: `GTM · theorg (org charts) · HTTP ${r.http}`,
      status: 'green', severity: 'degraded', note: null,
    });
  } catch (e) {
    checks.push({
      name: 'GTM · theorg (org charts)',
      status: 'yellow', severity: 'degraded',
      note: `unreachable (${String(e?.message || e).slice(0, 100)}) — Enrich-tab org charts + outreach org verification will fail`,
    });
  }
  {
    // Optional paid legs: configured-or-not only (a health check must never
    // burn paid API credits). Unset keys don't degrade the overall status —
    // the enrichment chain skips those legs gracefully — but they're listed
    // so the operator can see at a glance what's off.
    const gtmKeys = [
      ['PDL',     !!env.PDL_API_KEY,                                    'PDL_API_KEY'],
      ['SerpApi', !!env.SERPAPI_KEY,                                    'SERPAPI_KEY'],
      ['Twilio',  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),  'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN'],
    ];
    const unset = gtmKeys.filter(([, ok]) => !ok);
    checks.push({
      name: `GTM · enrichment keys (${gtmKeys.length - unset.length}/${gtmKeys.length} configured)`,
      status: 'green',
      severity: 'degraded',
      note: unset.length
        ? `optional — these legs skip until set: ${unset.map(([n, , s]) => `${n} (wrangler secret put ${s.split(' ')[0]})`).join(' · ')}`
        : null,
    });
  }

  // Roll up: red beats yellow beats green.
  const overall = checks.some((c) => c.status === 'red')    ? 'red'
                : checks.some((c) => c.status === 'yellow') ? 'yellow'
                : 'green';
  return c.json({ overall, checks, ts: Date.now() });
});

// ─── Nyo wake-up — proactive survey + catchup ───────────────
// Called by the Chat component on mount + tab refocus. Thin caller — the
// business rules (Sunday brain offer, stats survey, cadence gating, the
// once-per-day AEO autofire cap, outbox auto-retry) live in lib/wake-up.js,
// and the tunable thresholds live in the `wake-up-policy` knowledge doc.
//
// Body: { autofire?: boolean } — if true (default), missed AEO publish
// gets actually fired. If false, just reports what would be done.
app.post('/api/system/wake-up', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const autofire = body.autofire !== false; // default true
  const r = await runWakeUp(c.env, { autofire });
  return c.json(r.body, r.status);
});

// ─── Nyo pending messages (queue → chat injection) ───────────
// The Chat component polls /pending every 30s. Background workers
// (AEO writer, image generator, future cron tasks) queue assistant turns
// here via queueNyoMessage; the chat injects them + POSTs /deliver to clear.
app.get('/api/nyo/pending', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20', 10);
  return c.json({ messages: await listPendingNyoMessages(c.env, { limit }) });
});
app.post('/api/nyo/pending/:id/deliver', async (c) => {
  await markNyoMessageDelivered(c.env, c.req.param('id'));
  return c.json({ ok: true });
});
// ─── Deploy trigger — thin caller into the deploy gateway ─────────────────
// The sidecar (web-public/scripts/deploy-server.mjs, :8791, localhost-only)
// does the actual shell work. Boundary + auth key live in lib/deploy-gateway.js
// (DEPLOY_SIDECAR_KEY env — the key is no longer hardcoded in source).
app.get('/api/nyo/messages', async (c) => {
  // Full history surface (for an inbox-style view if we want one later).
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json({ messages: await recentNyoMessages(c.env, { limit }) });
});
app.post('/api/nyo/pending', async (c) => {
  // Manual queueing — handy for the scheduler.sh hook or for Nyo itself to
  // self-queue a follow-up message. Body: { content, kind?, ref_kind?, ref_id?, payload? }
  const body = await c.req.json().catch(() => ({}));
  try { return c.json({ queued: await queueNyoMessage(c.env, body) }, 201); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});

// ─── Nyo brain config (which LLM provider + model is wired) ─
app.get('/api/nyo/brain', async (c) => {
  const provider = (c.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const { loadModelConfig, modelDefaults } = await import('./lib/model-config.js');
  const models = await loadModelConfig(c.env);
  const keySet =
    provider === 'anthropic' ? !!c.env.ANTHROPIC_API_KEY :
    provider === 'openai'    ? !!c.env.OPENAI_API_KEY    :
    false;
  return c.json({
    provider,
    model: models.writer,           // the background-writer brain (legacy field)
    key_set: keySet,
    models,                          // full per-surface map incl. source
    defaults: modelDefaults(c.env),  // env/coded fallbacks, for the Settings UI
  });
});
// Update the per-surface model map (writes the llm-models knowledge doc).
app.put('/api/nyo/models', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { saveModelConfig } = await import('./lib/model-config.js');
  try {
    const models = await saveModelConfig(c.env, body);
    await logEvent(c.env, { kind: 'llm_models_updated', actor: 'operator', payload: body });
    return c.json({ models });
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});

// ─── outbound webhooks (Settings → where published content gets delivered) ─
app.get('/api/webhooks', async (c) => {
  const { loadWebhooks } = await import('./lib/webhooks.js');
  return c.json(await loadWebhooks(c.env));
});
app.put('/api/webhooks', async (c) => {
  const { saveWebhooks } = await import('./lib/webhooks.js');
  try { return c.json(await saveWebhooks(c.env, await c.req.json())); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// ─── gateway credentials (Settings → connections, post-setup) ─────
// Same store the setup wizard writes; these stay alive after setup closes.
app.get('/api/gateways', async (c) => {
  const { listGatewayStatus } = await import('./lib/gateway-config.js');
  return c.json({ gateways: await listGatewayStatus(c.env) });
});
app.post('/api/gateways', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.slug) return c.json({ error: 'slug required' }, 400);
  try {
    const { saveGatewayConfig } = await import('./lib/gateway-config.js');
    return c.json(await saveGatewayConfig(c.env, String(body.slug), body.config || {}));
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// Live probe — today only linkedin has one (cookie or daemon, same shape).
app.post('/api/gateways/probe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body?.slug !== 'linkedin') return c.json({ error: 'only linkedin has a probe' }, 400);
  try { return c.json(await probeLinkedIn(c.env)); }
  catch (e) { return c.json({ ready: false, error: String(e?.message || e) }, 502); }
});

app.post('/api/webhooks/test', async (c) => {
  const { sendWebhook } = await import('./lib/webhooks.js');
  const { which } = await c.req.json().catch(() => ({}));
  try {
    const r = await sendWebhook(c.env, which === 'social' ? 'social' : 'website',
      { type: 'test', which, sent_at: Date.now(), note: 'Nyyon outbound-webhook test' }, { source: 'settings-test' });
    return c.json(r);
  } catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 502); }
});

// ─── local article preview — same-origin render of the draft, no public site
app.get('/api/blog/:slug/preview', async (c) => {
  const post = await readBlogPost(c.env, c.req.param('slug'));
  if (!post) return c.text('not found', 404);
  const esc = (t) => String(t || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title)}</title>
<style>body{font:16px/1.65 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a}h1{line-height:1.2}img{max-width:100%;height:auto}figure{margin:2em 0}figcaption{font-size:13px;color:#777}</style>
</head><body>
${post.featured_image_url ? `<img src="${esc(post.featured_image_url)}" alt="">` : ''}
<h1>${esc(post.title)}</h1>
${post.excerpt ? `<p><em>${esc(post.excerpt)}</em></p>` : ''}
${post.body_html || post.body || ''}
</body></html>`);
});

// ─── activity log ─────────────────────────────────────────────
app.get('/api/events', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100', 10);
  return c.json({ events: await recentEvents(c.env, limit) });
});

// ─── knowledge ────────────────────────────────────────────────
app.get('/api/knowledge', async (c) => c.json({ docs: await listKnowledge(c.env) }));
// Breadcrumb path root → … → :slug. UI uses this for the breadcrumb strip
// above the doc; Nyo uses it when answering "what context do I need to
// understand X" so it can read the whole chain in one shot.
app.get('/api/knowledge/:slug/path', async (c) => {
  return c.json({ path: await readKnowledgePath(c.env, c.req.param('slug')) });
});
app.get('/api/knowledge/:slug', async (c) => {
  const d = await readKnowledge(c.env, c.req.param('slug'));
  if (!d) return c.json({ error: 'not found' }, 404);
  return c.json({ doc: d });
});
app.put('/api/knowledge/:slug', async (c) => {
  const body = await c.req.json();
  const slug = c.req.param('slug');
  if (!body?.title || body?.body === undefined) return c.json({ error: 'title + body required' }, 400);
  const d = await writeKnowledge(c.env, { ...body, slug });
  return c.json({ doc: d });
});
app.delete('/api/knowledge/:slug', async (c) => {
  await deleteKnowledge(c.env, c.req.param('slug'));
  return c.json({ ok: true });
});

// ─── content blocks (public-site copy) ────────────────────────
// ─── blog posts ───────────────────────────────────────────────
app.get('/api/blog/analytics', async (c) => {
  const publishedOnly = c.req.query('published_only') === '1';
  return c.json({ posts: await listBlogAnalytics(c.env, { publishedOnly }) });
});
app.get('/api/blog/:slug', async (c) => {
  const p = await readBlogPost(c.env, c.req.param('slug'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ post: p });
});
app.delete('/api/blog/:slug', async (c) => {
  await deleteBlogPost(c.env, c.req.param('slug'));
  return c.json({ ok: true });
});

// Featured-image generation (Cloudflare Workers AI → R2). Body optionally
// accepts { prompt_override, model } to tweak. Returns the generated metadata
// plus the public same-origin URL written back to the post row.
// Publish a single blog post from local D1 to the production worker and
// (by default) trigger the marketing-site rebuild. Every attempt — win,
// no-op, or fail — lands in the Outbox under channel='blog' so the
// operator and Nyo both see the audit trail.
app.post('/api/blog/:slug/publish', async (c) => {
  // Webhook-only publish: POST the full article to the configured website
  // webhook, then flip the row published. No blog-edge, no IndexNow.
  const slug = c.req.param('slug');
  const post = await readBlogPost(c.env, slug);
  if (!post) return c.json({ error: 'no such post' }, 404);
  const { sendWebhook } = await import('./lib/webhooks.js');
  try {
    const wr = await sendWebhook(c.env, 'website', {
      type: 'article.publish', slug, title: post.title, excerpt: post.excerpt || null,
      body_html: post.body_html || post.body || null, tags: post.tags || [],
      featured_image_url: post.featured_image_url || null, published_at: Date.now(),
    }, { source: 'blog-publish', source_ref: slug });
    await c.env.DB.prepare('UPDATE blog_posts SET published=1, published_at=COALESCE(published_at, ?) WHERE slug=?')
      .bind(Date.now(), slug).run();
    return c.json({ ok: true, webhook: true, http: wr.http, outbox_id: wr.outbox_id });
  } catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 502); }
});
app.post('/api/blog/:slug/generate-image', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await regenerateBlogFeaturedImage(c.env, c.req.param('slug'), {
      actor:           body.actor || 'operator',
      prompt_override: body.prompt_override || null,
      model:           body.model || null,
    });
    return c.json({ image: result });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

// ─── social cards (code-drawn brand graphics — lib/social-cards.js) ───
// ─── static assets served from R2 ─────────────────────────────
// The featured-image generator stores PNGs in the nyyon-assets bucket; we
// re-serve them at /assets/<key> so blog posts can use same-origin URLs.
// One-year immutable cache — the slug is in the path, regenerate overwrites
// the same key, browsers must hard-reload to see the new image (the ops
// "regenerate" button busts cache by appending ?t=<ts>).
app.get('/assets/blog/:filename', async (c) => {
  const key = `blog/${c.req.param('filename')}`;
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
    },
  });
});

// Article figures + covers live under blog-figures/ in the same bucket. In
// --local dev the public r2.dev URLs 404 (objects are in the local R2 sim), so
// the ops app rewrites figure URLs to this same-origin route to preview them.
app.get('/assets/blog-figures/:filename', async (c) => {
  const key = `blog-figures/${c.req.param('filename')}`;
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// GTM photos (org-chart avatars, lead photos) live under gtm/ — nested keys,
// so this one is a wildcard.
app.get('/assets/gtm/*', async (c) => {
  const key = new URL(c.req.url).pathname.replace(/^\/assets\//, '');
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
    },
  });
});

// Social cards live under social/ in the same bucket — same serving rules.
app.get('/assets/social/:filename', async (c) => {
  const key = `social/${c.req.param('filename')}`;
  if (!c.env.ASSETS) return c.json({ error: 'ASSETS R2 binding missing' }, 500);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag':          obj.httpEtag || '',
    },
  });
});

// ─── workflows (visibility into stitched pipelines + their runs) ──
// ─── Sunday Brain (weekly editorial planning) ────────────────
// ─── AEO feedback + editorial taste ──────────────────────────
// ─── AEO (question backlog + writer) ─────────────────────────
// ─── AEO suggestions (OSINT signals -> developed angles -> approval) ────
// ─── article figures (generate illustrations for blog posts) ───
// ─── contacts (operator-curated list on top of identities) ───
// ─── clients (companies / accounts — the CRM layer above contacts) ──
// ─── pipeline (deals board — clients with a stage + value; reuses the clients table) ──
// ─── gtm (gtm-builder folded in: intake → enrich → outreach; shared gateways) ──
app.get('/api/gtm/batches', async (c) => c.json({ batches: await gtmListBatches(c.env) }));
app.post('/api/gtm/batches/:id/rename', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(await gtmRenameBatch(c.env, c.req.param('id'), b.source));
});
app.get('/api/gtm/leads', async (c) => {
  const leads = await gtmListLeads(c.env, {
    batch_id: c.req.query('batch_id') || null,
    status:   c.req.query('status') || null,
    stage:    c.req.query('stage') || null,
    q:        c.req.query('q') || null,
  });
  return c.json({ leads });
});
app.post('/api/gtm/import', async (c) => {
  const b = await c.req.json();
  return c.json(await gtmImportLeads(c.env, { text: b.text, url: b.url, source: b.source }));
});
// Batch enrichment stepper — the UI loops this while remaining > 0 so each
// Worker invocation stays small (2 leads/call) instead of one long chain.
// WhatsApp intake picker — people the operator already talks to (DM chats +
// group senders + live group rosters) as selectable lead candidates.
app.post('/api/gtm/enrich', async (c) => {
  const b = await c.req.json();
  if (!b.batch_id) return c.json({ error: 'batch_id required' }, 400);
  return c.json(await gtmEnrichBatchStep(c.env, { batch_id: b.batch_id, limit: b.limit || 2 }));
});
app.get('/api/gtm/leads/:id', async (c) => {
  const lead = await gtmGetLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  const [org, angles, sends] = await Promise.all([
    listOrgPeople(c.env, lead.id),
    readAngles(c.env, lead.id),
    listSends(c.env, lead.id),
  ]);
  return c.json({ lead: { ...lead, state: gtmLeadState(lead), confidence: gtmConfidence(lead) }, org, angles, sends });
});
app.post('/api/gtm/leads/:id', async (c) => {
  // A rejected value is the caller's problem, not a server fault: manualEditLead
  // throws on input it refuses to coerce (a non-numeric headcount), and that
  // must read as 400 with the reason rather than a bare 500.
  try {
    const lead = await gtmManualEdit(c.env, c.req.param('id'), await c.req.json());
    return c.json({ lead: { ...lead, state: gtmLeadState(lead), confidence: gtmConfidence(lead) } });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
app.post('/api/gtm/leads/:id/enrich', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  // 'resume' = re-run only the steps a manual edit can unblock (SerpApi + the
  // finalize LinkedIn pass). Skips the paid per-lookup legs on purpose.
  if (b.kind === 'resume') return c.json(await gtmEnrichResume(c.env, id));
  return c.json(await gtmEnrichFull(c.env, id));
});
app.post('/api/gtm/leads/:id/dead-end', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(await gtmSetDeadEnd(c.env, c.req.param('id'), !!b.dead));
});
app.post('/api/gtm/leads/:id/company-context', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(await companyContextForLead(c.env, c.req.param('id'), { refresh: !!b.refresh }));
});
app.post('/api/gtm/leads/:id/icp', async (c) => c.json(await scoreIcpFit(c.env, c.req.param('id'))));
app.get('/api/gtm/green', async (c) => {
  const leads = await greenLeads(c.env);
  const [angles, statuses] = await Promise.all([
    readAnglesMany(c.env, leads.map((l) => l.id)),
    contactStatuses(c.env, leads.map((l) => l.id)),
  ]);
  return c.json({ leads: leads.map((l) => ({ ...l, angles: angles.get(l.id) ?? null, ...(statuses.get(l.id) || {}) })) });
});
app.get('/api/gtm/watch', async (c) => c.json(await runTool(c.env, 'gtm_watch_list', {})));
app.post('/api/gtm/leads/:id/watch', async (c) => {
  try { return c.json(await runTool(c.env, 'gtm_watch_set', { id: c.req.param('id'), on: (await c.req.json().catch(() => ({})))?.on !== false })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/gtm/watch/bulk', async (c) => {
  try {
    const b = await c.req.json();
    return c.json(await runTool(c.env, 'gtm_watch_set', { ids: b?.ids, on: b?.on !== false }));
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.post('/api/gtm/signals/:id', async (c) => {
  try { return c.json(await runTool(c.env, 'gtm_signal_mark', { id: c.req.param('id'), status: (await c.req.json())?.status })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// ─── LI Outreach (connect-first: throttled invites, judged contacts,
//     operator-scheduled messages; thin routes over the shared
//     li_outreach_* tool pool — Nyo drives the exact same surface) ──
// ── signals-first redesign: the Signals tab + per-contact assignment.
//    Thin dispatchers over the same shared pool; theme on intake/add rides
//    the whole-body forwards above (runTool passes input through untouched).
// ── LinkedIn Signals module ─────────────────────────────────────
// A read surface over work that already happens: the hourly scan detects,
// signal-priority scores, the digest stores. These routes only re-read that
// by relevance and curate the tracked list. The take on a card reuses the
// existing /api/li/signals/:id/draft-comment + /comment pair — this module
// adds no drafting of its own.
// ─── tasks (daily task list module; updatable by Lev, Nyo, or any agent) ──
// ─── daily planner (per-day plan + weekly objectives; operator + planner chat) ──
app.get('/api/daily-plan', async (c) => {
  const date = c.req.query('date') || (await todayLocal(c.env));
  const plan = await readPlan(c.env, date);
  return c.json({ date, plan });
});
app.put('/api/daily-plan', async (c) => {
  const b = await c.req.json();
  const src = b.plan || b;
  const date = b.date || src.date || (await todayLocal(c.env));
  const plan = await savePlan(c.env, { date, plan: src, mode: src.mode, actor: 'operator' });
  return c.json({ plan });
});
app.get('/api/daily-plan/search', async (c) => {
  const r = await searchPlans(c.env, { query: c.req.query('q') || '', limit: Number(c.req.query('limit')) || 20 });
  return c.json(r);
});
app.get('/api/daily-plan/recent', async (c) => {
  const r = await recentPlans(c.env, { days: Number(c.req.query('days')) || 3 });
  return c.json(r);
});
app.get('/api/weekly-objectives', async (c) => {
  // `week` = a literal week_start; `date` = any day, anchored server-side (the
  // workweek convention lives in weekAnchor — clients never re-derive it).
  const wk = c.req.query('week')
    || (await weekAnchor(c.env, c.req.query('date') || await todayLocal(c.env)));
  const objectives = await readWeeklyObjectives(c.env, wk);
  return c.json({ week_start: wk, objectives });
});
app.put('/api/weekly-objectives', async (c) => {
  const b = await c.req.json();
  const wk = b.week_start || (await weekAnchor(c.env, await todayLocal(c.env)));
  const objectives = await saveWeeklyObjectives(c.env, { week_start: wk, objectives: b.objectives || [], actor: 'operator' });
  return c.json({ objectives });
});

// ─── Hot Takes (editorial command center — topic → take → brief → article → distribute) ──
app.get('/api/hot-takes/packages', async (c) => {
  const statusQ = c.req.query('status');
  const statuses = statusQ ? statusQ.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const packages = await htListPackages(c.env, { statuses, limit: Number(c.req.query('limit')) || 200 });
  return c.json({ packages });
});
// `history=1` widens the lookback to everything we retain (the UI's Load more
// grows `limit` with this set); `q` searches all of it, not just what's loaded;
// `offset` is honoured for API callers. All optional — omitting them returns
// today's feed exactly as before.
app.get('/api/hot-takes/topics-of-the-day', async (c) => {
  const history = c.req.query('history');
  return c.json(await htTopicsOfTheDay(c.env, {
    limit: Number(c.req.query('limit')) || 12,
    offset: Number(c.req.query('offset')) || 0,
    q: c.req.query('q') || '',
    history: history === '1' || history === 'true',
  }));
});
app.post('/api/hot-takes/packages', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const pkg = await htCreatePackage(c.env, { ...b, origin: b.origin || 'manual', pinned: b.pinned ?? 1, actor: 'operator' });
  return c.json({ package: pkg });
});
app.post('/api/hot-takes/topics/pin', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ package: await htPinTopic(c.env, b, 'operator') });
});
// Manually remove a Topic-of-the-Day card from the feed (persisted; stays gone).
app.post('/api/hot-takes/topics/dismiss', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ package: await htDismissTopicCard(c.env, b, 'operator') });
});
app.post('/api/hot-takes/add-link', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'hottake_add_link', { url: b.url, actor: 'operator' });
  return c.json(res, res && res.error ? 400 : 200);
});
app.get('/api/hot-takes/packages/:id', async (c) => {
  const pkg = await htReadPackage(c.env, c.req.param('id'));
  if (!pkg) return c.json({ error: 'not found' }, 404);
  const posts = await htListPosts(c.env, pkg.id);
  return c.json({ package: pkg, posts, next_action: htNextAction(pkg, posts, htReleaseChannels(c.env)) });
});
app.patch('/api/hot-takes/packages/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ package: await htPatchPackage(c.env, c.req.param('id'), b, 'operator') });
});
app.post('/api/hot-takes/packages/:id/dismiss', async (c) => {
  return c.json({ package: await htDismissPackage(c.env, c.req.param('id'), 'operator') });
});
// The editorial spine — each step is a shared-pool tool (reasoning via the llm
// gateway); routes just trigger them with the operator actor.
app.post('/api/hot-takes/packages/:id/draft-take', async (c) => {
  const res = await runTool(c.env, 'hottake_draft_take', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/build-brief', async (c) => {
  const res = await runTool(c.env, 'hottake_build_brief', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/draft-angle', async (c) => {
  const res = await runTool(c.env, 'hottake_draft_angle', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/abandon', async (c) => {
  const res = await runTool(c.env, 'hottake_abandon_draft', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/refine', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'hottake_refine', { id: c.req.param('id'), stage: b.stage, direction: b.direction, actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/write-article', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try {
    const res = await runTool(c.env, 'hottake_write_article', { id: c.req.param('id'), voice: b.voice, actor: 'operator', confirm: true, operator_words: 'module UI: operator approved the angle in the drafting dialog and clicked write' });
    return c.json(res, res?.error ? 400 : 200);
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 500);
  }
});
app.post('/api/hot-takes/packages/:id/review-scan', async (c) => {
  const res = await runTool(c.env, 'hottake_review_scan', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/draft-social', async (c) => {
  // Optional body {channel} narrows to a single-leg redraft.
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'hottake_draft_social', { id: c.req.param('id'), channel: b?.channel || undefined, actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/schedule', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'hottake_schedule_release', { id: c.req.param('id'), ...b, actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/cancel-schedule', async (c) => {
  const res = await runTool(c.env, 'hottake_cancel_schedule', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
// Plain blog drafts (no package yet) — schedule or social-draft by slug; the
// tool adopts the draft into the release pipeline (ensurePackageForSlug).
app.post('/api/hot-takes/blog/:slug/schedule', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const res = await runTool(c.env, 'hottake_schedule_release', { slug: c.req.param('slug'), ...b, actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/blog/:slug/draft-social', async (c) => {
  const res = await runTool(c.env, 'hottake_draft_social', { slug: c.req.param('slug'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/packages/:id/publish-website', async (c) => {
  const res = await runTool(c.env, 'hottake_publish_website', { id: c.req.param('id'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.post('/api/hot-takes/posts/:postId/send', async (c) => {
  const res = await runTool(c.env, 'hottake_post_leg', { post_id: c.req.param('postId'), actor: 'operator' });
  return c.json(res, res?.error ? 400 : 200);
});
app.patch('/api/hot-takes/posts/:postId', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json({ post: await htPatchPost(c.env, c.req.param('postId'), b, 'operator') });
});
// Views over the same package store — the tabs.
app.get('/api/hot-takes/pipeline', async (c) => c.json(await htPipelineView(c.env)));
app.get('/api/hot-takes/article/:id', async (c) => {
  const v = await htArticleView(c.env, c.req.param('id'));
  return v ? c.json(v) : c.json({ error: 'not found' }, 404);
});
app.patch('/api/hot-takes/article/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(await htSaveArticleEdit(c.env, c.req.param('id'), b, 'operator'));
});
app.get('/api/hot-takes/schedule', async (c) => c.json(await htScheduleView(c.env, { days: Number(c.req.query('days')) || 30 })));
app.get('/api/hot-takes/sources', async (c) => c.json(await htListApprovedSources(c.env)));
app.get('/api/hot-takes/search', async (c) => c.json(await htSearch(c.env, { q: c.req.query('q') || '' })));
app.get('/api/hot-takes/notes', async (c) => c.json(await htLoadNotes(c.env)));
app.get('/api/hot-takes/state', async (c) => c.json({ live: await htLive(c.env) }));
// Poster identities for the social-post previews — read from the editable
// `hottakes-social-identities` note, never hardcoded.
app.get('/api/hot-takes/social-identities', async (c) => {
  const { loadSocialIdentities } = await import('./lib/hot-takes.js');
  try { return c.json({ identities: await loadSocialIdentities(c.env) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.post('/api/hot-takes/run-due', async (c) => c.json(await htRunDueReleases(c.env, { ctx: c.executionCtx })));

// ─── Digest (morning brief — actionable summary across sources) ──
// ─── Outbox (unified outbound send log across channels) ─────────
// ─── Social (auto-drafted social posts from published blog articles) ────
app.post('/api/social/generate/:slug', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Same declarative workflow the publish fan-out runs — one definition, one
  // trail. The CLIENT contract stays the tool's result ({ok, drafted, skipped,
  // reason}) + run_id: a runner-level failure (disabled workflow / step threw)
  // maps to 400 like the pre-workflow route did, not a silent 200.
  try {
    const { runWorkflow, seedSystemWorkflows } = await import('./workflows/runner.js');
    await seedSystemWorkflows(c.env);
    const r = await runWorkflow(c.env, 'social-drafts-for-article', { slug: c.req.param('slug'), force: !!body.force });
    if (!r.ok) return c.json({ error: r.error || `workflow failed at step ${r.failed_step} (${r.tool})`, run_id: r.run_id || null }, 400);
    const inner = r.results?.[r.results.length - 1]?.result ?? {};
    return c.json({ ...inner, run_id: r.run_id });
  } catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// ─── LinkedIn (local hybrid gateway: voyager reads + Playwright posts) ─
async function safeLi(c, fn) {
  try { return c.json(await fn()); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
}

// ─── Heartbeat (OSINT v2 — awareness layer) ──────────────────
app.post('/api/heartbeat/run', async (c) => {
  const { runHeartbeat } = await import('./lib/heartbeat.js');
  try { return c.json(await runHeartbeat(c.env, { actor: 'manual' })); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 500); }
});
// Score gates — the thresholds that decide what survives each stage. They are
// stored in the `heartbeat-priorities` knowledge note, not in code, so these
// routes read/write that note rather than any constant.
app.get('/api/heartbeat/gates', async (c) => {
  const { heartbeatGates } = await import('./lib/heartbeat.js');
  try { return c.json({ gates: await heartbeatGates(c.env) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.put('/api/heartbeat/gates', async (c) => {
  const { patchHeartbeatGates } = await import('./lib/heartbeat.js');
  try { return c.json({ gates: await patchHeartbeatGates(c.env, await c.req.json()) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.get('/api/heartbeat/signals', async (c) => {
  const { topSignals } = await import('./lib/heartbeat.js');
  const minContent = parseInt(c.req.query('min') || '55', 10);
  const days = parseInt(c.req.query('days') || '7', 10);
  return c.json({ signals: await topSignals(c.env, { days, minContent, limit: 30 }) });
});
app.get('/api/heartbeat/pulse', async (c) => {
  const { readPulse } = await import('./lib/heartbeat.js');
  return c.json({ pulse: await readPulse(c.env) });
});
// OSINT hot topics — synthesized, digest-ready angles from the scored signals.
app.post('/api/heartbeat/enrich', async (c) => {
  const { enrichSignals } = await import('./lib/heartbeat.js');
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await enrichSignals(c.env, { limit: body.limit || 8, minRelevance: body.minRelevance ?? 50 })); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 500); }
});
app.get('/api/heartbeat/sources', async (c) => {
  const { listHeartbeatSources } = await import('./lib/heartbeat.js');
  return c.json({ sources: await listHeartbeatSources(c.env) });
});
app.post('/api/heartbeat/sources', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { writeHeartbeatSource } = await import('./lib/heartbeat.js');
  try { return c.json({ source: await writeHeartbeatSource(c.env, body) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.patch('/api/heartbeat/sources/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { writeHeartbeatSource } = await import('./lib/heartbeat.js');
  try { return c.json({ source: await writeHeartbeatSource(c.env, { ...body, id: c.req.param('id') }) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
app.delete('/api/heartbeat/sources/:id', async (c) => {
  const { deleteHeartbeatSource } = await import('./lib/heartbeat.js');
  return c.json(await deleteHeartbeatSource(c.env, c.req.param('id')));
});

// ─── OSINT (review/mention scrapers — port of inrepute) ─────
app.get('/api/osint/listeners', async (c) => c.json({ listeners: await listOsintListeners(c.env) }));
app.get('/api/osint/listeners/:source', async (c) => {
  const l = await readOsintListener(c.env, c.req.param('source'));
  if (!l) return c.json({ error: 'not found' }, 404);
  return c.json({ listener: l });
});
app.patch('/api/osint/listeners/:source', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json({ listener: await patchOsintListener(c.env, c.req.param('source'), body) }); }
  catch (e) { return c.json({ error: String(e?.message || e) }, 400); }
});
// ─── home_sections (per-section visibility + ordering) ───────
app.get('/api/sections', async (c) => {
  const page = c.req.query('page') || 'home';
  return c.json({ sections: await listSections(c.env, page) });
});
app.patch('/api/sections/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ section: await patchSection(c.env, c.req.param('id'), body) });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
app.put('/api/sections/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ section: await upsertSection(c.env, c.req.param('id'), body) });
});
app.post('/api/sections/reorder', async (c) => {
  const body = await c.req.json();
  const page = body?.page || 'home';
  try {
    return c.json({ sections: await reorderSections(c.env, page, body?.order || []) });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});
app.delete('/api/sections/:id', async (c) => {
  const r = await deleteSection(c.env, c.req.param('id'));
  return c.json(r, r.ok ? 200 : 404);
});

// ─── feature flags ────────────────────────────────────────────
app.get('/api/feature-flags', async (c) => c.json({ flags: await listFlags(c.env) }));
app.put('/api/feature-flags/:key', async (c) => {
  const { value } = await c.req.json();
  await setFlag(c.env, c.req.param('key'), !!value);
  return c.json({ ok: true });
});


// ─── registry (live: gateways + Nyo tools + workflows + knowledge deps) ──
// Replaces the old hand-maintained modules/tools tables — derived from code.
app.get('/api/registry', async (c) => c.json(await buildRegistry(c.env)));

// ─── Plugins (trade capabilities between nyyon systems) ─────────────────
// Operator surface (gated): list / import / export / remove / materialize.
// Applier surface (bearer NYYON_APPLIER_KEY, exempted in gate.js):
// pending / applied / verify — future-proofing on cmd, where materialize
// commits through the GitHub gateway and CI redeploys.
app.get('/api/plugins', async (c) => {
  const { listPlugins } = await import('./lib/plugins.js');
  return c.json({ plugins: await listPlugins(c.env) });
});
app.post('/api/plugins/import', async (c) => {
  const raw = await c.req.text().catch(() => '');
  // Same ceiling as the URL/zip doors, checked BEFORE parse so an oversized
  // paste gets a clean refusal instead of a D1 row-size failure later.
  if (raw.length > 5_000_000) return c.json({ ok: false, error: 'manifest too large (5 MB limit; D1 stores it as one ~2 MB row, so stay well under that)' }, 400);
  const body = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (!body?.manifest) return c.json({ ok: false, error: 'manifest required' }, 400);
  const { importPlugin } = await import('./lib/plugins.js');
  return c.json(await importPlugin(c.env, body.manifest, { actor: 'operator' }));
});
// The primary import path: a SOURCE, not a file. A URL carries a version, can
// be re-fetched when the author ships a fix, and can be read before it is
// trusted — none of which a pasted blob or a zip on a desktop can do.
app.post('/api/plugins/import-url', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.url) return c.json({ ok: false, error: 'url required' }, 400);
  try {
    const { manifestFromUrl } = await import('./lib/plugin-package.js');
    const manifest = await manifestFromUrl(c.env, body.url, body.ref);
    const { importPlugin } = await import('./lib/plugins.js');
    const r = await importPlugin(c.env, manifest, { actor: 'operator' });
    return c.json({ ...r, source: manifest.origin });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});
// A plugin package (.zip): manifest.json + real .mjs / .md files. The
// authoring form — editable and diffable — assembled back into the canonical
// manifest on import, so nothing downstream knows which form arrived.
app.post('/api/plugins/import-package', async (c) => {
  const buf = await c.req.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return c.json({ ok: false, error: 'no package uploaded' }, 400);
  if (buf.byteLength > 5_000_000) return c.json({ ok: false, error: 'package too large (5 MB limit)' }, 400);
  try {
    const { manifestFromZip } = await import('./lib/plugin-package.js');
    const manifest = await manifestFromZip(buf);
    const { importPlugin } = await import('./lib/plugins.js');
    return c.json(await importPlugin(c.env, manifest, { actor: 'operator' }));
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 400);
  }
});
app.get('/api/plugins/surfaces', async (c) => {
  const { pluginSurfaces } = await import('./lib/plugins.js');
  return c.json({ surfaces: await pluginSurfaces(c.env) });
});
app.post('/api/plugins/:name/invoke/:tool', async (c) => {
  const input = await c.req.json().catch(() => ({}));
  const { invokePluginTool } = await import('./lib/plugins.js');
  const r = await invokePluginTool(c.env, c.req.param('name'), c.req.param('tool'), input);
  return c.json(r, r.ok ? 200 : 400);
});
// The cloud materializer: commit every bound plugin's code to the repo
// (GitHub gateway) and let the push-to-main CI pipeline redeploy. Operator
// -gated on purpose — a deploy-triggering commit is not an applier read.
app.post('/api/plugins/materialize', async (c) => {
  const { materializePending } = await import('./lib/plugins.js');
  return c.json(await materializePending(c.env));
});
app.get('/api/plugins/registry', async (c) => {
  const { pluginRegistry } = await import('./lib/plugins.js');
  return c.json({ plugins: await pluginRegistry(c.env) });
});
// The Expand builder prompt: everything an EXTERNAL LLM needs to author a
// plugin for THIS install — the contract (operator-annotated copy), the live
// gateway slugs + modes, the taken names, and how to deliver. Assembled fresh
// per request so it never drifts from the running system.
app.get('/api/plugins/builder-prompt', async (c) => {
  const { loadPluginFormatDoc } = await import('./lib/expand-contract.js');
  const { listGateways } = await import('./gateways/index.js');
  const contract = (await loadPluginFormatDoc(c.env)).body;
  const gateways = listGateways().map((g) => `- ${g.slug}: modes [${(g.modes || []).join(', ')}]`).join('\n');
  const rows = (await c.env.DB.prepare('SELECT name FROM plugins').all().catch(() => ({ results: [] }))).results || [];
  const taken = rows.map((r) => r.name).join(', ') || '(none yet)';
  const prompt = [
    'You are helping me author a plugin for my Nyyon Command Center. A plugin is ONE JSON manifest; my command center validates it, binds its gateway needs, activates its data instantly, and materializes any code through CI. Your job: interview me briefly (what should it DO, what data does it own, which gateways does it need), then produce the complete manifest JSON in one code block.',
    '',
    'Rules of the road:',
    '- The contract below is the law. Never invent a gateway slug or a mode: use exactly the live registry list included after it.',
    '- Plugin names already taken on my install: ' + taken + '.',
    '- Deliver ONE JSON object (nyyon_plugin: 2). I will paste it into my command center (Expand page, import box). The importer returns precise errors; I will paste them back to you. Fix and re-emit the FULL manifest each time until it imports clean.',
    '- Code-carrying plugins go live a few minutes after import (CI deploy); data-only plugins (knowledge + workflows) are live immediately.',
    '- Size limits: the whole manifest must stay under ~1 MB (it is stored as one database row capped at 2 MB; the import doors cap at 5 MB). Each tool/lib file becomes its own repo commit at materialize time, so keep any single code string under ~500 KB. Real plugins run tens of KB. If a capability wants more code than that, split it into smaller tools or lean on host gateways instead of vendoring logic.',
    '',
    '=== THE CONTRACT ===',
    contract,
    '',
    '=== LIVE GATEWAY REGISTRY (this install, right now) ===',
    gateways,
  ].join('\n');
  return c.json({ prompt });
});

// The local materializer's three calls (scripts/materialize.mjs). Session-
// gated like every operator route: the script signs in with the operator's
// own login, so no extra key exists.
app.get('/api/plugins/pending', async (c) => {
  const { pendingMaterializations } = await import('./lib/plugins.js');
  return c.json(await pendingMaterializations(c.env));
});
app.post('/api/plugins/applied', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { markMaterialized } = await import('./lib/plugins.js');
  const out = {};
  for (const n of Array.isArray(body?.names) ? body.names : []) out[n] = await markMaterialized(c.env, String(n), { ok: body?.ok !== false, error: body?.error || null });
  return c.json({ ok: true, results: out });
});
app.post('/api/plugins/cleaned', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { markCleaned } = await import('./lib/plugins.js');
  const out = {};
  for (const n of Array.isArray(body?.names) ? body.names : []) out[n] = await markCleaned(c.env, String(n));
  return c.json({ ok: true, results: out });
});

app.post('/api/plugins/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { verifyPlugin } = await import('./lib/plugins.js');
  return c.json(await verifyPlugin(c.env, body.name));
});
app.get('/api/plugins/:name/export', async (c) => {
  const { exportPlugin } = await import('./lib/plugins.js');
  try { return c.json(await exportPlugin(c.env, c.req.param('name'))); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 404); }
});
// Export as a PACKAGE: the folder shape, zipped — real .mjs/.md/.tsx files the
// receiving operator can open and diff before importing.
app.get('/api/plugins/:name/package', async (c) => {
  const name = c.req.param('name');
  try {
    const { exportPlugin } = await import('./lib/plugins.js');
    const { packageFiles, writeZip } = await import('./lib/plugin-package.js');
    const zip = writeZip(packageFiles(await exportPlugin(c.env, name)));
    return new Response(zip, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name}.nyyon-plugin.zip"`,
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 404);
  }
});
app.delete('/api/plugins/:name', async (c) => {
  const { removePlugin } = await import('./lib/plugins.js');
  try { return c.json(await removePlugin(c.env, c.req.param('name'))); }
  catch (e) { return c.json({ ok: false, error: String(e?.message || e) }, 404); }
});

// ─── funnel: tracking + identity stitching + conversions ─────
// Pull-sync from the gateway (the WhatsApp source of truth) into the D1 cache.
// This replaces the old webhook-into-this-API path: nothing pushes to us — we
// call the gateway. Triggered by the wake-up, digest generation, and on demand.
// ─── Dev-invoke API — authenticated curl access to every component ────────
// Auth: DEV_API_KEY bearer token, checked in gate.js, scoped to /api/dev/*.
// The operator's test bench: list the registries, invoke any tool/gateway/
// workflow directly, every invocation logged to Activity as dev_invoke.
app.get('/api/dev/registry', async (c) => c.json(await devListRegistry(c.env)));
app.post('/api/dev/tools/:name', async (c) => {
  const input = await c.req.json().catch(() => ({}));
  const r = await devInvokeTool(c.env, c.req.param('name'), input);
  return c.json(r, r.ok ? 200 : 400);
});
app.post('/api/dev/gateways/:slug', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await devInvokeGateway(c.env, c.req.param('slug'), body);
  return c.json(r, r.ok ? 200 : 400);
});
app.post('/api/dev/workflows/:slug', async (c) => {
  const input = await c.req.json().catch(() => ({}));
  // Seed system workflows first (idempotent) so a system slug is runnable on a
  // fresh DB — mirrors the social-drafts run route.
  const { seedSystemWorkflows } = await import('./workflows/runner.js');
  await seedSystemWorkflows(c.env).catch(() => {});
  const r = await devInvokeWorkflow(c.env, c.req.param('slug'), input);
  return c.json(r, r.ok ? 200 : 400);
});

// ─── Nyo chat (SSE) ───────────────────────────────────────────
app.post('/api/chat', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body?.messages)) return c.json({ error: 'messages required' }, 400);
  return handleChat(c.env, body);
});

// ─── Nyo conversation history — browse and resume past threads ────
// `agent` scopes the list to one persona's threads (omitted = Nyo), so the Nyo
// panel never shows or reopens a Daily Planner conversation.
app.get('/api/chat/conversations', async (c) => c.json(
  await listConversations(c.env, {
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
    agent: c.req.query('agent') || null,
  }),
));

app.get('/api/chat/conversations/:id', async (c) => {
  const conv = await readConversation(c.env, c.req.param('id'), { agent: c.req.query('agent') || null });
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  return c.json(conv);
});

app.patch('/api/chat/conversations/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await renameConversation(c.env, c.req.param('id'), body?.title));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

app.delete('/api/chat/conversations/:id', async (c) => {
  try {
    return c.json(await deleteConversation(c.env, c.req.param('id')));
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 400);
  }
});

// ─── Finance (monthly cashflow calculator) ──────────────────────────────
async function handleScheduled(event, env, ctx) {
  // Two cron slots (wrangler.jsonc triggers.crons):
  //   "0 * * * *" (hourly) → the awareness sweep: OSINT scrape → heartbeat →
  //                          regenerate the digest → fire meeting reminders.
  //   "0 6 * * *" (daily)  → AEO article publisher ONLY (never hourly — it would
  //                          double-post to your website).
  // At 06:00 both expressions fire, but each invocation carries its own
  // event.cron, so we branch and never double-run the sweep.
  const cron = event.cron || '';


  // ── Hourly awareness sweep — one LEG per invocation. The three legs used to
  // chain inside one invocation and together blew the Worker subrequest budget
  // (seen live twice: heartbeat died on "Too many subrequests" after the OSINT
  // scrapes). Staggered cron slots give each leg its own budget: :00 OSINT,
  // :15 heartbeat scoring, :30 digest regenerate — the digest still reads this
  // hour's fresh mentions/signals. Every leg logs a workflow_runs row under
  // the same hourly-awareness-sweep slug with output.leg naming it.
  const logLeg = (leg, startedAt, output, error) => logWorkflowRun(env, {
    workflow_slug: 'hourly-awareness-sweep', status: error ? 'failed' : 'succeeded',
    trigger_kind: 'cron', output: { leg, ...(output || {}) }, started_at: startedAt,
    error: error ? `${leg}: ${error}` : null,
  }).catch(console.error);

  if (cron.startsWith('15 ')) {
    ctx.waitUntil((async () => {
      const t0 = Date.now();
      try {
        const { runHeartbeat } = await import('./lib/heartbeat.js');
        const r = await runHeartbeat(env, { actor: 'heartbeat-cron' });
        console.log('[heartbeat-cron]', cron, JSON.stringify({ inserted: r.inserted, scored: r.scored }));
        await logLeg('heartbeat', t0, { inserted: r.inserted, scored: r.scored }, null);
      } catch (e) {
        console.error('[heartbeat-cron] unhandled', e?.message || e);
        await logLeg('heartbeat', t0, null, String(e?.message || e));
      }
    })());
    return;
  }


  // :45 — LI Outreach tick. Own cron slot = own subrequest budget (jittered
  // sends + a lazy profile resolve per connect can add up). The tick itself
  // caps, active hours, per-tick cap, per-send jitter.
  if (cron.startsWith('45 ')) {
    // Heartbeat scoring — the LIVE TOPICS feed. Its designed :15 slot was
    // never bound (account cron cap), so topics-of-the-day starved on stale
    // data while Hot Takes pretended to offer the world's news. Rides :45.
    ctx.waitUntil((async () => {
      try {
        const { runHeartbeat } = await import('./lib/heartbeat.js');
        const r = await runHeartbeat(env, {});
        console.log('[heartbeat]', cron, JSON.stringify({ ingested: r?.ingested ?? null, scored: r?.scored ?? null }));
      } catch (e) { console.error('[heartbeat] unhandled', e?.message || e); }
    })());


    return;
  }



  // Hot Takes due-scan — publish scheduled websites + fire scheduled LinkedIn
  // legs that are due. Website publishes are REAL (same trust as the Blog
  // Approve button); LinkedIn legs stay dry-run (log-only) unless the operator
  // set the hottakes.live feature flag. Own waitUntil + own workflow_runs row.
  ctx.waitUntil((async () => {
    const t0 = Date.now();
    try {
      const r = await htRunDueReleases(env, { ctx });
      const n = (r.website_published?.length || 0) + (r.posts_sent?.length || 0);
      if (n || r.errors?.length) console.log('[hottake-cron]', cron, JSON.stringify(r));
      await logWorkflowRun(env, {
        workflow_slug: 'hottake-scheduler', status: r.errors?.length ? 'failed' : 'succeeded',
        trigger_kind: 'cron', output: r, started_at: t0,
        error: r.errors?.length ? JSON.stringify(r.errors).slice(0, 500) : null,
      }).catch(console.error);
    } catch (e) {
      console.error('[hottake-cron] unhandled', e?.message || e);
      await logWorkflowRun(env, {
        workflow_slug: 'hottake-scheduler', status: 'failed',
        trigger_kind: 'cron', error: String(e?.message || e), started_at: t0,
      }).catch(console.error);
    }
  })());






  // GTM Watch — LinkedIn signal monitor over operator-flagged leads. READS
  // only (profile headline diff + company open-roles); a NEW signal pings the
  // OPERATOR (digest + his own WhatsApp) with a drafted response. It never
  // messages a lead. Bounded by the gtm-watch doc (leads_per_tick).
  ctx.waitUntil((async () => {
    try {
      const { runWatchTick } = await import('./lib/gtm-watch.js');
      const r = await runWatchTick(env);
      if (r.checked || r.errors) console.log('[gtm-watch]', cron, JSON.stringify(r));
    } catch (e) { console.error('[gtm-watch] unhandled', e?.message || e); }
  })());



}

// Authenticated fall-through: the gate passed and no /api route matched, so
// serve the built SPA (web/dist). run_worker_first=true routes every request
// through the Worker, so this handler is what actually serves static assets
// via the STATIC binding (with SPA fallback to index.html).
app.all('*', async (c) => {
  if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404);
  return c.env.STATIC.fetch(c.req.raw);
});

export default {
  fetch: async (req, env, ctx) => {
    // Remember this install's own origin so freshly generated asset URLs can
    // default to it when no ASSETS_BASE_URL is configured (lib/self-origin.js).
    noteSelfOrigin(req.url);
    // A brand-new database provisions itself on first contact (lib/schema.js).
    await ensureSchema(env).catch(() => {});
    return app.fetch(req, env, ctx);
  },
  scheduled: async (event, env, ctx) => {
    await ensureSchema(env).catch(() => {});
    return handleScheduled(event, env, ctx);
  },
};
