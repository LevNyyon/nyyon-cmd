// Plugins — trade capabilities between nyyon systems.
//
// Import: paste the manifest JSON another system exported; the server
// validates the format contract, binds gateways mechanically, and reports
// either the binding or the exact blocking errors. Export: one click copies
// the sealed manifest for handing to another system. On cmd (a cloud worker)
// code materializes via a GitHub commit — the Materialize button commits the
// bound plugins' files and CI redeploys (minutes); a plugin only reads
// "active" once its tools are live in the pool (Verify, or the 15s poll).
//
// This module is a two-view surface. The primary "Plugins" view is the
// installed list, each row expandable into its own registry (every component
// the plugin put into this system, with real paths). The secondary "System
// map" view folds in the old standalone Registry page — the live, honest map
// of every gateway / tool / workflow / module the running code exposes.

import { useEffect, useState, type ReactNode } from 'react';
import { api, type PluginRow, type PluginReg } from '../lib/api';
import { Registry } from './Registry';

type View = 'plugins' | 'system';
const VIEW_KEY = 'nyyon.plugins.view.v1';

const STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-700 bg-emerald-500/10',
  bound: 'text-amber-700 bg-amber-500/10',
  materialized: 'text-amber-700 bg-amber-500/10',
  blocked: 'text-rose-700 bg-rose-500/10',
  removed: 'text-mute bg-line/40',
};

