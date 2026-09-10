// Conversation history (nyyon-lite: the shared logic behind the conversation
// tools and Nyo's history panel).
//
// The chat loop already persists every turn to `conversations` + `messages`, but
// nothing could read them back: the client kept a single conversation id in
// localStorage and dropped it when the drawer closed, so finished threads became
// unreachable even though the server still had them. This is the read layer that
// makes them browsable and resumable.
//
// Scope: Nyo and the Daily Planner share this persistence path, so every read
// here is filtered by `conversations.agent` (NULL = Nyo, 'daily-planner' = the
// planning desk). Without that filter the Nyo panel lists planner threads and
// reopens one under the wrong persona.
//
// Titles: the chat loop historically wrote none, so old rows have title=NULL and
// a raw list would be unreadable. A display title is DERIVED from the first user
// message at read time (no write, no backfill pass); the stored column is set on
// creation for new threads and reserved for an explicit rename.
//
// Storage shapes this module has to speak (set by chat/index.js persistMessage):
//   role 'user'      → content is plain text
//   role 'assistant' → content is a JSON array of Anthropic content blocks
//   role 'tool'      → content is the JSON tool result, plus tool_name/tool_input
// `toUiMessages` folds those back into the flat {role, content, tool_events}
// shape the Chat component renders, so a resumed thread looks like it never left.

import { now } from './util.js';
import { logEvent } from './db.js';

const TITLE_MAX = 70;
// Cap on turns restored from one thread. Applied to the TAIL: a long thread
// resumes at its most recent turns, because the client posts whatever it holds
// back as the next turn's context — restoring the beginning and dropping the
// newest turns would silently rewrite the conversation's memory.
const MAX_RESTORED_ROWS = 400;

// A readable one-line title from arbitrary message text.
export function deriveTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Untitled';
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s;
}

// Agent scoping. The column is NULL for Nyo (and for every row written before
// it existed), so an explicit `IS NULL` is the Nyo filter.
function agentClause(agent) {
  return agent ? { sql: 'c.agent = ?', binds: [agent] } : { sql: 'c.agent IS NULL', binds: [] };
}

