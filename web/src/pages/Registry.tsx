// Registry — the live, honest map of the system. Replaces the old hand-typed
// Modules + Tools pages: everything here is derived from the running code
// (GET /api/registry), so it can't drift.
//   Gateways  — external-service boundaries + configured/missing status
//   Tools     — Nyo's real tool registry, grouped by domain
//   Workflows — described pipelines + authored (D1) workflows, real last-runs
//   Modules   — the machine-readable product-area list (nyyon-lite layer 4)
// Each row lists the knowledge docs it depends on ("edit the doc → change the
// behaviour").

import { useEffect, useMemo, useState } from 'react';
import { api, type Registry, type RegistryGateway } from '../lib/api';

type Tab = 'gateways' | 'tools' | 'workflows' | 'modules';
const TAB_KEY = 'nyyon.registry.tab.v1';

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const KIND_TONE: Record<RegistryGateway['kind'], string> = {
  tunnel:       'bg-emerald-100 text-emerald-800',
  saas:         'bg-sky-100    text-sky-800',
  'public-api': 'bg-violet-100 text-violet-800',
  binding:      'bg-stone-200  text-stone-700',
};

function Chips({ slugs }: { slugs: string[] }) {
  if (!slugs.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {slugs.map((s) => (
        <span key={s} className="mono text-[9px] px-1.5 py-0.5 rounded-sm bg-paper hairline text-mute" title="knowledge dependency — edit this doc to change behaviour">
          📄 {s}
        </span>
      ))}
    </div>
  );
}

