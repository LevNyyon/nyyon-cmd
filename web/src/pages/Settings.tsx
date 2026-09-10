import { useEffect, useState } from 'react';
import { api, FeatureFlag } from '../lib/api';
import {
  loadTheme, saveTheme, type Theme,
  loadSidebarSlugs, saveSidebarSlugs,
  SURFACE_MODULES, type SurfaceSlug,
} from '../lib/theme';
import { Sun, Moon, Monitor, Check } from '../components/Icons';

export function Settings() {
  return (
    <div className="h-full flex flex-col">
      <header className="px-4 sm:px-6 h-14 border-b border-line flex items-center bg-card/60 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-10 max-w-3xl">
        <Appearance />
        <NyoBrain />
        <SidebarPlacement />
        <LinkedInAccess />
        <EnrichmentKeys />
        <PluginPublishing />
        <OutboundWebhooks />
      <FeatureFlags />
      </div>
    </div>
  );
}




// ─── Plugin publishing (GitHub repo + token → CI deploy) ───────────
function PluginPublishing() {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [set_, setSet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = () => fetch('/api/gateways').then((r) => r.json()).then((d) => {
    const g = (d.gateways || []).find((x: { slug: string }) => x.slug === 'github');
    setSet(!!g?.ready);
  }).catch(() => {});
  useEffect(() => { load(); }, []);
  const save = async () => {
    setBusy(true); setNote(null);
    const config: Record<string, string> = {};
    for (const k of ['PLUGINS_GH_REPO', 'PLUGINS_GH_TOKEN']) { const v = (vals[k] || '').trim(); if (v) config[k] = v; }
    const r = await fetch('/api/gateways', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'github', config }) });
    const d = await r.json();
    setNote(r.ok ? 'Saved.' : d.error || `HTTP ${r.status}`);
    if (r.ok) setVals({});
    setBusy(false); load();
  };
  return (
    <Section title="Plugin publishing" hint="Plugins that carry code deploy as commits to YOUR OWN repo (a Worker cannot load code at run time): enter the repo and a token and installs are hands-off via your CI. Fallback without it: node scripts/materialize.mjs from your checkout. Data-only plugins never need either.">
      <p className="text-[11px] text-mute mb-2">
        Setup: this install's code lives in your own GitHub repo. Create a{' '}
        <a className="underline underline-offset-2 hover:text-ink" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained token</a>{' '}
        scoped to that one repo with Contents read and write. Enter owner/name and the token here.
        {set_ && <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-emerald-500/15 text-emerald-700 ml-2">connected</span>}
      </p>
      <div className="flex items-center gap-2">
        <input value={vals.PLUGINS_GH_REPO || ''} onChange={(e) => setVals((v) => ({ ...v, PLUGINS_GH_REPO: e.target.value }))}
          placeholder="owner/repo" className="w-56 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
        <input value={vals.PLUGINS_GH_TOKEN || ''} onChange={(e) => setVals((v) => ({ ...v, PLUGINS_GH_TOKEN: e.target.value }))}
          placeholder={set_ ? 'token · set — paste to replace' : 'github_pat_…'} type="password"
          className="flex-1 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
        <button onClick={() => void save()} disabled={busy || !(vals.PLUGINS_GH_REPO || '').trim() && !(vals.PLUGINS_GH_TOKEN || '').trim()}
          className="text-[12px] px-3 py-1 rounded-sm bg-ink text-paper disabled:opacity-40">{busy ? 'saving…' : 'save'}</button>
      </div>
      {note && <p className="text-[12px] text-mute mt-1.5">{note}</p>}
    </Section>
  );
}

