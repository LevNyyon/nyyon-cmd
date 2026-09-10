// First-run setup — the sequence a new operator walks on a fresh install.
//
//   1. Account     — username + password, a plain form. Creates the login and
//                    signs them in.
//   2. Model key   — everything this install writes runs on a model.
//   3. Connections — the services prospecting uses (serp, pdl, ...). All
//                    optional; sources self-skip when a key is missing.
//
// AND THAT IS ALL OF IT. Finish lands in the app.
//
// The voice interview is NOT a setup step any more. It runs AFTER the operator
// is inside, in the normal Nyo chat: Nyo notices the voice docs are missing,
// offers the interview, and follows the onboarding-voice-playbook knowledge
// doc (lib/onboarding-playbook.js seeds it at finish). Asking someone to
// describe their writing voice for fifteen minutes before they have seen the
// product is asking them to brief a machine they have not met — and Nyo
// already has the tools the interview needs (read_knowledge for the playbook,
// write_knowledge for the docs). The universal anti-AI blocks are welded on
// mechanically in the write_knowledge tool, so no model wording can drop them.
import { llmTransportAnthropic } from './openai.js';
import { noteLlmOk } from './llm.js';
import { logEvent } from './db.js';
import { loadOnboardingPlaybook } from './onboarding-playbook.js';
import {
  readInstallState, setAdminCredentials, markSetupComplete,
} from './install.js';
import { listGatewayStatus, saveGatewayConfig, resolveCredential } from './gateway-config.js';

// Is there a model key at all? Cheap: a key's PRESENCE decides whether the
// interview can be offered; whether it WORKS is proved separately by
// verifyLlmKey, which spends a real (tiny) request to find out.
export async function llmConfigured(env) {
  try {
    if (await resolveCredential(env, 'ANTHROPIC_API_KEY')) return true;
  } catch { /* fall through to the backup check */ }
  // A connected backup brain COUNTS — and the check must ask the gateway
  // registry, never a named table. It peeked at free-llm's table, so a key
  // stored by the gemini pack (its OWN table) left llm_ready false and boot
  // bounced the operator back onto the model step forever: verified,
  // configured, stuck. Any plugin advertising llm-backup satisfies this.
  try {
    const { pickBackupLlm } = await import('../gateways/index.js');
    return !!(await pickBackupLlm(env));
  } catch { return false; }
}

