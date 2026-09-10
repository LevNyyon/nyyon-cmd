// Setup — onboard an EMPTY command center. One page, three steps, each derived
// from the server's state machine (never a client-side step counter):
// account → model key → connections → done. The voice interview is NOT here —
// Nyo runs it in the normal chat once the operator is inside. Entry:
// ?setup=<token>. The token param is the test door — strippable later without
// touching the flow.
import { useCallback, useEffect, useState } from 'react';

type Step = 'account' | 'llm-key' | 'gateways' | 'done';
type State = { step: Step; has_admin: boolean; llm_ready: boolean };

const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('setup') || '';
const hdrs = { 'content-type': 'application/json', ...(TOKEN ? { 'x-setup-token': TOKEN } : {}) };
const j = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, { ...init, headers: { ...hdrs, ...(init?.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error || `HTTP ${r.status}`);
  return d as T;
};

export function Setup() {
  const [st, setSt] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => j<State>('/api/onboarding/state').then((s) => { setSt(s); setErr(null); }).catch((e) => setErr(String(e.message))), []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (err) return <Shell><p className="text-sm text-rose-700">{err}</p></Shell>;
  if (!st) return <Shell><p className="text-sm text-mute">loading…</p></Shell>;

  return (
    <Shell step={st.step} wide={st.step === 'gateways'}>
      {st.step === 'account' && <Account onDone={refresh} setBusy={setBusy} busy={busy} />}
      {st.step === 'llm-key' && <LlmKey onDone={refresh} setBusy={setBusy} busy={busy} />}
      {st.step === 'gateways' && <Connections onDone={refresh} />}
      {st.step === 'done' && (
        <div className="text-center space-y-4">
          <p className="text-[14px] leading-relaxed">Setup is complete.<br /><span className="text-mute text-[13px]">This command center is yours. Say hi to Nyo. He runs the voice interview in chat, and nothing it writes will sound like you until that's done.</span></p>
          <a href="/" className="block w-full py-3 rounded-[9px] bg-ink text-paper font-semibold text-[14px] hover:opacity-90 transition">Open the command center</a>
        </div>
      )}
    </Shell>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 64 70" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="w-[34px] h-auto text-ink">
      <path d="M33,0 L64,0 L64,66 L33,50 L33,0 Z M0,4 L31,20 L31,70 L0,70 L0,4 Z" fill="currentColor" />
    </svg>
  );
}

const STEPS: [string, Step[]][] = [
  ['Account', ['account']], ['Model key', ['llm-key']], ['Connections', ['gateways']], ['Done', ['done']],
];

function Shell({ step, wide, children }: { step?: Step; wide?: boolean; children: React.ReactNode }) {
  const idx = STEPS.findIndex(([, keys]) => step && keys.includes(step));
  return (
    <div
      className="min-h-screen bg-paper text-ink grid place-items-center p-6"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(120,120,120,.05) 1px, transparent 1px),' +
          'linear-gradient(to bottom, rgba(120,120,120,.05) 1px, transparent 1px)',
        backgroundSize: '56px 56px',
      }}
    >
      <div
        className={'hairline rounded-2xl bg-card/70 backdrop-blur-md px-8 pt-9 pb-8 w-full ' + (wide ? 'max-w-2xl' : 'max-w-[380px]')}
        style={{ boxShadow: '0 24px 70px -28px rgba(0,0,0,.45)' }}
      >
        <div className="flex flex-col items-center gap-3.5 mb-6">
          <Logo />
          <div className="text-[17px] font-semibold tracking-tight">nyyon</div>
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-mute">Command Center · Setup</div>
        </div>
        {/* step rail — dots + labels, quiet like the login's eyebrow */}
        <div className="flex items-center justify-center gap-1.5 mb-7">
          {STEPS.map(([label], i) => (
            <div key={label} className="flex items-center gap-1.5">
              {i > 0 && <div className={'h-px w-4 ' + (i <= idx ? 'bg-ink/60' : 'bg-line')} />}
              <div className="flex items-center gap-1.5">
                <span className={'h-1.5 w-1.5 rounded-full ' + (i < idx ? 'bg-emerald-600' : i === idx ? 'bg-ink' : 'bg-line')} />
                <span className={'mono text-[9px] uppercase tracking-[0.14em] whitespace-nowrap ' + (i === idx ? 'text-ink' : 'text-mute')}>{label}</span>
              </div>
            </div>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = 'w-full px-3.5 py-[11px] rounded-[9px] hairline bg-paper text-[14px] placeholder:text-mute/70 outline-none focus:border-ink transition';
const btnCls = 'w-full mt-5 py-3 rounded-[9px] bg-ink text-paper font-semibold text-[14px] hover:opacity-90 disabled:opacity-45 transition';
const labelCls = 'block mono text-[10px] uppercase tracking-[0.12em] text-mute mt-4 mb-1.5';

function Account({ onDone, setBusy, busy }: { onDone: () => void; setBusy: (b: boolean) => void; busy: boolean }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [e, setE] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setE(null);
    try { await j('/api/onboarding/account', { method: 'POST', body: JSON.stringify({ username: u, password: p }) }); onDone(); }
    catch (x) { setE(String((x as Error).message)); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="text-[13.5px] leading-relaxed text-mute text-center">Your operator account. This is how you sign in from now on.</p>
      <label className={labelCls}>Email</label>
      <input value={u} onChange={(x) => setU(x.target.value)} placeholder="you@company.com" type="email" autoFocus className={inputCls} />
      <label className={labelCls}>Password</label>
      <input value={p} onChange={(x) => setP(x.target.value)} placeholder="12+ characters" type="password" className={inputCls}
        onKeyDown={(x) => { if (x.key === 'Enter' && u && p) void go(); }} />
      {e && <p className="text-[12.5px] text-rose-600 text-center mt-3">{e}</p>}
      <button onClick={() => void go()} disabled={busy || !u || !p} className={btnCls}>{busy ? 'creating…' : 'Create account'}</button>
    </div>
  );
}

function LlmKey({ onDone, setBusy, busy }: { onDone: () => void; setBusy: (b: boolean) => void; busy: boolean }) {
  const [k, setK] = useState(''); const [e, setE] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setE(null);
    try { await j('/api/onboarding/llm-key', { method: 'POST', body: JSON.stringify({ key: k }) }); onDone(); }
    catch (x) { setE(String((x as Error).message)); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="text-[13.5px] leading-relaxed text-mute text-center">
        Nothing that thinks runs without a model key.{' '}
        <a className="underline underline-offset-2 hover:text-ink transition" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Create one at console.anthropic.com</a>{' '}
        and paste it here. It is verified with a real call, then stored in this install's own database.
      </p>
      <label className={labelCls}>Anthropic API key</label>
      <input value={k} onChange={(x) => setK(x.target.value)} placeholder="sk-ant-…" type="password" autoFocus className={inputCls + ' mono text-[13px]'}
        onKeyDown={(x) => { if (x.key === 'Enter' && k.trim()) void go(); }} />
      {e && <p className="text-[12.5px] text-rose-600 text-center mt-3">{e}</p>}
      <button onClick={() => void go()} disabled={busy || !k.trim()} className={btnCls}>{busy ? 'verifying…' : 'Verify + continue'}</button>
    </div>
  );
}

// The enrichment gates, one guided step each: why it matters, where the key
// lives, how to fetch it. Server truth (/api/onboarding/gateways) marks what
// is already connected; every step is skippable and revisitable in Settings.
type GateStep = {
  slug: string; name: string; why: string;
  link?: string; linkLabel?: string; how?: string[]; info?: boolean;
};
const GATE_STEPS: GateStep[] = [
  {
    slug: 'serp', name: 'SerpApi',
    why: 'Google search powers two enrichment legs: finding a lead\'s LinkedIn profile and reading their company off it. The highest-value key here.',
    link: 'https://serpapi.com', linkLabel: 'Open serpapi.com',
    how: [
      'Create a free account (100 searches a month on the free plan).',
      'Once signed in, open Your Account → "Api Key".',
      'Copy the private key and paste it below.',
    ],
  },
  {
    slug: 'pdl', name: 'People Data Labs',
    why: 'Turns a phone number or name into a full identity: name, company, title, location. Paid per matched lookup, and the chain only calls it when cheaper legs came up short.',
    link: 'https://www.peopledatalabs.com', linkLabel: 'Open peopledatalabs.com',
    how: [
      'Sign up self-serve (the free tier includes monthly credits).',
      'In the dashboard, open API Keys.',
      'Copy your key and paste it below.',
    ],
  },
  {
    slug: 'twilio', name: 'Twilio',
    why: 'Phone-line intelligence: line type, carrier, and a caller-ID name when the lead is still nameless. Lookups cost about a cent each.',
    link: 'https://console.twilio.com', linkLabel: 'Open console.twilio.com',
    how: [
      'Create a Twilio account.',
      'The Console home page shows an "Account Info" card with Account SID and Auth Token.',
      'Copy both values below.',
    ],
  },
  {
    slug: 'truecaller', name: 'Truecaller', info: true,
    why: 'The manual fallback, no key needed. Every lead row in Prospecting links its number straight to a Truecaller search: open it with your own Truecaller login, read what it knows, and type what you learn into the row. Manual entries are stamped as your own, and they unblock the rest of the chain.',
  },
  {
    slug: 'github', name: 'Plugin publishing',
    why: 'Optional, and only about plugins that carry code. Default: you run one command on your own machine (node scripts/materialize.mjs) and it writes the plugin files and deploys from your checkout. This step is the hands-off alternative: a GitHub repo plus a token, and CI deploys for you. Skip it unless you want that.',
    link: 'https://github.com/settings/personal-access-tokens/new', linkLabel: 'Create a GitHub token',
    how: [
      'You deployed this install from a GitHub repo (your fork). This step points at that same repo.',
      'Create a fine-grained personal access token scoped to ONLY that repo, permission Contents: read and write.',
      'Enter the repo as owner/name and paste the token below.',
    ],
  },
  {
    slug: 'linkedin', name: 'LinkedIn',
    why: 'Powers Watch: role-change and open-role signals on the people you track after qualification.',
    link: 'https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm', linkLabel: 'Get Cookie-Editor',
    how: [
      'Install the Cookie-Editor extension from the Chrome Web Store.',
      'Open linkedin.com while signed in, click the extension.',
      'Copy the value of the li_at cookie and paste it below.',
    ],
  },
];

function Connections({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<{ slug: string; keys: { key: string; set: boolean }[]; ready: boolean }[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => j<{ gateways?: any } | any>('/api/onboarding/gateways').then((d) => setRows(Array.isArray(d) ? d : d.gateways)).catch((e) => setNote(String(e.message))), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <p className="text-sm text-mute">loading…</p>;

  const step = GATE_STEPS[idx];
  const last = idx === GATE_STEPS.length - 1;
  const row = rows.find((r) => r.slug === step.slug);
  const connected = !!row?.ready;
  const keys = row?.keys || [];
  const filled = keys.every((k) => (vals[`${step.slug}.${k.key}`] || '').trim());
  const next = () => { setNote(null); if (last) return; setIdx(idx + 1); };

  const save = async () => {
    setBusy(true); setNote(null);
    const config: Record<string, string> = {};
    for (const k of keys) config[k.key] = (vals[`${step.slug}.${k.key}`] || '').trim();
    try { await j('/api/onboarding/gateways', { method: 'POST', body: JSON.stringify({ slug: step.slug, config }) }); await load(); next(); }
    catch (e) { setNote(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {/* sub-rail: which gate we are on */}
      <div className="flex items-center justify-center gap-1.5">
        {GATE_STEPS.map((s, i) => (
          <button key={s.slug} onClick={() => { setIdx(i); setNote(null); }}
            className={'mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm transition ' +
              (i === idx ? 'text-paper bg-ink' : rows.find((r) => r.slug === s.slug)?.ready ? 'text-emerald-700' : 'text-mute hover:text-ink')}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="hairline rounded-xl bg-paper/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Connect {idx + 1}/{GATE_STEPS.length}</span>
          <span className="mono text-[11px] uppercase tracking-[0.14em] font-medium">{step.name}</span>
          {connected && <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-emerald-500/15 text-emerald-700">connected</span>}
          {step.info && <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-card hairline text-mute">no key needed</span>}
        </div>
        <p className="text-[13px] leading-relaxed text-mute">{step.why}</p>

        {!step.info && !connected && step.how && (
          <ol className="list-decimal ml-5 space-y-1 text-[12.5px] leading-relaxed">
            {step.how.map((h, i) => <li key={i}>{h}</li>)}
          </ol>
        )}
        {!step.info && !connected && step.link && (
          <a href={step.link} target="_blank" rel="noreferrer"
            className="inline-block mono text-[10px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-[7px] hairline bg-paper hover:bg-card transition">{step.linkLabel} ↗</a>
        )}

        {!step.info && !connected && keys.map((k) => (
          <input key={k.key} value={vals[`${step.slug}.${k.key}`] || ''} onChange={(e) => setVals((v) => ({ ...v, [`${step.slug}.${k.key}`]: e.target.value }))}
            placeholder={k.key} type="password" className="w-full px-3 py-2.5 rounded-[9px] hairline bg-paper mono text-[12.5px] placeholder:text-mute/60 outline-none focus:border-ink transition" />
        ))}
        {note && <p className="text-[12.5px] text-rose-600">{note}</p>}

        <div className="flex items-center gap-3 pt-1">
          {step.info || connected ? (
            !last && <button onClick={next} className="px-5 py-2.5 rounded-[9px] bg-ink text-paper font-semibold text-[13px] hover:opacity-90 transition">Continue</button>
          ) : (
            <>
              <button onClick={() => void save()} disabled={busy || !filled}
                className="px-5 py-2.5 rounded-[9px] bg-ink text-paper font-semibold text-[13px] hover:opacity-90 disabled:opacity-45 transition">{busy ? 'saving…' : 'Save + continue'}</button>
              {!last && <button onClick={next} className="mono text-[10px] uppercase tracking-[0.14em] text-mute hover:text-ink underline underline-offset-4 transition">skip for now →</button>}
            </>
          )}
        </div>
      </div>

      <p className="text-[11px] text-mute text-center">All of these are optional. Sources self-skip when a key is missing, and every one is editable later in Settings.</p>
      <button onClick={() => j('/api/onboarding/finish', { method: 'POST', body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) }).then(onDone).catch((e) => setNote(String((e as Error).message)))}
        className="w-full py-3 rounded-[9px] bg-ink text-paper font-semibold text-[14px] hover:opacity-90 transition">Finish setup</button>
    </div>
  );
}
