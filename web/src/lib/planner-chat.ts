// Isolated chat state for the Daily Planner surface. It renders the same <Chat>
// component as Nyo, but on its OWN conversation — a separate localStorage cache
// and conversationId — so planning never mixes into Nyo's command thread.
//
// The conversation RESETS on a new calendar day: the cache stores the day it
// belongs to, and hydrate drops it when the day has rolled over, so each new day
// starts empty (matching the panel, which fetches a fresh per-day plan).
//
// Deliberately a self-contained hook, NOT the Nyo ChatProvider: it drops the
// Nyo-only machinery (wake-up sweep, /api/nyo/pending poller, drawer-close
// reset). Its return shape matches the subset of ChatState that <Chat> consumes
// from useChatState(), so the one component can render either source.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Msg } from './chat';

const STORAGE_KEY = 'nyyon.planner.v1';

// Operator-local calendar day (YYYY-MM-DD) — the reset key.
const localDay = () => {
  try { return new Date().toLocaleDateString('en-CA'); } catch { return new Date().toISOString().slice(0, 10); }
};

export type PlannerChat = {
  messages: Msg[];
  setMessages: Dispatch<SetStateAction<Msg[]>>;
  conversationId: string | null;
  setConversationId: Dispatch<SetStateAction<string | null>>;
  streaming: boolean;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  clearAll: () => void;
  pendingSend: string | null;
  setPendingSend: Dispatch<SetStateAction<string | null>>;
  markSeen: () => void;
  bumpAssistantActivity: () => void;
};

// `active` gates all localStorage I/O. <Chat> mounts this hook unconditionally
// (rules of hooks) but only the Daily Planner instance passes active=true; every
// other <Chat> (Nyo page, ⌘J drawer) passes false and stays fully inert, so it
// never reads or writes the planner cache.
export function usePlannerChat(active = true): PlannerChat {
  const [messages, setMessages]             = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming]           = useState(false);
  const [pendingSend, setPendingSend]       = useState<string | null>(null);
  const hydrated = useRef(false);

  // Hydrate once from localStorage (active instance only) — but drop it on a new day.
  useEffect(() => {
    if (!active) { hydrated.current = true; return; }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const msgs: Msg[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
        // Day of the LAST activity — prefer the last message's timestamp (robust
        // even for caches written before the `day` field existed, or that span a
        // day boundary), fall back to the stored `day`. A previous calendar day
        // means the conversation is stale → start fresh (chat empties on a new day).
        const lastTs = msgs.length ? Number(msgs[msgs.length - 1]?.ts) : NaN;
        const lastDay = Number.isFinite(lastTs)
          ? new Date(lastTs).toLocaleDateString('en-CA')
          : (typeof parsed?.day === 'string' ? parsed.day : null);
        if (lastDay && lastDay !== localDay()) {
          localStorage.removeItem(STORAGE_KEY); // new day → start fresh
        } else {
          if (msgs.length) setMessages(msgs);
          if (parsed?.conversationId) setConversationId(parsed.conversationId);
        }
      }
    } catch { /* corrupt cache, drop it */ }
    hydrated.current = true;
  }, [active]);

  // Persist on every change after hydration (active instance only).
  useEffect(() => {
    if (!active || !hydrated.current) return;
    if (!messages.length && !conversationId) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        day: localDay(),
        conversationId,
        messages: messages.slice(-100),
      }));
    } catch { /* quota */ }
  }, [messages, conversationId, active]);

  function clearAll() {
    setMessages([]);
    setConversationId(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  return {
    messages, setMessages,
    conversationId, setConversationId,
    streaming, setStreaming,
    clearAll,
    pendingSend, setPendingSend,
    // Nyo-only signals (floating-launcher badge) — inert for the planner.
    markSeen: () => {},
    bumpAssistantActivity: () => {},
  };
}