// ─── Enrichment keys (serp / pdl / twilio) ─────────────────────────
const ENRICH_GATES: { slug: string; label: string; link: string; hint: string }[] = [
  { slug: 'serp', label: 'SerpApi', link: 'https://serpapi.com', hint: 'Google search · finds the LinkedIn profile + company. Free tier: 100 searches/mo.' },
  { slug: 'pdl', label: 'People Data Labs', link: 'https://www.peopledatalabs.com', hint: 'phone/name → identity. Paid per match; called only when cheaper legs came up short.' },
  { slug: 'twilio', label: 'Twilio', link: 'https://console.twilio.com', hint: 'line type + carrier + caller-ID name. About a cent per lookup.' },
];
function EnrichmentKeys() {
  const [rows, setRows] = useState<{ slug: string; keys: { key: string; set: boolean }[]; ready: boolean }[]>([]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = () => fetch('/api/gateways').then((r) => r.json()).then((d) => setRows(d.gateways || [])).catch(() => {});
  useEffect(() => { load(); }, []);
  const save = async (slug: string, keys: { key: string }[]) => {
    setBusy(slug); setNote(null);
    const config: Record<string, string> = {};
    for (const k of keys) { const v = (vals[`${slug}.${k.key}`] || '').trim(); if (v) config[k.key] = v; }
    const r = await fetch('/api/gateways', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, config }) });
    const d = await r.json();
    setNote(r.ok ? `${slug} saved.` : `${slug}: ${d.error || r.status}`);
    if (r.ok) setVals((v) => { const n = { ...v }; for (const k of keys) delete n[`${slug}.${k.key}`]; return n; });
    setBusy(null); load();
  };
  return (
    <Section title="Enrichment keys" hint="The sources prospecting enrichment calls. Each self-skips when its key is missing; the manual fallback is the per-row Truecaller link in Prospecting.">
      {ENRICH_GATES.map((g) => {
        const row = rows.find((r) => r.slug === g.slug);
        const keys = row?.keys || [];
        return (
          <div key={g.slug} className="mb-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="mono text-[10px] uppercase tracking-[0.14em] font-medium">{g.label}</span>
              {row?.ready && <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-emerald-500/15 text-emerald-700">connected</span>}
              <a href={g.link} target="_blank" rel="noreferrer" className="text-[11px] underline underline-offset-2 text-mute hover:text-ink">{g.link.replace('https://', '')} ↗</a>
            </div>
            <p className="text-[11px] text-mute mb-1.5">{g.hint}</p>
            <div className="flex items-center gap-2">
              {keys.map((k) => (
                <input key={k.key} value={vals[`${g.slug}.${k.key}`] || ''} onChange={(e) => setVals((v) => ({ ...v, [`${g.slug}.${k.key}`]: e.target.value }))}
                  placeholder={k.set ? `${k.key} · set — paste to replace` : k.key} type="password"
                  className="flex-1 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
              ))}
              <button onClick={() => void save(g.slug, keys)} disabled={busy !== null || !keys.some((k) => (vals[`${g.slug}.${k.key}`] || '').trim())}
                className="text-[12px] px-3 py-1 rounded-sm bg-ink text-paper disabled:opacity-40">{busy === g.slug ? 'saving…' : 'save'}</button>
            </div>
          </div>
        );
      })}
      {note && <p className="text-[12px] text-mute">{note}</p>}
    </Section>
  );
}

