// Shared "live preview" iframe with a built-in health probe. Used by
// WebsiteContent, WebsiteManager, and Blog — every place the ops UI shows
// the local public-site dev server.
//
// Why probe before render: when the public site isn't running (or is on a
// different port because Vite shifted), the iframe just renders a generic
// browser "can't reach" page that looks identical to a real error and
// doesn't tell the operator HOW to fix it. The probe shows a clear
// "site is down — start it" panel with the actual command.

import { useEffect, useState } from 'react';

type Props = {
  src: string;
  title?: string;
  className?: string;
  /** path that should resolve cheaply (200) — defaults to "/" */
  probePath?: string;
};

type Health = 'probing' | 'up' | 'down';

const PROBE_TIMEOUT_MS = 2500;
const RE_PROBE_INTERVAL_MS = 4000;

async function probe(url: string, timeout: number): Promise<boolean> {
  // Cross-origin GET will be opaque, but a *connection* failure throws.
  // That's all we need: "does anything answer on this port?".
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    await fetch(url, { mode: 'no-cors', signal: ctl.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Reusable two-state toggle pill: "Staging" (local) vs "Live" (production).
// Used in Blog and Website to flip the preview iframe between unpublished
// drafts and what real visitors see. Two dots + labels — single thing the
// operator scans without reading.
export type PreviewMode = 'staging' | 'live';
export function PreviewModePill({ mode, onChange }: { mode: PreviewMode; onChange: (m: PreviewMode) => void }) {
  return (
    <div className="inline-flex items-center hairline rounded-sm bg-card p-0.5 shrink-0">
      <button
        onClick={() => onChange('staging')}
        className={
          'inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] h-6 px-2 rounded-sm transition ' +
          (mode === 'staging' ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
        }
        title="Local dev server — shows unpublished drafts"
      >
        <span className={'inline-block h-1.5 w-1.5 rounded-full ' + (mode === 'staging' ? 'bg-amber-300' : 'bg-amber-400')} aria-hidden />
        Staging
      </button>
      <button
        onClick={() => onChange('live')}
        className={
          'inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] h-6 px-2 rounded-sm transition ' +
          (mode === 'live' ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
        }
        title="The live article page"
      >
        <span className={'inline-block h-1.5 w-1.5 rounded-full ' + (mode === 'live' ? 'bg-emerald-300' : 'bg-emerald-500')} aria-hidden />
        Live
      </button>
    </div>
  );
}

export function SitePreview({ src, title = 'Public site preview', className = '', probePath = '/' }: Props) {
  const [health, setHealth] = useState<Health>('probing');
  const [tick, setTick]     = useState(0);

  useEffect(() => {
    let alive = true;
    const url = new URL(probePath, src).toString();
    setHealth('probing');
    probe(url, PROBE_TIMEOUT_MS).then((ok) => { if (alive) setHealth(ok ? 'up' : 'down'); });
    // Keep polling while down so the iframe pops back the moment the user
    // starts the dev server in another terminal.
    const id = window.setInterval(async () => {
      if (!alive) return;
      const ok = await probe(url, PROBE_TIMEOUT_MS);
      if (alive) setHealth(ok ? 'up' : 'down');
    }, RE_PROBE_INTERVAL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [src, probePath, tick]);

  if (health === 'up') {
    return (
      <iframe
        src={src}
        title={title}
        className={className || 'w-full h-full border-0 bg-paper'}
      />
    );
  }

  return (
    <div className={(className || 'w-full h-full') + ' grid place-items-center bg-paper'}>
      <div className="max-w-md text-center p-8">
        <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">
          {health === 'probing' ? 'probing preview…' : 'public site is down'}
        </div>
        {health === 'down' && (
          <>
            <div className="text-[13px] text-ink mb-3">
              Can't reach <span className="mono text-[12px]">{src}</span>
            </div>
            {(() => {
              // Local dev server vs remote production failure modes look
              // identical to the iframe ("connection refused") but the fix
              // is different. Branch the helper text + show the dev-server
              // bootstrap when host is localhost.
              let isLocal = false;
              try { const u = new URL(src); isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { /* malformed src */ }
              if (isLocal) {
                return (
                  <>
                    <div className="text-xs text-mute mb-4">
                      Start the public-site dev server, then this preview will pop back automatically.
                    </div>
                    <pre className="text-left mono text-[11px] bg-card hairline rounded-sm px-3 py-2 mb-4 select-all">
{`cd ~/nyyon-command-center/web-public
npm run dev`}
                    </pre>
                  </>
                );
              }
              return (
                <div className="text-xs text-mute mb-4">
                  The live site isn't answering. Check your internet, or Cloudflare's status if it lingers.
                </div>
              );
            })()}
            <button
              onClick={() => setTick((t) => t + 1)}
              className="mono text-[10px] uppercase tracking-[0.18em] h-8 px-3 rounded-sm hairline bg-ink text-paper hover:opacity-90"
            >
              Probe now
            </button>
          </>
        )}
        {health === 'probing' && (
          <div className="text-xs text-mute">Checking <span className="mono">{src}</span>…</div>
        )}
      </div>
    </div>
  );
}
