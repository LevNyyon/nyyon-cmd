// knowledge — Nyo tools (split from chat/tools.js).
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.

import {
  listKnowledge, readKnowledge, readKnowledgePath, writeKnowledge, deleteKnowledge,
} from '../lib/db.js';
import { UNIVERSAL_STYLE_RULES, UNIVERSAL_PERSONAL_RULES } from '../lib/onboarding-playbook.js';

export const tools = {
  // ── knowledge ──────────────────────────────────────────────
  list_knowledge: {
    def: {
      name: 'list_knowledge',
      description: 'List every knowledge doc (slug + title + scope). Call this before reading or writing so you know what already exists.',
      input_schema: {
        type: 'object',
        properties: {
          scope:  { type: 'string', enum: ['global', 'module'] },
          module: { type: 'string', description: 'when scope=module, filter by module slug' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ docs: await listKnowledge(env, input || {}) }),
  },
  read_knowledge: {
    def: {
      name: 'read_knowledge',
      description: 'Read one knowledge doc by slug. Returns title + full markdown body. Knowledge is a tree — every doc has a `parent_slug` pointing at its parent (null for `nyyon-root`). Use `read_knowledge_path` when you need the full context chain root → … → leaf.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => {
      const d = await readKnowledge(env, input.slug);
      return d ? { found: true, doc: d } : { found: false };
    },
  },
  read_knowledge_path: {
    def: {
      name: 'read_knowledge_path',
      description: 'Return the breadcrumb chain root → … → :slug for a knowledge doc. The chain IS the context the operator (or any reader) needs to fully understand the leaf. Use before answering questions about a leaf doc so you ground in its parents too.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => ({ path: await readKnowledgePath(env, input.slug) }),
  },
  write_knowledge: {
    def: {
      name: 'write_knowledge',
      description: 'Create or update a knowledge doc. Use to capture decisions, system design, definitions, module descriptions, anything the operator wants persisted across sessions. Slug is the stable identifier — never rename, write a new doc and link. parent_slug (optional) sets the tree position; pass the parent doc slug to nest the new doc, pass null to make it a root, or omit to keep the current parent when updating.',
      input_schema: {
        type: 'object',
        properties: {
          slug:        { type: 'string', description: 'lowercase-with-dashes' },
          title:       { type: 'string' },
          body:        { type: 'string', description: 'markdown' },
          scope:       { type: 'string', enum: ['global', 'module'] },
          module:      { type: 'string', description: 'when scope=module' },
          parent_slug: { type: ['string', 'null'], description: 'slug of the parent doc in the knowledge tree, or null for a root doc. Omit to keep the current parent when updating.' },
        },
        required: ['slug', 'title', 'body'],
      },
    },
    run: async (env, input) => {
      const arg = { ...(input || {}) };
      // The universal anti-AI blocks are welded on mechanically when a voice
      // doc is FIRST created (the interview path), so no model wording can
      // drop them. Existing docs pass through untouched — the operator's live
      // curation is theirs.
      try {
        if ((arg.slug === 'writing-style-rules' || arg.slug === 'nyyon-voice-lev') && !(await readKnowledge(env, arg.slug))) {
          const body = String(arg.body || '').trim();
          if (arg.slug === 'writing-style-rules' && !body.includes('## Banned phrases')) {
            arg.body = [body, '', '## Universal rules', '', UNIVERSAL_STYLE_RULES].filter(Boolean).join('\n');
          }
          if (arg.slug === 'nyyon-voice-lev' && !body.includes('## RULE ZERO')) {
            arg.body = [UNIVERSAL_PERSONAL_RULES, '', body].filter(Boolean).join('\n\n');
          }
        }
      } catch { /* weld is best-effort; the write itself must not fail on it */ }
      return { doc: await writeKnowledge(env, arg) };
    },
  },
  delete_knowledge: {
    def: {
      name: 'delete_knowledge',
      description: 'Delete a knowledge doc. Use sparingly; prefer writing a new doc that supersedes the old one.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => { await deleteKnowledge(env, input.slug); return { ok: true }; },
  },

};
