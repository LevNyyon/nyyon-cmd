import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DailyPlan, type PlanBlock, type PlanTodo, type WeeklyObjective, type WeeklyObjectives } from '../lib/api';
import { Search, X, MessageSquare, Menu } from './Icons';

// The plan surface of the Daily Planner workspace — the main course, and on a
// phone the ENTIRE page (the chat is a drawer over it; see pages/DailyPlanner).
// The plan's CONTENT is built and edited by the planner CHAT; here you watch it,
// mark items done, and step back. 🎯 Weekly Objectives pinned on top (collapsible
// on mobile, where vertical space is the scarce resource); 🔥 Focus Sessions (bold,
// black-framed 2h blocks vs plain regular blocks; done items stay struck-through,
// NOT collapsed); ✅ today-only to-dos. ↩ Undo reverts the last change; a spinner
// shows while a chat turn or a save is in flight; it refreshes after every chat turn.
//
// Touch sizing: checking items off is the primary phone job, so controls are
// finger-sized by default and shrink to the compact desktop scale at lg.

type Props = {
  // Present only below lg, where the chat is a drawer that needs opening.
  // Undefined on desktop, where the chat is always on screen.
  onOpenChat?: () => void;
};

const HISTORY_MAX = 15;
const OBJ_OPEN_KEY = 'nyyon.planner.objectives.open.v1';
const fmtDate = (d: string) => {
  try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  catch { return d; }
};
const todayLocal = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const byTime = (a: PlanBlock, b: PlanBlock) => (a.start || '99:99').localeCompare(b.start || '99:99');
const todoOrder = (a: PlanTodo, b: PlanTodo) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (b.star ? 1 : 0) - (a.star ? 1 : 0);
const EMPTY: DailyPlan = { date: '', mode: 'wing_it', summary: '', weekly_ref: null, schedule: [], todos: [], created_at: 0, updated_at: 0 };
const planSig = (p: DailyPlan | null) => p ? JSON.stringify([p.mode, p.summary, p.weekly_ref, p.schedule, p.todos]) : '';

function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-ink/25 border-t-ink animate-spin align-middle" aria-label="updating" />;
}

