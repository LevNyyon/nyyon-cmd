// Schedule-first send control — one clean primary button that opens a compact
// popover of preset times (mail-client style), with a custom picker tucked
// behind "pick a time…" and send-now as the quiet last row. Shared by the
// Outreach conversations composer and the GTM outreach card so scheduling
// reads the same everywhere.
//
// All times are computed and displayed in the timezone the gtm-schedule
// knowledge doc names (via the `defaults` prop) — e.g. America/New_York —
// regardless of where the operator's browser is. Without one, browser-local.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Clock, Send } from './Icons';

export type ScheduleDefaults = { default_send_hour?: number; default_days_ahead?: number; default_jitter_minutes?: number; timezone?: string };
export type ScheduleSendHandle = { open: () => void };

// what the epoch reads as on a wall clock in tz (browser-local when tz unset)
function wallParts(epoch: number, tz?: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(epoch))) if (x.type !== 'literal') p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute };
}

// epoch for a wall-clock time in tz (fixed-point iteration handles DST edges)
// Exported: the cohort sheet edits a send time in the COHORT's zone and needs
// exactly this conversion. A second implementation would drift on a DST edge.
export function epochForWall(tz: string | undefined, y: number, m: number, d: number, hh: number, mm: number): number {
  if (!tz) return new Date(y, m - 1, d, hh, mm).getTime();
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const w = wallParts(guess, tz);
    const diff = Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

export const fmtWhen = (epoch: number, tz?: string) =>
  new Date(epoch).toLocaleString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: tz, timeZoneName: tz ? 'short' : undefined,
  });

