// The OSINT listener table — the engines that scrape targets for mentions.
//
// Extracted verbatim from pages/Osint.tsx so BOTH the OSINT page and the Hot
// Takes → Approved Sources tab render the identical table from one source of
// truth. It is a SHARED control surface on purpose: toggling a listener or
// changing its cadence here changes it everywhere, because both mount this
// component against the same /api/osint/listeners endpoints.
//
// `timeAgo` is kept local (a copy of the one in Osint.tsx) rather than imported
// from ArticleBits: that exported variant formats dates >30d differently, and
// this table must render exactly as it always has.

import { useEffect, useState } from 'react';
import { api, type OsintSource, type OsintListener } from '../lib/api';

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function OsintListeners() {
  const [listeners, setListeners] = useState<OsintListener[] | null>(null);
  const [saving, setSaving] = useState<OsintSource | null>(null);

  async function refresh() { setListeners(await api.listOsintListeners()); }
  useEffect(() => { refresh(); }, []);

  async function toggle(source: OsintSource, enabled: boolean) {
    setSaving(source);
    try { await api.patchOsintListener(source, { enabled: enabled ? 1 : 0 }); await refresh(); }
    finally { setSaving(null); }
  }
  async function setCadence(source: OsintSource, cadence: OsintListener['cadence']) {
    setSaving(source);
    try { await api.patchOsintListener(source, { cadence }); await refresh(); }
    finally { setSaving(null); }
  }

  const enabledCount = (listeners || []).filter((l) => l.enabled).length;

  return (
    <>
      <div className="text-xs text-mute">
        {listeners ? `${enabledCount} of ${listeners.length} listeners enabled. Disabled engines skip scrapes until you flip them on.` : 'loading…'}
      </div>
      {!listeners && <div className="text-sm text-mute">Loading…</div>}
      {listeners && (
        <div className="overflow-x-auto hairline rounded-sm bg-card/80">
        <ul className="min-w-[720px] divide-y divide-line">
          {/* Every column left-aligned, generous gaps — the rows need room to breathe. */}
          <li className="px-5 py-2.5 grid grid-cols-12 gap-4 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
            <span className="col-span-1">on</span>
            <span className="col-span-3">listener</span>
            <span className="col-span-2">cadence</span>
            <span className="col-span-2">last run</span>
            <span className="col-span-2">runs · added</span>
            <span className="col-span-2">status</span>
          </li>
          {listeners.map((l) => (
            <li key={l.source} className="px-5 py-3.5 grid grid-cols-12 gap-4 items-baseline text-[13px] hover:bg-card transition">
              <span className="col-span-1">
                <button
                  onClick={() => toggle(l.source, !l.enabled)}
                  disabled={saving === l.source}
                  aria-pressed={!!l.enabled}
                  className={
                    'relative h-5 w-9 rounded-full transition ' +
                    (l.enabled ? 'bg-ink' : 'bg-line') +
                    (saving === l.source ? ' opacity-40' : '')
                  }
                >
                  <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-paper transition ' + (l.enabled ? 'left-[18px]' : 'left-0.5')} />
                </button>
              </span>
              <span className="col-span-3 min-w-0">
                <div className="font-medium text-ink truncate">{l.label}</div>
                <div className="mono text-[10px] text-mute truncate">{l.source} · {l.notes || ''}</div>
              </span>
              <span className="col-span-2">
                <select
                  value={l.cadence}
                  onChange={(e) => setCadence(l.source, e.target.value as OsintListener['cadence'])}
                  disabled={saving === l.source}
                  className="h-7 px-2 rounded-sm hairline bg-paper text-[12px] mono uppercase tracking-[0.04em] focus:border-ink focus:outline-none"
                >
                  <option value="manual">manual</option>
                  <option value="hourly">hourly</option>
                  <option value="daily">daily</option>
                </select>
              </span>
              <span className="col-span-2 mono text-[10px] text-mute">{timeAgo(l.last_run_at)}</span>
              <span className="col-span-2 mono text-[11px] tabular-nums">{l.total_runs} · +{l.total_added}</span>
              <span className="col-span-2 mono text-[10px]">
                {l.last_status === 'ok'    && <span className="text-emerald-700">ok</span>}
                {l.last_status === 'error' && <span className="text-rose-700">err</span>}
                {!l.last_status            && <span className="text-mute">—</span>}
                {l.last_error              && <span className="text-mute"> · {l.last_error.slice(0, 30)}</span>}
              </span>
            </li>
          ))}
        </ul>
        </div>
      )}
    </>
  );
}
