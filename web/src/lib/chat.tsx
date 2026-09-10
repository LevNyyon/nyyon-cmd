// Shared chat state for Nyo. Both the right-side drawer (Cmd/Ctrl+J) and the
// full-screen Nyo page render the same <Chat> component — pulling state from
// this single context means a send in either surface updates the other live,
// not just on reload.
//
// Storage shape: { conversationId, messages: last 100 }. Same key as the
// previous in-component cache so existing history survives the upgrade.
//
// ChatProvider also runs a background poller against /api/nyo/pending — any
// queued assistant turn from a worker hook (AEO publish, image gen, etc.)
// gets injected as an assistant message + bumps `hasUnseen` so the floating
// Nyo button badges, even when the user is on a different surface.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';

export type ToolEvent = { name: string; input?: unknown; result?: unknown; error?: string };
// `ts` is the epoch-ms the message was created (user send, assistant stream
// start, or pending-message injection). Optional so old cached messages from
// before this field shipped still parse — they just render without a stamp.
export type Msg = { role: 'user' | 'assistant'; content: string; tool_events?: ToolEvent[]; ts?: number };

const STORAGE_KEY = 'nyyon.chat.v1';

// One-time hygiene for the cached transcript. The pre-fix wake-up bug (see
// /api/system/wake-up) flooded the local history with recurring auto-notifications
// — near-identical "morning briefings" and one "I need your take" interview nag
// per pending question. This collapses EACH such class to its most recent
// instance, and drops any run of byte-identical consecutive assistant messages,
// so the chat reads as a conversation again. Real user/assistant turns are
// preserved; the underlying work still lives in its module (dashboard state,
// pending interviews in AEO). Runs on every hydrate; a no-op once clean.
const NOTIFICATION_CLASSES: ((c: string) => boolean)[] = [
  (c) => c.includes("here's where we stand"),                                    // wake-up morning briefing
  (c) => c.includes('i need your take') || c.includes('before i write the next article'), // AEO interview nag
];
function dedupeHistory(msgs: Msg[]): Msg[] {
  if (!Array.isArray(msgs)) return [];
  const classOf = (m: Msg): number => {
    if (m?.role !== 'assistant' || typeof m.content !== 'string') return -1;
    const c = m.content.toLowerCase();
    return NOTIFICATION_CLASSES.findIndex((fn) => fn(c));
  };
  const lastIdxByClass = new Map<number, number>();
  msgs.forEach((m, i) => { const k = classOf(m); if (k >= 0) lastIdxByClass.set(k, i); });
  const out: Msg[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const k = classOf(m);
    if (k >= 0 && lastIdxByClass.get(k) !== i) continue;          // keep only the latest of each notification class
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.content === m.content) continue; // drop consecutive exact dup
    out.push(m);
  }
  return out;
}

export type ChatState = {
  messages: Msg[];
  setMessages: React.Dispatch<React.SetStateAction<Msg[]>>;
  conversationId: string | null;
  setConversationId: React.Dispatch<React.SetStateAction<string | null>>;
  streaming: boolean;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  clearAll: () => void;
  // Cross-surface handoff: another page (e.g. Digest) stages a prelude here,
  // navigates to /nyo, and the Chat component picks it up and auto-sends.
  pendingSend: string | null;
  setPendingSend: React.Dispatch<React.SetStateAction<string | null>>;
  // Background-task notifications. When Nyo replies / finishes a tool while
  // the user isn't viewing the chat (drawer closed AND full-screen Nyo not
  // active), `hasUnseen` flips true. A visible chat surface clears it on mount
  // and whenever streaming completes while mounted, via markSeen().
  //
  // `unseenCount` is the number of PROACTIVE Nyo messages that arrived via
  // the /api/nyo/pending poller since the operator last opened chat. Token
  // streams from the operator's own send() don't increment it — only
  // background pushes (wake-up briefings, post-publish notifications, etc.)
  // do. Rendered as a number on the floating launcher.
  hasUnseen: boolean;
  unseenCount: number;
  markSeen: () => void;
  bumpAssistantActivity: () => void;
  bumpUnseenCount: (n: number) => void;
};