export const toWallInput = (epoch: number, tz?: string) => {
  const w = wallParts(epoch, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.m)}-${p(w.d)}T${p(w.hh)}:${p(w.mm)}`;
};

// Computed ONCE per popover open (the jitter minute must match what the
// operator saw when they clicked). Default: the next noon in tz, at 12:0X
// where X is random — a flat :00 send time reads as a bot.
function presetTimes(defaults?: ScheduleDefaults | null): { label: string; at: number }[] {
  const tz = defaults?.timezone || undefined;
  const hour = defaults?.default_send_hour ?? 12;
  const days = defaults?.default_days_ahead ?? 0;
  const jitter = Math.max(0, defaults?.default_jitter_minutes ?? 9);
  const minute = Math.floor(Math.random() * (jitter + 1));
  const now = Date.now();
  const today = wallParts(now, tz);
  const atOffset = (offset: number) => {
    const dd = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    return epochForWall(tz, dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), hour, minute);
  };
  // the configured slot, rolled forward until it's actually in the future
  let offset = days;
  let at = atOffset(offset);
  while (at < now + 15 * 60 * 1000) { offset += 1; at = atOffset(offset); }
  const out: { label: string; at: number }[] = [];
  out.push({ label: offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `in ${offset} days`, at });
  const evening = epochForWall(tz, today.y, today.m, today.d, 17, minute);
  if (evening > now + 15 * 60 * 1000) out.push({ label: 'this evening', at: evening });
  out.push({ label: 'in 1 hour', at: now + 60 * 60 * 1000 });
  return out;
}

// short human name for the popover header: America/New_York -> "New York time"
const tzLabel = (tz?: string) => (tz ? `${tz.split('/').pop()!.replace(/_/g, ' ')} time` : 'local time');

type Props = {
  disabled?: boolean;
  busy?: boolean;
  defaults?: ScheduleDefaults | null;
  onSchedule: (atMs: number) => void | Promise<void>;
  onSendNow: () => void;
  // 'round' = circular icon button; 'label' = labelled pill (sm fits a
  // toolbar row, md matches a chat composer's 36px controls)
  variant?: 'round' | 'label';
  size?: 'sm' | 'md';
  label?: string;
  // Which way the popover opens. 'up' suits a composer pinned to the bottom of
  // the screen; 'down' is for a control near the TOP of a scroll container,
  // where opening upward would put the list behind the container's own edge.
  placement?: 'up' | 'down';
};

export const ScheduleSend = forwardRef<ScheduleSendHandle, Props>(function ScheduleSend(
  { disabled, busy, defaults, onSchedule, onSendNow, variant = 'round', size = 'sm', label = 'schedule', placement = 'up' }, ref,
) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customAt, setCustomAt] = useState('');
  // frozen at popover-open so the jittered minute the operator SEES is the
  // exact minute that gets scheduled (a render must not re-roll it)
  const [presets, setPresets] = useState<{ label: string; at: number }[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tz = defaults?.timezone || undefined;
  useImperativeHandle(ref, () => ({ open: () => { if (!disabled) setOpen(true); } }), [disabled]);

  // click-outside + Escape close the popover
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // a fresh open computes fresh presets (jitter included) + the custom default
  useEffect(() => {
    if (open) {
      const p = presetTimes(defaults);
      setPresets(p);
      setCustom(false);
      setCustomAt(toWallInput(p[0].at, defaults?.timezone || undefined));
    }
  }, [open, defaults]);

  function pick(atMs: number) {
    setOpen(false);
    onSchedule(atMs);
  }

  function pickCustom() {
    const m = customAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!m) return;
    pick(epochForWall(tz, +m[1], +m[2], +m[3], +m[4], +m[5]));
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      {variant === 'round' ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled || busy}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-emerald-500 text-white disabled:opacity-40 transition"
          aria-label="Schedule send"
          title="Schedule this message"
        >
          <Clock size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled || busy}
          className={
            (size === 'md'
              ? 'h-9 px-4 rounded-full text-[11px] '
              : 'h-7 px-2.5 rounded-sm text-[10px] ') +
            'bg-emerald-500 text-white mono uppercase tracking-[0.12em] disabled:opacity-40 transition inline-flex items-center gap-1.5'
          }
          title="Schedule this message"
        >
          <Clock size={size === 'md' ? 13 : 11} /> {busy ? 'scheduling…' : label}
        </button>
      )}

      {open && (
        <div className={(placement === 'down' ? 'top-full mt-2' : 'bottom-full mb-2')
          + ' absolute right-0 w-72 bg-card hairline rounded-sm shadow-lg z-30 p-1'}>
          <div className="px-2.5 pt-2 pb-1 mono text-[9px] uppercase tracking-[0.2em] text-mute">
            Schedule send · {tzLabel(tz)}
          </div>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => pick(p.at)}
              className="w-full flex items-baseline justify-between gap-2 px-2.5 py-2 rounded-sm text-left text-[12px] hover:bg-paper transition"
            >
              <span>{p.label}</span>
              <span className="mono text-[10px] text-mute">{fmtWhen(p.at, tz)}</span>
            </button>
          ))}
          {!custom ? (
            <button
              type="button"
              onClick={() => setCustom(true)}
              className="w-full px-2.5 py-2 rounded-sm text-left text-[12px] text-mute hover:bg-paper hover:text-ink transition"
            >
              pick a time…
            </button>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-2">
              <input
                type="datetime-local"
                value={customAt}
                onChange={(e) => setCustomAt(e.target.value)}
                className="flex-1 min-w-0 h-8 px-2 rounded-sm hairline bg-paper mono text-[10px]"
                title={`Interpreted as ${tzLabel(tz)}`}
              />
              <button
                type="button"
                onClick={pickCustom}
                className="h-8 px-2.5 rounded-sm bg-emerald-500 text-white mono text-[10px] uppercase tracking-[0.12em]"
              >
                set
              </button>
            </div>
          )}
          <div className="border-t border-[var(--color-line)] my-1" />
          <button
            type="button"
            onClick={() => { setOpen(false); onSendNow(); }}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-sm text-left text-[12px] text-mute hover:bg-paper hover:text-ink transition"
          >
            <Send size={12} /> send now instead
          </button>
        </div>
      )}
    </div>
  );
});
