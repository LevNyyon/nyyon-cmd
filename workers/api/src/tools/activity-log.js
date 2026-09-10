// activity log — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import { recentEvents, logEvent } from '../lib/db.js';

export const tools = {
  // ── activity log ───────────────────────────────────────────
  recent_events: {
    def: {
      name: 'recent_events',
      description: 'Append-only activity log, newest first. Knowledge writes, roadmap changes, notes, module/tool changes all land here.',
      input_schema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    },
    run: async (env, input) => {
      // Keep this lean: a 50-row dump with full payloads (e.g. cover URLs) bloats
      // the chat context and can blow the ITPM ceiling on the next hop. Cap rows
      // and truncate each payload.
      const raw = await recentEvents(env, Math.min(Math.max(input?.limit ?? 12, 1), 25));
      return { events: raw.map((e) => {
        let p = ''; try { p = (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? {})).slice(0, 180); } catch { /* */ }
        return { id: e.id, kind: e.kind, actor: e.actor, created_at: e.created_at, payload: p };
      }) };
    },
  },
  log_note: {
    def: {
      name: 'log_note',
      description: 'Append a free-form note into the activity log. Use when the operator says "for the record" or makes a decision you want timestamped without bloating a knowledge doc.',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    run: async (env, input) => {
      await logEvent(env, { kind: 'note', actor: 'nyo', payload: { text: input.text } });
      return { ok: true };
    },
  },

};