// ── list ────────────────────────────────────────────────────────────────────
// Empty shells are excluded IN SQL (a conversation row is created before the
// first turn persists). Filtering after LIMIT would return short pages, make
// OFFSET skip rows, and overstate `total`.
export async function listConversations(env, { limit = 40, offset = 0, agent = null } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 200);
  const skip = Math.max(parseInt(offset, 10) || 0, 0);
  const a = agentClause(agent);
  const nonEmpty = 'EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)';

  // Let a real D1 failure throw: swallowing it here would render as "no past
  // conversations yet" in the panel and read to Nyo as an authoritative "you
  // have no history", which it would then state to the operator as fact.
  const rows = (await env.DB.prepare(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.role = 'user') AS turns,
            (SELECT m.content FROM messages m
              WHERE m.conversation_id = c.id AND m.role = 'user'
              ORDER BY m.created_at LIMIT 1) AS first_user
       FROM conversations c
      WHERE ${a.sql} AND ${nonEmpty}
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(...a.binds, cap, skip).all()).results || [];

  const total = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM conversations c WHERE ${a.sql} AND ${nonEmpty}`,
  ).bind(...a.binds).first())?.n ?? rows.length;

  const conversations = rows.map((r) => ({
    id: r.id,
    title: r.title || deriveTitle(r.first_user),
    // Operator turns, not raw rows: one exchange persists an assistant row per
    // model hop plus a row per tool call, so a raw count bears no relation to
    // the handful of bubbles the thread actually shows.
    turns: r.turns || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return { conversations, total };
}

// ── read ────────────────────────────────────────────────────────────────────
// Fold persisted rows back into the flat UI message shape.
export function toUiMessages(rows = []) {
  const out = [];
  // A model hop that ONLY calls tools persists an assistant row with no text.
  // Emitting that as its own message would put `content: ''` into the resumed
  // thread, and the next send posts every message straight back to the model,
  // which rejects an empty content block. So tool calls are buffered and ride
  // along with the next assistant turn that actually says something — the same
  // way the live stream renders one bubble accumulating text plus its tools.
  let pending = [];

  const attachResult = (name, raw) => {
    let value;
    try { value = JSON.parse(raw || 'null'); } catch { value = raw; }
    const target = pending.find((e) => e.name === name && e.result === undefined && e.error === undefined)
      || [...out].reverse().find((m) => m.role === 'assistant' && m.tool_events)
        ?.tool_events.find((e) => e.name === name && e.result === undefined && e.error === undefined);
    if (!target) return;
    // Failed tools persist as {error}. The renderer keys off `error` to show a
    // failure; writing it to `result` would render every past failure as ✓.
    if (value && typeof value === 'object' && typeof value.error === 'string') target.error = value.error;
    else target.result = value;
  };

  for (const row of rows) {
    if (row.role === 'user') {
      // Flush trailing tool calls onto the previous assistant turn so their
      // results are not silently dropped when the operator speaks again.
      if (pending.length) {
        const prev = [...out].reverse().find((m) => m.role === 'assistant');
        if (prev) prev.tool_events = [...(prev.tool_events || []), ...pending];
      }
      pending = [];
      out.push({ role: 'user', content: String(row.content || ''), ts: row.created_at });
      continue;
    }
    if (row.role === 'assistant') {
      let blocks = [];
      try { blocks = JSON.parse(row.content || '[]'); } catch { blocks = []; }
      if (!Array.isArray(blocks)) blocks = [];
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('').trim();
      const calls = blocks
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({ name: b.name, input: b.input }));
      if (!text) { pending.push(...calls); continue; }   // tools only — carry forward
      const tool_events = [...pending, ...calls];
      pending = [];
      out.push({ role: 'assistant', content: text, ...(tool_events.length ? { tool_events } : {}), ts: row.created_at });
      continue;
    }
    if (row.role === 'tool') attachResult(row.tool_name, row.content);
  }
  return out;
}

export async function readConversation(env, id, { agent = null } = {}) {
  if (!id) throw new Error('conversation id required');
  const a = agentClause(agent);
  const conv = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at FROM conversations c WHERE c.id = ? AND ${a.sql}`,
  ).bind(id, ...a.binds).first();
  if (!conv) return null;
  // Newest-first with a cap, then reversed: this restores the TAIL of a long
  // thread. Taking the head would resume a conversation at its beginning and
  // hand the model a truncated, stale context.
  const rows = ((await env.DB.prepare(
    `SELECT role, content, tool_name, tool_input, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(id, MAX_RESTORED_ROWS).all()).results || []).reverse();
  const firstUser = rows.find((r) => r.role === 'user');
  return {
    id: conv.id,
    title: conv.title || deriveTitle(firstUser?.content),
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    truncated: rows.length >= MAX_RESTORED_ROWS,
    messages: toUiMessages(rows),
  };
}

// ── mutations ───────────────────────────────────────────────────────────────
export async function renameConversation(env, id, title) {
  if (!id) throw new Error('conversation id required');
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) throw new Error('title required');
  await env.DB.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .bind(clean, now(), id).run();
  await logEvent(env, { kind: 'conversation_renamed', actor: 'operator', payload: { id, title: clean } });
  return { id, title: clean };
}

// `activeId` guards the thread the operator is currently talking in. Deleting it
// mid-turn removes the parent row while the loop keeps inserting messages, and
// the schema's foreign key then kills the turn with a FK failure instead of a
// reply. The panel deletes an explicitly picked row, so it passes no activeId.
export async function deleteConversation(env, id, { activeId = null } = {}) {
  if (!id) throw new Error('conversation id required');
  if (activeId && id === activeId) {
    throw new Error('that is the conversation we are in right now — delete it from the history panel instead');
  }
  await env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();
  await logEvent(env, { kind: 'conversation_deleted', actor: 'operator', payload: { id } });
  return { ok: true, id };
}
