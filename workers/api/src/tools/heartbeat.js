// Heartbeat — industry awareness (OSINT v2) — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import { signalToBlog, signalToSocialDraft, listHeartbeatSources, writeHeartbeatSource, deleteHeartbeatSource } from '../lib/heartbeat.js';

export const tools = {
  list_heartbeat_sources: {
    def: {
      name: 'list_heartbeat_sources',
      description: "List the industry-awareness feed sources (OSINT module 'Sources' tab): RSS feeds + Google News topic queries the hourly heartbeat ingests. Each row: id, kind (rss|gnews), name, url, theme, enabled, last_fetched_at/status.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ sources: await listHeartbeatSources(env) }),
  },
  write_heartbeat_source: {
    def: {
      name: 'write_heartbeat_source',
      description: "Add or edit an industry-awareness feed source. New rss source: {kind:'rss', name, url}. New Google News topic: {kind:'gnews', name, query} (the feed URL is built from the query). Edit: pass id + the fields to change (enabled:false disables without deleting).",
      input_schema: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['rss', 'gnews'] }, name: { type: 'string' }, url: { type: 'string' }, query: { type: 'string', description: 'gnews only — plain search query' }, theme: { type: 'string' }, enabled: { type: 'boolean' } }, required: [] },
    },
    run: async (env, input) => {
      const source = await writeHeartbeatSource(env, input || {});
      // Fill the feed NOW — a freshly added source that sits empty until the
      // next hourly tick reads as broken to a new operator.
      let refreshed = null;
      try {
        const { runHeartbeat } = await import('../lib/heartbeat.js');
        const r = await runHeartbeat(env, { actor: 'nyo' });
        refreshed = { inserted: r.inserted ?? 0, scored: r.scored ?? 0 };
      } catch (e) { refreshed = { error: String(e?.message || e).slice(0, 200) }; }
      return { source, refreshed };
    },
  },
  delete_heartbeat_source: {
    def: {
      name: 'delete_heartbeat_source',
      description: 'Delete an industry-awareness feed source by id (its already-ingested signals are kept). Prefer write_heartbeat_source with enabled:false to pause a feed reversibly.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => deleteHeartbeatSource(env, input.id),
  },
  // ── Heartbeat — industry awareness (OSINT v2) ─────────────
  run_heartbeat: {
    def: {
      name: 'run_heartbeat',
      description: "Fetch the topic feed's sources NOW (all enabled RSS/Google-News sources), score the new items, and report counts. Use when the operator adds sources and wants the feed filled without waiting for the hourly tick, or asks to refresh the feed.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const { runHeartbeat } = await import('../lib/heartbeat.js');
      const r = await runHeartbeat(env, { actor: 'nyo' });
      return { inserted: r.inserted ?? 0, scored: r.scored ?? 0, note: 'new items land on the Hot Takes feed once scored' };
    },
  },
  industry_pulse: {
    def: {
      name: 'industry_pulse',
      description: "Get Nyyon's current industry awareness — what's happening in AI + AI-marketing right now and what Nyyon could do about it. Pull this into ANY strategic conversation (client calls, campaigns, positioning, content). It's the synthesized 'pulse' from authoritative sources (company blogs + news). Call it whenever current external context would sharpen your answer.",
      input_schema: { type: 'object', properties: {} },
    },
    async run(env) {
      const { readPulse, topSignals } = await import('../lib/heartbeat.js');
      const pulse = await readPulse(env);
      const signals = await topSignals(env, { days: 7, minContent: 60, limit: 8 });
      return { ok: true, pulse, top_signals: signals.map((s) => ({ id: s.id, title: s.title, source: s.source_name, content_score: s.content_score, angle: s.suggested_angle, url: s.url })) };
    },
  },

  hot_topics: {
    def: {
      name: 'hot_topics',
      description: "Nyyon's synthesized OSINT HOT TOPICS — sharp, blog-grade angles on what is happening right now, clustered from real industry signals. Each carries a thesis, a why-now, the Nyyon angle, and source links. This is the layer that feeds the morning digest. Pull it whenever the operator asks 'what should we write/post about', 'what's hot', 'give me angles', or wants timely content ideas. Pass refresh=true to re-synthesize from the latest signals first.",
      input_schema: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Re-synthesize from the latest scored signals before returning.' },
          limit:   { type: 'number',  description: 'How many topics to return (default 6).' },
        },
      },
    },
    async run(env, { refresh, limit } = {}) {
      const { synthesizeHotTopics, topHotTopics } = await import('../lib/heartbeat.js');
      if (refresh) { try { await synthesizeHotTopics(env); } catch { /* best effort */ } }
      let topics = await topHotTopics(env, { limit: limit || 6 });
      if (!topics.length && !refresh) { try { await synthesizeHotTopics(env); topics = await topHotTopics(env, { limit: limit || 6 }); } catch { /* */ } }
      return { ok: true, topics: topics.map((t) => ({ id: t.id, title: t.title, thesis: t.thesis, why_now: t.why_now, angle: t.angle, format: t.format, heat: t.heat, sources: t.sources })) };
    },
  },

  list_signals: {
    def: {
      name: 'list_signals',
      description: "List recent scored industry signals (real news/blog items from the heartbeat). Use to find content opportunities or answer 'what's new in X'. Each has a content_score (how write/post-worthy) and a suggested angle. Filter by minimum content score.",
      input_schema: {
        type: 'object',
        properties: {
          min_content: { type: 'number', description: 'Minimum content_score 0-100 (default 55).' },
          days:        { type: 'number', description: 'Lookback window in days (default 7).' },
        },
      },
    },
    async run(env, { min_content, days }) {
      const { topSignals } = await import('../lib/heartbeat.js');
      const sigs = await topSignals(env, { days: days || 7, minContent: min_content || 55, limit: 20 });
      return { ok: true, signals: sigs.map((s) => ({ id: s.id, title: s.title, source: s.source_name, theme: s.theme, content_score: s.content_score, formats: s.formats, angle: s.suggested_angle, url: s.url })) };
    },
  },

  signal_to_blog: {
    def: {
      name: 'signal_to_blog',
      description: "Turn an industry signal into a blog opportunity — creates an AEO question seeded with the signal's angle (priority 2, timely). It then flows through the normal interview→write path. Pass the signal id (from list_signals / industry_pulse). Use when the operator wants to write about something the heartbeat surfaced.",
      input_schema: {
        type: 'object',
        properties: { signal_id: { type: 'string' } },
        required: ['signal_id'],
      },
    },
    run: async (env, { signal_id }) => signalToBlog(env, signal_id),
  },

  read_signal: {
    def: {
      name: 'read_signal',
      description: "Read the FULL article behind a heartbeat signal (not just its title) and return the text so you can react to what it actually says. Fetches + caches the article on first read. Use when the operator asks 'what does that article actually say', 'is it any good', or before drafting a reaction/post about it.",
      input_schema: {
        type: 'object',
        properties: { signal_id: { type: 'string' } },
        required: ['signal_id'],
      },
    },
    async run(env, { signal_id }) {
      const { readSignalContent } = await import('../lib/heartbeat.js');
      const sig = await readSignalContent(env, signal_id);
      if (!sig) return { ok: false, error: 'signal not found' };
      if (!sig.full_text) return { ok: false, error: `couldn't fetch the article (paywall, JS-only, or blocked). URL: ${sig.url}`, title: sig.title, summary: sig.summary };
      return { ok: true, title: sig.title, source: sig.source_name, url: sig.url, content: sig.full_text };
    },
  },

  signal_to_social: {
    def: {
      name: 'signal_to_social',
      description: "Draft a LinkedIn/social post reacting to an industry signal, in Nyyon's voice. Returns the draft for the operator to review — does NOT auto-post. Pass the signal id. Use when the operator wants to ride a piece of news with a quick post.",
      input_schema: {
        type: 'object',
        properties: { signal_id: { type: 'string' } },
        required: ['signal_id'],
      },
    },
    run: async (env, { signal_id }) => signalToSocialDraft(env, signal_id),
  },

};
