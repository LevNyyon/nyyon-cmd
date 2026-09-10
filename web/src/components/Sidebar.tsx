import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { loadSidebarSlugs, type SurfaceSlug } from '../lib/theme';
import type { Nav } from '../App';
import { BookOpen, Plug, Cube, Activity as ActivityIcon, Gear, MessageSquare, CalendarCheck, Flame, Target, Wrench, X } from './Icons';

type Item = {
  key: Nav;
  label: string;
  Icon: (p: { size?: number; className?: string }) => ReactNode;
};

const SURFACE_ITEMS: Record<SurfaceSlug, Item> = {
  nyo:      { key: 'nyo',      label: 'Nyo',      Icon: MessageSquare },
  'daily-planner': { key: 'daily-planner', label: 'Daily Planner', Icon: CalendarCheck },
  prospecting: { key: 'prospecting', label: 'Prospecting', Icon: Target },
  'hot-takes': { key: 'hot-takes', label: 'Hot Takes', Icon: Flame },
};

// System tools — always pinned. Knowledge (the live doc tree Nyo reads/writes)
// + Activity (the real event log) + Settings are the ones with day-to-day
// value. The old Roadmap / Modules / Tools / Registry pages are fully REMOVED
// as standalone nav entries (routes deleted from App.tsx too) — the live
// machine-readable map (modules/gateways/tools/workflows from GET /api/registry)
// now lives folded into the Plugins module as its "System map" view.
// Restoring one would need a Nav key + route in App.tsx AND a line here.
const SYSTEM_ITEMS: Item[] = [
  { key: 'knowledge', label: 'Knowledge', Icon: BookOpen },
  { key: 'plugins',   label: 'Plugins',   Icon: Plug },
  { key: 'expand',    label: 'Expand',    Icon: Wrench },
  { key: 'activity',  label: 'Activity',  Icon: ActivityIcon },
  { key: 'settings',  label: 'Settings',  Icon: Gear },
];

// A plugin surface ships its icon in the manifest: a NAME from this host's
// icon set, inline SVG (validated at import), or an emoji. Cube if absent.
import * as AllIcons from './Icons';
function pluginIcon(icon?: string | null): Item['Icon'] {
  if (!icon) return Cube;
  const named = (AllIcons as Record<string, unknown>)[icon];
  if (typeof named === 'function') return named as Item['Icon'];
  if (/^\s*</.test(icon)) {
    return ({ size = 16 }: { size?: number }) => (
      <span style={{ width: size, height: size }} className="inline-block [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: icon }} />
    );
  }
  return ({ size = 16 }: { size?: number }) => (
    <span style={{ fontSize: size - 2, lineHeight: 1 }} className="inline-block">{icon}</span>
  );
}

type Props = {
  active: Nav; onNav: (k: Nav) => void; mobileOpen?: boolean; onClose?: () => void;
  // Pages contributed by installed plugins. They sit in their own section so
  // it is always obvious which parts of the app came from a plugin.
  pluginSurfaces?: { plugin: string; slug: string; title: string; icon?: string | null }[];
};