const Ctx = createContext<ChatState | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages]             = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming]           = useState(false);
  const [pendingSend, setPendingSend]       = useState<string | null>(null);
  const [lastAssistantAt, setLastAssistantAt] = useState<number>(0);
  const [lastSeenAt, setLastSeenAt]           = useState<number>(() => Date.now());
  const [unseenCount, setUnseenCount]         = useState<number>(0);
  const hydrated = useRef(false);

  // Stable references — without useCallback these are new function objects
  // on every render. Consumers list them in useEffect dep arrays (e.g.
  // Chat.tsx's "clear unseen when idle" effect), so a new reference fires
  // the effect, which calls setState here, which re-renders, which makes
  // another new reference → infinite loop. Both setters they wrap come from
  // useState so the empty dep array is safe.
  const markSeen              = useCallback(() => {
    setLastSeenAt(Date.now());
    setUnseenCount(0);
  }, []);
  const bumpAssistantActivity = useCallback(() => setLastAssistantAt(Date.now()), []);
  const bumpUnseenCount       = useCallback((n: number) => setUnseenCount((c) => c + n), []);
  const hasUnseen = lastAssistantAt > lastSeenAt;

  // Hydrate once from localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.messages)) setMessages(dedupeHistory(parsed.messages));
        if (parsed?.conversationId) setConversationId(parsed.conversationId);
      }
    } catch { /* corrupt cache, drop it */ }
    hydrated.current = true;
  }, []);

  // Persist on every change after hydration.
  useEffect(() => {
    if (!hydrated.current) return;
    if (!messages.length && !conversationId) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        conversationId,
        messages: messages.slice(-100),
      }));
    } catch { /* quota */ }
  }, [messages, conversationId]);

  // Wake-up trigger — once per session on mount + on tab refocus. The server
  // surveys state, fires any missed AEO publish, and queues a briefing as a
  // Nyo message. The 30s poller below picks it up and injects it. Server is
  // idempotent (skips when nothing changed) so refocusing the tab doesn't
  // spam the operator.
  useEffect(() => {
    let lastFired = 0;
    const MIN_GAP_MS = 5 * 60 * 1000; // 5 min between wake-ups regardless of focus events

    function maybeWake() {
      const now = Date.now();
      if (now - lastFired < MIN_GAP_MS) return;
      lastFired = now;
      api.systemWakeUp().catch(() => { /* network blip, retry next focus */ });
    }
    // Mount: fire once.
    maybeWake();
    // Tab refocus: fire if it's been a while.
    function onVisibility() {
      if (document.visibilityState === 'visible') maybeWake();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Background poller — pulls queued assistant turns from /api/nyo/pending
  // every 30s and injects them into the conversation. Skips while a stream
  // is in progress (avoid stomping the in-flight assistant message). Each
  // delivered row is acknowledged so we never inject the same message twice.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function pollOnce() {
      if (cancelled || streaming) return schedule();
      try {
        const pending = await api.listNyoPending();
        if (!cancelled && pending.length) {
          setMessages((prev) => {
            const next = [...prev];
            for (const m of pending) next.push({ role: 'assistant', content: m.content, ts: m.created_at || Date.now() });
            return next;
          });
          // Bump activity so the floating Nyo button badges + bump the count
          // so we can show "N new" instead of just a generic red dot.
          setLastAssistantAt(Date.now());
          setUnseenCount((c) => c + pending.length);
          // Acknowledge in parallel; failures aren't fatal — worst case we
          // re-inject next tick. We dedupe via the message id on the server.
          await Promise.allSettled(pending.map((m) => api.deliverNyoMessage(m.id)));
        }
      } catch { /* network blip, retry next tick */ }
      schedule();
    }
    function schedule() {
      if (cancelled) return;
      timer = setTimeout(pollOnce, 30_000);
    }
    // Fire one poll on mount, then run on the 30s interval.
    pollOnce();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearAll() {
    setMessages([]);
    setConversationId(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  // Reset the conversation when the chat drawer is CLOSED (an open→closed
  // transition), so reopening is a fresh chat instead of resurrecting the last
  // thread. The server-side conversation log is untouched — nothing is lost,
  // it just doesn't clutter the next session. Guarded so we never wipe a
  // response that's still streaming. App.tsx dispatches 'nyyon:chat-toggled'
  // with detail = the new open state on every toggle.
  const wasOpenRef    = useRef(false);
  const streamingRef  = useRef(streaming);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);
  useEffect(() => {
    function onToggle(e: Event) {
      const open = !!(e as CustomEvent).detail;
      if (wasOpenRef.current && !open && !streamingRef.current) clearAll();
      wasOpenRef.current = open;
    }
    window.addEventListener('nyyon:chat-toggled', onToggle);
    return () => window.removeEventListener('nyyon:chat-toggled', onToggle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: ChatState = {
    messages, setMessages,
    conversationId, setConversationId,
    streaming, setStreaming,
    clearAll,
    pendingSend, setPendingSend,
    hasUnseen, unseenCount, markSeen, bumpAssistantActivity, bumpUnseenCount,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatState(): ChatState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChatState() called outside <ChatProvider>');
  return v;
}

// Cross-page event used to switch the App's nav state to another surface.
// Listeners live in App.tsx. Fire from anywhere (e.g. a Digest card handler).
export function navigateTo(target: string) {
  window.dispatchEvent(new CustomEvent('nyyon:nav-to', { detail: { target } }));
}

// Open the Nyo chat drawer without leaving the current page (so the page stays
// visible beside the chat). Pair with setPendingSend() to brief Nyo on load.
// Listener lives in App.tsx.
export function openChat() {
  window.dispatchEvent(new Event('nyyon:open-chat'));
}
