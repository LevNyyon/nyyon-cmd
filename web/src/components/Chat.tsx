import { useEffect, useRef, useState, Fragment, type ReactNode } from 'react';
import { chat, ChatEvent, api, type ConversationSummary } from '../lib/api';
import { useChatState, type Msg } from '../lib/chat';
import { usePlannerChat } from '../lib/planner-chat';
import { X, Trash, Mic, Clock } from './Icons';

type Props = {
  onClose?: () => void;
  scope?: 'nyo' | 'daily-planner';
  title?: string;
  // When set, the compact title header is replaced by a single full-width "Back"
  // bar and the ✕ is dropped — one obvious way out instead of a small glyph in
  // the corner. Used by the Daily Planner drawer on mobile, where the chat covers
  // the plan completely and the way back has to be unmissable. Nyo passes onClose
  // instead and keeps the ✕.
  onBack?: () => void;
  backLabel?: string;
};

// Model tier switch. Low = local Qwen (fast/cheap, core tools only), Mid = Sonnet,
// High = Opus. Sent per message so it can be flipped mid-conversation. Default Mid
// matches Nyo's prior behavior. The backend maps these to concrete models.
type Tier = 'mid' | 'high';
const TIER_KEY = 'nyyon.nyo.tier.v1';
const TIERS: { id: Tier; label: string; sub: string }[] = [
  { id: 'mid',  label: 'Mid',  sub: 'Sonnet' },
  { id: 'high', label: 'High', sub: 'Opus' },
];
function loadTier(): Tier {
  try { const v = localStorage.getItem(TIER_KEY); if (v === 'mid' || v === 'high') return v; } catch { /* ignore */ }
  return 'mid';
}

