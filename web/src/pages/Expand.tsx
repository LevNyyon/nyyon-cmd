import { useEffect, useState } from 'react';
import { api, type PluginRow } from '../lib/api';
import { Refresh } from '../components/Icons';

// Expand — the plugin-building door. The operator's OWN LLM does the
// authoring: this page hands it a builder prompt (the plugin contract + this
// install's live gateway registry + taken names + delivery instructions),
// and receives the result through the import box. The importer's precise
// errors are the iteration loop — paste them back to the LLM until clean.
// The old in-app authoring chat (EXPAND agent) was removed: it duplicated
// what any outside model does with the prompt, on the operator's dime.

const STATUS_TONE: Record<string, string> = {
  active: 'text-emerald-700 bg-emerald-500/10',
  bound: 'text-amber-700 bg-amber-500/10',
  materialized: 'text-amber-700 bg-amber-500/10',
  blocked: 'text-rose-700 bg-rose-500/10',
  removed: 'text-mute bg-line/40',
};

export function Expand() {
  return (
    <div className="h-full min-h-0 flex bg-paper">
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <header className="px-4 sm:px-6 h-14 border-b border-line flex items-center bg-card/60">
          <h1 className="text-xl font-semibold tracking-tight">Expand</h1>
        </header>
        <div className="p-4 sm:p-6 max-w-2xl space-y-8">
          <BuilderPrompt />
          <ImportBox />
        </div>
      </div>
      <aside className="hidden lg:flex lg:flex-col w-[300px] shrink-0 border-l border-line panel">
        <InstalledRail />
      </aside>
    </div>
  );
}