// ─── LinkedIn access (li_at cookie → Watch signals) ────────────────
function LinkedInAccess() {
  const [val, setVal] = useState('');
  const [state, setState] = useState<{ ready?: boolean; set?: boolean; error?: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => fetch('/api/gateways').then((r) => r.json()).then((d) => {
    const li = (d.gateways || []).find((g: { slug: string }) => g.slug === 'linkedin');
    setState({ set: !!li?.ready });
  }).catch(() => setState({}));
  useEffect(() => { load(); }, []);
  const save = async () => {
    setBusy('save');
    const r = await fetch('/api/gateways', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'linkedin', config: { LI_AT_COOKIE: val.trim() } }) });
    const d = await r.json();
    setState((s) => ({ ...s, set: r.ok && !!val.trim(), error: r.ok ? null : d.error }));
    if (r.ok) setVal('');
    setBusy(null); load();
  };
  const test = async () => {
    setBusy('test');
    const r = await fetch('/api/gateways/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'linkedin' }) });
    const d = await r.json();
    setState((s) => ({ ...s, ready: !!d.ready, error: d.ready ? null : (d.error || 'session not ready') }));
    setBusy(null);
  };
  return (
    <Section title="LinkedIn access" hint="Powers Prospecting → Watch (role changes + open roles). Paste your li_at cookie from linkedin.com. No daemon needed.">
      <p className="text-[11px] text-mute mb-2">
        How: install{' '}
        <a className="underline underline-offset-2 hover:text-ink" href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank" rel="noreferrer">Cookie-Editor</a>{' '}
        from the Chrome Web Store, open linkedin.com while signed in, click the extension, and copy the value of the <span className="mono">li_at</span> cookie. It expires roughly yearly; paste a fresh one when Watch reports the session died.
      </p>
      <div className="flex items-center gap-2 mb-2">
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-mute w-16 shrink-0">li_at</span>
        <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={state?.set ? 'saved — paste to replace' : 'AQEDAV…'} type="password"
          className="flex-1 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
        <button onClick={() => void save()} disabled={busy !== null || !val.trim()}
          className="text-[12px] px-3 py-1 rounded-sm bg-ink text-paper disabled:opacity-40">{busy === 'save' ? 'saving…' : 'save'}</button>
        <button onClick={() => void test()} disabled={busy !== null || !state?.set}
          className="text-[11px] px-2 py-1 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40">{busy === 'test' ? 'testing…' : 'test'}</button>
      </div>
      {state?.ready && <p className="text-[12px] text-emerald-600">LinkedIn session is live.</p>}
      {state?.error && <p className="text-[12px] text-rose-600">{state.error}</p>}
    </Section>
  );
}