// ── MarkdownLite — render the subset of markdown Nyo actually emits
// (headings, bold/italic, inline code, links, ordered/unordered lists,
// fenced code, paragraphs). Renders to React elements, so no XSS surface.
// ponytail: covers Nyo's output, not full CommonMark; swap in react-markdown
// if Nyo starts emitting tables/nested lists/blockquotes.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={k++} className="px-1 py-0.5 rounded bg-paper/80 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('[')) { const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!; out.push(<a key={k++} href={mm[2]} target="_blank" rel="noreferrer" className="underline underline-offset-2 font-medium">{mm[1]}</a>); }
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isBlockStart = (l: string) => /^```|^#{1,6}\s|^\s*([-*+]|\d+\.)\s+/.test(l);

function MarkdownLite({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={key++} className="my-1.5 p-2 rounded bg-paper/80 overflow-x-auto font-mono text-[12px] whitespace-pre-wrap break-words">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const cls = h[1].length <= 2 ? 'text-[14px] font-semibold mt-2 mb-1' : 'text-[13px] font-semibold mt-1.5 mb-0.5';
      blocks.push(<div key={key++} className={cls}>{inline(h[2])}</div>);
      i++; continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>);
        i++;
      }
      blocks.push(ordered
        ? <ol key={key++} className="list-decimal ml-5 my-1 space-y-0.5">{items}</ol>
        : <ul key={key++} className="list-disc ml-5 my-1 space-y-0.5 marker:text-mute">{items}</ul>);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    blocks.push(<p key={key++} className="my-1 leading-relaxed">{buf.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>);
  }
  return <div className="space-y-0.5">{blocks}</div>;
}

// Format a message timestamp as "day + time". Today → just the time
// (e.g. "14:32"); any earlier day → "Mon 14:32" within the last week,
// "3 Jun, 14:32" beyond. Keeps the common case terse.
function fmtStamp(ts: number): string {
  const d   = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;
  const days = Math.floor((now.getTime() - ts) / 86400000);
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

export function Chat({ onClose, scope = 'nyo', title, onBack, backLabel = 'Back to plan' }: Props) {
  // State source. Nyo (⌘J drawer + full-screen page) shares one ChatProvider
  // conversation; the Daily Planner and Expand surfaces each use their own
  // isolated thread (usePlannerChat) so planning never mixes into the Nyo
  // command chat. Both expose the same shape, so the rest of this component
  // is source-agnostic.
  const shared  = useChatState();
  const planner = usePlannerChat(scope === 'daily-planner');
  const { messages, setMessages, conversationId, setConversationId, streaming, setStreaming, clearAll, pendingSend, setPendingSend, markSeen, bumpAssistantActivity } =
    scope === 'daily-planner' ? planner : shared;
  const [input, setInput] = useState(''); // local — typing in one surface shouldn't bleed into the other
  // Conversation history. Nyo persists every thread server-side; this panel is
  // the way back into one. Daily Planner keeps its own isolated thread, so the
  // history affordance is Nyo-only.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyErr, setHistoryErr] = useState<string | null>(null);

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryBusy(true);
    setHistoryErr(null);
    try {
      const r = await api.listConversations(50);
      setHistory(r.conversations);
    } catch (e) {
      setHistoryErr(e instanceof Error ? e.message : 'could not load history');
    } finally {
      setHistoryBusy(false);
    }
  }

  // Reopen a past thread: pull its turns and swap them into the live state, so
  // the next send continues that same server-side conversation.
  async function resumeConversation(id: string) {
    setHistoryBusy(true);
    setHistoryErr(null);
    try {
      const conv = await api.readConversation(id);
      setMessages(conv.messages as Msg[]);
      setConversationId(conv.id);
      setHistoryOpen(false);
    } catch (e) {
      setHistoryErr(e instanceof Error ? e.message : 'could not open that conversation');
    } finally {
      setHistoryBusy(false);
    }
  }

  async function removeConversation(id: string) {
    try {
      await api.deleteConversation(id);
      setHistory((h) => (h ? h.filter((c) => c.id !== id) : h));
      if (conversationId === id) clearAll();
    } catch { /* leave the row; the operator can retry */ }
  }
  // Model tier switch (Mid=Sonnet · High=Opus). Persisted, and
  // read fresh on each send so flipping it mid-conversation applies to the next turn.
  const [tier, setTier] = useState<Tier>(loadTier);
  function pickTier(t: Tier) { setTier(t); try { localStorage.setItem(TIER_KEY, t); } catch { /* quota */ } }
  const endRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Speech-to-text (dictation). Web Speech API — present in Chrome/Edge, absent
  // in some browsers (the mic button hides when unsupported). Transcribes into the
  // input box (you review, then send), appended after any text already there.
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const sttSupported = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  function toggleDictation() {
    if (listening) { try { recRef.current?.stop(); } catch { /* noop */ } return; }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
    const baseline = input;
    let finalText = '';
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk; else interim += chunk;
      }
      const spoken = `${finalText} ${interim}`.replace(/\s+/g, ' ').trim();
      setInput(baseline ? `${baseline} ${spoken}`.trim() : spoken);
    };
    rec.onend = () => { setListening(false); recRef.current = null; };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); recRef.current = null; }
  }
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* noop */ } }, []);

  // Per-surface copy — empty-state prompt starters + input placeholder.
  const suggestions = scope === 'daily-planner'
    ? [
        { send: 'plan my day', label: 'plan my day' },
        { send: "what's on my calendar today?", label: "what's on today?" },
        { send: 'what should I focus on first today?', label: 'what should I focus on first?' },
        { send: "roll over what I didn't finish yesterday", label: "roll over yesterday's unfinished tasks" },
      ]
    : [
        { send: 'what modules exist?', label: 'what modules exist?' },
        { send: 'list every tool and its status', label: 'list every tool and its status' },
        { send: 'add a roadmap node: openai image gen wiring, status next, area website', label: 'add a roadmap node for openai image gen' },
        { send: 'what changed in the last hour?', label: 'what changed in the last hour?' },
      ];
  const placeholder = scope === 'daily-planner'
    ? 'Describe your day or ask a question'
    : 'Ask: "register a new module", "what shipped", "write a knowledge doc on X"';

  // Abort the in-flight turn — cancels the fetch/SSE so a wedged Nyo unsticks
  // immediately instead of hanging on "Thinking…".
  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streaming]);

  // Chat is visible — mark unseen activity cleared on mount, and again whenever
  // the stream finishes while we're mounted. If Chat unmounts mid-stream
  // (drawer closes, user navigates away), the chat() Promise keeps running
  // against ChatProvider state; once it completes the `hasUnseen` flag stays
  // true and the floating launcher badges.
  useEffect(() => { markSeen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!streaming) markSeen(); }, [streaming, markSeen]);

  // Cross-page handoff: when another surface stages a prelude (e.g. Digest's
  // "Discuss with Nyo" button), pick it up here and auto-send. We clear it
  // first so re-mounting Chat (drawer + page) doesn't double-fire.
  useEffect(() => {
    if (!pendingSend || streaming) return;
    const text = pendingSend;
    setPendingSend(null);
    void send(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSend, streaming]);

  function clearChat() {
    if (streaming) return;
    if (!confirm('Clear local chat history? (Server messages stay logged.)')) return;
    clearAll();
  }

  async function send(textArg?: string) {
    // textArg lets the handoff useEffect (and any future caller) bypass the
    // textarea state and send programmatically.
    const text = (textArg ?? input).trim();
    if (!text || streaming) return;
    const userMsg: Msg = { role: 'user', content: text, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    if (textArg === undefined) setInput('');
    setStreaming(true);
    if (scope === 'daily-planner') window.dispatchEvent(new CustomEvent('nyyon:chat-busy', { detail: true }));

    let assistant: Msg = { role: 'assistant' as const, content: '', tool_events: [], ts: Date.now() };
    setMessages([...next, assistant]);

    const apiMessages = next.map((m) => ({ role: m.role, content: m.content as any }));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await chat(apiMessages, conversationId, (e: ChatEvent) => {
        if (e.kind === 'start') setConversationId(e.conversation_id);
        else if (e.kind === 'delta') {
          assistant = { ...assistant, content: assistant.content + e.text };
          setMessages([...next, assistant]);
          bumpAssistantActivity();
        } else if (e.kind === 'tool_call') {
          assistant = {
            ...assistant,
            tool_events: [...(assistant.tool_events || []), { name: e.name, input: e.input }],
          };
          setMessages([...next, assistant]);
          bumpAssistantActivity();
        } else if (e.kind === 'tool_result') {
          const evs = (assistant.tool_events || []).slice();
          const last = [...evs].reverse().find((t) => t.name === e.name && t.result === undefined && t.error === undefined);
          if (last) { last.result = e.result; last.error = e.error; }
          assistant = { ...assistant, tool_events: evs };
          setMessages([...next, assistant]);
          bumpAssistantActivity();
          // Planner surface: a plan-mutating tool just returned — refresh the panel live.
          if (scope === 'daily-planner' && (e.name === 'save_daily_plan' || e.name === 'update_daily_plan' || e.name === 'set_weekly_objectives')) {
            window.dispatchEvent(new Event('nyyon:plan-updated'));
          }
          // Plugin lists (Expand rail, Plugins page) refresh the moment an
          // install / removal / verify lands in ANY chat.
          if (e.name === 'install_plugin' || e.name === 'remove_plugin' || e.name === 'verify_plugin') {
            window.dispatchEvent(new Event('nyyon:plugins-updated'));
          }
        } else if (e.kind === 'error') {
          assistant = { ...assistant, content: (assistant.content ? assistant.content + '\n\n' : '') + `[error] ${e.message}` };
          setMessages([...next, assistant]);
          bumpAssistantActivity();
        }
      }, controller.signal, scope === 'nyo' ? tier : 'mid', scope === 'nyo' ? undefined : scope);
    } finally {
      abortRef.current = null;
      setStreaming(false);
      bumpAssistantActivity();
      if (scope === 'daily-planner') window.dispatchEvent(new CustomEvent('nyyon:chat-busy', { detail: false }));
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && streaming) { e.preventDefault(); stop(); }
  }

  // Planner starts with the composer centered ("what's on your mind"); once the
  // conversation begins it drops to the normal bottom bar. Nyo + the ⌘J drawer
  // always use the bottom bar.
  const centered = scope === 'daily-planner' && messages.length === 0 && !streaming;

  // The composer (textarea + tier / dictate / send) — rendered centered in
  // the planner's empty state, or as the bottom bar once messages exist.
  const composer = (
    <form
      onSubmit={(e) => { e.preventDefault(); send(); }}
      className={centered ? 'w-full rounded-xl hairline bg-card/40 p-3 shadow-sm' : 'border-t border-line p-3 shrink-0 bg-card/40'}
    >
      <textarea
        rows={2}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        // text-base below lg: iOS Safari zooms the whole page when a focused input
        // is under 16px, which on the planner drawer throws the layout off.
        className="w-full resize-none rounded-sm hairline bg-card/90 px-3 py-2 text-base lg:text-sm placeholder:text-mute focus:border-ink focus:outline-none transition"
      />
      <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {/* Nyo gets the Low/Mid/High switch; the planner and expand desks are
              fixed to Mid and just show the model name (no picker,
              toggle). Expand MUST stay off Low: the local model's curated tool
              set carries none of the plugin-development tools, so its persona
              would command tools that do not exist in the payload. */}
          {scope !== 'nyo' ? (
            <span className="mono text-[10px] tracking-wider text-mute truncate">{TIERS.find((t) => t.id === 'mid')?.sub}</span>
          ) : (
            <div className="inline-flex rounded-sm hairline overflow-hidden shrink-0" role="group" aria-label="Model tier">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTier(t.id)}
                  title={`${t.label} — ${t.sub}`}
                  aria-pressed={tier === t.id}
                  className={
                    'mono text-[10px] uppercase tracking-wider px-2 h-6 transition ' +
                    (tier === t.id ? 'bg-ink text-paper' : 'bg-card/60 text-mute hover:text-ink')
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {scope === 'nyo' && (
            <span className="mono text-[10px] tracking-wider text-mute truncate hidden lg:inline">
              {TIERS.find((t) => t.id === tier)?.sub}
            </span>
          )}
          {/* Dictate — speech-to-text into the box (Web Speech API; hidden if unsupported) */}
          {sttSupported && (
            <button
              type="button"
              onClick={toggleDictation}
              aria-pressed={listening}
              title={listening ? 'Stop dictation' : 'Dictate — speak to type'}
              className={
                'mono inline-flex items-center gap-1 h-6 px-2 rounded-sm hairline text-[10px] uppercase tracking-wider transition shrink-0 ' +
                (listening ? 'bg-rose-600 text-white animate-pulse' : 'bg-card/60 text-mute hover:text-ink')
              }
            >
              <Mic size={12} /> {listening ? 'Listening' : 'Dictate'}
            </button>
          )}
        </div>
        {streaming ? (
          <button type="button" onClick={stop} title="Stop Nyo (Esc)"
            className="mono inline-flex items-center gap-1.5 h-7 px-3 rounded-sm bg-rose-600 text-white text-[11px] uppercase tracking-wider hover:bg-rose-700 transition">
            <span className="inline-block h-2 w-2 bg-white rounded-[1px]" /> Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}
            className="mono inline-flex items-center h-7 px-3 rounded-sm bg-ink text-paper text-[11px] uppercase tracking-wider disabled:opacity-40">
            Send →
          </button>
        )}
      </div>
    </form>
  );

  return (
    <div className="relative flex flex-col h-full bg-paper">
      {onBack ? (
        // Back bar: the chat covers the plan entirely here, so the way out is a
        // full-width target rather than a corner glyph. Clear-history stays, small
        // and to the side — it is destructive and shouldn't sit next to the exit.
        <div className="border-b border-line shrink-0 flex items-stretch bg-card/40">
          <button
            onClick={onBack}
            className="flex-1 min-w-0 h-14 px-4 flex items-center gap-2.5 text-left text-ink font-semibold tracking-tight active:bg-card/80 transition"
          >
            <span className="text-lg leading-none" aria-hidden>←</span>
            <span className="truncate">{backLabel}</span>
          </button>
          <button
            onClick={clearChat}
            title="Clear local history"
            aria-label="Clear local history"
            className="h-14 w-12 grid place-items-center text-mute active:text-ink transition shrink-0"
          >
            <Trash size={15} />
          </button>
        </div>
      ) : (
        <div className="px-4 h-12 border-b border-line flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">{title || 'Nyo · command chat'}</span>
            {conversationId && <span className="mono text-[10px] text-mute">{conversationId.slice(0, 8)}</span>}
          </div>
          <div className="flex items-center gap-1">
            {/* History is Nyo-only: the conversations panel lists Nyo threads
                (no agent scoping on the client), so isolated-scope surfaces
                (planner, expand) would list — and could resume — the wrong
                agent's conversations. */}
            {scope === 'nyo' && (
              <button
                onClick={openHistory}
                title="Past conversations"
                aria-label="Past conversations"
                className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
              >
                <Clock size={15} />
              </button>
            )}
            <button
              onClick={clearChat}
              title="New chat (clears this thread from the screen; the conversation stays in history)"
              className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
            >
              <Trash size={15} />
            </button>
            {onClose && (
              <button
                onClick={onClose}
                title="Close chat"
                className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {historyOpen && (
        // Overlay rather than a sidebar: the chat surface is narrow in the ⌘J
        // drawer, and picking a thread is a brief, focused act.
        <div className="absolute inset-0 z-30 bg-paper flex flex-col">
          <div className="px-4 h-12 border-b border-line flex items-center justify-between shrink-0">
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Past conversations</span>
            <button
              onClick={() => setHistoryOpen(false)}
              title="Back to chat"
              className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {historyBusy && !history && <div className="p-4 text-sm text-mute">Loading…</div>}
            {historyErr && (
              <div className="p-4 text-sm">
                <div className="text-rose-600 mb-2">{historyErr}</div>
                <button onClick={openHistory} className="mono text-[11px] uppercase tracking-wider text-mute hover:text-ink">Retry</button>
              </div>
            )}
            {history && !history.length && !historyErr && (
              <div className="p-4 text-sm text-mute">No past conversations yet.</div>
            )}
            {history?.map((c) => (
              <div
                key={c.id}
                className={
                  'group border-b border-line flex items-stretch ' +
                  (c.id === conversationId ? 'bg-card/70' : 'hover:bg-card/50')
                }
              >
                <button
                  onClick={() => resumeConversation(c.id)}
                  disabled={historyBusy}
                  className="flex-1 min-w-0 text-left px-4 py-3 disabled:opacity-50"
                >
                  <div className="text-sm text-ink truncate">{c.title}</div>
                  <div className="mono text-[10px] text-mute mt-1">
                    {new Date(c.updated_at).toLocaleString()} · {c.turns} turn{c.turns === 1 ? '' : 's'}
                    {c.id === conversationId ? ' · current' : ''}
                  </div>
                </button>
                <button
                  onClick={() => removeConversation(c.id)}
                  title="Delete this conversation"
                  aria-label="Delete this conversation"
                  className="w-11 grid place-items-center text-mute opacity-0 group-hover:opacity-100 hover:text-rose-600 transition shrink-0"
                >
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {centered ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 gap-5">
          <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-ink text-center">What do you want done today?</h2>
          <div className="w-full max-w-2xl">{composer}</div>
          <div className="flex flex-wrap justify-center gap-2 max-w-2xl">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setInput(s.send)}
                className="mono text-[11px] text-mute hover:text-ink hairline rounded-full px-3 py-1.5 hover:bg-card/70 transition"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">
            {messages.length === 0 && (
              <div className="text-sm text-mute leading-relaxed">
                <p className="mono text-[10px] uppercase tracking-wider mb-2">Try</p>
                <ul className="space-y-1">
                  {suggestions.map((s) => (
                    <li key={s.label} className="hover:text-ink cursor-pointer" onClick={() => setInput(s.send)}>· {s.label}</li>
                  ))}
                </ul>
              </div>
            )}

            {messages.map((m, i) => {
              const isUser = m.role === 'user';
              // Group consecutive turns from the same role so we only show the
              // sender label on the first message of a run — matches how real
              // chat clients (iMessage, Slack) handle multi-turn replies.
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const showLabel = !prev || prev.role !== m.role;
              // Show the timestamp under the LAST message of each consecutive
              // same-role run (chat convention) — and only if we have a ts.
              const showStamp = !!m.ts && (!next || next.role !== m.role);
              return (
                <div key={i} className={'flex flex-col ' + (isUser ? 'items-end' : 'items-start')}>
                  {showLabel && (
                    <div className={'mono text-[10px] uppercase tracking-[0.18em] text-mute mb-1 ' + (isUser ? 'mr-1' : 'ml-1')}>
                      {isUser ? 'You' : 'Nyo'}
                    </div>
                  )}
                  <div className={
                    isUser
                      ? 'max-w-[85%] bg-ink text-paper rounded-2xl rounded-tr-sm px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap shadow-sm'
                      : 'max-w-[90%] bg-card/80 hairline text-ink rounded-2xl rounded-tl-sm px-3.5 py-2 text-sm leading-relaxed'
                  }>
                    {isUser
                      ? m.content
                      : (m.content
                          ? <MarkdownLite text={m.content} />
                          : (streaming && i === messages.length - 1 ? <span className="text-mute">…</span> : null))}
                    {!isUser && m.tool_events && m.tool_events.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {m.tool_events.map((t, j) => (
                          <details key={j} className="rounded-sm hairline bg-paper/80 px-2 py-1.5">
                            <summary className="mono text-[10px] uppercase tracking-wider text-mute cursor-pointer">
                              {t.error ? '✗' : t.result === undefined ? '·' : '✓'} {t.name}
                            </summary>
                            <pre className="mt-2 text-[11px] leading-snug whitespace-pre-wrap break-words text-mute">
{JSON.stringify(t.input ?? {}, null, 2)}
{t.result !== undefined ? '\n\n→ ' + JSON.stringify(t.result, null, 2) : ''}
{t.error ? '\n\n✗ ' + t.error : ''}
                            </pre>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                  {showStamp && (
                    <div className={'mono text-[9px] tracking-wider text-mute/70 mt-1 ' + (isUser ? 'mr-1' : 'ml-1')}>
                      {fmtStamp(m.ts!)}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          {composer}
        </>
      )}
    </div>
  );
}
