import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatDrawer } from './components/ChatDrawer';
import { PluginSurface, type PluginSurfaceDef } from './components/PluginSurface';
import { api } from './lib/api';
import { Knowledge }       from './pages/Knowledge';
import { Plugins }         from './pages/Plugins';
import { Expand }          from './pages/Expand';
import { Activity }        from './pages/Activity';
import { Settings }        from './pages/Settings';
import { Setup } from './pages/Setup';
import { Prospecting } from './pages/Prospecting';
import { HotTakes } from './pages/HotTakes';
import { Nyo } from './pages/Nyo';
import { DailyPlanner } from './pages/DailyPlanner';
import { MessageSquare, Menu } from './components/Icons';
import { applyTheme, loadTheme, watchSystemTheme } from './lib/theme';
import { ChatProvider, useChatState } from './lib/chat';

// `plugin:<name>:<slug>` keys route to installed plugins' surfaces — no
// static registration; installing the plugin is enough.
export type Nav = 'nyo' | 'daily-planner' | 'prospecting' | 'hot-takes' | 'knowledge' | 'plugins' | 'expand' | 'activity' | 'settings' | `plugin:${string}`;

const NAV_KEY       = 'nyyon.nav.v1';
const CHAT_OPEN_KEY = 'nyyon.chat.open.v1';

// Section title for the mobile top bar (desktop shows the sidebar rail instead).
const NAV_TITLES: Partial<Record<Nav, string>> = { nyo: 'Nyo', 'daily-planner': 'Daily Planner', 'hot-takes': 'Hot Takes' };
const navTitle = (n: Nav) => NAV_TITLES[n] ?? n.charAt(0).toUpperCase() + n.slice(1);


export default function App() {
  // Setup mode: ?setup=<token> renders the onboarding wizard instead of the
  // app (the server guards every call; this is only routing). Strippable
  // later by deleting these two lines.
  if (new URLSearchParams(location.search).has('setup')) return <Setup />;

  const [nav, setNav] = useState<Nav>(() => {
    const saved = localStorage.getItem(NAV_KEY);
    // A saved nav can point at a module that no longer exists (removed in a
    // slim-down); restoring it renders a blank page. Fall back to a real one.
    const valid = new Set(['nyo', 'daily-planner', 'prospecting', 'hot-takes', 'knowledge', 'plugins', 'expand', 'activity', 'settings']);
    if (saved && (valid.has(saved) || saved.startsWith('plugin:'))) return saved as Nav;
    return 'nyo';
  });
  const [chatOpen, setChatOpen] = useState<boolean>(() => localStorage.getItem(CHAT_OPEN_KEY) === '1');
  // Off-canvas sidebar state (mobile only; desktop keeps the static rail).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Installed plugins' pages. A surface is data, so a newly imported plugin
  // shows up on the next load with no rebuild.
  const [pluginSurfaces, setPluginSurfaces] = useState<PluginSurfaceDef[]>([]);
  useEffect(() => {
    api.pluginSurfaces()
      .then((d) => setPluginSurfaces(d.surfaces || []))
      .catch(() => setPluginSurfaces([]));
  }, []);
  const handleNav = (n: Nav) => { setNav(n); setSidebarOpen(false); };

  // Apply persisted theme on mount + react to OS changes when in system mode.
  useEffect(() => {
    applyTheme(loadTheme());
    return watchSystemTheme(() => loadTheme());
  }, []);

  useEffect(() => { localStorage.setItem(NAV_KEY, nav); }, [nav]);
  useEffect(() => {
    localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? '1' : '0');
    // Let pages (e.g. Social) reflow their content out from under the fixed
    // 460px drawer when it opens.
    window.dispatchEvent(new CustomEvent('nyyon:chat-toggled', { detail: chatOpen }));
  }, [chatOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Cross-page nav: other surfaces fire 'nyyon:nav-to' with detail.target to
  // switch nav (e.g. Digest's "Discuss with Nyo" button hops to the Nyo page).
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent<{ target?: Nav }>).detail?.target;
      if (target) setNav(target);
    };
    window.addEventListener('nyyon:nav-to', handler);
    return () => window.removeEventListener('nyyon:nav-to', handler);
  }, []);

  // Cross-page "open the Nyo drawer" (e.g. Social's "Edit with Nyo" button) —
  // opens the drawer alongside the current page rather than navigating away.
  useEffect(() => {
    const handler = () => setChatOpen(true);
    window.addEventListener('nyyon:open-chat', handler);
    return () => window.removeEventListener('nyyon:open-chat', handler);
  }, []);

  // A page that suppresses the mobile top bar (Daily Planner) still needs a way
  // to reach the off-canvas sidebar, so it asks for it by event.
  useEffect(() => {
    const handler = () => setSidebarOpen(true);
    window.addEventListener('nyyon:open-menu', handler);
    return () => window.removeEventListener('nyyon:open-menu', handler);
  }, []);

  return (
    <ChatProvider>
    <div className="flex h-full">
      <Sidebar active={nav} onNav={handleNav} mobileOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} pluginSurfaces={pluginSurfaces} />

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Mobile top bar — hamburger + current section. Hidden on desktop (lg+), where the static rail shows.
            Skipped on the Daily Planner: that page's own header already carries a
            title and its actions, so both bars together burned ~104px of a phone
            screen to say one thing. It renders the hamburger itself and asks for
            the menu via 'nyyon:open-menu' (same event pattern as nav-to / open-chat). */}
        {nav !== 'daily-planner' && (
          <div className="lg:hidden h-12 shrink-0 border-b border-line panel flex items-center gap-1 px-2">
            <button onClick={() => setSidebarOpen(true)} aria-label="Open menu" className="h-10 w-10 grid place-items-center text-ink">
              <Menu size={22} />
            </button>
            <span className="font-semibold tracking-tight text-[15px]">{navTitle(nav)}</span>
          </div>
        )}
        {nav === 'nyo'    && <Nyo />}
        {nav === 'daily-planner' && <DailyPlanner />}
        {nav === 'prospecting' && <Prospecting />}
        {nav === 'hot-takes' && <HotTakes />}
        {nav === 'knowledge' && <Knowledge />}
        {nav === 'plugins'   && <Plugins />}
        {nav === 'expand'    && <Expand />}
        {/* A plugin's own page. The nav key carries which one, so a surface
            needs no route registration — installing the plugin is enough. */}
        {String(nav).startsWith('plugin:') && (() => {
          // Plugin surfaces are declarative — the host renders them.
          const def = pluginSurfaces.find((s) => `plugin:${s.slug}` === nav);
          return def ? <PluginSurface def={def} /> : null;
        })()}
        {nav === 'activity'  && <Activity />}
        {nav === 'settings'  && <Settings />}
      </main>

      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />

      {/* Hide the floating launcher when Nyo is the full-page surface — no need to open the drawer too.
          Also hidden on the Daily Planner: that page has its OWN chat (the
          planner thread). */}
      {!chatOpen && nav !== 'nyo' && nav !== 'daily-planner' && (
        <FloatingLauncher onOpen={() => setChatOpen(true)} />
      )}
    </div>
    </ChatProvider>
  );
}

