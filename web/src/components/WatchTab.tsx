// Watch — hiring/job-change signals on watched leads (lifted whole from the
// retired GTM page; lives in Prospecting after Qualification). The hourly
// tick checks watched leads in bounded batches; a hit pings the operator on
// WhatsApp with a drafted response. Enriched leads are watched by default —
// curation is remove-many.
import { useEffect, useState } from 'react';
import { api, type GtmGreenLead, type GtmSignal, type GtmWatchLead, type GtmWatchState } from '../lib/api';
import { LinkedIn, Refresh, Search } from './Icons';

const btn = 'h-8 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] transition bg-card text-mute hover:text-ink disabled:opacity-40';
const btnPrimary = 'h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] transition bg-ink text-paper hover:opacity-90 disabled:opacity-40';

export function WatchTab() {
  const [state, setState] = useState<GtmWatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    try { setState(await api.gtmWatch()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { refresh(); }, []);

  const cfg = state?.config;
  // open work first (new/pinged), then the resolved tail — newest inside each
  const SIG_DONE: Record<GtmSignal['status'], number> = { new: 0, pinged: 0, responded: 1, dismissed: 1 };
  const signals = [...(state?.signals || [])].sort((a, b) =>
    (SIG_DONE[a.status] - SIG_DONE[b.status]) || (b.detected_at - a.detected_at));
  const watchedIds = new Set((state?.leads || []).map((l) => l.id));

  async function mark(id: string, status: 'responded' | 'dismissed' | 'new') {
    setBusy('sig:' + id);
    try { const r = await api.gtmSignalMark(id, status); if (r.error) alert(r.error); await refresh(); }
    finally { setBusy(null); }
  }
  async function setWatch(id: string, on: boolean) {
    setBusy('watch:' + id);
    try { const r = await api.gtmWatchSet(id, on); if (r.error) alert(r.error); await refresh(); }
    finally { setBusy(null); }
  }
  // Curation is remove-MANY: enriched leads are watched by default, the
  // operator prunes the irrelevant ones in one action.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSel((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const allSelected = (state?.leads.length ?? 0) > 0 && sel.size === state?.leads.length;
  async function removeSelected() {
    if (!sel.size) return;
    setBusy('bulk');
    try {
      const r = await api.gtmWatchBulk([...sel], false);
      if (r.error) alert(r.error);
      setSel(new Set());
      await refresh();
    } finally { setBusy(null); }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap max-w-3xl">
        <p className="text-[11px] text-mute flex-1 min-w-[240px]">
          Hiring + job-change signals on watched leads, checked automatically on the hourly
          cron{cfg ? ` — ${cfg.leads_per_tick} per pass, oldest first` : ''} · {
            (state?.leads || []).filter((l) => l.watch_checked_at && Date.now() - l.watch_checked_at < 86400000).length
          }/{state?.leads.length ?? 0} checked in the last 24h · next pass at the top of the hour.
          Signals ping YOU in the Digest · nothing here ever messages a lead.
        </p>
        <button onClick={refresh} className={btn + ' inline-flex items-center gap-1.5 shrink-0'}><Refresh size={11} /> refresh</button>
      </div>
      {error && (
        <div className="hairline rounded-sm bg-rose-500/5 border-rose-400/60 p-3 mb-3 max-w-3xl">
          <div className="text-xs text-rose-600">Couldn’t load watch state: {error}</div>
          <button onClick={refresh} className={btn + ' mt-2'}>retry</button>
        </div>
      )}

      {/* signal feed — the main event */}
      <ul className="space-y-2 max-w-3xl">
        {signals.map((s) => <SignalCard key={s.id} s={s} busy={busy === 'sig:' + s.id} onMark={(st) => mark(s.id, st)} />)}
      </ul>
      {state && signals.length === 0 && !error && (
        <div className="hairline rounded-sm bg-card/60 p-4 max-w-3xl text-[12px] text-mute">
          No signals yet. When a watched lead's company posts a role matching the watch
          patterns, or their LinkedIn headline changes, the signal lands here and pings
          the Digest.
        </div>
      )}

      {/* watched leads — enriched leads land here by default; prune in bulk */}
      <div className="flex items-center gap-2 mt-6 mb-1.5 max-w-3xl">
        <label className="flex items-center gap-1.5 shrink-0" title="Select all">
          <input type="checkbox" checked={allSelected}
            onChange={() => setSel(allSelected ? new Set() : new Set((state?.leads || []).map((l) => l.id)))}
            className="accent-current" />
        </label>
        <span className="mono text-[9px] uppercase tracking-[0.15em] text-mute flex-1">watched leads · {state?.leads.length ?? 0}</span>
        {sel.size > 0 && (
          <button onClick={removeSelected} disabled={busy === 'bulk'}
            className={btn + ' h-6 px-2 text-rose-600 border-rose-400/60'}>
            {busy === 'bulk' ? 'removing…' : `stop watching ${sel.size} selected`}
          </button>
        )}
        <button onClick={() => setShowAdd((v) => !v)} className={btn + ' h-6 px-2'}>{showAdd ? 'close' : '+ add leads'}</button>
      </div>
      {showAdd && <WatchAddPicker watchedIds={watchedIds} adding={busy} onAdd={(id) => setWatch(id, true)} />}
      <ul className="space-y-1.5 max-w-3xl">
        {(state?.leads || []).map((l) => (
          <WatchLeadRow key={l.id} lead={l} busy={busy}
                        selected={sel.has(l.id)} onToggle={() => toggleSel(l.id)}
                        onStop={() => setWatch(l.id, false)} />
        ))}
      </ul>
      {state && state.leads.length === 0 && !error && (
        <div className="text-[12px] text-mute py-3 max-w-3xl">Nobody is being watched. Enriched leads join automatically; add extras above.</div>
      )}

      <p className="text-[11px] text-mute mt-6">Config lives in the <span className="mono">gtm-watch</span> knowledge doc (cadence, role patterns, WhatsApp ping).</p>
    </div>
  );
}

function SignalCard({ s, busy, onMark }: { s: GtmSignal; busy: boolean; onMark: (status: 'responded' | 'dismissed' | 'new') => void }) {
  const [copied, setCopied] = useState(false);
  const d = s.detail;
  const resolved = s.status === 'responded' || s.status === 'dismissed';
  const statusTone = s.status === 'new'
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
    : s.status === 'pinged'
    ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300'
    : 'bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400';

  return (
    <li className={'hairline rounded-sm bg-card/80 p-3 space-y-2' + (resolved ? ' opacity-60' : '')}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm font-medium">{s.lead_name || s.lead_phone || s.lead_id}</span>
        {s.lead_company && <span className="mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-sm bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{s.lead_company}</span>}
        <span className="mono text-[9px] uppercase px-1.5 py-0.5 rounded-sm bg-paper hairline text-mute">{s.kind === 'open_role' ? '🎯 hiring' : '🔄 job change'}</span>
        <span className={'mono text-[9px] uppercase px-1.5 py-0.5 rounded-sm ' + statusTone}>{s.status}</span>
        <span className="mono text-[10px] text-mute ml-auto" title={new Date(s.detected_at).toLocaleString()}>{timeAgo(s.detected_at)}</span>
      </div>
      <div className="text-[12px]">{s.title}</div>
      {d && s.kind === 'open_role' && (d.role || d.url) && (
        <div className="text-[11px] text-mute">
          {d.url ? (
            <a href={d.url} target="_blank" rel="noreferrer" className="hover:text-ink hover:underline underline-offset-2">
              {d.role || 'open role'}{d.location && <span className="mono text-[10px]"> · {d.location}</span>} ↗
            </a>
          ) : (
            <>{d.role}{d.location && <span className="mono text-[10px]"> · {d.location}</span>}</>
          )}
        </div>
      )}
      {d && s.kind === 'job_change' && (d.old || d.new) && (
        <div className="text-[11px] text-mute">
          {d.old && <span dir="auto">{d.old}</span>} → {d.new && <span dir="auto" className="text-ink">{d.new}</span>}
          {d.company && <span className="mono text-[10px]"> · {d.company}</span>}
        </div>
      )}
      {s.draft && (
        <div className="hairline rounded-sm bg-paper p-2.5 flex items-start gap-2">
          <div dir="auto" className="flex-1 min-w-0 text-[13px] whitespace-pre-wrap break-words">{s.draft}</div>
          <button
            onClick={() => { navigator.clipboard.writeText(s.draft || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className={btn + ' h-7 shrink-0'}
            title="Copy the draft to the clipboard"
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {s.wa_link && (
          <a href={s.wa_link} target="_blank" rel="noreferrer" className={btnPrimary + ' inline-flex items-center'}>
            open in whatsapp ↗
          </a>
        )}
        {!resolved ? (
          <>
            <button onClick={() => onMark('responded')} disabled={busy} className={btn}>mark responded</button>
            <button onClick={() => onMark('dismissed')} disabled={busy} className={btn}>dismiss</button>
          </>
        ) : (
          <button onClick={() => onMark('new')} disabled={busy} className={btn}>reopen</button>
        )}
      </div>
    </li>
  );
}

function WatchLeadRow({ lead: l, busy, selected, onToggle, onStop }: {
  lead: GtmWatchLead; busy: string | null;
  selected: boolean; onToggle: () => void; onStop: () => void;
}) {
  return (
    <li className="hairline rounded-sm bg-card/80 flex items-center gap-3 px-3 py-2.5">
      <input type="checkbox" checked={selected} onChange={onToggle}
        className="shrink-0 accent-current" title="Select for bulk remove" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{l.name || <span className="text-mute mono text-xs">{l.normalized_phone || l.phone}</span>}</span>
          {l.company && <span className="mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-sm bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300">{l.company}</span>}
          {l.position && <span className="text-[11px] text-mute truncate">{l.position}</span>}
          {l.icp_fit && <span className="mono text-[9px] uppercase px-1.5 py-0.5 rounded-sm bg-paper hairline text-mute">{l.icp_fit}</span>}
        </div>
        <div className="mono text-[10px] text-mute flex items-center gap-2 flex-wrap">
          {l.headline_snapshot && <span className="truncate max-w-[320px]" title={l.headline_snapshot}>{l.headline_snapshot}</span>}
          <span className="shrink-0" title="The hourly cron rotates through all watchable leads, oldest check first">
            checked {l.watch_checked_at ? timeAgo(l.watch_checked_at) : 'never — queued for the next passes'}
          </span>
        </div>
      </div>
      {l.linkedin && (
        <a href={l.linkedin} target="_blank" rel="noreferrer" className="text-mute hover:text-ink shrink-0" title={l.linkedin}>
          <LinkedIn size={13} />
        </a>
      )}
      <button onClick={onStop} disabled={!!busy} className={btn + ' h-7 shrink-0'} title="Stop watching this lead">
        {busy === 'watch:' + l.id ? '…' : 'stop watching'}
      </button>
    </li>
  );
}

function WatchAddPicker({ watchedIds, adding, onAdd }: { watchedIds: Set<string>; adding: string | null; onAdd: (id: string) => void }) {
  const [leads, setLeads] = useState<GtmGreenLead[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.gtmGreen().then(setLeads).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);
  const needle = q.trim().toLowerCase();
  const visible = (leads || [])
    .filter((l) => !watchedIds.has(l.id) && (l.linkedin || l.company))
    .filter((l) => !needle || (l.name || '').toLowerCase().includes(needle) || (l.company || '').toLowerCase().includes(needle));
  return (
    <div className="hairline rounded-sm bg-card/60 p-2.5 mb-2 max-w-3xl space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-mute shrink-0"><Search size={12} /></span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or company…"
          autoFocus
          className="flex-1 h-7 hairline rounded-sm bg-paper px-2.5 text-xs focus:outline-none"
        />
      </div>
      {err && <div className="text-xs text-rose-600 px-1 py-1">{err}</div>}
      {leads === null && !err && <div className="text-xs text-mute px-1 py-2">Loading enriched leads…</div>}
      <ul className="max-h-56 overflow-y-auto space-y-0.5">
        {visible.map((l) => (
          <li
            key={l.id}
            onClick={() => { if (!adding) onAdd(l.id); }}
            className={'flex items-center gap-2.5 px-2.5 py-1.5 rounded-sm transition ' + (adding ? 'opacity-60' : 'cursor-pointer hover:bg-card/70')}
          >
            <span className="text-xs font-medium truncate flex-1">{l.name || l.normalized_phone || l.phone}</span>
            {l.company && <span className="mono text-[10px] text-mute truncate max-w-[180px]">{l.company}</span>}
            {l.position && <span className="text-[10px] text-mute truncate max-w-[160px] hidden sm:inline">{l.position}</span>}
            <span className="mono text-[9px] uppercase text-mute shrink-0">{adding === 'watch:' + l.id ? 'adding…' : '+ watch'}</span>
          </li>
        ))}
        {leads !== null && visible.length === 0 && !err && <div className="text-xs text-mute px-2 py-3">No unwatched enriched leads match.</div>}
      </ul>
    </div>
  );
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}