export function Registry() {
  const [reg, setReg] = useState<Registry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab) || 'gateways');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  useEffect(() => { api.registry().then(setReg).catch((e) => setErr(String(e))); }, []);

  const c = reg?.counts;
  const tabs = useMemo(() => ([
    { key: 'gateways'  as Tab, label: `Gateways ${c ? `· ${c.gateways_configured}/${c.gateways}` : ''}` },
    { key: 'tools'     as Tab, label: `Tools ${c ? `· ${c.tools}` : ''}` },
    { key: 'workflows' as Tab, label: `Workflows ${c ? `· ${c.workflows}` : ''}` },
    { key: 'modules'   as Tab, label: `Modules ${c?.modules ? `· ${c.modules}` : ''}` },
  ]), [c]);

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 sm:px-6 h-14 border-b border-line flex items-center justify-between bg-card/60 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold tracking-tight">Registry</h1>
          <div className="mono text-[10px] uppercase tracking-wider text-mute">live · derived from code</div>
        </div>
        {reg && <div className="mono text-[10px] uppercase tracking-wider text-mute">generated {timeAgo(reg.generated_at)}</div>}
      </header>

      <div className="px-4 sm:px-6 pt-4 shrink-0">
        <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] transition ' +
                (tab === t.key ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        {err && <div className="text-sm text-rose-700">Failed to load registry: {err}</div>}
        {!reg && !err && <div className="text-sm text-mute">Loading…</div>}

        {/* GATEWAYS */}
        {reg && tab === 'gateways' && (
          <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-w-5xl">
            {reg.gateways.map((g) => (
              <li key={g.name} className="hairline rounded-sm bg-card/80 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={'h-2 w-2 rounded-full shrink-0 ' + (g.configured ? 'bg-emerald-500' : 'bg-stone-300')} title={g.configured ? 'configured' : 'not configured'} />
                  <span className="font-semibold text-sm">{g.name}</span>
                  <span className={'mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm ' + KIND_TONE[g.kind]}>{g.kind}</span>
                  {!g.configured && <span className="mono text-[9px] uppercase text-amber-600 ml-auto">optional · unset</span>}
                </div>
                <div className="text-xs text-mute">{g.service}</div>
                <div className="text-[12px] mt-1.5">{g.ops}</div>
                <div className="mono text-[10px] text-mute mt-2">
                  {g.config.length
                    ? g.config.map((k) => (
                        <span key={k} className={'mr-2 ' + (g.missing.includes(k) ? 'text-amber-600' : 'text-emerald-700')}>
                          {g.missing.includes(k) ? '✗' : '✓'} {k}
                        </span>
                      ))
                    : <span className="text-mute">no key required</span>}
                </div>
                <Chips slugs={g.knowledge} />
              </li>
            ))}
          </ul>
        )}

        {/* TOOLS */}
        {reg && tab === 'tools' && (
          <div className="space-y-2 max-w-4xl">
            <p className="text-[11px] text-mute mb-1">{reg.counts.tools} live tools in {reg.counts.tool_groups} groups — the real registry Nyo calls, not a hand-list.</p>
            {reg.tools.map((grp) => {
              const open = openGroups.has(grp.group);
              return (
                <div key={grp.group} className="hairline rounded-sm bg-card/80">
                  <button
                    onClick={() => setOpenGroups((prev) => { const n = new Set(prev); n.has(grp.group) ? n.delete(grp.group) : n.add(grp.group); return n; })}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
                  >
                    <span className="mono text-[10px] text-mute w-4">{open ? '▾' : '▸'}</span>
                    <span className="font-semibold text-sm flex-1">{grp.group}</span>
                    {grp.knowledge.length > 0 && <span className="mono text-[9px] text-mute">📄 {grp.knowledge.length}</span>}
                    <span className="mono text-[10px] uppercase tracking-wider text-mute">{grp.count}</span>
                  </button>
                  {open && (
                    <div className="px-4 pb-3 pt-1 border-t border-line">
                      {grp.knowledge.length > 0 && <Chips slugs={grp.knowledge} />}
                      <ul className="mt-2 space-y-1.5">
                        {grp.tools.map((t) => (
                          <li key={t.name} className="text-[12px]">
                            <span className="mono text-ink">{t.name}</span>
                            {t.description && <span className="text-mute"> — {t.description}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* WORKFLOWS — grouped automated → continuous → event → on-demand */}
        {reg && tab === 'workflows' && (
          <div className="max-w-4xl space-y-6">
            {([
              ['automated',  'Automated · fires itself (cron)'],
              ['continuous', 'Continuous · runs while the app is open'],
              ['event',      'Event-driven · fires on a trigger'],
              ['on-demand',  'On-demand · you or Nyo starts it'],
            ] as const).map(([kind, label]) => {
              const items = reg.workflows.filter((w) => w.kind === kind);
              if (!items.length) return null;
              return (
                <div key={kind}>
                  <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">{label} · {items.length}</div>
                  <ul className="space-y-2.5">
                    {items.map((w) => (
                      <li key={w.name} className="hairline rounded-sm bg-card/80 p-4">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm">{w.name}</span>
                          <span className="mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-stone-200 text-stone-700">{w.trigger}</span>
                          {w.last_run_at !== null && <span className="mono text-[10px] text-emerald-700 ml-auto">last run {timeAgo(w.last_run_at)}</span>}
                        </div>
                        <div className="text-[12px] mt-1.5">{w.steps}</div>
                        {w.touches && <div className="mono text-[10px] text-mute mt-1">writes · {w.touches}</div>}
                        <Chips slugs={w.knowledge} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {/* MODULES — the machine-readable product-area registry (layer 4) */}
        {reg && tab === 'modules' && (
          <div className="max-w-4xl space-y-6">
            {([['module', 'Modules · product areas'], ['system', 'System · operator plumbing']] as const).map(([area, label]) => {
              const items = (reg.modules || []).filter((m) => m.area === area);
              if (!items.length) return null;
              return (
                <div key={area}>
                  <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">{label} · {items.length}</div>
                  <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {items.map((m) => (
                      <li key={m.key} className="hairline rounded-sm bg-card/80 p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{m.title}</span>
                          <span className="mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-paper hairline text-mute">{m.key}</span>
                        </div>
                        <div className="text-[12px] text-mute mt-1.5">{m.description}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