// ─── appearance ──────────────────────────────────────────────
function Appearance() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  function pick(t: Theme) {
    setTheme(t);
    saveTheme(t);
  }

  const opts: { key: Theme; label: string; Icon: (p: any) => any }[] = [
    { key: 'light',  label: 'Light',  Icon: Sun },
    { key: 'dark',   label: 'Dark',   Icon: Moon },
    { key: 'system', label: 'System', Icon: Monitor },
  ];

  return (
    <Section title="Appearance" hint="Theme persists in this browser only.">
      <div className="flex gap-2">
        {opts.map(({ key, label, Icon }) => {
          const on = theme === key;
          return (
            <button
              key={key}
              onClick={() => pick(key)}
              className={
                'flex items-center gap-2 h-10 px-4 rounded-sm hairline text-sm transition ' +
                (on
                  ? 'bg-ink text-paper shadow-[inset_0_0_0_1px_var(--color-ink)]'
                  : 'bg-card/80 text-mute hover:text-ink')
              }
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ─── sidebar module placement ────────────────────────────────
function SidebarPlacement() {
  const [slugs, setSlugs] = useState<SurfaceSlug[]>(() => loadSidebarSlugs());

  function toggle(slug: SurfaceSlug) {
    const next = slugs.includes(slug) ? slugs.filter((s) => s !== slug) : [...slugs, slug];
    // Preserve canonical order from SURFACE_MODULES.
    const ordered = SURFACE_MODULES.map((m) => m.slug).filter((s) => next.includes(s));
    setSlugs(ordered);
    saveSidebarSlugs(ordered);
  }

  return (
    <Section title="Sidebar modules" hint="Off = hidden from the sidebar; the page stays reachable by URL.">
      <ul className="hairline rounded-sm bg-card/80 divide-y divide-line">
        {SURFACE_MODULES.map(({ slug, label }) => {
          const on = slugs.includes(slug);
          return (
            <li key={slug} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="mono text-[10px] uppercase tracking-wider text-mute">{slug}</div>
              </div>
              <Toggle on={on} onToggle={() => toggle(slug)} label={`Show ${label} in sidebar`} />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ─── Nyo brain — which LLM provider powers the chat ──────────
function NyoBrain() {
  const [brain, setBrain] = useState<Awaited<ReturnType<typeof api.brain>> | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() { setBrain(await api.brain()); }
  useEffect(() => { refresh(); }, []);

  const provider = brain?.provider;
  const ready = !!(brain && brain.key_set);

  return (
    <Section
      title="Nyo brain"
      hint="Per-surface model choices save to the llm-models knowledge doc and apply immediately — no deploy. Blank resets a field to its wrangler.jsonc default."
    >
      <div className="hairline rounded-sm bg-card/80 p-5 flex items-start gap-3">
        <span
          className={
            'mt-1 inline-block h-2 w-2 rounded-full shrink-0 ' +
            (busy ? 'bg-stone-400 animate-pulse'
              : ready ? 'bg-emerald-500'
              : brain ? 'bg-rose-500'
              : 'bg-stone-400 animate-pulse')
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-sm">
              {provider ? `Provider · ${provider}` : 'loading…'}
            </span>
            <button
              onClick={async () => { setBusy(true); try { await refresh(); } finally { setBusy(false); } }}
              className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink"
            >
              recheck ↻
            </button>
          </div>
          {brain && (
            <div className="mono text-[11px] text-mute mt-1">
              model <span className="text-ink">{brain.model || '—'}</span>
              <span className="mx-2">·</span>
              api key {brain.key_set ? <span className="text-emerald-700">set ✓</span> : <span className="text-rose-700">missing</span>}
            </div>
          )}
        </div>
      </div>

      {brain && <ModelEditor brain={brain} onSaved={refresh} />}

      <div className="mt-3 text-[12px] text-mute leading-relaxed">
        Supported providers today: <span className="mono text-ink">anthropic</span> · <span className="mono text-ink">openai</span>.
        Tool-use loop is provider-agnostic — same Nyo tools work either way; only the call format differs.
      </div>

      {brain && !brain.key_set && (
        <div className="mt-3 hairline rounded-sm bg-paper p-3 text-[12px] text-mute leading-relaxed">
          API key for <span className="mono text-ink">{provider}</span> not set. Edit{' '}
          <span className="mono text-ink">~/nyyon-command-center/workers/api/.dev.vars</span> and add the matching key (e.g.{' '}
          <span className="mono text-ink">{provider === 'openai' ? 'OPENAI_API_KEY=sk-...' : 'ANTHROPIC_API_KEY=sk-ant-...'}</span>),
          then restart wrangler dev.
        </div>
      )}
    </Section>
  );
}

// ─── WhatsApp / wa-gateway connection ────────────────────────────



// ─── feature flags ───────────────────────────────────────────


const WEBHOOK_SETUP_PROMPT = `I run a Nyyon Command Center. When I publish content it POSTs JSON to webhooks I still need to build. Help me set the receivers up, step by step. Ask me about my stack before writing any code.

What Nyyon sends:

1. Website publish -> POST to my "website webhook" URL:
{ "type": "article.publish", "slug": "my-article", "title": "...", "excerpt": "..." or null, "body_html": "<full article HTML>", "tags": ["..."], "featured_image_url": "https://..." or null, "package_id": "...", "published_at": 1757000000000 }

2. Social post -> POST to my "social webhook" URL:
{ "type": "social.post", "channel": "linkedin" (or another channel name), "content": "the post text", "image_url": "https://..." or null, "article_slug": "..." or null, "package_id": "..." }

Both requests: Content-Type application/json, an X-Nyyon-Event header carrying the type, 20 second timeout. Any 2xx counts as delivered; anything else shows up in my command center as a failed publish. So the receiver must return 2xx only after it truly accepted the content. There is also a test payload { "type": "test" } my Settings page can send.

What I need from you:
1. Ask me where my website lives (static site, WordPress, Webflow, a CMS with an API, nothing yet) and where social posts should go (LinkedIn page, Buffer, Make/Zapier scenario, or just email me the text).
2. Help me build one public HTTPS endpoint per webhook that receives this JSON and actually publishes it there. A Cloudflare Worker, a Make/Zapier webhook, or a small route in my existing backend are all fine. Nyyon adds no auth; if we want a secret, put it in the URL path.
3. Give me the two final https:// URLs. I will paste them into Nyyon under Settings -> Outbound webhooks and press "test" on each, and I expect HTTP 2xx.`;

function OutboundWebhooks() {
  const [cfg, setCfg] = useState<{ website_url: string; social_url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { fetch('/api/webhooks').then((r) => r.json()).then(setCfg).catch(() => setCfg({ website_url: '', social_url: '' })); }, []);
  if (!cfg) return null;
  const save = async () => {
    setBusy('save'); setNote(null);
    const r = await fetch('/api/webhooks', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
    const d = await r.json();
    setNote(r.ok ? 'Saved.' : `Save failed: ${d.error || r.status}`);
    setBusy(null);
  };
  const test = async (which: 'website' | 'social') => {
    setBusy(which); setNote(null);
    const r = await fetch('/api/webhooks/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ which }) });
    const d = await r.json();
    setNote(r.ok ? `${which} webhook answered HTTP ${d.http}.` : `${which} test failed: ${d.error || r.status}`);
    setBusy(null);
  };
  return (
    <Section title="Outbound webhooks" hint="Where finished content gets delivered. Publish POSTs the full article to the website webhook; social legs POST to the social webhook. Blank = publishing fails until a webhook is set.">
      {(['website_url', 'social_url'] as const).map((k) => (
        <div key={k} className="flex items-center gap-2 mb-2">
          <span className="mono text-[10px] uppercase tracking-[0.14em] text-mute w-16 shrink-0">{k === 'website_url' ? 'website' : 'social'}</span>
          <input value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} placeholder="https://…"
            className="flex-1 h-8 px-2 rounded-sm hairline bg-paper mono text-[12px] outline-none focus:border-emerald-500" />
          <button onClick={() => void test(k === 'website_url' ? 'website' : 'social')} disabled={busy !== null || !cfg[k]}
            className="text-[11px] px-2 py-1 rounded-sm hairline bg-paper hover:bg-card disabled:opacity-40">{busy === (k === 'website_url' ? 'website' : 'social') ? 'testing…' : 'test'}</button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy !== null}
          className="text-[12px] px-3 py-1 rounded-sm bg-ink text-paper disabled:opacity-40">{busy === 'save' ? 'saving…' : 'save'}</button>
        <button onClick={() => { navigator.clipboard.writeText(WEBHOOK_SETUP_PROMPT).then(() => setNote('Setup prompt copied — paste it to any LLM and it will walk you through building the receivers.')).catch(() => setNote('Copy failed — select and copy from the docs instead.')); }}
          className="text-[11px] px-2 py-1 rounded-sm hairline bg-paper hover:bg-card">copy LLM setup prompt</button>
        {note && <span className="text-[12px] text-mute">{note}</span>}
      </div>
      <p className="text-[11px] text-mute mt-2">No webhook receiver yet? Copy the setup prompt and hand it to any LLM — it explains exactly what Nyyon sends and walks you through standing up the receiving end.</p>
    </Section>
  );
}
function FeatureFlags() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api.listFlags().then(setFlags).catch(() => {});
  }, []);

  async function flip(key: string, current: boolean) {
    setSaving(key);
    await api.setFlag(key, !current);
    setFlags((prev) => prev.map((f) => (f.key === key ? { ...f, value: !current ? 1 : 0 } : f)));
    setSaving(null);
  }

  const byScope: Record<string, FeatureFlag[]> = {};
  for (const f of flags) (byScope[f.scope] ||= []).push(f);

  return (
    <Section title="Feature flags" hint="hottakes.live: unset = social posts go live once the social webhook is configured; set false to force dry-run, true to force live. tool.<name> rows, if added, gate Nyo tools.">
      {flags.length === 0 ? (
        <div className="text-mute text-sm">No flags registered.</div>
      ) : (
        <div className="space-y-6">
          {Object.entries(byScope).map(([scope, items]) => (
            <div key={scope}>
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-mute mb-2">{scope}</div>
              <ul className="hairline rounded-sm bg-card/80 divide-y divide-line">
                {items.map((f) => {
                  const on = f.value === 1;
                  return (
                    <li key={f.key} className="flex items-center justify-between px-4 py-3">
                      <div className="min-w-0 flex-1 pr-4">
                        <div className="mono text-[12px]">{f.key}</div>
                        {f.description && <div className="text-[11px] text-mute mt-0.5">{f.description}</div>}
                      </div>
                      <Toggle on={on} onToggle={() => flip(f.key, on)} pending={saving === f.key} label={`Toggle ${f.key}`} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ─── shared ──────────────────────────────────────────────────
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold mb-1">{title}</h2>
      {hint && <p className="text-xs text-mute mb-3">{hint}</p>}
      {children}
    </section>
  );
}

function Toggle({ on, onToggle, pending, label }: { on: boolean; onToggle: () => void; pending?: boolean; label: string }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      disabled={pending}
      onClick={onToggle}
      className={
        'relative h-6 w-10 rounded-full transition shrink-0 ' +
        (on ? 'bg-ink' : 'bg-line') +
        (pending ? ' opacity-40' : '')
      }
    >
      <span
        className={
          'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-paper transition-transform shadow ' +
          (on ? 'translate-x-4' : 'translate-x-0')
        }
      >
        {on && <Check size={12} className="absolute inset-0 m-auto text-ink" />}
      </span>
    </button>
  );
}

// ─── per-surface model editor (writes the llm-models knowledge doc) ──────────
const MODEL_FIELDS: { key: keyof Omit<import('../lib/api').NyoModelMap, 'source'>; label: string; hint: string }[] = [
  { key: 'nyo_mid',      label: 'Nyo · Mid',   hint: 'the default chat tier' },
  { key: 'nyo_high',     label: 'Nyo · High',  hint: 'hard reasoning in chat' },
  { key: 'writer',       label: 'Writer',       hint: 'the Hot Takes article composer' },
  { key: 'writer_small', label: 'Utility',      hint: 'cheap "mini/haiku" call sites' },
  { key: 'vision',       label: 'Vision',       hint: 'image judging (featured-image picker)' },
  { key: 'writer_fallback', label: 'Fallback writer', hint: 'Hugging Face model used while Anthropic credit is out (blank = writers pause)' },
  { key: 'wizard_tier', label: 'Wizard tier', hint: 'chat tier (low / mid / high) the Hot Takes drafting wizard runs on' },
];

function ModelEditor({ brain, onSaved }: { brain: import('../lib/api').BrainInfo; onSaved: () => Promise<void> | void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const val = (k: string) => (draft[k] !== undefined ? draft[k] : (brain.models as any)[k] || '');
  const dirty = MODEL_FIELDS.some(({ key }) => draft[key] !== undefined && draft[key] !== (brain.models as any)[key]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const patch: Record<string, string> = {};
      for (const { key } of MODEL_FIELDS) {
        if (draft[key] !== undefined) patch[key] = draft[key].trim() || (brain.defaults as any)[key];
      }
      await api.saveNyoModels(patch);
      setDraft({});
      await onSaved();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="mt-3 hairline rounded-sm bg-card/80 p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="mono text-[10px] uppercase tracking-[0.2em] text-mute">Models per surface</span>
        <span className="mono text-[10px] text-mute">{brain.models.source === 'doc' ? 'from llm-models doc' : 'wrangler defaults'}</span>
      </div>
      <div className="space-y-2">
        {MODEL_FIELDS.map(({ key, label, hint }) => (
          <div key={key} className="grid grid-cols-12 gap-3 items-center">
            <div className="col-span-4 min-w-0">
              <div className="text-xs font-medium">{label}</div>
              <div className="text-[10px] text-mute truncate">{hint}</div>
            </div>
            <input
              value={val(key)}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              placeholder={(brain.defaults as any)[key]}
              className="col-span-8 h-8 hairline rounded-sm bg-paper px-2.5 text-xs mono focus:outline-none focus:border-ink"
            />
          </div>
        ))}
      </div>
      {err && <div className="text-xs text-rose-700">{err}</div>}
      <div className="flex justify-end gap-2">
        {dirty && (
          <button onClick={() => setDraft({})} className="h-8 px-3 rounded-sm hairline mono text-[10px] uppercase tracking-[0.15em] text-mute hover:text-ink">
            discard
          </button>
        )}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="h-8 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.15em] bg-ink text-paper disabled:opacity-40"
        >
          {saving ? 'saving…' : 'save models'}
        </button>
      </div>
    </div>
  );
}
