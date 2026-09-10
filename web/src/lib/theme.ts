// Theme + sidebar prefs — all local, persisted in localStorage.

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY      = 'nyyon.theme.v1';
const HIDDEN_KEY     = 'nyyon.sidebar.hidden.v1';
const LEGACY_PREF_KEY = 'nyyon.sidebar.modules.v1'; // pre-2026-05-25 positive-list shape

// Modules that have a real surface (page) AND can be shown in the sidebar.
// Future modules (blog, ai-sdr, osint) join here once their page lands.
// IMPORTANT: when adding a new surface module, see Nyo knowledge doc
// `how-to-add-a-module` — there are 6 wiring spots that all need updating.
// Only "real" product modules belong here — these are the rows the operator can
// toggle from Settings → Sidebar modules. Knowledge / Roadmap / Modules-registry
// are system tools and live pinned in the System section instead.
export type SurfaceSlug = 'nyo' | 'daily-planner' | 'prospecting' | 'hot-takes';
// ORDER MATTERS — this array is the sidebar's running order (loadSidebarSlugs
// filters it by the hidden-list, preserving this sequence) and also the order of
// the toggle rows in Settings → Sidebar modules. The three the operator works out
// of daily lead; everything else follows in its established order.
export const SURFACE_MODULES: { slug: SurfaceSlug; label: string }[] = [
  { slug: 'daily-planner', label: 'Daily Planner' },
  { slug: 'hot-takes', label: 'Hot Takes' },
  { slug: 'prospecting', label: 'Prospecting' },
  // Prospecting picks WHO; Signals shows what those people are doing; Outreach
  // is the approach. The three read left-to-right as one motion.
  // Straight after Prospecting — picking who to approach, then approaching them.
  { slug: 'nyo',       label: 'Nyo' },
];
const ALL_SLUGS: SurfaceSlug[] = SURFACE_MODULES.map((m) => m.slug);

export function loadTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function saveTheme(t: Theme) {
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
}

function resolvedDark(t: Theme): boolean {
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', resolvedDark(t));
}

export function watchSystemTheme(get: () => Theme): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => { if (get() === 'system') applyTheme('system'); };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

// Hidden-list pref: the value stored is the list of slugs the operator
// explicitly hid. Anything in SURFACE_MODULES that isn't in the hidden list
// is shown — so newly-added modules surface by default forever.
function loadHidden(): Set<SurfaceSlug> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((s): s is SurfaceSlug => ALL_SLUGS.includes(s)));
      }
    }
    // One-time legacy migration: the old key stored a positive list (slugs to
    // show). We can't tell from it which slugs were explicitly hidden vs.
    // simply didn't exist yet. Drop it and default to showing everything;
    // operator can re-hide via Settings.
    if (localStorage.getItem(LEGACY_PREF_KEY) !== null) {
      localStorage.removeItem(LEGACY_PREF_KEY);
    }
    return new Set();
  } catch {
    return new Set();
  }
}

export function loadSidebarSlugs(): SurfaceSlug[] {
  const hidden = loadHidden();
  return ALL_SLUGS.filter((s) => !hidden.has(s));
}

export function saveSidebarSlugs(slugs: SurfaceSlug[]) {
  const shown = new Set(slugs);
  const hidden = ALL_SLUGS.filter((s) => !shown.has(s));
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  window.dispatchEvent(new Event('nyyon:sidebar-changed'));
}