export function Plugins() {
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) as View) || 'plugins');
  const [rows, setRows] = useState<PluginRow[]>([]);
  const [reg, setReg] = useState<Record<string, PluginReg>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [paste, setPaste] = useState('');
  const [srcUrl, setSrcUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

  // A swallowed load error rendered "Nothing installed yet." over a session
  // that had simply expired — the operator saw an empty, apparently working
  // page and no reason to sign in again. Surface it instead, and name the 401
  // for what it is.
  const loadError = (e: unknown) => {
    const msg = String((e as Error)?.message || e);
    setNote(/^401\b/.test(msg)
      ? 'Session expired — reload the page and sign in again to see installed plugins.'
      : `Could not load plugins: ${msg}`);
  };
  const reload = () => Promise.all([
    api.listPlugins().then((r) => { setRows(r); return true; }).catch((e) => { loadError(e); return false; }),
    api.pluginRegistry()
      .then((p) => { setReg(Object.fromEntries(p.map((x) => [x.name, x]))); return true; })
      .catch((e) => { loadError(e); return false; }),
  ]);
  useEffect(() => { reload(); const t = setInterval(reload, 15000); return () => clearInterval(t); }, []);

  // The cloud materializer has work when a plugin awaits its commit, or a
  // removed plugin's files still sit in the repo (report.step ≠ cleaned).
  const needsMaterialize = rows.some(
    (r) => r.status === 'bound' || (r.status === 'removed' && r.report?.step !== 'cleaned'),
  );

  const doImport = async () => {
    setBusy(true); setNote(null);
    try {
      const manifest = JSON.parse(paste);
      const r = await api.importPlugin(manifest);
      setNote(r.ok
        ? `Imported — status: ${r.status}.${r.status === 'bound' ? ' Hit Materialize to commit the code (CI deploys it).' : ''}`
        : `Blocked:\n${(r.errors || []).join('\n')}`);
      if (r.ok) setPaste('');
      reload();
    } catch (e) {
      setNote(`Not valid JSON: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  // The primary path: install FROM A SOURCE. The URL is recorded with the
  // plugin, so "where did this come from" and "is there a newer version" are
  // answerable later — the two questions a pasted blob can never answer.
  const doImportUrl = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.importPluginUrl(srcUrl.trim());
      setNote(r.ok
        ? `Imported from ${r.source?.source_url || srcUrl}${r.source?.ref ? ` @ ${r.source.ref}` : ''} — status: ${r.status}.${r.status === 'bound' ? ' Hit Materialize to commit the code (CI deploys it).' : ''}`
        : `Blocked:\n${(r.errors || [r.error]).filter(Boolean).join('\n')}`);
      if (r.ok) setSrcUrl('');
      reload();
    } catch (e) {
      setNote(`Could not fetch that source: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  // A package is the authoring form: manifest.json plus real .mjs/.md files.
  // The server assembles it back into the same manifest the paste box takes.
  const doImportPackage = async (file: File) => {
    setBusy(true); setNote(null);
    try {
      const r = await api.importPluginPackage(file);
      setNote(r.ok
        ? `Imported ${file.name} — status: ${r.status}.${r.status === 'bound' ? ' Hit Materialize to commit the code (CI deploys it).' : ''}`
        : `Blocked:\n${(r.errors || [r.error]).filter(Boolean).join('\n')}`);
      reload();
    } catch (e) {
      setNote(`Could not read the package: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  const doMaterialize = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.materializePlugins();
      setNote(r.ok
        ? `Committed: ${(r.committed || []).join(', ') || '(nothing)'}${(r.cleaned || []).length ? ` · cleaned: ${r.cleaned!.join(', ')}` : ''}. ${r.note || ''}`.trim()
        : r.error || (r.failed || []).map((f) => `${f.name}: ${f.error}`).join('\n') || 'Materialize failed.');
      reload();
    } catch (e) {
      setNote(`Materialize failed: ${String((e as Error)?.message || e)}`);
    } finally { setBusy(false); }
  };

  const doVerify = async (name: string) => {
    const r = await api.verifyPlugin(name).catch((e) => ({ ok: false, error: String(e) }));
    setNote(r.ok ? `"${name}" is live — status: active.` : `Not live yet: ${r.error || 'unknown'}`);
    reload();
  };

  const doExport = async (name: string) => {
    const m = await api.exportPlugin(name);
    await navigator.clipboard.writeText(JSON.stringify(m, null, 2));
    setNote(`"${name}" manifest copied to the clipboard — paste it into the other system's Plugins page.`);
  };

  const doRemove = async (name: string) => {
    if (!confirm(`Remove plugin "${name}"? Its workflows disable and its code is cleaned on the next Materialize. Tables and data stay.`)) return;
    await api.removePlugin(name);
    reload();
  };

  return (
    <div className="h-full flex flex-col">
      {/* View toggle: the installed plugins vs the system-wide live map. */}
      <div className="px-4 sm:px-6 pt-4 shrink-0">
        <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit">
          {([['plugins', 'Plugins'], ['system', 'System map']] as [View, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={
                'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.18em] transition ' +
                (view === v ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'plugins' && (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-3xl space-y-6">
            <header>
              <h1 className="text-lg font-semibold">Plugins</h1>
              <p className="text-[12px] text-mute mt-1">
                Capabilities traded between nyyon systems. Code travels verbatim — nothing is
                rewritten; a plugin runs against a capability object (its own tables, only the
                gateways it declared), never this install's env. Format: docs/plugin-format.md.
                Importing code is an operator action: read the source before you paste it.
              </p>
            </header>

            <section className="hairline rounded-sm bg-card/80 p-4 space-y-2">
              <div className="mono text-[10px] uppercase tracking-[0.14em] text-mute">Install from a source</div>
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 h-9 px-2.5 text-[12px] mono rounded-sm hairline bg-paper outline-none focus:border-emerald-500"
                  placeholder="https://github.com/owner/plugin  (or a link to a .zip / manifest.json)"
                  value={srcUrl}
                  onChange={(e) => setSrcUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && srcUrl.trim() && !busy) doImportUrl(); }}
                />
                <button
                  className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-paper disabled:opacity-40 shrink-0"
                  disabled={busy || !srcUrl.trim()} onClick={doImportUrl}
                >{busy ? 'Installing…' : 'Install'}</button>
              </div>
              <p className="text-[11px] text-mute">
                A source is recorded with the plugin, so you can see where it came from and re-install a newer version later.
              </p>

              <div className="mono text-[10px] uppercase tracking-[0.14em] text-mute pt-2">Or paste a manifest</div>
              <textarea
                className="w-full h-32 text-[12px] mono p-2 rounded-sm bg-paper hairline"
                placeholder='Paste the manifest JSON another system exported ({"nyyon_plugin":2, ...})'
                value={paste} onChange={(e) => setPaste(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <button
                  className="text-[12px] px-3 py-1.5 rounded-sm bg-ink text-paper disabled:opacity-40"
                  disabled={busy || !paste.trim()} onClick={doImport}
                >{busy ? 'Working…' : 'Import'}</button>
                <label className="text-[11px] text-mute hover:text-ink cursor-pointer">
                  or upload a .zip package
                  <input
                    type="file" accept=".zip,application/zip" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) doImportPackage(f); e.target.value = ''; }}
                  />
                </label>
                {needsMaterialize && (
                  <button
                    className="text-[12px] px-3 py-1.5 rounded-sm hairline bg-card hover:bg-card/70 disabled:opacity-40"
                    disabled={busy} onClick={doMaterialize}
                    title="Commit the bound plugins' code files to the repo — CI deploys the commit"
                  >Materialize (commit + deploy)</button>
                )}
                {note && <pre className="text-[11px] text-mute whitespace-pre-wrap flex-1">{note}</pre>}
              </div>
            </section>

            <section className="space-y-2">
              <div className="mono text-[10px] uppercase tracking-[0.14em] text-mute">Installed</div>
              {!rows.length && <div className="text-[12px] text-mute">Nothing installed yet.</div>}
              {rows.map((r) => (
                <div key={r.name} className="hairline rounded-sm bg-card/80 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{r.title}</span>
                    <span className="mono text-[10px] text-mute">{r.name} · v{r.version}</span>
                    <span className={`mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-full ${STATUS_TONE[r.status] || 'text-mute bg-line/40'}`}>{r.status}</span>
                    <span className="flex-1" />
                    {r.status === 'materialized' && (
                      <button className="text-[11px] text-mute hover:text-ink" onClick={() => doVerify(r.name)} title="Check the tools are live in the pool (run after the CI deploy lands)">Verify</button>
                    )}
                    <button className="text-[11px] text-mute hover:text-ink" onClick={() => doExport(r.name)}>Export</button>
                    <a
                      className="text-[11px] text-mute hover:text-ink"
                      href={`/api/plugins/${encodeURIComponent(r.name)}/package`}
                      download
                    >Download .zip</a>
                    {r.status !== 'removed' && (
                      <button className="text-[11px] text-rose-700/70 hover:text-rose-700" onClick={() => doRemove(r.name)}>Remove</button>
                    )}
                  </div>
                  {Object.keys(r.binding || {}).length > 0 && (
                    <div className="mt-1 text-[11px] text-mute">
                      gateways: {Object.entries(r.binding).map(([slug, b]) => `${slug} → ${b.target} (${b.via})`).join(' · ')}
                    </div>
                  )}
                  {/* A v1-with-code row is NOT in the pool, whatever its status
                      column says. Say so on the card rather than letting the
                      page claim a plugin is live when its tools are absent. */}
                  {r.needs_reauthoring && (
                    <div className="mt-1 text-[11px] text-amber-700">
                      v1 code — not in the tool pool. v1 tools expected raw <span className="mono">env</span> and cannot run
                      under the capability contract. Re-author as v2 and re-import, or Remove (then Materialize to delete its files).
                    </div>
                  )}
                  {r.status === 'blocked' && (
                    <pre className="mt-1 text-[11px] text-rose-700/90 whitespace-pre-wrap">{(r.report?.errors || [r.report?.error]).filter(Boolean).join('\n')}</pre>
                  )}
                  {reg[r.name] && (
                    <button className="mt-1 text-[11px] text-mute hover:text-ink" onClick={() => setOpen((o) => ({ ...o, [r.name]: !o[r.name] }))}>
                      {open[r.name] ? '▾ registry' : '▸ registry'}
                    </button>
                  )}
                  {open[r.name] && reg[r.name] && <PluginRegistry p={reg[r.name]} />}
                </div>
              ))}
            </section>
          </div>
        </div>
      )}

      {view === 'system' && (
        // Fold in the old standalone Registry page — reused verbatim, not
        // rewritten. It renders its own header + gateways/tools/workflows/
        // modules tabs; here it lives as the Plugins module's second view.
        <div className="flex-1 min-h-0">
          <Registry />
        </div>
      )}
    </div>
  );
}

// One plugin's full registry: every component it put into this system, with
// the real paths its code lives at. This IS the Registry — plugin-scoped.
function PluginRegistry({ p }: { p: PluginReg }) {
  const Section = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="mt-1.5">
      <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute">{label}</div>
      <div className="text-[11px] mt-0.5 space-y-0.5">{children}</div>
    </div>
  );
  const none = <span className="text-mute">none</span>;
  return (
    <div className="mt-2 pl-3 border-l border-line/70">
      <Section label="Path">
        <span className="mono text-[10px]">{p.path}/</span>
        {p.origin?.system && <span className="text-mute"> · from {p.origin.system}</span>}
      </Section>
      <Section label={`Tools (${p.tools.length})`}>
        {p.tools.length ? p.tools.map((t) => (
          <div key={t.name}><span className="mono text-[10px]">{t.name}</span> — <span className="mono text-[10px] text-mute">{t.path}</span>
            {t.description && <div className="text-mute">{t.description.slice(0, 110)}</div>}</div>
        )) : none}
      </Section>
      <Section label={`Gateways (${p.gateways.length} bundled · ${p.gateway_bindings.length} bound)`}>
        {p.gateways.map((g) => (
          <div key={g.slug}><span className="mono text-[10px]">{g.installed_as}</span> — <span className="mono text-[10px] text-mute">{g.path}</span>
            {g.in_use === false && <span className="text-mute"> · not installed (the host gateway won the binding)</span>}</div>
        ))}
        {p.gateway_bindings.map((b) => (
          <div key={b.slug}><span className="mono text-[10px]">{b.slug}</span> → <span className="mono text-[10px]">{b.target}</span> <span className="text-mute">({b.via})</span>
            {!!b.modes?.length && <span className="text-mute"> · modes: {b.modes.join(', ')}</span>}</div>
        ))}
        {!p.gateways.length && !p.gateway_bindings.length && none}
      </Section>
      <Section label={`Workflows (${p.workflows.length})`}>
        {p.workflows.length ? p.workflows.map((w) => (
          <div key={w.slug}><span className="mono text-[10px]">{w.slug}</span> — {w.steps.join(' → ') || <span className="text-mute">observability-only</span>}</div>
        )) : none}
      </Section>
      <Section label={`Knowledge (${p.knowledge.length})`}>
        {p.knowledge.length ? p.knowledge.map((k) => (
          <div key={k.slug}><span className="mono text-[10px]">{k.slug}</span> — {k.title}</div>
        )) : none}
      </Section>
      <Section label={`Tables (${p.tables.length})`}>
        {p.tables.length ? p.tables.map((t) => <div key={t} className="mono text-[10px]">{t}</div>) : none}
      </Section>
      <Section label={`Surfaces (${p.surfaces.length})`}>
        {p.surfaces.length ? p.surfaces.map((sf) => (
          <div key={sf.slug}><span className="mono text-[10px]">{sf.slug}</span>{sf.title && <span className="text-mute"> — {sf.title}</span>}{!!sf.tabs && <span className="text-mute"> · {sf.tabs} tab{sf.tabs === 1 ? '' : 's'}</span>}</div>
        )) : none}
      </Section>
    </div>
  );
}