export function PlanPanel({ onOpenChat }: Props) {
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [objectives, setObjectives] = useState<WeeklyObjectives | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false); // a chat turn is in flight
  const [history, setHistory] = useState<DailyPlan[]>([]); // undo stack (past plans)
  const [future,  setFuture]  = useState<DailyPlan[]>([]); // redo stack (undone plans)
  // Objectives are pinned above the scroll area, so on a short screen they eat
  // ~156px of the plan. Default COLLAPSED and let the count carry the signal —
  // they're weekly context, not the thing you act on hourly. Only affects mobile:
  // the body below renders `hidden lg:block`, so desktop always shows the list.
  // The choice sticks (house pattern: localStorage).
  const [objOpen, setObjOpen] = useState(() => localStorage.getItem(OBJ_OPEN_KEY) === '1');
  useEffect(() => { localStorage.setItem(OBJ_OPEN_KEY, objOpen ? '1' : '0'); }, [objOpen]);

  // history search
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<DailyPlan[] | null>(null);
  const [viewing, setViewing] = useState<DailyPlan | null>(null); // a past day being reviewed
  const [viewDate, setViewDate] = useState<string>(todayLocal);   // the day the header shows — ‹ › time travel

  const planRef = useRef<DailyPlan | null>(null);
  useEffect(() => { planRef.current = plan; }, [plan]);

  const loadToday = useCallback(async () => {
    try {
      const [pr, wo] = await Promise.all([api.dailyPlan(), api.weeklyObjectives({}).catch(() => null)]);
      const cur = planRef.current;
      // A chat turn changed the plan → snapshot the pre-change version for Undo.
      if (cur && pr.plan && planSig(cur) !== planSig(pr.plan)) {
        setHistory((h) => (h.length && planSig(h[h.length - 1]) === planSig(cur)) ? h : [...h.slice(-(HISTORY_MAX - 1)), cur]);
        setFuture([]); // a chat turn is a forward change → the redo stack no longer applies
      }
      setPlan(pr.plan);
      setObjectives(wo?.objectives || null);
    } catch { /* keep prior */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadToday(); }, [loadToday]);

  // Time travel — ‹ › browse previous days (read-only, exactly like a searched
  // day), forward capped at today. The weekly objectives follow the VIEWED
  // day's workweek: the server anchors the date, the client never re-derives
  // the week convention.
  const gotoDate = useCallback(async (date: string) => {
    const today = todayLocal();
    const target = date > today ? today : date;
    setViewDate(target);
    if (target === today) {
      setViewing(null);
      loadToday();
      return;
    }
    try {
      const [pr, wo] = await Promise.all([
        api.dailyPlan(target),
        api.weeklyObjectives({ date: target }).catch(() => null),
      ]);
      setViewing(pr.plan || { ...EMPTY, date: target });
      if (wo) setObjectives(wo.objectives || null);
    } catch {
      setViewing({ ...EMPTY, date: target });
    }
  }, [loadToday]);
  const shiftDay = (delta: number) => {
    const d = new Date(`${viewDate}T00:00:00`);
    d.setDate(d.getDate() + delta);
    const p = (n: number) => String(n).padStart(2, '0');
    void gotoDate(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  };
  const isToday = viewDate === todayLocal();
  // Live refresh when a plan tool returns.
  useEffect(() => {
    const h = () => loadToday();
    window.addEventListener('nyyon:plan-updated', h);
    return () => window.removeEventListener('nyyon:plan-updated', h);
  }, [loadToday]);
  // Spinner + refresh keyed to the chat turn (fires on every input).
  useEffect(() => {
    const h = (e: Event) => {
      const busy = !!(e as CustomEvent).detail;
      setUpdating(busy);
      if (!busy) loadToday();
    };
    window.addEventListener('nyyon:chat-busy', h);
    return () => window.removeEventListener('nyyon:chat-busy', h);
  }, [loadToday]);

  const base = plan || EMPTY;

  // Persist a plan change (marking an item done). `track` pushes the pre-change
  // plan onto the Undo stack. The chat owns the content; the panel only marks done.
  async function persist(next: DailyPlan, track = true) {
    if (track && plan) {
      setHistory((h) => (h.length && planSig(h[h.length - 1]) === planSig(plan)) ? h : [...h.slice(-(HISTORY_MAX - 1)), plan]);
      setFuture([]); // a new forward change invalidates the redo stack (no redo across a branch)
    }
    setPlan(next);            // optimistic
    setSaving(true);
    try { setPlan(await api.saveDailyPlan(next)); }
    catch { /* keep optimistic copy */ } finally { setSaving(false); }
  }
  // Undo/redo shuttle the plan between two stacks. undo pops the last past plan
  // and pushes the current one onto the redo stack; redo does the reverse. Both
  // save with track=false so persist() touches neither stack — the moves are
  // managed here. Any NEW forward change (an edit, a reuse, a chat turn) clears
  // the redo stack via persist()/loadToday, so you can't redo across a branch.
  function undo() {
    if (!history.length || !plan) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [...f.slice(-(HISTORY_MAX - 1)), plan]);
    persist(prev, false);
  }
  function redo() {
    if (!future.length || !plan) return;
    const next = future[future.length - 1];
    setFuture((f) => f.slice(0, -1));
    setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), plan]);
    persist(next, false);
  }

  // mark done — the only in-panel plan edits
  const toggleBlock = (id: string) => persist({ ...base, schedule: base.schedule.map((b) => b.id === id ? { ...b, done: !b.done } : b) });
  const toggleTodo  = (id: string) => persist({ ...base, todos: base.todos.map((t) => t.id === id ? { ...t, done: !t.done } : t) });

  // objectives (separate weekly store) — mark done only; the chat sets them
  const objList = objectives?.objectives || [];
  async function saveObjectives(list: WeeklyObjective[]) {
    setObjectives((o) => (o ? { ...o, objectives: list } : { week_start: '', objectives: list, created_at: 0, updated_at: 0 }));
    setSaving(true);
    try { setObjectives(await api.saveWeeklyObjectives(list)); } catch { /* keep */ } finally { setSaving(false); }
  }
  const toggleObjective = (id: string) => saveObjectives(objList.map((o) => o.id === id ? { ...o, done: !o.done } : o));

  async function runSearch() { try { setResults(await api.searchDailyPlans(q.trim(), 30)); } catch { setResults([]); } }
  // Reuse a past day as today's draft. This REPLACES today's plan wholesale, so
  // it is the most destructive action in the panel and must go through persist()
  // — that is what pushes the outgoing plan onto the Undo stack. It used to call
  // api.saveDailyPlan directly, which overwrote today with no way back: ↩ had
  // nothing to restore.
  //
  // Spread `base` (today), never `src` (the past day). The PUT route resolves the
  // target day from the payload — `b.date || src.date || todayLocal` in index.js —
  // so carrying the source day's date across would rewrite THAT day instead of
  // today, quietly destroying a second plan.
  async function reuseAsToday(src: DailyPlan) {
    const next: DailyPlan = {
      ...base,
      mode: src.mode,
      summary: src.summary,
      weekly_ref: null,
      schedule: src.schedule.map((b) => ({ ...b, done: false })),
      todos: src.todos.map((t) => ({ ...t, done: false })),
    };
    // Drop out of the past-day view first so the reused plan is what you land on
    // (and snap the header + objectives back to today's week).
    setViewing(null); setViewDate(todayLocal()); setSearchOpen(false); setResults(null); setQ('');
    void api.weeklyObjectives({}).then((wo) => setObjectives(wo.objectives || null)).catch(() => {});
    await persist(next);
  }

  const shown = viewing || plan;
  const blocks = (shown?.schedule || []).slice().sort(byTime);   // done stays in place (no collapse)
  const todos  = (shown?.todos || []).slice().sort(todoOrder);
  const ro = !!viewing; // reviewing a past day → read-only

  const renderBlock = (b: PlanBlock) => (
    <li key={b.id} className={'flex items-start gap-3 lg:gap-2.5 px-3 py-3 lg:py-2.5 ' + (b.focus ? 'rounded-lg border-2 border-ink bg-card/40' : 'rounded-md hairline bg-card/30')}>
      <input type="checkbox" checked={b.done} disabled={ro} onChange={() => toggleBlock(b.id)} className="mt-0.5 lg:mt-1 shrink-0 accent-ink h-5 w-5 lg:h-4 lg:w-4" />
      <div className="flex-1 min-w-0">
        <div className={'leading-snug flex items-center gap-1.5 flex-wrap ' + (b.focus ? 'font-bold text-[15px] ' : 'text-sm ') + (b.done ? 'line-through text-mute' : 'text-ink')}>
          {b.focus && <span>🎯</span>}
          {(b.start || b.end) && <span className="mono text-xs text-mute font-normal">{b.start || '--:--'}–{b.end || '--:--'}</span>}
          <span className="flex-1 min-w-[6rem]">{b.title || <span className="text-mute italic">(untitled)</span>}</span>
        </div>
        {b.deliverable && (
          <div className="text-[13px] text-mute mt-0.5 flex items-baseline gap-1">
            <span>→</span><span className="flex-1">{b.deliverable}</span>
          </div>
        )}
      </div>
    </li>
  );

  const renderTodo = (t: PlanTodo) => (
    <li key={t.id} className="flex items-center gap-2.5 lg:gap-2 px-1 py-2.5 lg:py-1.5">
      <input type="checkbox" checked={t.done} disabled={ro} onChange={() => toggleTodo(t.id)} className="shrink-0 accent-ink h-5 w-5 lg:h-4 lg:w-4" />
      {t.star && <span className="shrink-0 text-[15px] leading-none" title="Extra important">⭐</span>}
      <span className={'flex-1 text-[15px] ' + (t.done ? 'line-through text-mute' : t.star ? 'text-ink font-semibold' : 'text-ink')}>
        {t.text || <span className="text-mute italic">(empty)</span>}
      </span>
    </li>
  );

  return (
    <div className="flex flex-col h-full w-full bg-paper/60 min-h-0">
      {/* header */}
      <div className="pl-1 pr-2 lg:px-5 h-14 border-b border-line flex items-center justify-between gap-1 lg:gap-2 shrink-0">
        <div className="flex items-center gap-1 lg:gap-2.5 min-w-0">
          {/* Below lg this header IS the page's top bar — App.tsx skips its own for
              this page — so the hamburger lives here. */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('nyyon:open-menu'))}
            aria-label="Open menu"
            className="lg:hidden h-11 w-11 shrink-0 grid place-items-center text-ink"
          >
            <Menu size={22} />
          </button>
          {/* The date leads the header at every width, with ‹ › time travel —
              ‹ walks back through past days (read-only), › returns toward today. */}
          <button
            onClick={() => shiftDay(-1)}
            aria-label="Previous day"
            className="h-11 w-8 lg:h-8 lg:w-7 shrink-0 grid place-items-center rounded-sm text-mute hover:text-ink hover:bg-card/70 transition text-base leading-none"
          >‹</button>
          <span className="text-base font-semibold tracking-tight text-ink truncate min-w-0">
            🗓️ {fmtDate(viewDate)}
            {isToday && <span className="hidden lg:inline text-mute font-normal"> · Today</span>}
          </span>
          <button
            onClick={() => shiftDay(1)}
            disabled={isToday}
            aria-label="Next day"
            className="h-11 w-8 lg:h-8 lg:w-7 shrink-0 grid place-items-center rounded-sm text-mute hover:text-ink hover:bg-card/70 transition text-base leading-none disabled:opacity-25 disabled:hover:bg-transparent"
          >›</button>
          {/* Mode chip (Strategic / Wing it): desktop only — noise in the tight mobile header. */}
          {shown && shown.mode && !viewing && (
            <span className={'hidden lg:inline-block mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm shrink-0 ' + (shown.mode === 'strategic' ? 'bg-ink text-paper' : 'bg-card text-mute hairline')}>
              {shown.mode === 'strategic' ? 'Strategic' : 'Wing it'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 lg:gap-1 shrink-0">
          {(saving || updating) && <Spinner />}
          {!viewing && (
            <button onClick={undo} disabled={!history.length} title="Undo last change" aria-label="Undo last change"
              className="h-11 w-11 lg:h-8 lg:w-8 grid place-items-center rounded-sm text-mute hover:text-ink hover:bg-card/70 transition disabled:opacity-25 disabled:hover:bg-transparent text-base leading-none">↩</button>
          )}
          {!viewing && (
            <button onClick={redo} disabled={!future.length} title="Redo last change" aria-label="Redo last change"
              className="h-11 w-11 lg:h-8 lg:w-8 grid place-items-center rounded-sm text-mute hover:text-ink hover:bg-card/70 transition disabled:opacity-25 disabled:hover:bg-transparent text-base leading-none">↪</button>
          )}
          <button onClick={() => { setSearchOpen((v) => !v); setViewing(null); }} title="Search past days" aria-label="Search past days"
            className={'h-11 w-11 lg:h-8 lg:w-8 grid place-items-center rounded-sm transition ' + (searchOpen ? 'bg-card text-ink hairline' : 'text-mute hover:text-ink hover:bg-card/70')}>
            <Search size={16} />
          </button>
          {/* Below lg the chat is a drawer — this is the way back to it. */}
          {onOpenChat && (
            <button onClick={onOpenChat} title="Open the planner chat" aria-label="Open the planner chat"
              className="h-11 w-11 grid place-items-center rounded-sm bg-ink text-paper ml-0.5">
              <MessageSquare size={17} />
            </button>
          )}
        </div>
      </div>

      {/* history search */}
      {searchOpen && (
        <div className="border-b border-line p-3 shrink-0 bg-card/30">
          <div className="flex items-center gap-2">
            {/* text-base below lg: iOS Safari auto-zooms the page on focus when
                an input's font-size is under 16px. */}
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder="🔍 Search past plans…" autoFocus
              className="flex-1 min-w-0 rounded-sm hairline bg-card/90 px-2.5 py-2 lg:py-1.5 text-base lg:text-sm placeholder:text-mute focus:border-ink focus:outline-none" />
            <button onClick={runSearch} className="mono text-[10px] uppercase tracking-wider h-11 lg:h-8 px-3 lg:px-2.5 shrink-0 rounded-sm bg-ink text-paper">Go</button>
          </div>
          {results && (
            <ul className="mt-2 space-y-1 max-h-56 overflow-y-auto">
              {results.length === 0 && <li className="text-xs text-mute px-1 py-2">No matching days.</li>}
              {results.map((r) => (
                <li key={r.date}>
                  <button onClick={() => void gotoDate(r.date)} className="w-full text-left px-2 py-2.5 lg:py-1.5 rounded-sm hover:bg-card/70 transition">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-ink">{fmtDate(r.date)}</span>
                      <span className="mono text-[9px] text-mute">{r.schedule.length}b · {r.todos.length}t</span>
                    </div>
                    {r.summary && <div className="text-xs text-mute truncate">{r.summary}</div>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <div className="p-5 text-sm text-mute">Loading…</div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* 🎯 Weekly Objectives — persist for the whole workweek: a past day
              shows ITS week's objectives (read-only); today's are editable. */}
          {(
            <div className="shrink-0 px-4 lg:px-5 pt-3 lg:pt-4 pb-2.5 lg:pb-3.5 border-b border-line bg-paper/70">
              {/* The heading toggles the list below lg, where vertical space is
                  scarce; at lg+ it is a plain heading and the list is always open. */}
              <button
                onClick={() => setObjOpen((v) => !v)}
                aria-expanded={objOpen}
                className="w-full flex items-center gap-2 text-left lg:pointer-events-none min-h-[44px] lg:min-h-0"
              >
                <h2 className="text-lg font-bold tracking-tight text-ink flex items-center gap-2">🎯 Weekly Objectives</h2>
                {objList.length > 0 && (
                  <span className="mono text-[10px] text-mute shrink-0">
                    {objList.filter((o) => o.done).length}/{objList.length}
                  </span>
                )}
                <span className={'lg:hidden ml-auto text-mute text-xs transition-transform ' + (objOpen ? 'rotate-180' : '')} aria-hidden>▾</span>
              </button>

              <div className={objOpen ? 'block' : 'hidden lg:block'}>
                <ul className="mt-1.5 lg:mt-2 space-y-0.5 lg:space-y-1">
                  {objList.map((ob) => (
                    <li key={ob.id} className="flex items-start gap-2.5 lg:gap-2 text-[15px] leading-snug py-1 lg:py-0">
                      <input type="checkbox" checked={ob.done} disabled={!!viewing} onChange={() => toggleObjective(ob.id)} className="mt-0.5 lg:mt-1 shrink-0 accent-ink h-5 w-5 lg:h-3.5 lg:w-3.5" />
                      <span className={'flex-1 ' + (ob.done ? 'line-through text-mute' : 'text-ink font-medium')}>{ob.text}</span>
                    </li>
                  ))}
                </ul>
                {objList.length === 0 && (
                  <p className="mt-1.5 text-sm text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <span aria-hidden>⚠️</span> No weekly objectives were set yet
                  </p>
                )}
              </div>
            </div>
          )}

          {/* scrolling: summary + focus sessions + to-dos */}
          <div className="flex-1 overflow-y-auto p-4 lg:p-5 space-y-6 lg:space-y-7">
            {viewing && (
              <button onClick={() => void gotoDate(todayLocal())} className="mono text-[10px] uppercase tracking-wider text-mute hover:text-ink flex items-center gap-1">
                <X size={12} /> back to today
              </button>
            )}
            {shown?.summary && <div className="text-base text-ink leading-relaxed">{shown.summary}</div>}

            {/* 🔥 Focus Sessions / schedule */}
            <section>
              <h3 className="text-base font-bold text-ink flex items-center gap-2 mb-2.5">🔥 Focus Sessions</h3>
              {blocks.length === 0 ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="rounded-lg border-2 border-ink px-4 py-3 flex items-center justify-between opacity-60">
                      <span className="font-bold text-ink flex items-center gap-2">🎯 Session {n}</span>
                      <span className="mono text-[11px] text-mute">2h</span>
                    </div>
                  ))}
                  {onOpenChat ? (
                    <button onClick={onOpenChat} className="mt-1 w-full h-11 rounded-sm bg-ink text-paper mono text-[10px] uppercase tracking-wider">
                      Plan the day
                    </button>
                  ) : (
                    <p className="text-xs text-mute pt-0.5">Placeholders — plan the day with the chat.</p>
                  )}
                </div>
              ) : (
                <ul className="space-y-2">{blocks.map(renderBlock)}</ul>
              )}
            </section>

            {/* ✅ To-do (today only) */}
            <section>
              <h3 className="text-base font-bold text-ink flex items-center gap-2 mb-2.5">✅ Today’s To-do</h3>
              {todos.length === 0 ? (
                onOpenChat ? (
                  <button onClick={onOpenChat} className="w-full h-11 rounded-sm hairline bg-card/40 text-mute text-sm">
                    Nothing yet — tap to plan the day
                  </button>
                ) : (
                  <div className="text-sm text-mute">Nothing yet — plan the day with the chat.</div>
                )
              ) : (
                <ul className="space-y-0.5">{todos.map(renderTodo)}</ul>
              )}
              {viewing && (
                <button onClick={() => reuseAsToday(viewing)} className="mt-4 mono text-[10px] uppercase tracking-wider h-11 lg:h-8 px-4 lg:px-3 rounded-sm bg-ink text-paper">
                  ♻️ Reuse as today’s draft
                </button>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
