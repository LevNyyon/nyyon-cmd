// Conversation history — Nyo tools (nyyon-lite shared pool).
//
// Nyo persists every turn, so it can also READ its own past threads: "what did
// we decide about the Shlomit retainer", "find the conversation where we fixed
// the LinkedIn gateway". Each tool is { def, run } returning plain JSON.

import { listConversations, readConversation, renameConversation, deleteConversation } from '../lib/conversations.js';

export const tools = {
  list_conversations: {
    def: {
      name: 'list_conversations',
      description: 'List past Nyo conversations, newest first: id, title (derived from the first thing the operator said), message count and timestamps. Read-only. Use to answer "what did we talk about", "find the conversation about X", or before reading one in full.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many to return (default 40, max 200).' },
          offset: { type: 'number', description: 'Skip this many for paging.' },
        },
        required: [],
      },
    },
    run: async (env, input) => listConversations(env, { ...(input || {}), agent: null }),
  },
  read_conversation: {
    def: {
      name: 'read_conversation',
      description: 'Read one past conversation in full: every user and assistant turn in order, with the tools that ran. Read-only. Use after list_conversations to recall exactly what was said or decided in an earlier thread.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Conversation id from list_conversations.' } },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const conv = await readConversation(env, input?.id, { agent: null });
      return conv || { error: 'conversation not found', id: input?.id };
    },
  },
  rename_conversation: {
    def: {
      name: 'rename_conversation',
      description: 'Give a past conversation an explicit title so it is easy to find later. Overrides the title derived from the first message.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Conversation id.' },
          title: { type: 'string', description: 'The new title.' },
        },
        required: ['id', 'title'],
      },
    },
    run: async (env, input) => renameConversation(env, input?.id, input?.title),
  },
  delete_conversation: {
    def: {
      name: 'delete_conversation',
      description: 'Permanently delete one PAST conversation and all of its messages. DESTRUCTIVE and irreversible: confirm the exact conversation with the operator before calling. Refuses to delete the conversation currently in progress.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Conversation id.' } },
        required: ['id'],
      },
    },
    run: async (env, input, ctx = {}) => deleteConversation(env, input?.id, { activeId: ctx.conversation_id || null }),
  },
};
