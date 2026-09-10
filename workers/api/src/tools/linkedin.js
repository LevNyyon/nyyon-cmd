// linkedin (local hybrid gateway: voyager + Playwright) — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import {
  probeLinkedIn, getMyProfile as liMyProfile, getProfile as liProfile, getFeed as liFeed, listConversations as liConversations, getConversationMessages as liConversationMessages, searchPeople as liSearchPeople, sendDirectMessage as liSendDm, sendConnectionRequest as liConnect, postText as liPostText, reactToPost as liReactPost,
} from '../lib/linkedin.js';

export const tools = {
  // ── linkedin (local hybrid gateway: voyager + Playwright) ─
  // Auth state is managed inside the gateway via cookies.json. If a tool
  // returns an "no linkedin cookies" / "session not ready" error, the
  // operator needs to capture cookies — point them at the linkedin-endpoints
  // knowledge doc.
  linkedin_status: {
    def: {
      name: 'linkedin_status',
      description: 'Probe the LinkedIn gateway. Returns reachable/ready/cookies_loaded plus the logged-in profile when ready. Call this before any other LinkedIn tool so you can give the operator a clear "needs auth" answer instead of a confusing 500.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => probeLinkedIn(env),
  },
  read_linkedin_profile: {
    def: {
      name: 'read_linkedin_profile',
      description: 'Read a LinkedIn profile by public_id (e.g. "levkerzhner" or whatever shows in the URL slug). Returns the voyager profile blob — current_company, headline, summary, locations, experience, education. Use this when the operator asks about a person or asks to draft a message tailored to them.',
      input_schema: {
        type: 'object',
        properties: { public_id: { type: 'string' } },
        required: ['public_id'],
      },
    },
    run: async (env, input) => liProfile(env, input.public_id),
  },
  me_linkedin: {
    def: {
      name: 'me_linkedin',
      description: 'Read the operator\'s own LinkedIn profile. Useful when drafting content "as them" so the voice + role line up.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => liMyProfile(env),
  },
  get_linkedin_feed: {
    def: {
      name: 'get_linkedin_feed',
      description: 'Pull recent posts from the operator\'s home feed. Useful for "what are people talking about on LinkedIn this week" — surface industry signal worth weighing in on.',
      input_schema: {
        type: 'object',
        properties: { count: { type: 'number', description: 'default 20, max 50' } },
        required: [],
      },
    },
    run: async (env, input) => liFeed(env, { count: Math.min(input?.count || 20, 50) }),
  },
  list_linkedin_dms: {
    def: {
      name: 'list_linkedin_dms',
      description: 'List DM conversation threads, newest first. Returns the conversation_urn id needed for read_linkedin_dm and surface-level metadata (other participant, last message preview). Voyager-backed, fast.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'default 25' } },
        required: [],
      },
    },
    run: async (env, input) => liConversations(env, { limit: input?.limit || 25 }),
  },
  read_linkedin_dm: {
    def: {
      name: 'read_linkedin_dm',
      description: 'Read the messages of one DM thread. Pass the conversation_urn id from list_linkedin_dms.',
      input_schema: {
        type: 'object',
        properties: {
          conversation_urn: { type: 'string' },
          limit:            { type: 'number', description: 'default 25' },
        },
        required: ['conversation_urn'],
      },
    },
    run: async (env, input) => liConversationMessages(env, input.conversation_urn, { limit: input.limit || 25 }),
  },
  send_linkedin_dm: {
    def: {
      name: 'send_linkedin_dm',
      description: 'Send a direct message to a LinkedIn profile by their urn id. Voyager-backed. Be deliberate — LinkedIn flags accounts that DM aggressively. Soft cap is 50 DMs/day across all tooling. The operator should approve copy before send unless they explicitly asked you to fire.',
      input_schema: {
        type: 'object',
        properties: {
          profile_urn_id: { type: 'string', description: 'the recipient\'s profile URN — usually obtained from search_linkedin_people' },
          body:           { type: 'string', description: 'the DM body — match Nyyon brand voice (see nyyon-brand-voice doc)' },
        },
        required: ['profile_urn_id', 'body'],
      },
    },
    run: async (env, input) => liSendDm(env, input),
  },
  post_linkedin_text: {
    def: {
      name: 'post_linkedin_text',
      description: 'FALLBACK ONLY — do NOT use this to publish. Use post_to_social (the Make-webhook gateway: linkedin-company / linkedin-personal) for LinkedIn posts — that is the reliable path. This tool drives headless Chromium (Playwright) and can hang or fail silently — it exists only as an emergency fallback. It returns {posted, verified, post_url}; never claim it went live unless verified:true. Default visibility ANYONE.',
      input_schema: {
        type: 'object',
        properties: {
          body:       { type: 'string', description: 'the post body — short paragraphs, declarative claim opener, no banned phrases (see nyyon-brand-voice doc)' },
          visibility: { type: 'string', enum: ['ANYONE', 'CONNECTIONS'], description: 'default ANYONE' },
        },
        required: ['body'],
      },
    },
    run: async (env, input) => liPostText(env, input),
  },
  react_linkedin_post: {
    def: {
      name: 'react_linkedin_post',
      description: 'React to a LinkedIn post by URL. Playwright-driven. Use sparingly — automated reactions get accounts flagged. Generally only react to posts from contacts in the pipeline or industry leaders worth signal-boosting.',
      input_schema: {
        type: 'object',
        properties: {
          post_url: { type: 'string', description: 'the full /feed/update/urn:li:activity:... URL' },
          reaction: { type: 'string', description: 'LIKE | PRAISE | EMPATHY | INTEREST | APPRECIATION | ENTERTAINMENT — default LIKE' },
        },
        required: ['post_url'],
      },
    },
    run: async (env, input) => liReactPost(env, input),
  },
  search_linkedin_people: {
    def: {
      name: 'search_linkedin_people',
      description: 'Search LinkedIn people by keywords (name, headline, company, role). Returns lightweight result rows with profile_urn_ids you can pass into send_linkedin_dm or send_linkedin_connection.',
      input_schema: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'e.g. "head of marketing fintech tel aviv"' },
          limit:    { type: 'number', description: 'default 10' },
        },
        required: ['keywords'],
      },
    },
    run: async (env, input) => liSearchPeople(env, input),
  },
  send_linkedin_connection: {
    def: {
      name: 'send_linkedin_connection',
      description: 'Send a connection request. Optionally include a 300-char note. Voyager-backed. Soft cap is 100 connection requests/week.',
      input_schema: {
        type: 'object',
        properties: {
          profile_urn_id: { type: 'string' },
          note:           { type: 'string', description: 'optional 300-char personal note in Nyyon voice' },
        },
        required: ['profile_urn_id'],
      },
    },
    run: async (env, input) => liConnect(env, input),
  },

};
