// GATEWAYS registry — the single machine-readable pool of service boundaries.
//
// nyyon-lite layer 1. Each entry wraps ONE external service class with a
// uniform surface: { slug, service, description, modes: { name: fn(env, input) } }.
// Entries are thin adapters over the existing lib/ implementations (zero
// behavior change); as the gateway extraction sweep proceeds, more services
// move out of fused libs and register here.
//
// Call through callGateway(env, slug, mode, input) — used by the dev-invoke
// API today, and the intended seam for tools as the refactor lands.

import {
  callOpenAIText, callOpenAIJson, callOpenAIVision,
} from '../lib/openai.js';
import { getLlmHealth } from '../lib/llm.js';
import {
  probeLinkedIn, getMyProfile, getProfile, getProfileDash, getProfilePosts, getFeed, getLiCompany, getLiCompanyJobs,
  searchPeople, listSentInvitations, sendDirectMessage, sendConnectionRequest, postText,
  listConversations, getConversationMessages, getSentMessages,
  reactToPost, commentOnPost,
} from '../lib/linkedin.js';
import {
  renderImage, storeImageBytes, readImage, generateImage, IMAGE_MODELS,
} from '../lib/image-gateway.js';
import { fetchText as webFetchText, head as webHead, postJson as webPostJson, fetchBytes as webFetchBytes } from '../lib/web-gateway.js';
import { writeContact as crmWriteContact } from '../lib/db.js';
import { promoteLeadToPipeline, listPipeline, updateDeal } from '../lib/pipeline.js';
import { pdlEnrich, twilioLookup, serpSearch } from '../lib/gtm.js';
import { fetchTheorg, probeTheorg } from '../lib/gtm-context.js';
import { hfComplete, probeHf } from '../lib/hf-gateway.js';
import { ghConfigured } from '../lib/github-gateway.js';
import { pluginGateways } from '../plugins/index.js';

