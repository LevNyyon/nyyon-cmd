import { useEffect, useState } from 'react';
import { Chat } from '../components/Chat';
import { PlanPanel } from '../components/PlanPanel';

// Daily Planner workspace — MOBILE FIRST.
//
// The plan is the product: it renders at every width and is what you check off
// all day. The planning conversation is the TOOL that produces it, used once in
// the morning — so on a phone it slides in over the plan as a drawer (mirroring
// ChatDrawer), and at lg+ it settles into a fixed column beside it. Previously
// the panel was `hidden md:flex`, which meant the plan — the whole point of the
// module — did not render on a phone at all.
//
// The breakpoint is lg, matching the app shell: Sidebar, the mobile top bar and
// ChatDrawer all switch at lg. The old md: split left a dead zone at 768-1024px
// where the mobile chrome and the desktop two-column layout were on screen at
// once.

const DESKTOP = '(min-width: 1024px)'; // Tailwind lg

export function DailyPlanner() {
  const [chatOpen, setChatOpen] = useState(false);
  const [desktop, setDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP).matches,
  );

  // Track the breakpoint so the chat can be a REAL drawer below lg (hidden from
  // assistive tech while closed, and closable) and a plain static column above
  // it. CSS alone can't express that — aria-hidden and the close button both
  // have to be off on desktop, where the chat is always visible.
  //
  // Sync on mount as well as on change: the useState initializer runs once, and
  // if the viewport differs by the time the effect attaches (or a change event
  // is missed) the state would otherwise stay wrong for the life of the page.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = () => {
      setDesktop(mq.matches);
      if (mq.matches) setChatOpen(false); // resizing up shouldn't strand drawer state
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!chatOpen || desktop) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setChatOpen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [chatOpen, desktop]);

  return (
    <div className="h-full min-h-0 flex bg-paper">
      {/* Scrim — mobile only; over the plan, under the drawer. */}
      <div
        onClick={() => setChatOpen(false)}
        className={
          'lg:hidden fixed inset-0 bg-black/25 backdrop-blur-[1px] z-40 transition-opacity duration-200 ' +
          (chatOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none')
        }
      />

      {/* The planning chat: drawer below lg, static column at lg+. */}
      <aside
        // aria-hidden alone would hide the closed drawer from screen readers while
        // leaving its buttons and composer in the tab order — focus could land on
        // content that is off-screen and announced as hidden. `inert` (React 19)
        // removes it from the tab order too. Both, so the intent is explicit.
        aria-hidden={!desktop && !chatOpen}
        inert={!desktop && !chatOpen}
        className={
          'fixed top-0 right-0 h-full w-full sm:w-[460px] bg-paper border-l border-line z-50 ' +
          'shadow-[-16px_0_40px_-20px_rgba(10,10,10,0.18)] transition-transform duration-300 ease-out ' +
          // max-lg: scopes the closed-drawer transform to BELOW lg. Emitting a bare
          // `translate-x-full` alongside `lg:translate-x-0` does not work — the lg
          // variant loses the cascade and the column renders shifted a full width
          // to the right, on top of the plan. Scoping it means the two never collide.
          (chatOpen ? 'translate-x-0 ' : 'max-lg:translate-x-full ') +
          'lg:static lg:z-auto lg:w-[480px] lg:shrink-0 lg:flex lg:flex-col ' +
          'lg:border-l-0 lg:border-r lg:shadow-none'
        }
      >
        <Chat
          scope="daily-planner"
          title="Daily Planner · your day"
          // Below lg the chat covers the plan, so it gets a full-width "Back to
          // plan" bar instead of a ✕. At lg+ the plan is already beside it and
          // neither is needed.
          onBack={desktop ? undefined : () => setChatOpen(false)}
        />
      </aside>

      {/* The plan — the base layer, visible at every width. */}
      <div className="flex-1 min-w-0 min-h-0 flex">
        <PlanPanel onOpenChat={desktop ? undefined : () => setChatOpen(true)} />
      </div>
    </div>
  );
}