// Step 1 — the prompt. Assembled server-side from the live system so it never
// drifts: contract doc (operator-annotated copy), gateway slugs + modes,
// installed names.
function BuilderPrompt() {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch('/api/plugins/builder-prompt');
      const d = await r.json();
      if (!r.ok || !d.prompt) throw new Error(d.error || `HTTP ${r.status}`);
      await navigator.clipboard.writeText(d.prompt);
      setNote('Copied. Paste it to any LLM (Claude, ChatGPT, ...) and describe the capability you want.');
    } catch (e) { setNote(`Could not copy: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };
  return (
    <section>
      <h2 className="text-[15px] font-semibold mb-1">1 · Author with your own LLM</h2>
      <p className="text-[12.5px] text-mute leading-relaxed mb-3">
        Copy the builder prompt and hand it to any LLM. It carries the plugin contract,
        this install's live gateway registry, and the names already taken, so the model
        can interview you and produce a complete manifest that fits this exact system.
      </p>
      <div className="flex items-center gap-3">
        <button onClick={() => void copy()} disabled={busy}
          className="text-[12px] px-4 py-2 rounded-sm bg-ink text-paper disabled:opacity-40">{busy ? 'assembling…' : 'Copy builder prompt'}</button>
        {note && <span className="text-[12px] text-mute">{note}</span>}
      </div>
    </section>
  );
}

// Step 2 — the door. Everything authored anywhere enters here; the importer's
// errors are the feedback loop the outside LLM iterates against.
function ImportBox() {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const finish = (d: any, okNote: string) => {
    if (d.ok) {
      setResult({ ok: true, lines: [okNote + (d.status === 'bound' ? ' Code goes live after the next Materialize + CI deploy (Plugins page).' : ' Live now.')] });
      window.dispatchEvent(new Event('nyyon:plugins-updated'));
      setText('');
    } else {
      setResult({ ok: false, lines: (d.errors || [d.error || 'import failed']).slice(0, 12) });
    }
  };
  const importJson = async () => {
    setBusy('json'); setResult(null);
    try {
      let manifest: unknown;
      try { manifest = JSON.parse(text); } catch { throw new Error('That is not valid JSON — paste the complete manifest object.'); }
      const r = await fetch('/api/plugins/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) });
      finish(await r.json(), 'Imported.');
    } catch (e) { setResult({ ok: false, lines: [String((e as Error).message)] }); }
    finally { setBusy(null); }
  };
  const importUrl = async () => {
    setBusy('url'); setResult(null);
    try {
      const r = await fetch('/api/plugins/import-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.trim() }) });
      finish(await r.json(), 'Imported from URL.');
    } catch (e) { setResult({ ok: false, lines: [String((e as Error).message)] }); }
    finally { setBusy(null); }
  };
  return (
    <section>
      <h2 className="text-[15px] font-semibold mb-1">2 · Import the manifest</h2>
      <p className="text-[12.5px] text-mute leading-relaxed mb-3">
        Paste the JSON your LLM produced. If it is refused, paste the errors below back
        to the LLM and import the corrected manifest. Repeat until clean.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
        placeholder='{"nyyon_plugin": 2, "name": "…", …}'
        className="w-full px-3 py-2.5 rounded-sm hairline bg-card/60 mono text-[12px] leading-relaxed outline-none focus:border-emerald-500 resize-y" />
      <div className="flex items-center gap-2 mt-2">
        <button onClick={() => void importJson()} disabled={busy !== null || !text.trim()}
          className="text-[12px] px-4 py-2 rounded-sm bg-ink text-paper disabled:opacity-40">{busy === 'json' ? 'importing…' : 'Import'}</button>
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-mute px-1">or</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (manifest.json or .zip package)"
          className="flex-1 h-9 px-2 rounded-sm hairline bg-card/60 mono text-[12px] outline-none focus:border-emerald-500" />
        <button onClick={() => void importUrl()} disabled={busy !== null || !url.trim()}
          className="text-[12px] px-3 py-2 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40">{busy === 'url' ? 'fetching…' : 'Import URL'}</button>
      </div>
      {result && (
        <div className={'mt-3 text-[12px] leading-relaxed rounded-sm hairline p-3 ' + (result.ok ? 'text-emerald-700 bg-emerald-500/10' : 'text-rose-700 bg-rose-500/5')}>
          {result.lines.map((l, i) => <div key={i} className="break-words">{result.ok ? l : `· ${l}`}</div>)}
        </div>
      )}
    </section>
  );
}

function InstalledRail() {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api.listPlugins());
      setErr(null);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      setErr(/^401\b/.test(msg)
        ? 'Session expired — reload and sign in again.'
        : `Could not load plugins: ${msg}`);
    }
  }

  useEffect(() => {
    void load();
    // Chat fires this when an install/remove/verify tool result lands; focus
    // catches installs done elsewhere (the Plugins page, another tab).
    const refresh = () => { void load(); };
    window.addEventListener('nyyon:plugins-updated', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('nyyon:plugins-updated', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return (
    <>
      <div className="px-4 h-12 border-b border-line flex items-center justify-between shrink-0">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Installed plugins</span>
        <button
          onClick={() => void load()}
          title="Refresh"
          aria-label="Refresh installed plugins"
          className="h-8 w-8 grid place-items-center text-mute hover:text-ink rounded-sm hover:bg-card/70 transition"
        >
          <Refresh size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {err && <div className="text-[12px] text-rose-600 leading-relaxed">{err}</div>}
        {!err && rows === null && <div className="text-[12px] text-mute">Loading…</div>}
        {!err && rows !== null && rows.length === 0 && (
          <div className="text-[12px] text-mute leading-relaxed">
            Nothing installed yet. Copy the builder prompt, author a manifest with
            your own LLM, and import it here.
          </div>
        )}
        {rows?.map((r) => (
          <div key={r.name} className="hairline rounded-sm bg-card/80 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-ink truncate">{r.title}</span>
              <span className={`mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-full ${STATUS_TONE[r.status] || 'text-mute bg-line/40'}`}>
                {r.status}
              </span>
            </div>
            <div className="mono text-[10px] text-mute mt-1">{r.name} · v{r.version}</div>
            {r.status === 'blocked' && (r.report?.errors?.length ?? 0) > 0 && (
              <div className="mt-1.5 text-[11px] text-rose-600 leading-snug break-words">
                {r.report.errors![0]}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-line px-4 py-2.5 mono text-[9px] uppercase tracking-[0.14em] text-mute shrink-0">
        Full pipeline lives in Plugins
      </div>
    </>
  );
}