export const GATEWAYS = {
  llm: {
    slug: 'llm',
    service: 'Anthropic Messages API (fallback: local Ollama via circuit breaker)',
    description: 'The ONLY sanctioned LLM boundary. text/json/vision completions; vision always requires OPENAI_API_KEY.',
    modes: {
      text:   (env, input) => callOpenAIText(env, input),
      json:   (env, input) => callOpenAIJson(env, input),
      vision: (env, input) => callOpenAIVision(env, input),
      health: (env) => getLlmHealth(env),
    },
  },
  linkedin: {
    slug: 'linkedin',
    service: 'linkedin-gateway daemon (tunneled FastAPI, LI_BASE_URL)',
    description: 'Reads/writes the operator LinkedIn account through the local gateway daemon.',
    modes: {
      probe:        (env) => probeLinkedIn(env),
      me:           (env) => getMyProfile(env),
      profile:      (env, input) => getProfile(env, input?.public_id),
      // modern dash lookup by /in/<slug> — the legacy `profile` mode is
      // HTTP-410-dead at LinkedIn; this one powers add-by-URL intake.
      profile_lookup: (env, input) => getProfileDash(env, input?.public_id),
      profile_posts: (env, input) => getProfilePosts(env, input?.urn_id || input?.public_id, input?.count),
      feed:         (env, input) => getFeed(env, input || {}),
      company:      (env, input) => getLiCompany(env, input?.universal_name),
      company_jobs: (env, input) => getLiCompanyJobs(env, input?.company_id),
      search:       (env, input) => searchPeople(env, input || {}),
      sent_invitations: (env) => listSentInvitations(env),
      dm:           (env, input) => sendDirectMessage(env, input || {}),
      connect:      (env, input) => sendConnectionRequest(env, input || {}),
      post:         (env, input) => postText(env, input || {}),
      react:        (env, input) => reactToPost(env, { post_url: input?.post_url || (input?.urn ? `https://www.linkedin.com/feed/update/${input.urn}/` : null), reaction: input?.reaction || 'LIKE' }),
      comment:      (env, input) => commentOnPost(env, input?.urn, input?.text),
      conversations:        (env, input) => listConversations(env, input || {}),
      conversation_messages: (env, input) => getConversationMessages(env, input?.conversation_urn, input || {}),
      sent_messages:        (env, input) => getSentMessages(env, input || {}),
    },
  },
  image: {
    slug: 'image',
    service: 'image generation (OpenAI Images / Cloudflare Workers AI, model-routed)',
    description: 'Generates imagery. No knowledge of blogs or social — callers bring their own keys/prompts. Storage lives in the assets gateway.',
    modes: {
      models:   () => ({ models: IMAGE_MODELS }),
      render:   (env, input) => renderImage(env, input || {}),
      generate: (env, input) => generateImage(env, input || {}),
    },
  },
  assets: {
    slug: 'assets',
    service: 'Cloudflare R2 bucket (nyyon-assets)',
    description: 'Binary asset store behind ASSETS_BASE_URL — featured images, lead photos, org-chart avatars.',
    modes: {
      store: (env, input) => storeImageBytes(env, input?.key, input?.bytes, input?.metadata || {}),
      read:  (env, input) => readImage(env, input?.key),
    },
  },
  web: {
    slug: 'web',
    service: 'the public web (generic http(s) fetch)',
    description: 'Shared bounded fetch for public pages/APIs. Users: gtm import/social-scan/photo, web_fetch tool, heartbeat feeds/articles, osint scrapers.',
    modes: {
      text: (env, input) => webFetchText(env, input || {}),
      // Binary fetch — plugin packages arrive as zip archives.
      bytes: (env, input) => webFetchBytes(env, input || {}),
      head: (env, input) => webHead(env, input || {}),
      post_json: (env, input) => webPostJson(env, input || {}),
    },
  },
  // The plugin-safe boundary to the host CRM store: a traded pack that
  // promotes a lead or upserts a contact declares `crm` in requires.gateways
  // and the operator sees the grant at import — it never touches the
  // clients/contacts tables directly.
  crm: {
    slug: 'crm',
    service: 'the host CRM store (clients, contacts, pipeline deals)',
    description: 'Promote a lead into the pipeline, upsert a contact, read/update deals. The plugin-safe boundary to the clients/contacts tables.',
    modes: {
      promote: (env, input) => promoteLeadToPipeline(env, input?.id, input?.actor || 'plugin'),
      write_contact: (env, input) => crmWriteContact(env, input || {}),
      pipeline: (env) => listPipeline(env),
      update_deal: (env, input) => updateDeal(env, input?.id, input?.patch || {}, input?.actor || 'plugin'),
    },
  },
  // One slug per external service (the old bundled `enrich` slug split here):
  // each degrades to {skipped} when its secret is unset.
  pdl: {
    slug: 'pdl',
    service: 'People Data Labs person-enrich API',
    description: 'phone/name -> identity (GTM intake). Degrades to {skipped} without PDL_API_KEY.',
    modes: {
      person: (env, input) => pdlEnrich(env, input || {}),
    },
  },
  twilio: {
    slug: 'twilio',
    service: 'Twilio Lookup API',
    description: 'phone -> line type + carrier + CNAM. Degrades to {skipped} without TWILIO_ACCOUNT_SID/AUTH_TOKEN.',
    modes: {
      lookup: (env, input) => twilioLookup(env, input?.phone),
    },
  },
  serp: {
    slug: 'serp',
    service: 'SerpApi (Google Search + Lens)',
    description: 'name -> socials / company-from-LinkedIn / reverse image. Degrades to {skipped} without SERPAPI_KEY.',
    modes: {
      search: (env, input) => serpSearch(env, input || {}),
    },
  },
  hf: {
    slug: 'hf',
    service: 'Hugging Face Inference Providers (router.huggingface.co)',
    description: 'The writing fallback: heavy prose writers run here (open model picked for writing quality) while the Anthropic credit breaker is open. Model id: llm-models doc writer_fallback.',
    modes: {
      probe: (env) => probeHf(env),
      text:  (env, input) => hfComplete(env, input || {}),
    },
  },
  theorg: {
    slug: 'theorg',
    service: 'theorg.com GraphQL (public, no key)',
    description: 'company -> real org chart (names, titles, hierarchy, photos). Used by GTM Enrich.',
    modes: {
      probe:     (env) => probeTheorg(env),
      org_chart: (env, input) => fetchTheorg(env, input || {}),
    },
  },
  github: {
    slug: 'github',
    service: 'GitHub contents API (this repo, branch main — PLUGINS_GH_REPO)',
    description: 'Status only. The Plugins materializer calls lib/github-gateway.js DIRECTLY; the write modes are deliberately NOT registered here.',
    // SECURITY: put_file / delete_file / get_file / list_dir are NOT exposed as
    // gateway modes. Anything reachable through callGateway is reachable by
    // imported plugin code, and a repo-write mode backed by PLUGINS_GH_TOKEN is
    // a straight path from "install a plugin" to "arbitrary code on main plus a
    // CI deploy". lib/plugins.js imports the functions directly instead, which
    // keeps the capability inside the module that owns it.
    modes: {
      probe: (env) => ({ configured: ghConfigured(env), repo: env.PLUGINS_GH_REPO || null }),
    },
  },
};

// Bundled plugin gateways (namespaced plugin__<name>__<slug>) join the
// registry. A HOST entry always wins the key: the generated aggregator only
// ever emits plugin__ keys so nothing should collide, but this is the same
// "host wins if the check fails open" defence the tool pool has, and a gateway
// is the one layer that legitimately holds credentials.
for (const [slug, gw] of Object.entries(pluginGateways)) {
  if (GATEWAYS[slug]) continue;
  GATEWAYS[slug] = gw;
}

export function listGateways() {
  return Object.values(GATEWAYS).map((g) => ({
    slug: g.slug,
    service: g.service,
    description: g.description,
    modes: Object.keys(g.modes),
  }));
}

export async function callGateway(env, slug, mode, input) {
  const g = GATEWAYS[slug];
  if (!g) throw new Error(`unknown gateway "${slug}" — options: ${Object.keys(GATEWAYS).join(', ')}`);
  const fn = g.modes[mode];
  if (!fn) throw new Error(`gateway "${slug}" has no mode "${mode}" — options: ${Object.keys(g.modes).join(', ')}`);
  return fn(env, input);
}