// Save a model key and PROVE it before letting the operator past this step.
// An unverified key means the next screen dies with a wall of nothing and no
// explanation, which is the worst possible first minute with a product.
export async function saveAndVerifyLlmKey(env, { key, provider = 'anthropic' }) {
  const clean = String(key || '').trim();
  if (!clean) return { ok: false, error: 'Paste your API key to continue.' };

  const field = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  await saveGatewayConfig(env, 'llm', { [field]: clean, ...(provider === 'openai' ? { LLM_PROVIDER: 'openai' } : {}) });

  try {
    // Verify against the provider DIRECTLY, bypassing the circuit breaker.
    //
    // The breaker protects running jobs: one failure marks the model down and
    // routes everything to the local fallback. During setup that is exactly
    // wrong — a mistyped key trips it, and then the CORRECT key cannot be
    // verified either ("local model unavailable"), so one typo locks the
    // operator out of the step with an error about a fallback they have never
    // heard of. A key check is a probe, not production traffic.
    // Verify with the key JUST PASTED: it lives in the database, not in env,
    // and a fresh deploy has no env key at all.
    const r = await llmTransportAnthropic({ ...env, [field]: clean }, {
      model: env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ok' }],
    }, { timeoutMs: 30_000 });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${body.slice(0, 200)}`);
    }
    // A working key also proves the model is reachable, so clear any "down"
    // an earlier bad attempt recorded.
    await noteLlmOk(env).catch(() => {});
    return { ok: true, provider, verified: true };
  } catch (e) {
    // Roll the bad key back out so a retry starts clean rather than layering
    // a second wrong value over a first.
    await saveGatewayConfig(env, 'llm', { [field]: '' }).catch(() => {});
    const msg = String(e?.message || e);
    const friendly = /401|403|invalid|authentication|x-api-key/i.test(msg)
      ? 'That key was rejected by Anthropic. Check you pasted the whole key.'
      : /timed out|timeout|abort/i.test(msg)
        ? 'Could not reach Anthropic — the request timed out. Check your connection and try again.'
        : `Could not verify the key: ${msg.slice(0, 160)}`;
    return { ok: false, error: friendly };
  }
}

// ── the four state transitions ──────────────────────────────────────────────
// Thin, named, and all in one place so the routes never import the install
// store directly and every transition lands on the activity bus exactly once
// (install.js logs them).

// STEP ONE. Creates the login; the ROUTE issues the session cookie afterwards.
// Refuses on an install with no GATE_SECRET rather than handing the operator a
// credential no session could ever be signed with: they would set a password,
// get a 500 on the way in, and be locked out of a product they just installed.
export async function createOperatorAccount(env, { username, password } = {}) {
  if (!env.GATE_SECRET) {
    throw new Error('cannot create the account: GATE_SECRET is not configured on this install, so no sign-in session could be issued. Set it (the installer generates it) and try again.');
  }
  const r = await setAdminCredentials(env, { username, password });
  return { ok: true, username: r.username };
}

// THE LAST STEP. Closes setup permanently. Also seeds the interview playbook
// knowledge doc, so the Nyo that greets them knows how to run the voice
// interview they have not done yet.
export async function finishSetup(env, { reason = 'setup', tz = null } = {}) {
  await loadOnboardingPlaybook(env).catch(() => {});
  // The knowledge tree root. Every seeded doc parents to nyyon-root; without
  // this row they render orphaned in the Knowledge tree on a fresh install.
  try {
    const { readKnowledge, writeKnowledge } = await import('./db.js');
    if (!(await readKnowledge(env, 'nyyon-root'))) {
      await writeKnowledge(env, {
        slug: 'nyyon-root', title: 'Knowledge',
        body: 'The root of this install\'s knowledge tree. Docs here are live configuration: the modules read them at run time, so editing a doc changes behavior with no deploy. The voice interview (ask Nyo) writes the docs that make this system sound like you.',
        parent_slug: null,
      });
    }
  } catch { /* cosmetic tree root — never fail finish on it */ }
  // The operator's own clock: the wizard sends the browser timezone, and the
  // planner-rhythm doc seeds from it so a fresh install never plans in the
  // shipped default zone. Never touches an existing doc.
  try {
    const { seedKpiConfig } = await import('./kpi.js');
    await seedKpiConfig(env, { tz });
  } catch { /* planner falls back to code defaults; not worth failing finish */ }
  const r = await markSetupComplete(env, { reason: String(reason || 'setup').slice(0, 40) });
  return { ok: true, ...r };
}

// Where the operator is in the SEQUENCE. Three answers are forms the app
// owns; the fourth is the app itself.
function deriveStep({ install, llmReady }) {
  if (install.setup_complete) return 'done';
  if (!install.has_admin) return 'account';
  if (!llmReady) return 'llm-key';
  return 'gateways';
}

// Where setup stands. Deliberately shallow: the SPA asks this BEFORE anyone
// has proved anything (it picks the boot screen), so the answer carries only
// how far this install has been claimed, which leaks nothing.
export async function onboardingState(env) {
  const install = await readInstallState(env);
  const llm_ready = await llmConfigured(env);
  return {
    needed: install.needs_setup,
    llm_ready,
    has_admin: Boolean(install.has_admin),
    setup_complete: Boolean(install.setup_complete),
    setup_token_set: Boolean(install.setup_token_set),
    install_id: install.install_id || null,
    step: deriveStep({ install, llmReady: llm_ready }),
  };
}

// Thin pass-throughs so the routes never import the store libs directly and
// the onboarding surface stays one module wide.
export async function onboardingGateways(env) {
  return listGatewayStatus(env);
}
export async function connectOnboardingGateway(env, slug, config) {
  const r = await saveGatewayConfig(env, slug, config || {});
  await logEvent(env, { kind: 'onboarding_gateway_connected', actor: 'operator', payload: { slug: r.slug } }).catch(() => {});
  return r;
}
