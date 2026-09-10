// The renderer for DECLARATIVE plugin surfaces (`tabs`) — the lightweight
// form for small packs: data, so it activates on import with no rebuild.
//
// A module's REAL page ships as `page_code` instead, materialized into the
// bundle by the applier behind a build gate (App.tsx routes those through
// PLUGIN_PAGES before falling back here).

import { useEffect, useState } from 'react';

export type SurfaceView = {
  kind: 'list' | 'form' | 'markdown';
  tool?: string;
  input?: Record<string, unknown>;
  rows_path?: string;                                   // where the rows live in the result
  columns?: { key: string; label: string }[];
  fields?: { key: string; label: string; type?: string; placeholder?: string }[];
  submit_label?: string;
  empty?: string;
  body?: string;                                        // markdown
  actions?: { label: string; tool: string; input?: Record<string, unknown> }[];
};
export type PluginSurfaceDef = {
  plugin: string;
  plugin_title: string;
  slug: string;
  title: string;
  icon?: string | null;
  tabs: { key: string; title: string; view: SurfaceView }[];
};

// Read `a.b.c` out of a result. Plugins describe where their rows are rather
// than every tool having to agree on one envelope.
function at(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

async function invoke(plugin: string, tool: string, input: Record<string, unknown>) {
  const r = await fetch(`/api/plugins/${encodeURIComponent(plugin)}/invoke/${encodeURIComponent(tool)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result;
}

function ListView({ plugin, view }: { plugin: string; view: SurfaceView }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!view.tool) return;
    setBusy(true); setErr(null);
    invoke(plugin, view.tool, view.input || {})
      .then((res) => {
        const found = at(res, view.rows_path);
        setRows(Array.isArray(found) ? found as Record<string, unknown>[] : []);
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setBusy(false));
  };
  useEffect(load, [plugin, view.tool]);

  const cols = view.columns?.length ? view.columns : [{ key: 'id', label: 'id' }];
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button className="text-[11px] text-mute hover:text-ink" onClick={load} disabled={busy}>
          {busy ? 'loading…' : 'refresh ↻'}
        </button>
      </div>
      {err && <div className="text-[12px] text-rose-700/90 mb-2">{err}</div>}
      {rows && rows.length === 0 && <div className="text-[12px] text-mute">{view.empty || 'Nothing yet.'}</div>}
      {rows && rows.length > 0 && (
        <div className="hairline rounded-sm overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-mute">
                {cols.map((c) => (
                  <th key={c.key} className="mono text-[9px] uppercase tracking-[0.14em] font-normal px-2.5 py-1.5">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-line/60">
                  {cols.map((c) => (
                    <td key={c.key} className="px-2.5 py-1.5 align-top">
                      {row[c.key] === null || row[c.key] === undefined
                        ? <span className="text-mute">—</span>
                        : String(row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FormView({ plugin, view }: { plugin: string; view: SurfaceView }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!view.tool) return;
    setBusy(true); setErr(null); setOut(null);
    try {
      const res = await invoke(plugin, view.tool, { ...(view.input || {}), ...values });
      setOut(JSON.stringify(res, null, 2));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2 max-w-xl">
      {(view.fields || []).map((f) => (
        <label key={f.key} className="block">
          <span className="mono text-[9px] uppercase tracking-[0.14em] text-mute">{f.label}</span>
          <input
            type={f.type === 'password' ? 'password' : 'text'}
            placeholder={f.placeholder || ''}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className="mt-0.5 w-full h-8 px-2 rounded-sm hairline bg-paper text-[12px] outline-none focus:border-emerald-500"
          />
        </label>
      ))}
      <button
        className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-paper disabled:opacity-40"
        disabled={busy} onClick={submit}
      >{busy ? 'Running…' : (view.submit_label || 'Run')}</button>
      {err && <div className="text-[12px] text-rose-700/90">{err}</div>}
      {out && <pre className="text-[11px] mono bg-paper p-3 rounded-sm hairline overflow-x-auto whitespace-pre-wrap">{out}</pre>}
    </div>
  );
}

export function PluginSurface({ def }: { def: PluginSurfaceDef }) {
  const [tab, setTab] = useState(def.tabs[0]?.key);
  const active = def.tabs.find((t) => t.key === tab) || def.tabs[0];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-4xl space-y-4">
      <header>
        <h1 className="text-lg font-semibold">{def.title}</h1>
        <p className="text-[11px] text-mute mt-0.5">
          from the <span className="mono">{def.plugin}</span> plugin
        </p>
      </header>

      {def.tabs.length > 1 && (
        <div className="hairline rounded-sm p-1 bg-card w-fit flex gap-1">
          {def.tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-[12px] px-2.5 py-1 rounded-sm ${t.key === active?.key ? 'bg-ink text-paper' : 'text-mute hover:text-ink'}`}
            >{t.title}</button>
          ))}
        </div>
      )}

      {active?.view.kind === 'list' && <ListView plugin={def.plugin} view={active.view} />}
      {active?.view.kind === 'form' && <FormView plugin={def.plugin} view={active.view} />}
      {active?.view.kind === 'markdown' && (
        <pre className="text-[12px] whitespace-pre-wrap leading-relaxed">{active.view.body || ''}</pre>
      )}
    </div>
  );
}