// Floating Nyo launcher with unread-badge + streaming pulse. Lives inside the
// ChatProvider so it can read `hasUnseen` + `streaming` from the shared chat
// state. When the user gives Nyo a task and closes the drawer / navigates away,
// the chat() promise keeps running against ChatProvider state; the badge here
// is how Nyo signals "I have an update for you" — clicking opens the drawer
// and Chat.tsx clears the flag on mount.
//
// Desktop only (`hidden lg:grid`): on a phone the bubble sits on top of page
// content, and every surface is already reachable from the off-canvas menu —
// Nyo included, as its own full-page surface. The unread/streaming badge is a
// desktop affordance in consequence; the sidebar carries no chat state, so there
// is no mobile badge to fall back to.
function FloatingLauncher({ onOpen }: { onOpen: () => void }) {
  const { hasUnseen, unseenCount, streaming } = useChatState();
  // Show the count when proactive Nyo messages came in (wake-up briefings,
  // post-publish notifications). Fall back to the plain unread dot if we
  // know SOMETHING happened but lost count (e.g. operator was on a tool
  // result mid-stream when the page reloaded).
  const showCount = unseenCount > 0 && !streaming;
  const showDot   = hasUnseen && !showCount && !streaming;
  const titleText =
    streaming   ? 'Nyo is working… (⌘J)' :
    showCount   ? `Nyo has ${unseenCount} new update${unseenCount === 1 ? '' : 's'} (⌘J)` :
    showDot     ? 'Nyo has an update (⌘J)' :
                  'Open Nyo (⌘J)';
  return (
    <button
      onClick={onOpen}
      title={titleText}
      aria-label={titleText}
      className={
        'fixed bottom-5 right-5 h-12 w-12 rounded-full bg-ink text-paper hidden lg:grid place-items-center shadow-[0_8px_30px_-8px_rgba(10,10,10,0.4)] z-40 hover:scale-105 transition-transform ' +
        (streaming || showCount || showDot ? 'animate-pulse' : '')
      }
    >
      <MessageSquare size={20} />
      {streaming && (
        <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-paper" aria-hidden />
      )}
      {showCount && (
        <span
          className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 ring-2 ring-paper text-paper mono text-[10px] font-semibold leading-none grid place-items-center"
          aria-hidden
        >
          {unseenCount > 9 ? '9+' : unseenCount}
        </span>
      )}
      {showDot && (
        <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-paper" aria-hidden />
      )}
    </button>
  );
}