export function Sidebar({ active, onNav, mobileOpen = false, onClose, pluginSurfaces = [] }: Props) {
  const [slugs, setSlugs] = useState<SurfaceSlug[]>(() => loadSidebarSlugs());

  useEffect(() => {
    const refresh = () => setSlugs(loadSidebarSlugs());
    window.addEventListener('nyyon:sidebar-changed', refresh);
    return () => window.removeEventListener('nyyon:sidebar-changed', refresh);
  }, []);

  const moduleItems: Item[] = slugs.map((s) => SURFACE_ITEMS[s]);
  const pluginItems: Item[] = pluginSurfaces.map((sf) => ({
    key: `plugin:${sf.slug}` as Nav, label: sf.title, Icon: pluginIcon(sf.icon),
  }));

  return (
    <>
      {/* Mobile backdrop — tap to dismiss the off-canvas drawer. Desktop: none. */}
      <div
        className={
          'lg:hidden fixed inset-0 bg-black/30 z-40 transition-opacity duration-200 ' +
          (mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none')
        }
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={
          // Desktop: static 224px rail. Mobile (<lg): fixed off-canvas 256px drawer
          // that slides in from the left; solid bg so page content doesn't bleed.
          'flex flex-col shrink-0 border-r border-line ' +
          'fixed lg:static inset-y-0 left-0 z-50 w-64 lg:w-56 ' +
          'bg-paper lg:bg-paper/60 lg:panel ' +
          'transition-transform duration-200 lg:translate-x-0 ' +
          (mobileOpen ? 'translate-x-0' : '-translate-x-full')
        }
      >
      <div className="h-12 border-b border-line px-4 flex items-center gap-2">
        {/* Real Nyyon glyph (64×70). Light + dark variants swap via the `dark` class on <html>. */}
        <img
          src="/assets/nyyon-logo-dark.svg"
          alt="Nyyon"
          width={Math.round(20 * (64 / 70))}
          height={20}
          className="block dark:hidden shrink-0"
          style={{ height: 20 }}
          draggable={false}
        />
        <img
          src="/assets/nyyon-logo-light.svg"
          alt=""
          aria-hidden="true"
          width={Math.round(20 * (64 / 70))}
          height={20}
          className="hidden dark:block shrink-0"
          style={{ height: 20 }}
          draggable={false}
        />
        <span className="font-semibold tracking-tight text-[15px]">nyyon</span>
        <span className="mono text-[10px] text-mute ml-auto">v0.1</span>
        {/* Close the drawer on mobile; hidden on desktop where the rail is static. */}
        <button onClick={onClose} aria-label="Close menu" className="lg:hidden -mr-1 h-9 w-9 grid place-items-center text-mute hover:text-ink">
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 p-3 flex flex-col overflow-y-auto">
        <Section title="Modules" items={moduleItems} active={active} onNav={onNav} />
        {pluginItems.length > 0 && (
          <div className="pt-6">
            <Section title="Plugins" items={pluginItems} active={active} onNav={onNav} />
          </div>
        )}
        <div className="mt-auto pt-6">
          <Section title="System" items={SYSTEM_ITEMS} active={active} onNav={onNav} />
        </div>
      </nav>

      <Health />
      </aside>
    </>
  );
}

function Section({ title, items, active, onNav }: { title: string; items: Item[]; active: Nav; onNav: (k: Nav) => void }) {
  return (
    <div>
      <div className="mono text-[9px] uppercase tracking-[0.2em] text-mute px-2 pb-1">{title}</div>
      <div className="space-y-0.5">
        {items.map((it) => {
          const isActive = active === it.key;
          return (
            <button
              key={it.key}
              onClick={() => onNav(it.key)}
              className={
                'w-full text-left px-2 py-1.5 rounded-sm text-sm flex items-center gap-2.5 transition ' +
                (isActive
                  ? 'bg-card text-ink shadow-[inset_0_0_0_1px_var(--color-line)]'
                  : 'text-mute hover:text-ink hover:bg-card/70')
              }
            >
              <it.Icon size={16} className={isActive ? '' : 'opacity-90'} />
              <span className="flex-1">{it.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Traffic-light system health indicator. Polls every 30s. Hover reveals the
// per-check breakdown so the operator can see which subsystem is yellow/red.
// - green: all clear
// - yellow: a non-critical subsystem is degraded (WhatsApp puppet down,
//           a digest channel is erroring, etc.) — Nyyon is still operable
// - red: a mission-critical subsystem is down (DB unreachable, LLM key
//        missing) — most operator flows will fail until fixed
import type { SystemHealth, SystemHealthLevel } from '../lib/api';
const HEALTH_POLL_MS = 300_000; // 5 min — a status light must not poll hot (the LinkedIn probe is rate-limited)
const HEALTH_COLOR: Record<SystemHealthLevel, string> = {
  green:  'bg-emerald-500',
  yellow: 'bg-amber-500',
  red:    'bg-rose-500',
};
const HEALTH_LABEL: Record<SystemHealthLevel, string> = {
  green:  'systems ok',
  yellow: 'degraded',
  red:    'down',
};

function Health() {
  const [data, setData] = useState<SystemHealth | null>(null);
  const [downHard, setDownHard] = useState(false);

  useEffect(() => {
    let alive = true;
    async function probe() {
      try {
        const h = await api.systemHealth();
        if (alive) { setData(h); setDownHard(false); }
      } catch {
        if (alive) setDownHard(true);
      }
    }
    probe();
    const id = window.setInterval(probe, HEALTH_POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Worker itself is unreachable — treat as hard red.
  if (downHard) {
    return (
      <div className="relative group border-t border-line px-4 py-2.5 mono text-[10px] uppercase tracking-wider text-mute flex items-center gap-2 shrink-0 cursor-default">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
        api unreachable
        <Tooltip>
          <div className="font-semibold text-paper mb-1">Worker offline</div>
          <div className="text-paper/70">Can't reach <span className="mono">127.0.0.1:8788</span>. Check that wrangler dev is running.</div>
        </Tooltip>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="border-t border-line px-4 py-2.5 mono text-[10px] uppercase tracking-wider text-mute flex items-center gap-2 shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-stone-400" />
        checking…
      </div>
    );
  }
  const dot = HEALTH_COLOR[data.overall];
  const label = HEALTH_LABEL[data.overall];
  return (
    <div className="relative group border-t border-line px-4 py-2.5 mono text-[10px] uppercase tracking-wider text-mute flex items-center gap-2 shrink-0 cursor-default">
      <span className={'h-1.5 w-1.5 rounded-full ' + dot + (data.overall === 'red' ? ' animate-pulse' : '')} />
      <span>{label}</span>
      <Tooltip>
        <div className="font-semibold text-paper mb-1.5 flex items-center gap-2">
          <span className={'h-1.5 w-1.5 rounded-full ' + dot} />
          {label}
        </div>
        <ul className="space-y-1">
          {data.checks.map((c, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={'h-1.5 w-1.5 rounded-full mt-1 shrink-0 ' + HEALTH_COLOR[c.status]} />
              <span className="flex-1 min-w-0">
                <div className="text-paper">{c.name}</div>
                {c.note && <div className="text-paper/60 text-[10px]">{c.note}</div>}
              </span>
              {c.severity === 'critical' && c.status !== 'green' && (
                <span className="mono text-[9px] uppercase tracking-[0.18em] text-rose-300 shrink-0">critical</span>
              )}
            </li>
          ))}
        </ul>
      </Tooltip>
    </div>
  );
}

// Small hover tooltip floating up from the Health row. Pointer-events-none
// so it doesn't block clicks behind it.
function Tooltip({ children }: { children: ReactNode }) {
  return (
    <div
      role="tooltip"
      className="absolute left-3 bottom-full mb-2 w-64 z-50 hidden group-hover:block pointer-events-none"
    >
      <div className="rounded-sm bg-ink text-paper text-[11px] leading-relaxed px-3 py-2 shadow-[0_8px_30px_-8px_rgba(10,10,10,0.4)]">
        {children}
      </div>
    </div>
  );
}
