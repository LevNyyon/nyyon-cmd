// Hot Takes — the editorial command center. ONE publication package carried
// across five views of the same store: Topics → Publications → Social Posts →
// Schedule → Approved Sources. The linear path is Topic → Take → Brief →
// Article → Review → Social → Schedule → Verify; every screen shows the next
// action, not just a status. Distribution is DRY-RUN by default (hottakes.live
// feature flag) so nothing reaches your website or LinkedIn until the operator
// flips it deliberately.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type HotTakePackage, type HotTakePost, type HotTakeTopicCard, type HotTakeView,
  type HotTakePipeline, type HotTakeScheduleView, type HotTakeSource,
  type HotTakeClaim, type HotTakeFlag, type HotTakeSearchResults, type HeartbeatGates,
} from '../lib/api';
import type { KnowledgeDoc } from '../lib/api';
import { Flame, Search, X, Sparkle, Check, Refresh, Pin, LinkedIn, Globe, Newspaper } from '../components/Icons';
import { useChatState, openChat } from '../lib/chat';
import { PublicationsTab } from '../components/HotTakesPublications';
// The same listener table the OSINT page renders — one shared control surface.
import { OsintListeners } from '../components/OsintListeners';

// Brief Nyo to draft the take, then hand off to the chat (same pattern as the
// Digest's "Discuss with Nyo"). Drafting happens IN CONVERSATION rather than as a
// one-shot generation: Nyo has the whole tool pool, so the take can be pushed on,
// sharpened and only saved once the operator approves it.
function nyoDraftPrompt(p: Partial<HotTakePackage> & { id: string }) {
  return [
    `Draft the company's take for this Hot Takes package (id: ${p.id}).`,
    '',
    `Topic: ${p.headline || p.title || 'Untitled'}`,
    p.summary ? `Summary: ${p.summary}` : '',
    p.why_it_matters ? `Why it matters: ${p.why_it_matters}` : '',
    p.source_url ? `Source: ${p.source_url}` : '',
    '',
    'Read it with hottake_read_package first. Then propose the take — the argument, what we believe, what is commonly misunderstood, who should care, and what the reader should do differently. Show it to me before saving; when I approve it, save it with hottake_patch_package.',
  ].filter(Boolean).join('\n');
}

type Tab = 'topics' | 'publications' | 'social' | 'schedule' | 'sources';
const TAB_KEY = 'nyyon.hottakes.tab.v1';
const TABS: { key: Tab; label: string }[] = [
  { key: 'topics',       label: 'Topics' },
  { key: 'publications', label: 'Publications' },
  { key: 'social',       label: 'Social Posts' },
  { key: 'schedule',     label: 'Schedule' },
  { key: 'sources',      label: 'Approved Sources' },
];
// The only tabs that exist on a phone — the two surfaces worked daily.
const MOBILE_TABS: Tab[] = ['topics', 'publications'];

// Selected Topics shows work still in the operator's hands by default;
// "See All" also reveals ready (done editing, awaiting a date), booked and live.
const ACTIVE_STAGES = ['topic', 'take', 'brief', 'article', 'review'];
const ALL_STAGES = [...ACTIVE_STAGES, 'ready', 'scheduled', 'published', 'complete'];
const STATUS_LABEL: Record<string, string> = {
  topic: 'Topic', take: 'Take', brief: 'Brief', article: 'Article',
  review: 'Needs review', ready: 'Ready', scheduled: 'Scheduled',
  published: 'Published', complete: 'Complete',
};
const STATUS_TONE: Record<string, string> = {
  topic: 'bg-stone-100 text-stone-700', take: 'bg-sky-100 text-sky-800',
  brief: 'bg-sky-100 text-sky-800', article: 'bg-violet-100 text-violet-800',
  review: 'bg-amber-100 text-amber-900', ready: 'bg-emerald-100 text-emerald-800',
  scheduled: 'bg-blue-100 text-blue-800', published: 'bg-emerald-100 text-emerald-800',
  complete: 'bg-emerald-100 text-emerald-800',
};
const CHANNEL_LABEL: Record<string, string> = {
  'linkedin-company': 'Company LinkedIn',
  'linkedin-personal': 'Personal LinkedIn',
};
function timeAgo(ts?: number | null): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtWhen(ts?: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function hostOf(url?: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
export function HotTakes() {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab) || 'topics');
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  // A phone can land on a desktop-only tab via saved state — fall back to Topics.
  useEffect(() => {
    if (window.matchMedia('(max-width: 639px)').matches && !MOBILE_TABS.includes(tab)) setTab('topics');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [openId, setOpenId] = useState<string | null>(null);      // spine drawer
  const [editorId, setEditorId] = useState<string | null>(null);  // publication editor
  const [pubFocusSlug, setPubFocusSlug] = useState<string | null>(null); // Social → Publications jump target
  const [draftPkg, setDraftPkg] = useState<HotTakePackage | null>(null); // Topics "Draft a Take" → editor popup handoff
  const [live, setLive] = useState<boolean | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<HotTakeSearchResults | null>(null);
  const [bump, setBump] = useState(0);                            // cross-tab refresh tick
  const refresh = () => setBump((v) => v + 1);

  useEffect(() => { api.hotTakeState().then((s) => setLive(s.live)).catch(() => {}); }, [bump]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setResults(null); return; }
    const h = window.setTimeout(() => {
      api.hotTakeSearch(t).then(setResults).catch(() => setResults(null));
    }, 250);
    return () => window.clearTimeout(h);
  }, [q]);

  const openPackage = (id: string, status?: string) => {
    setResults(null); setQ('');
    if (status && ['article', 'review', 'ready', 'scheduled', 'published', 'complete'].includes(status)) setEditorId(id);
    else setOpenId(id);
  };

  return (
    <div className="h-full flex flex-col relative">
      <div className="px-4 sm:px-6 pt-4 border-b border-line bg-paper/60 shrink-0">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <Flame size={18} className="text-orange-500" />
          <h1 className="font-semibold tracking-tight text-[15px]">Hot Takes</h1>
          <span className="mono text-[10px] text-mute uppercase tracking-[0.18em] ml-1 hidden sm:inline">editorial command center</span>
          {live !== null && (
            <span className={'mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm ' + (live ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900')}>
              {live ? 'LIVE' : 'DRY RUN'}
            </span>
          )}
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-mute" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search topics, articles, posts…"
              className="h-8 pl-7 pr-2 rounded-sm bg-card border border-line text-xs text-ink placeholder:text-mute focus:outline-none focus:border-ink/40 w-52 sm:w-64"
            />
            {results && (
              <div className="absolute right-0 top-9 w-80 max-h-96 overflow-y-auto z-50 panel rounded-sm border border-line shadow-[0_16px_50px_-16px_rgba(10,10,10,0.35)] p-2 space-y-2 bg-paper">
                {!results.packages.length && !results.posts.length && !results.notes.length && (
                  <div className="text-xs text-mute px-2 py-1">No matches.</div>
                )}
                {results.packages.length > 0 && (
                  <div>
                    <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute px-2 pb-1">Publications</div>
                    {results.packages.map((p) => (
                      <button key={p.id} onClick={() => openPackage(p.id, p.status)} className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-card">
                        <div className="text-sm text-ink truncate">{p.headline || p.title || p.id}</div>
                        <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute">{STATUS_LABEL[p.status] || p.status}</div>
                      </button>
                    ))}
                  </div>
                )}
                {results.posts.length > 0 && (
                  <div>
                    <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute px-2 pb-1">Social posts</div>
                    {results.posts.map((p) => (
                      <button key={p.id} onClick={() => { setResults(null); setQ(''); setTab('social'); }} className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-card">
                        <div className="text-xs text-ink truncate">{p.snippet || p.id}</div>
                        <div className="mono text-[9px] uppercase tracking-[0.14em] text-mute">{CHANNEL_LABEL[p.channel] || p.channel} · {p.status}</div>
                      </button>
                    ))}
                  </div>
                )}
                {results.notes.length > 0 && (
                  <div>
                    <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute px-2 pb-1">Library notes</div>
                    {results.notes.map((n) => (
                      <button key={n.slug} onClick={() => { setResults(null); setQ(''); setTab('sources'); }} className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-card text-sm text-ink">
                        {n.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit overflow-x-auto max-w-full">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.18em] transition shrink-0 ' +
                // Mobile keeps only the two working surfaces; the rest are desktop.
                (MOBILE_TABS.includes(t.key) ? '' : 'hidden sm:block ') +
                (tab === t.key ? 'bg-ink text-paper' : 'text-mute hover:text-ink')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'topics' && (
        <TopicsTab
          bump={bump}
          refresh={refresh}
          onOpenPublication={(slug) => { setPubFocusSlug(slug); setTab('publications'); }}
          onDraftTopic={(pkg) => { setDraftPkg(pkg); setTab('publications'); }}
        />
      )}
      {tab === 'publications' && (
        <PublicationsTab
          bump={bump}
          refresh={refresh}
          focusSlug={pubFocusSlug}
          onConsumeFocus={() => setPubFocusSlug(null)}
          onOpenEditor={(id) => setEditorId(id)}
          draftingPkg={draftPkg}
          onConsumeDrafting={() => setDraftPkg(null)}
        />
      )}
      {tab === 'social' && (
        <SocialTab
          bump={bump}
          refresh={refresh}
          onOpenPublication={(slug, pkgId) => {
            if (slug) { setPubFocusSlug(slug); setTab('publications'); } else setEditorId(pkgId);
          }}
        />
      )}
      {tab === 'schedule' && (
        <ScheduleTab
          bump={bump}
          onOpenPublication={(slug, pkgId) => {
            if (slug) { setPubFocusSlug(slug); setTab('publications'); } else setEditorId(pkgId);
          }}
        />
      )}
      {tab === 'sources' && <SourcesTab bump={bump} refresh={refresh} />}

      {openId && (
        <SpineDrawer
          id={openId}
          onClose={() => { setOpenId(null); refresh(); }}
          onOpenEditor={(id) => { setOpenId(null); setEditorId(id); }}
        />
      )}
      {editorId && (
        <PublicationEditor id={editorId} onClose={() => { setEditorId(null); refresh(); }} />
      )}
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────
// Collapsible section headers render as color-coded TAGS — each section owns a
// tone, so the page scans as labeled regions rather than plain text rows.
function SectionHead({ open, onToggle, label, count, right, tone = 'bg-stone-100 text-stone-700' }: {
  open: boolean; onToggle: () => void; label: string; count?: number; right?: React.ReactNode; tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={'inline-flex items-center gap-2 px-2.5 py-1 rounded-sm mono text-[10px] uppercase tracking-[0.16em] font-semibold transition hover:opacity-85 ' + tone}
      >
        <span className={'text-[9px] transition-transform ' + (open ? 'rotate-90' : '')}>▶</span>
        <span>{label}</span>
        {count !== undefined && <span className="opacity-70 tabular-nums">{count}</span>}
      </button>
      <div className="ml-auto">{right}</div>
    </div>
  );
}

function SourceLine({ name, url, when, multi }: { name?: string | null; url?: string | null; when?: number | null; multi?: number }) {
  const host = hostOf(url);
  return (
    <div className="flex items-center gap-2 mono text-[10px] uppercase tracking-[0.14em] text-mute flex-wrap">
      <span className="text-ink/70">{name || host || 'source'}</span>
      {when ? <><span>·</span><span>{timeAgo(when)}</span></> : null}
      {multi && multi > 1 ? <><span>·</span><span className="text-violet-600">{multi} sources</span></> : null}
      {url ? <><span>·</span><a href={url} target="_blank" rel="noreferrer" className="hover:text-ink underline decoration-dotted">read</a></> : null}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={'mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm ' + (STATUS_TONE[status] || 'bg-stone-100 text-stone-700')}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function Btn({ children, onClick, disabled, tone = 'ink', title }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'ink' | 'line' | 'danger'; title?: string;
}) {
  const cls = tone === 'ink'
    ? 'bg-ink text-paper'
    : tone === 'danger'
      ? 'border border-line text-rose-600 hover:bg-rose-50'
      : 'border border-line text-mute hover:text-ink';
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`h-8 px-3 rounded-sm text-xs font-medium disabled:opacity-50 shrink-0 ${cls}`}>
      {children}
    </button>
  );
}

// ─── Topics tab ───────────────────────────────────────────────────────────────

// How many feed cards one page carries — the initial read and every Load more.
const FEED_PAGE = 14;

// Compact search field for a section header.
//
// Top-level ON PURPOSE: a component holding a text input, if defined inside
// TopicsTab, remounts on every parent render and the field loses focus after a
// single keystroke (the same trap called out on the social-post row below).
function SectionSearch({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div className="relative">
      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-mute pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 w-36 sm:w-52 pl-6 pr-6 rounded-sm bg-paper hairline text-[12px] text-ink placeholder:text-mute/70 focus:outline-none focus:border-ink/40"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title="Clear search"
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-mute hover:text-ink"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function TopicsTab({ bump, refresh, onOpenPublication, onDraftTopic }: {
  bump: number;
  refresh: () => void;
  onOpenPublication: (slug: string) => void;
  onDraftTopic: (pkg: HotTakePackage) => void;
}) {
  const [packages, setPackages] = useState<HotTakePackage[]>([]);
  const [feed, setFeed] = useState<HotTakeTopicCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showFeed, setShowFeed] = useState(true);
  const [showSelected, setShowSelected] = useState(false); // collapsed by default — the feed leads
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false); // brief "Updated" confirmation after a refresh
  // Feed search runs SERVER-side so it reaches every retained topic/signal, not
  // just the cards already on screen. Selected Topics is a dozen rows the client
  // already holds, so that one filters locally.
  const [feedQ, setFeedQ] = useState('');
  const [selectedQ, setSelectedQ] = useState('');
  // Load more GROWS this window rather than paging by offset — the ranked list is
  // recomputed per request, so a fixed offset would drift (see topicsOfTheDay).
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);
  const [feedHasMore, setFeedHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [seeAll, setSeeAll] = useState(false);            // reveal scheduled + published in Selected

  async function load() {
    setLoading(true);
    try {
      const [pkgs, page] = await Promise.all([
        api.hotTakePackages(),
        api.hotTakeTopicsOfTheDay({ limit: FEED_PAGE, q: feedQ }),
      ]);
      setPackages(pkgs);
      setFeed(page.topics);
      setFeedLimit(FEED_PAGE);
      setFeedHasMore(page.has_more);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [bump]);

  // Debounced feed search. Skipped on mount so it doesn't duplicate load()'s
  // first fetch; every later change re-queries from the top of the ranking.
  const firstFeedQ = useRef(true);
  useEffect(() => {
    if (firstFeedQ.current) { firstFeedQ.current = false; return; }
    const t = setTimeout(() => { void searchFeed(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedQ]);

  async function searchFeed() {
    setRefreshing(true); setErr(null);
    try {
      // A new search starts from a fresh window. No `history` flag needed — a
      // non-empty query already widens the lookback server-side.
      const page = await api.hotTakeTopicsOfTheDay({ limit: FEED_PAGE, q: feedQ });
      setFeed(page.topics);
      setFeedLimit(FEED_PAGE);
      setFeedHasMore(page.has_more);
      if (!showFeed) setShowFeed(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'search failed');
    } finally {
      setRefreshing(false);
    }
  }

  // Reach further back into the retained history. Grows the window and REPLACES
  // the list with one consistently-ranked result, rather than appending a page
  // computed against a list that shifted underneath us.
  async function loadMore() {
    const next = feedLimit + FEED_PAGE;
    setLoadingMore(true); setErr(null);
    try {
      const page = await api.hotTakeTopicsOfTheDay({ limit: next, q: feedQ, history: true });
      setFeed(page.topics);
      setFeedLimit(next);
      setFeedHasMore(page.has_more);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not load more');
    } finally {
      setLoadingMore(false);
    }
  }

  // Re-run the Topics of the Day search. topicsOfTheDay is a LIVE read that
  // re-merges + re-ranks the latest synthesized topics, scored signals and digest
  // items, so a re-fetch surfaces whatever the background awareness sweep has
  // added since the page loaded. (It reads the freshest data; it does not itself
  // kick off the OSINT scraper.)
  async function refreshFeed() {
    setRefreshing(true); setJustRefreshed(false); setErr(null);
    const started = Date.now();
    try {
      // Preserve however far back the operator has browsed — a refresh should
      // re-rank what they're looking at, not collapse it to the first page.
      const page = await api.hotTakeTopicsOfTheDay({
        limit: feedLimit, q: feedQ, history: feedLimit > FEED_PAGE,
      });
      setFeed(page.topics);
      setFeedHasMore(page.has_more);
      if (!showFeed) setShowFeed(true); // surface the freshly-searched results
      // Hold the in-flight state ~600ms minimum so a fast fetch still registers
      // visually, then flash "Updated" so it's clear the search actually ran.
      const remain = 600 - (Date.now() - started);
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 1600);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  // Deepest in the pipeline first — scheduled → ready → review → article → brief
  // → take → topic, so the work closest to shipping leads the list.
  const selected = useMemo(() => {
    const visible = seeAll ? ALL_STAGES : ACTIVE_STAGES;
    const rows = packages
      .filter((p) => visible.includes(p.status))
      // LIFO — the topic selected last sits on top.
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    // Client-side filter: this list is the operator's own dozen packages, all
    // already in memory, so a round trip would only add latency.
    const needle = selectedQ.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((p) =>
      `${p.title || ''} ${p.summary || ''} ${p.why_it_matters || ''} ${p.take || ''}`
        .toLowerCase().includes(needle));
  }, [packages, selectedQ, seeAll]);
  const selectedRefs = useMemo(() => new Set(packages.map((p) => p.origin_ref).filter(Boolean)), [packages]);
  const freshFeed = useMemo(
    () => feed.filter((c) => !c.already_selected && !selectedRefs.has(c.origin_ref)),
    [feed, selectedRefs],
  );

  async function addLink() {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) { setErr('Enter a full http(s) link'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.hotTakeAddLink(u);
      if (res.error || !res.package) { setErr(res.error || 'could not read that link'); return; }
      setUrl('');
      setPackages((prev) => (prev.some((p) => p.id === res.package!.id) ? prev : [res.package as HotTakePackage, ...prev]));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'add failed');
    } finally {
      setBusy(false);
    }
  }

  async function pin(card: HotTakeTopicCard) {
    setBusy(true); setErr(null);
    try {
      const pkg = await api.hotTakePinTopic(card);
      setPackages((prev) => (prev.some((p) => p.id === pkg.id) ? prev : [pkg, ...prev]));
      setFeed((prev) => prev.map((c) => (c.origin_ref === card.origin_ref ? { ...c, already_selected: true } : c)));
      return pkg;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'pin failed');
      return null;
    } finally {
      setBusy(false);
    }
  }

  // The main CTA hands off IMMEDIATELY: the Publications editor popup opens at
  // once and runs the take → brief → article chain itself, behind a progress
  // screen — no waiting on the card.
  function draftTake(p: HotTakePackage) {
    onDraftTopic(p);
  }

  // Feed-card variant: select the topic first (same as the pin), then hand off.
  async function draftFromCard(card: HotTakeTopicCard) {
    const pkg = await pin(card);
    if (pkg) onDraftTopic(pkg);
  }

  async function dismiss(id: string) {
    setPackages((prev) => prev.filter((p) => p.id !== id));
    try { await api.hotTakeDismiss(id); refresh(); } catch { load(); }
  }

  // Manually drop a Topic-of-the-Day card the operator doesn't find good enough.
  // Optimistically remove it, then persist so the hourly sweep won't resurface it.
  async function dismissCard(card: HotTakeTopicCard) {
    setFeed((prev) => prev.filter((c) => !(c.origin === card.origin && c.origin_ref === card.origin_ref)));
    try { await api.hotTakeDismissTopic(card); } catch { load(); }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 space-y-6">
        {/* One box, one act: paste a link, it becomes a pinned Selected topic. */}
        <div className="panel panel-pad rounded-sm">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addLink(); }}
              placeholder="manually add a topic link here"
              className="flex-1 h-9 px-3 rounded-sm bg-paper border border-line text-sm text-ink placeholder:text-mute focus:outline-none focus:border-ink/40"
            />
            <button onClick={addLink} disabled={busy}
              className="h-9 px-4 rounded-sm bg-ink text-paper text-sm font-medium disabled:opacity-50 shrink-0">
              {busy ? 'Reading…' : 'Add link'}
            </button>
          </div>
          {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}
        </div>

        {loading ? (
          <div className="text-sm text-mute px-1">Loading topics…</div>
        ) : (
          <>
            <section>
              <SectionHead
                open={showSelected}
                onToggle={() => setShowSelected((v) => !v)}
                label="Selected Topics"
                count={selected.length}
                tone="bg-violet-100 text-violet-800"
                right={
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSeeAll((v) => !v)}
                      aria-pressed={seeAll}
                      title={seeAll ? 'Showing everything — click to hide scheduled & published again' : 'Scheduled & published topics are hidden — click to see all'}
                      className={'h-7 px-2.5 rounded-sm mono text-[10px] uppercase tracking-[0.12em] transition shrink-0 ' +
                        (seeAll ? 'bg-ink text-paper' : 'hairline bg-card text-mute hover:text-ink')}
                    >
                      See All
                    </button>
                    <SectionSearch value={selectedQ} onChange={setSelectedQ} placeholder="Search selected…" />
                  </div>
                }
              />
              {showSelected && (
                selected.length === 0 ? (
                  <div className="text-sm text-mute px-1 py-3">
                    Add a link or choose a topic below. When you find something worth addressing, select “Draft a Take.”
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selected.map((p) => (
                      <div
                        key={p.id}
                        className="group hairline rounded-sm bg-card/80 p-4 transition hover:border-ink/40"
                      >
                        {/* meta row — pin · source · time, with the pipeline-stage chip on the right.
                            The pin is filled (selected): clicking it removes the topic from Selected.
                            The card body is INERT — every action is a button. */}
                        <div className="flex items-center gap-2 mb-2">
                          <button
                            onClick={() => dismiss(p.id)}
                            aria-label="Remove from selected" aria-pressed={true}
                            title="Selected — click to remove"
                            className="h-6 w-6 grid place-items-center rounded-sm shrink-0 bg-ink text-paper border border-ink transition"
                          >
                            <Pin size={13} />
                          </button>
                          <span className="text-[11px] text-mute truncate min-w-0">{p.source_name || hostOf(p.source_url) || 'source'}</span>
                          {p.published_at ? <span className="text-[10px] text-mute mono shrink-0">· {timeAgo(p.published_at)}</span> : null}
                          {p.multi_source && p.multi_source.length > 1 ? <span className="text-[10px] text-violet-600 mono shrink-0">· {p.multi_source.length} sources</span> : null}
                          <span className="ml-auto shrink-0"><StatusChip status={p.status} /></span>
                        </div>
                        <div dir="auto" className="text-[14px] text-ink font-medium leading-snug">{p.headline || p.title || 'Untitled topic'}</div>
                        {p.summary && <p dir="auto" className="text-[12px] text-mute mt-1.5 leading-relaxed line-clamp-3">{p.summary}</p>}
                        {p.why_it_matters && (
                          <div dir="auto" className="mt-1.5 rounded-sm border border-line/70 bg-card/50 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink/70 flex items-start gap-1.5">
                            <Sparkle size={12} className="mt-0.5 text-amber-500/70 shrink-0" />
                            <span>{p.why_it_matters}</span>
                          </div>
                        )}
                        <div className="mt-3 flex items-center gap-3 flex-wrap">
                          {p.blog_slug ? (
                            <button onClick={() => onOpenPublication(p.blog_slug!)}
                              title="Open this publication in the full-screen editor"
                              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition">
                              Open
                            </button>
                          ) : (
                            <button onClick={() => draftTake(p)}
                              title="Opens the publication editor and drafts the take, brief and article there"
                              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition">
                              <Sparkle size={12} /> Draft a Take
                            </button>
                          )}
                          {p.source_url && (
                            <a href={p.source_url} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2.5 py-1 hover:bg-card transition"
                              title="Open the source">
                              Read ↗
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </section>

            <section>
              <SectionHead
                open={showFeed}
                onToggle={() => setShowFeed((v) => !v)}
                label="Topics of the Day"
                count={freshFeed.length}
                tone="bg-amber-100 text-amber-900"
                right={
                  <div className="flex items-center gap-2">
                    {/* Searches every retained topic/signal, not just what's loaded. */}
                    <SectionSearch value={feedQ} onChange={setFeedQ} placeholder="Search all topics…" />
                  <button
                    onClick={refreshFeed}
                    disabled={refreshing || loading}
                    title="Re-run the topic search"
                    className={'inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] rounded-sm px-2.5 py-1 transition disabled:opacity-100 ' +
                      (justRefreshed ? 'bg-emerald-600 text-white' : 'text-ink bg-paper hairline hover:bg-card')}
                  >
                    {refreshing
                      ? <><Refresh size={12} className="animate-spin" /> Searching…</>
                      : justRefreshed
                        ? <><Check size={12} /> Updated</>
                        : <><Refresh size={12} /> Refresh</>}
                  </button>
                  </div>
                }
              />
              {showFeed && (
                <>
                {freshFeed.length === 0 ? (
                  <div className="text-sm text-mute px-1 py-3">
                    {feedQ.trim()
                      ? `Nothing matches “${feedQ.trim()}”. This searches every topic and signal we still hold, not just today's.`
                      : 'No new topics right now. Approved sources feed this list as the hourly sweep runs.'}
                  </div>
                ) : (
                  <div className={'space-y-2 transition-opacity ' + (refreshing ? 'opacity-40 pointer-events-none' : '')}>
                    {freshFeed.map((c) => (
                      <div key={`${c.origin}:${c.origin_ref}`} className="group hairline rounded-sm bg-card/80 p-4 transition hover:border-ink/40">
                        {/* meta row — pin · source · time. The pin is hollow (not selected):
                            clicking it moves the topic into Selected (same as the Select CTA). */}
                        <div className="flex items-center gap-2 mb-2">
                          <button
                            onClick={() => pin(c)} disabled={busy}
                            aria-label="Move to selected" aria-pressed={false}
                            title="Select this topic"
                            className="h-6 w-6 grid place-items-center rounded-sm shrink-0 bg-transparent text-mute border border-line hover:text-ink hover:border-ink/40 transition disabled:opacity-50"
                          >
                            <Pin size={13} />
                          </button>
                          <span className="text-[11px] text-mute truncate min-w-0">{c.source_name || hostOf(c.source_url) || 'source'}</span>
                          {c.published_at ? <span className="text-[10px] text-mute mono shrink-0">· {timeAgo(c.published_at)}</span> : null}
                          {c.multi_source && c.multi_source > 1 ? <span className="text-[10px] text-violet-600 mono shrink-0">· {c.multi_source} sources</span> : null}
                          {/* remove from feed — not good enough (hover-revealed, like the signal card's dismiss) */}
                          <button onClick={() => dismissCard(c)} aria-label="Remove from feed" title="Remove — not good enough"
                            className="ml-auto shrink-0 h-6 w-6 grid place-items-center rounded-sm text-mute/70 opacity-0 group-hover:opacity-100 hover:text-rose-600 hover:bg-rose-50 transition">
                            <X size={14} />
                          </button>
                        </div>
                        <div dir="auto" className="text-[14px] text-ink font-medium leading-snug">{c.title}</div>
                        {c.summary && <p dir="auto" className="text-[12px] text-mute mt-1.5 leading-relaxed line-clamp-3">{c.summary}</p>}
                        {c.why_it_matters && (
                          <div dir="auto" className="mt-1.5 rounded-sm border border-line/70 bg-card/50 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink/70 flex items-start gap-1.5">
                            <Sparkle size={12} className="mt-0.5 text-amber-500/70 shrink-0" />
                            <span>{c.why_it_matters}</span>
                          </div>
                        )}
                        {/* Draft a Take is the main act — it selects the topic, drafts
                            take → brief → article, and lands in the publication editor.
                            The pin stays for "keep it, decide later". */}
                        <div className="mt-3 flex items-center gap-3 flex-wrap">
                          <button
                            onClick={() => draftFromCard(c)}
                            disabled={busy}
                            title="Select this topic and open the publication editor — the draft is written there"
                            className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] bg-ink text-paper rounded-sm px-2.5 py-1 hover:opacity-90 transition disabled:opacity-50"
                          >
                            <Sparkle size={12} /> Draft a Take
                          </button>
                          {c.source_url && (
                            <a href={c.source_url} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.18em] text-ink bg-paper hairline rounded-sm px-2.5 py-1 hover:bg-card transition"
                              title="Open the source">
                              Read ↗
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Walks backwards through the retained history. Driven by
                    has_more, not by page length — the server drops already-
                    selected cards, so a short page is not the end of the list. */}
                {feedHasMore && (
                  <button
                    onClick={loadMore}
                    disabled={loadingMore || refreshing}
                    className="mt-2 w-full h-10 rounded-sm hairline bg-paper hover:bg-card text-ink mono text-[10px] uppercase tracking-[0.18em] transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {loadingMore
                      ? <><Refresh size={12} className="animate-spin" /> Loading…</>
                      : 'Load more'}
                  </button>
                )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── the spine drawer (Topic → Take → Brief) ─────────────────────────────────
function SpineDrawer({ id, onClose, onOpenEditor }: { id: string; onClose: () => void; onOpenEditor: (id: string) => void }) {
  const [view, setView] = useState<HotTakeView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<HotTakePackage>>({});
  const { setPendingSend } = useChatState();

  // Hand the topic to Nyo to draft the take in conversation (main path).
  function draftWithNyo(p: HotTakePackage) {
    setPendingSend(nyoDraftPrompt(p));
    openChat();
  }

  const load = () => api.hotTakeView(id).then((v) => { setView(v); setDraft({}); }).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { load(); }, [id]);

  const pkg = view?.package;
  const val = <K extends keyof HotTakePackage>(k: K): HotTakePackage[K] | string =>
    (draft[k] !== undefined ? (draft[k] as HotTakePackage[K]) : (pkg?.[k] ?? '')) as HotTakePackage[K] | string;

  async function saveDraftFields() {
    if (!pkg || !Object.keys(draft).length) return;
    await api.hotTakePatchPackage(pkg.id, draft);
    await load();
  }

  async function run(step: 'take' | 'brief' | 'article', fn: () => Promise<unknown>) {
    setBusy(step); setErr(null);
    try {
      await saveDraftFields();
      const r = (await fn()) as { error?: string };
      if (r?.error) setErr(r.error);
      await load();
      if (step === 'article' && !r?.error && pkg) onOpenEditor(pkg.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  const Field = ({ label, k, rows = 2 }: { label: string; k: keyof HotTakePackage; rows?: number }) => (
    <div>
      <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute mb-1">{label}</div>
      <textarea
        value={String(val(k) ?? '')}
        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value } as Partial<HotTakePackage>))}
        onBlur={saveDraftFields}
        rows={rows}
        className="w-full px-3 py-2 rounded-sm bg-paper border border-line text-sm text-ink focus:outline-none focus:border-ink/40"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className="relative w-full sm:w-[560px] h-full bg-paper border-l border-line overflow-y-auto">
        <div className="sticky top-0 bg-paper/95 border-b border-line px-5 py-3 flex items-center gap-2 z-10">
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Topic → Take → Brief</span>
          {pkg && <StatusChip status={pkg.status} />}
          <button onClick={onClose} className="ml-auto text-mute hover:text-ink"><X size={17} /></button>
        </div>
        {!pkg ? (
          <div className="p-5 text-sm text-mute">{err || 'Loading…'}</div>
        ) : (
          <div className="p-5 space-y-5">
            <div>
              <SourceLine name={pkg.source_name} url={pkg.source_url} when={pkg.published_at} multi={pkg.multi_source?.length} />
              <h2 className="text-lg font-semibold text-ink mt-1 leading-snug">{pkg.title || 'Untitled topic'}</h2>
              {pkg.summary && <p className="text-sm text-mute mt-1.5">{pkg.summary}</p>}
              {pkg.why_it_matters && (
                <p className="text-sm text-ink/80 mt-1.5 flex items-start gap-1.5">
                  <Sparkle size={13} className="mt-0.5 text-amber-500 shrink-0" /><span>{pkg.why_it_matters}</span>
                </p>
              )}
            </div>

            {/* THE TAKE — the proposed argument is the star of this screen */}
            <div className="panel panel-pad rounded-sm space-y-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-ink">The company's take</span>
                {busy === 'take' && <span className="mono text-[10px] text-mute animate-pulse">drafting…</span>}
              </div>
              {pkg.take || draft.take !== undefined ? (
                <>
                  <Field label="The take (the argument)" k="take" rows={3} />
                  <div className="grid grid-cols-1 gap-3">
                    <Field label="What does the company believe?" k="believe" />
                    <Field label="What is commonly misunderstood?" k="misunderstood" />
                    <Field label="Who should care?" k="who_cares" />
                    <Field label="What should the reader do differently?" k="reader_action" />
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <Btn onClick={() => run('take', () => api.hotTakeDraftTake(pkg.id))} disabled={!!busy} tone="line">Redraft with AI</Btn>
                    <Btn onClick={() => run('brief', () => api.hotTakeBuildBrief(pkg.id))} disabled={!!busy}>
                      {busy === 'brief' ? 'Building brief…' : 'Approve take → build brief'}
                    </Btn>
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-mute">No take yet. Draft the company's point of view — you confirm or rewrite it before anything is written.</p>
                  {/* Drafting presents as action cards (same shape as the Digest item drawer).
                      Nyo is the main path — the take gets argued out, not one-shot generated. */}
                  <section className="hairline rounded-sm bg-card/60 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                      <Sparkle size={14} /> Draft the take with Nyo
                    </div>
                    <p className="text-[11px] text-mute">Opens this topic in the full Nyo chat. Shape the argument together, push back on it, and save once it's right.</p>
                    <button
                      onClick={() => draftWithNyo(pkg)}
                      className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm bg-ink text-paper hover:opacity-90 transition text-[10px] uppercase tracking-[0.18em]"
                    >
                      draft with nyo →
                    </button>
                  </section>
                  <section className="hairline rounded-sm bg-card/60 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                      <Sparkle size={14} /> Generate a first draft
                    </div>
                    <p className="text-[11px] text-mute">One-shot AI pass at the take and its four inputs, straight into the fields here for you to edit.</p>
                    <button
                      onClick={() => run('take', () => api.hotTakeDraftTake(pkg.id))}
                      disabled={!!busy}
                      className="mono inline-flex items-center gap-1.5 h-8 px-3 rounded-sm hairline text-ink hover:bg-card transition text-[10px] uppercase tracking-[0.18em] disabled:opacity-40"
                    >
                      {busy === 'take' ? 'drafting…' : 'generate draft →'}
                    </button>
                  </section>
                </div>
              )}
            </div>

            {/* THE BRIEF */}
            {pkg.brief && (
              <div className="panel panel-pad rounded-sm space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-ink">Editorial brief</span>
                  {typeof (pkg.brief as Record<string, unknown>).pattern === 'string' && (
                    <span className="mono text-[9px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm bg-stone-100 text-stone-700">
                      {String((pkg.brief as Record<string, unknown>).pattern)}
                    </span>
                  )}
                </div>
                {(['argument', 'audience', 'why_now'] as const).map((k) => (
                  <div key={k}>
                    <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">{k.replace('_', ' ')}</div>
                    <div className="text-sm text-ink">{String((pkg.brief as Record<string, unknown>)[k] || '')}</div>
                  </div>
                ))}
                {(['points', 'evidence', 'objections'] as const).map((k) => {
                  const arr = (pkg.brief as Record<string, unknown>)[k];
                  if (!Array.isArray(arr) || !arr.length) return null;
                  return (
                    <div key={k}>
                      <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">{k}</div>
                      <ul className="text-sm text-ink list-disc pl-4 space-y-0.5">
                        {arr.map((x, i) => {
                          if (typeof x === 'string') return <li key={i}>{x}</li>;
                          const o = x as { title?: unknown; text?: unknown };
                          const label = [o?.title, o?.text].filter(Boolean).join(': ');
                          return <li key={i}>{label || JSON.stringify(x)}</li>;
                        })}
                      </ul>
                    </div>
                  );
                })}
                {typeof (pkg.brief as Record<string, unknown>).conclusion === 'string' && (
                  <div>
                    <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">conclusion</div>
                    <div className="text-sm text-ink">{String((pkg.brief as Record<string, unknown>).conclusion)}</div>
                  </div>
                )}
                <div className="flex gap-2 pt-1 flex-wrap">
                  <Btn onClick={() => run('brief', () => api.hotTakeBuildBrief(pkg.id))} disabled={!!busy} tone="line">Rebuild brief</Btn>
                  {!pkg.blog_slug && (
                    <Btn onClick={() => run('article', () => api.hotTakeWriteArticle(pkg.id))} disabled={!!busy}>
                      {busy === 'article' ? 'Writing (1–3 min)…' : 'Approve brief → write article'}
                    </Btn>
                  )}
                </div>
              </div>
            )}

            {pkg.blog_slug && (
              <div className="panel panel-pad rounded-sm flex items-center gap-3">
                <div className="flex-1 text-sm text-ink">Article drafted: <span className="font-medium">{pkg.headline || pkg.blog_slug}</span></div>
                <Btn onClick={() => onOpenEditor(pkg.id)}>Open in editor</Btn>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3">
              <Field label="Company notes" k="company_notes" />
              <Field label="Author notes" k="author_notes" />
            </div>

            {err && <div className="text-xs text-rose-600">{err}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Publications tab: components/HotTakesPublications.tsx (the blog experience
//     + schedule-first approval), wired from the root above. ──────────────────

// ─── the Publication Editor ───────────────────────────────────────────────────
function PublicationEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [view, setView] = useState<HotTakeView | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.hotTakeView(id).then((v) => {
    setView(v);
    setTitle(v.article?.title || v.package.headline || v.package.title || '');
    setBody(v.article?.body || '');
    setDirty(false);
  }).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { load(); }, [id]);

  const pkg = view?.package;
  const review = (pkg?.review || null) as { claims?: HotTakeClaim[]; quality_flags?: HotTakeFlag[] } | null;

  async function saveArticle() {
    if (!pkg) return;
    setBusy('save'); setErr(null);
    try {
      await api.hotTakeSaveArticle(pkg.id, { title, body });
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'save failed'); }
    finally { setBusy(null); }
  }

  async function rescan() {
    if (!pkg) return;
    setBusy('scan'); setErr(null);
    try {
      if (dirty) await api.hotTakeSaveArticle(pkg.id, { title, body });
      const r = await api.hotTakeReviewScan(pkg.id);
      if (r.error) setErr(r.error);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'scan failed'); }
    finally { setBusy(null); }
  }

  async function patchReview(mut: (r: { claims: HotTakeClaim[]; quality_flags: HotTakeFlag[] }) => void) {
    if (!pkg) return;
    const next = { claims: [...(review?.claims || [])], quality_flags: [...(review?.quality_flags || [])] };
    mut(next);
    await api.hotTakePatchPackage(pkg.id, { review: next } as Partial<HotTakePackage>);
    await load();
  }

  async function markReady() {
    if (!pkg) return;
    setBusy('ready');
    try {
      await api.hotTakePatchPackage(pkg.id, { status: 'ready' });
      await load();
    } finally { setBusy(null); }
  }

  const openClaims = (review?.claims || []).filter((c) => c.status === 'needs_confirmation').length;
  const openFlags = (review?.quality_flags || []).filter((f) => !f.resolved).length;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className="relative m-auto w-[96vw] max-w-6xl h-[92vh] bg-paper border border-line rounded-sm overflow-hidden flex flex-col">
        <div className="border-b border-line px-5 py-3 flex items-center gap-3 shrink-0 flex-wrap">
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Publication editor</span>
          {pkg && <StatusChip status={pkg.status} />}
          {view?.next_action && <span className="text-xs text-ink/80">Next: {view.next_action}</span>}
          <div className="ml-auto flex items-center gap-2">
            {view?.article && (
              <Btn tone="line" onClick={() => setPreview((v) => !v)}>{preview ? 'Edit HTML' : 'Preview'}</Btn>
            )}
            <Btn onClick={saveArticle} disabled={!dirty || !!busy}>{busy === 'save' ? 'Saving…' : 'Save article'}</Btn>
            <button onClick={onClose} className="text-mute hover:text-ink ml-1"><X size={17} /></button>
          </div>
        </div>

        {!view ? (
          <div className="p-6 text-sm text-mute">{err || 'Loading…'}</div>
        ) : !view.article ? (
          <div className="p-6 text-sm text-mute">No article yet — approve the brief and write it from the topic drawer.</div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
            {/* Article pane */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-3">
              <input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                className="w-full text-xl font-semibold text-ink bg-transparent border-b border-line pb-2 focus:outline-none focus:border-ink/40"
              />
              {preview ? (
                <div
                  className="prose prose-stone prose-sm max-w-none text-ink [&_h2]:font-semibold [&_h2]:text-lg [&_h3]:font-semibold [&_p]:leading-relaxed [&_img]:max-w-full"
                  dangerouslySetInnerHTML={{ __html: body }}
                />
              ) : (
                <textarea
                  value={body}
                  onChange={(e) => { setBody(e.target.value); setDirty(true); }}
                  className="w-full h-[60vh] mono text-xs px-3 py-2 rounded-sm bg-card border border-line text-ink focus:outline-none focus:border-ink/40"
                />
              )}
            </div>

            {/* Review pane */}
            <div className="w-full lg:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-line overflow-y-auto p-4 space-y-4 bg-paper/60">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-ink">Review</span>
                <span className="mono text-[10px] text-mute">{openClaims} claims · {openFlags} issues open</span>
                <div className="ml-auto">
                  <Btn tone="line" onClick={rescan} disabled={!!busy}>{busy === 'scan' ? 'Scanning…' : (review ? 'Re-scan' : 'Scan claims + quality')}</Btn>
                </div>
              </div>

              {review?.claims?.length ? (
                <div className="space-y-2">
                  <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">Claims</div>
                  {review.claims.map((c, i) => (
                    <div key={i} className="panel rounded-sm p-2.5 space-y-1.5">
                      <div className="text-xs text-ink leading-snug">“{c.text}”</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={'mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-sm ' +
                          (c.support === 'directly_supported' ? 'bg-emerald-100 text-emerald-800'
                            : c.support === 'company_experience' ? 'bg-sky-100 text-sky-800'
                            : c.support === 'opinion' ? 'bg-stone-100 text-stone-700'
                            : 'bg-amber-100 text-amber-900')}>
                          {(c.support || 'unsupported').replace('_', ' ')}
                        </span>
                        {c.source && <span className="text-[10px] text-mute truncate max-w-[140px]" title={c.source}>{c.source}</span>}
                        {c.status === 'needs_confirmation' ? (
                          <button
                            onClick={() => patchReview((r) => { r.claims[i] = { ...r.claims[i], status: 'confirmed' }; })}
                            className="ml-auto h-6 px-2 rounded-sm bg-ink text-paper text-[10px] font-medium">
                            Confirm
                          </button>
                        ) : (
                          <span className="ml-auto mono text-[9px] uppercase text-emerald-700">confirmed</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : review ? (
                <div className="text-xs text-mute">No claims flagged.</div>
              ) : (
                <div className="text-xs text-mute">Run the scan to pull out the claims that matter and the sections that need judgment.</div>
              )}

              {review?.quality_flags?.length ? (
                <div className="space-y-2">
                  <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">Quality flags</div>
                  {review.quality_flags.map((f, i) => (
                    <div key={i} className={'panel rounded-sm p-2.5 space-y-1 ' + (f.resolved ? 'opacity-50' : '')}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-ink">{f.kind}</span>
                        {f.severity && <span className={'mono text-[9px] uppercase px-1 rounded-sm ' + (f.severity === 'high' ? 'bg-rose-100 text-rose-800' : 'bg-stone-100 text-stone-600')}>{f.severity}</span>}
                        {!f.resolved && (
                          <button
                            onClick={() => patchReview((r) => { r.quality_flags[i] = { ...r.quality_flags[i], resolved: true }; })}
                            className="ml-auto h-6 px-2 rounded-sm border border-line text-[10px] text-mute hover:text-ink">
                            Resolve
                          </button>
                        )}
                      </div>
                      {f.section && <div className="text-[10px] text-mute">§ {f.section}</div>}
                      {f.note && <div className="text-xs text-ink/80">{f.note}</div>}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="border-t border-line pt-3 space-y-2">
                {pkg && ['article', 'review'].includes(pkg.status) && (
                  <Btn onClick={markReady} disabled={!!busy || openClaims > 0}>
                    {openClaims > 0 ? `Confirm ${openClaims} claim${openClaims === 1 ? '' : 's'} first` : (busy === 'ready' ? 'Marking…' : 'Mark ready')}
                  </Btn>
                )}
                {pkg && pkg.status === 'ready' && (
                  <div className="text-xs text-emerald-700">Ready — prepare the social posts, then schedule the release.</div>
                )}
                {view.article.published && view.package.website_url && (
                  <a className="text-xs underline decoration-dotted text-ink" href={view.package.website_url} target="_blank" rel="noreferrer">View live article</a>
                )}
              </div>

              {err && <div className="text-xs text-rose-600">{err}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Social Posts tab ─────────────────────────────────────────────────────────
// The standalone social queue: every post that is in review (draft/ready/failed)
// or scheduled, across ALL publications, each linking back to the publication it
// distributes. Cards read clean by default — the pencil opens the same in-card
// editor; Schedule is the one primary action. Drafting new posts happens from
// the publication's detail panel on the Publications tab.
function SocialTab({ bump, refresh, onOpenPublication }: {
  bump: number;
  refresh: () => void;
  onOpenPublication: (slug: string | null, pkgId: string) => void;
}) {
  const [busyAll, setBusyAll] = useState<string | null>(null);
  const [pipe, setPipe] = useState<HotTakePipeline | null>(null);

  const load = () => api.hotTakePipeline().then(setPipe).catch(() => {});
  useEffect(() => { load(); }, [bump]);

  const entries = useMemo<SocialEntry[]>(() => {
    if (!pipe) return [];
    const out: SocialEntry[] = [];
    for (const group of [pipe.in_flight, pipe.needs_review, pipe.ready, pipe.scheduled, pipe.published]) {
      for (const pkg of group) for (const post of pkg.posts) out.push({ post, pkg });
    }
    return out;
  }, [pipe]);
  // Posts bunched in a container under their publication — the Social module
  // page's layout, adopted here. Active statuses only (posted/skipped hidden,
  // as before); groups newest-publication-first.
  const groups = useMemo(() => {
    const m = new Map<string, { pkg: SocialEntry['pkg']; posts: HotTakePost[] }>();
    for (const e of entries) {
      if (!['draft', 'ready', 'failed', 'scheduled'].includes(e.post.status)) continue;
      const g = m.get(e.pkg.id) || { pkg: e.pkg, posts: [] };
      g.posts.push(e.post);
      m.set(e.pkg.id, g);
    }
    return [...m.values()].sort((a, b) => (b.pkg.created_at || 0) - (a.pkg.created_at || 0));
  }, [entries]);

  if (!pipe) return <div className="flex-1 grid place-items-center text-sm text-mute">Loading…</div>;

  const onChanged = () => { load(); refresh(); };

  // Which of a group's posts CAN be approved right now: planned, unapproved,
  // with text and a time. Approve = the state the hourly due-scan sends.
  const approvable = (posts: HotTakePost[]) =>
    posts.filter((p) => ['draft', 'ready', 'failed'].includes(p.status) && (p.body || '').trim() !== '' && !!p.scheduled_at);

  async function approveAll(pkgId: string, posts: HotTakePost[]) {
    const eligible = approvable(posts);
    if (!eligible.length) return;
    setBusyAll(pkgId);
    try {
      for (const p of eligible) await api.hotTakePatchPost(p.id, { status: 'scheduled' });
      onChanged();
    } finally {
      setBusyAll(null);
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 space-y-5">
        {groups.length === 0 && (
          <div className="text-sm text-mute">
            No social posts waiting. Draft them from a publication's editor on the Publications tab.
          </div>
        )}

        {groups.map(({ pkg, posts }) => (
          <article key={pkg.id} className="rounded-sm border border-line bg-card/30 overflow-hidden">
            <div className="px-4 py-3 border-b border-line flex items-center gap-3">
              <Newspaper size={15} className="text-mute shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mono text-[9px] uppercase tracking-[0.18em] text-mute">publication</div>
                <div className="text-sm font-medium truncate text-ink">{pkg.headline || pkg.title || pkg.blog_slug || pkg.id}</div>
              </div>
              <StatusChip status={pkg.status} />
              <button
                onClick={() => onOpenPublication(pkg.blog_slug, pkg.id)}
                title="Open the publication"
                className="mono text-[10px] uppercase tracking-[0.18em] text-mute hover:text-ink transition shrink-0"
              >
                open ↗
              </button>
              {approvable(posts).length > 0 && (
                <button
                  onClick={() => approveAll(pkg.id, posts)}
                  disabled={busyAll === pkg.id}
                  title="Approve every ready post — each goes out at its scheduled time"
                  className="h-7 px-3 rounded-sm border border-emerald-400/60 text-emerald-700 dark:text-emerald-300 text-[11px] mono uppercase tracking-[0.18em] hover:bg-emerald-100 dark:hover:bg-emerald-950/40 transition shrink-0 disabled:opacity-50"
                >
                  {busyAll === pkg.id ? 'Approving…' : `Approve all ${approvable(posts).length}`}
                </button>
              )}
            </div>
            <div className="divide-y divide-line">
              {posts.map((post) => (
                <HotTakeDraftRow key={post.id} post={post} onChanged={onChanged} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

type SocialEntry = { post: HotTakePost; pkg: HotTakePackage & { posts: HotTakePost[]; next_action: string } };

// Row labels in the Social module's style: "LinkedIn · Company" / "LinkedIn · Lev".
const ROW_LABEL: Record<string, string> = {
  'linkedin-company': 'LinkedIn · Company',
  'linkedin-personal': 'LinkedIn · Lev',
};

// One social post as a SLIM ROW — the Social module's DraftRow anatomy, cloned
// for hot-take legs: a collapsed one-liner (channel · first-line preview · img
// mark · char count · chevron) that expands to a textarea with Save edit /
// Skip / Approve. The one semantic difference from the module: Approve here
// books the post for its scheduled time (status 'scheduled'); it does not
// post immediately.
// Top-level ON PURPOSE: holds a textarea — defined inside SocialTab it would
// remount on every parent render and drop the caret.
function HotTakeDraftRow({ post, onChanged }: { post: HotTakePost; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(post.body || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dirty = text.trim() !== (post.body || '').trim();
  useEffect(() => { setText(post.body || ''); }, [post.body]);
  const preview = (post.body || '').split('\n').find((l) => l.trim()) || 'no text yet';
  const approved = post.status === 'scheduled';

  async function act(tag: string, fn: () => Promise<unknown>) {
    setBusy(tag); setErr(null);
    try {
      const r = (await fn()) as { error?: string } | undefined;
      if (r && r.error) { setErr(r.error); return; }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(null);
    }
  }
  const save = () => act('save', () => api.hotTakePatchPost(post.id, { body: text }));
  const skip = () => act('skip', () => api.hotTakePatchPost(post.id, { status: 'not_planned' }));
  const approve = () => act('approve', () => api.hotTakePatchPost(post.id, { status: 'scheduled' }));
  const hold = () => act('hold', () => api.hotTakePatchPost(post.id, { status: 'ready' }));

  return (
    <div>
      {/* Collapsed row — click to expand and edit/approve. */}
      <button onClick={() => setOpen(!open)} className="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-card/50 transition">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0 whitespace-nowrap">{ROW_LABEL[post.channel] || post.channel}</span>
        <span className="flex-1 truncate text-[13px] text-mute">{preview}</span>
        {approved && post.scheduled_at && (
          <span className="mono text-[9px] uppercase tracking-[0.14em] text-emerald-700 shrink-0" title="Approved — posts at this time">
            ✓ {fmtWhen(post.scheduled_at)}
          </span>
        )}
        {post.status === 'failed' && <span className="mono text-[9px] uppercase text-rose-600 shrink-0">failed</span>}
        {post.image_url && <span className="mono text-[9px] uppercase tracking-[0.18em] text-mute opacity-60 shrink-0" title="cover image attached">img</span>}
        <span className="mono text-[10px] text-mute shrink-0">{(post.body || '').length}</span>
        <span className={'text-mute text-sm leading-none transition-transform shrink-0 ' + (open ? 'rotate-90' : '')}>›</span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1">
          <textarea
            dir="auto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(14, Math.max(5, text.split('\n').length + 1))}
            className="w-full text-[13px] leading-relaxed rounded-sm bg-paper border border-line px-3 py-2 focus:outline-none focus:border-ink/40 resize-y"
          />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {dirty && (
              <button onClick={save} disabled={!!busy} className="h-7 px-3 rounded-sm border border-line text-[11px] mono uppercase tracking-[0.18em] text-mute hover:text-ink hover:border-ink/40 transition disabled:opacity-50">
                {busy === 'save' ? 'Saving…' : 'Save edit'}
              </button>
            )}
            <button onClick={skip} disabled={!!busy} className="ml-auto h-7 px-3 rounded-sm border border-line text-[11px] mono uppercase tracking-[0.18em] text-mute hover:text-ink transition disabled:opacity-50">
              Skip
            </button>
            {approved ? (
              <button onClick={hold} disabled={!!busy} title="Approved — click to hold it back" className="h-7 px-3 rounded-sm border border-emerald-400/60 text-emerald-700 dark:text-emerald-300 text-[11px] mono uppercase tracking-[0.18em] hover:bg-emerald-100 dark:hover:bg-emerald-950/40 transition disabled:opacity-50 flex items-center gap-1.5">
                <Check size={12} /> Approved
              </button>
            ) : (
              <button
                onClick={approve}
                disabled={!!busy || dirty || !text.trim() || !post.scheduled_at}
                title={dirty ? 'Save your edit first' : !text.trim() ? 'Write the post first' : !post.scheduled_at ? 'Schedule the publication first — the post needs its time' : 'Approve — goes out at its scheduled time'}
                className={'h-7 px-3 rounded-sm border text-[11px] mono uppercase tracking-[0.18em] transition flex items-center gap-1.5 ' + (busy || dirty || !text.trim() || !post.scheduled_at ? 'border-line text-mute opacity-60 cursor-not-allowed' : 'border-emerald-400/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/40')}
              >
                <Check size={12} /> {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
            )}
          </div>
          {err && <div className="mt-1 text-[11px] text-rose-600">{err}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Schedule tab ─────────────────────────────────────────────────────────────
// A CALENDAR, nothing else: every website publish and social leg lands on its
// day at its time. Default: a MONTH view (5 week-aligned rows) starting at the
// beginning of the current workweek, weekends tinted gray. ‹ › page one span at
// a time (‹ scrolls back into history — the release store keeps published
// releases and posted legs), the date field jumps anywhere, Today returns.
type CalView = 'day' | 'week' | '14d' | 'month';
const CAL_SPAN: Record<CalView, number> = { day: 1, week: 7, '14d': 14, month: 35 };
const WEEK_ALIGNED: CalView[] = ['week', '14d', 'month'];
const DAY_MS = 86400000;

type CalEntry = {
  key: string;
  at: number;
  kind: 'website' | 'linkedin-company' | 'linkedin-personal';
  tone: string;
  label: string;
  title: string;
  slug: string | null;
  pkgId: string;
};

function dayStart(ts: number): number { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

// The operator's week, from the browser locale: firstDay/weekend as ISO days
// (Mon=1 … Sun=7). Falls back to ISO (Monday start, Sat+Sun weekend) where
// Intl.Locale weekInfo isn't available.
function localWeekInfo(): { firstDay: number; weekend: number[] } {
  try {
    const loc = new Intl.Locale(navigator.language) as unknown as {
      weekInfo?: { firstDay: number; weekend: number[] };
      getWeekInfo?: () => { firstDay: number; weekend: number[] };
    };
    const wi = loc.weekInfo || loc.getWeekInfo?.();
    if (wi?.firstDay) return { firstDay: wi.firstDay, weekend: wi.weekend?.length ? wi.weekend : [6, 7] };
  } catch { /* fall through */ }
  return { firstDay: 1, weekend: [6, 7] };
}
const WEEK_INFO = localWeekInfo();
const isoDayOf = (ts: number) => (new Date(ts).getDay() || 7); // Mon=1 … Sun=7

function startOfWeek(ts: number): number {
  const day0 = dayStart(ts);
  const diff = (isoDayOf(day0) - WEEK_INFO.firstDay + 7) % 7;
  // half-day nudge before re-flooring keeps a DST hour from drifting the walk
  return dayStart(day0 - diff * DAY_MS + DAY_MS / 2);
}

function ScheduleTab({ bump, onOpenPublication }: {
  bump: number;
  onOpenPublication: (slug: string | null, pkgId: string) => void;
}) {
  const [view, setView] = useState<HotTakeScheduleView | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [cal, setCal] = useState<CalView>('month');
  const [anchor, setAnchor] = useState<number>(() => startOfWeek(Date.now()));

  const load = () => {
    setLoadErr(false);
    api.hotTakeScheduleView().then(setView).catch(() => setLoadErr(true));
  };
  useEffect(() => { load(); }, [bump]);

  const span = CAL_SPAN[cal];
  const start = anchor;

  // Every dated event, bucketed by its day. Derived client-side — the release
  // store already returns full history, so paging back needs no refetch.
  const byDay = useMemo(() => {
    const m = new Map<number, CalEntry[]>();
    if (!view) return m;
    const push = (e: CalEntry) => {
      const k = dayStart(e.at);
      const arr = m.get(k) || [];
      arr.push(e);
      m.set(k, arr);
    };
    for (const r of view.releases) {
      const title = r.title || r.blog_slug || r.id;
      const site = r.markers.website;
      if (r.scheduled_at) {
        push({
          key: `${r.id}:site`, at: r.scheduled_at, kind: 'website',
          tone: site.state === 'done' ? 'bg-emerald-100 text-emerald-800'
            : site.state === 'overdue' ? 'bg-rose-100 text-rose-800'
            : 'bg-blue-100 text-blue-800',
          label: site.state === 'done' ? 'live' : site.state,
          title, slug: r.blog_slug, pkgId: r.id,
        });
      }
      for (const p of r.posts) {
        if (p.channel !== 'linkedin-company' && p.channel !== 'linkedin-personal') continue;
        if (p.status === 'not_planned' || p.status === 'skipped') continue;
        const at = p.posted_at || p.scheduled_at;
        if (!at) continue;
        push({
          key: p.id, at, kind: p.channel,
          tone: p.status === 'posted' ? 'bg-emerald-100 text-emerald-800'
            : p.status === 'failed' ? 'bg-rose-100 text-rose-800'
            : p.status === 'scheduled' ? 'bg-blue-100 text-blue-800'
            : 'bg-amber-100 text-amber-900', // draft/ready — awaiting approval
          label: p.status === 'posted' ? 'posted' : p.status === 'scheduled' ? 'approved' : 'awaiting approval',
          title, slug: r.blog_slug, pkgId: r.id,
        });
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => a.at - b.at);
    return m;
  }, [view]);

  // DST-safe day walk (half-day nudge before re-flooring to local midnight).
  const days = Array.from({ length: span }, (_, i) => dayStart(start + i * DAY_MS + DAY_MS / 2));
  const today = dayStart(Date.now());
  const rangeLabel = span === 1
    ? new Date(start).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : `${new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(days[days.length - 1]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const dateInputValue = (() => {
    const d = new Date(start);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  const align = (ts: number, v: CalView) => (WEEK_ALIGNED.includes(v) ? startOfWeek(ts) : dayStart(ts));

  function switchView(v: CalView) {
    setCal(v);
    setAnchor((a) => align(a, v));
  }
  function jump(dateStr: string) {
    const t = new Date(`${dateStr}T00:00:00`).getTime();
    if (Number.isFinite(t)) setAnchor(align(t, cal));
  }

  const viewChip = (active: boolean) =>
    'h-7 px-2.5 rounded-sm mono text-[10px] uppercase tracking-[0.12em] transition shrink-0 ' +
    (active ? 'bg-ink text-paper' : 'text-mute hover:text-ink');

  const Entry = ({ e }: { e: CalEntry }) => (
    <button
      onClick={() => onOpenPublication(e.slug, e.pkgId)}
      title={`${e.title} — ${e.label}`}
      className={'w-full text-left rounded-sm px-1.5 py-1 transition hover:opacity-80 ' + e.tone}
    >
      <span className="flex items-center gap-1">
        {e.kind === 'website'
          ? <Globe size={10} className="shrink-0" />
          : <><LinkedIn size={10} className="shrink-0" /><span className="mono text-[8px] font-bold shrink-0">{e.kind === 'linkedin-company' ? 'C' : 'P'}</span></>}
        <span className="mono text-[9px] tabular-nums shrink-0">{new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </span>
      <span className="block truncate text-[10px] leading-tight mt-0.5">{e.title}</span>
    </button>
  );

  if (loadErr) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="text-center space-y-2">
          <div className="text-sm text-mute">The schedule couldn't load.</div>
          <button onClick={load} className="h-8 px-3 rounded-sm bg-ink text-paper mono text-[10px] uppercase tracking-[0.16em] hover:opacity-90 transition">Retry</button>
        </div>
      </div>
    );
  }
  if (!view) return <div className="flex-1 grid place-items-center text-sm text-mute">Loading schedule…</div>;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-5 space-y-3">
        {/* the calendar's controls — view, time travel, date jump */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-0.5 hairline rounded-sm p-0.5 bg-card overflow-x-auto max-w-full">
            {(['day', 'week', '14d', 'month'] as CalView[]).map((v) => (
              <button key={v} onClick={() => switchView(v)} className={viewChip(cal === v)}>
                {v === 'day' ? 'Day' : v === 'week' ? 'Week' : v === '14d' ? '14 days' : 'Month'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setAnchor((a) => dayStart(a - span * DAY_MS + DAY_MS / 2))} aria-label="Back in time"
              className="h-8 w-8 grid place-items-center rounded-sm hairline bg-card text-mute hover:text-ink transition text-base">‹</button>
            <button onClick={() => setAnchor(align(Date.now(), cal))}
              className="h-8 px-2.5 rounded-sm hairline bg-card mono text-[10px] uppercase tracking-[0.12em] text-mute hover:text-ink transition">Today</button>
            <button onClick={() => setAnchor((a) => dayStart(a + span * DAY_MS + DAY_MS / 2))} aria-label="Forward in time"
              className="h-8 w-8 grid place-items-center rounded-sm hairline bg-card text-mute hover:text-ink transition text-base">›</button>
          </div>
          <input
            type="date" value={dateInputValue} onChange={(e) => jump(e.target.value)}
            aria-label="Jump to date"
            className="h-8 px-2 rounded-sm bg-paper border border-line text-xs text-ink mono focus:outline-none focus:border-ink/40"
          />
          <span className="ml-auto text-sm font-medium text-ink">{rangeLabel}</span>
        </div>

        {/* the calendar */}
        {cal === 'day' ? (
          <div className="hairline rounded-sm bg-card/40 p-3 space-y-1.5 min-h-[300px]">
            {(byDay.get(start) || []).length === 0
              ? <div className="text-sm text-mute p-6 text-center">Nothing on this day.</div>
              : (byDay.get(start) || []).map((e) => <div key={e.key} className="max-w-md"><Entry e={e} /></div>)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px] grid grid-cols-7 gap-1">
              {days.map((d) => {
                const entries = byDay.get(d) || [];
                const isToday = d === today;
                const isWeekend = WEEK_INFO.weekend.includes(isoDayOf(d));
                return (
                  <div
                    key={d}
                    className={'rounded-sm hairline p-1.5 min-h-[76px] sm:min-h-[92px] space-y-1 '
                      + (isWeekend ? 'bg-stone-200/50 ' : 'bg-card/40 ')
                      + (isToday ? 'ring-1 ring-ink/40' : '')}
                  >
                    <div className="flex items-baseline justify-between px-0.5">
                      <span className={'text-[11px] font-medium ' + (isToday ? 'text-ink' : 'text-mute')}>{new Date(d).getDate()}</span>
                      <span className="mono text-[8px] uppercase text-mute/70">{new Date(d).toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    </div>
                    {entries.map((e) => <Entry key={e.key} e={e} />)}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-[11px] text-mute">
          Website publishes (globe) and LinkedIn posts (C company · P personal), each at its time.
          Weekends are tinted. Click any entry to open its publication. Green live/posted · blue scheduled/approved · amber awaiting approval · red overdue/failed.
        </p>
      </div>
    </div>
  );
}


// ─── Approved Sources tab ─────────────────────────────────────────────────────
function SourcesTab({ bump, refresh }: { bump: number; refresh: () => void }) {
  const [channels, setChannels] = useState<HotTakeSource[]>([]);
  const [topics, setTopics] = useState<HotTakeSource[]>([]);
  const [notes, setNotes] = useState<Record<string, KnowledgeDoc> | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [kind, setKind] = useState<'rss' | 'gnews'>('rss');
  const [name, setName] = useState('');
  const [urlOrQuery, setUrlOrQuery] = useState('');
  const [theme, setTheme] = useState('general');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openCh, setOpenCh] = useState(true);
  const [openTo, setOpenTo] = useState(true);
  const [openLib, setOpenLib] = useState(false);
  const [openHow, setOpenHow] = useState(true);
  const [gates, setGates] = useState<HeartbeatGates | null>(null);
  const [gateDraft, setGateDraft] = useState<Partial<Record<keyof HeartbeatGates, string>>>({});
  const [gateBusy, setGateBusy] = useState(false);

  const load = () => Promise.all([
    api.hotTakeSources().then((r) => { setChannels(r.channels); setTopics(r.topics); }),
    api.hotTakeNotes().then(setNotes),
    // Gates live in the `heartbeat-priorities` note, not in code — read them so
    // the numbers on screen are the ones actually filtering the sweep.
    api.heartbeatGates().then(setGates),
  ]).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { load(); }, [bump]);

  // A cleared field is NOT dirty: saveGates skips empty values, so treating ''
  // as a change would show a Save that does nothing for that field.
  const gateDirty = !!gates && (Object.keys(gateDraft) as (keyof HeartbeatGates)[])
    .some((k) => {
      const v = gateDraft[k];
      return v !== undefined && v !== '' && Number(v) !== gates[k];
    });

  async function saveGates() {
    if (!gates) return;
    setGateBusy(true); setErr(null);
    try {
      const patch: Partial<HeartbeatGates> = {};
      for (const k of Object.keys(gateDraft) as (keyof HeartbeatGates)[]) {
        const v = gateDraft[k];
        if (v !== undefined && v !== '') patch[k] = Number(v);
      }
      setGates(await api.saveHeartbeatGates(patch));
      setGateDraft({});
    } catch (e) { setErr(e instanceof Error ? e.message : 'could not save gates'); }
    finally { setGateBusy(false); }
  }

  async function add() {
    if (!name.trim() || !urlOrQuery.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.writeHeartbeatSource(kind === 'rss'
        ? { kind, name: name.trim(), url: urlOrQuery.trim(), theme }
        : { kind, name: name.trim(), query: urlOrQuery.trim(), theme });
      setName(''); setUrlOrQuery(''); setShowAdd(false);
      await load(); refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : 'add failed'); }
    finally { setBusy(false); }
  }

  async function toggle(s: HotTakeSource) {
    await api.patchHeartbeatSource(String(s.id), { enabled: s.enabled ? 0 : 1 } as Partial<HotTakeSource>);
    await load();
  }
  async function remove(s: HotTakeSource) {
    if (!window.confirm(`Remove "${s.name}"? Ingested signals are kept; the source stops being watched.`)) return;
    await api.deleteHeartbeatSource(String(s.id));
    await load();
  }

  const NoteEditor = ({ slug, doc }: { slug: string; doc: KnowledgeDoc }) => {
    const v = noteDrafts[slug] !== undefined ? noteDrafts[slug] : (doc.body || '');
    const dirty = noteDrafts[slug] !== undefined && noteDrafts[slug] !== doc.body;
    return (
      <div className="panel rounded-sm p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-ink">{doc.title}</span>
          {dirty && (
            <Btn onClick={async () => {
              await api.hotTakeSaveNote(slug, doc.title, noteDrafts[slug]);
              setNoteDrafts((m) => { const n = { ...m }; delete n[slug]; return n; });
              await load();
            }}>Save</Btn>
          )}
        </div>
        <textarea value={v} onChange={(e) => setNoteDrafts((m) => ({ ...m, [slug]: e.target.value }))} rows={8}
          className="w-full mono text-xs px-3 py-2 rounded-sm bg-paper border border-line text-ink focus:outline-none focus:border-ink/40" />
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 space-y-6">
        <div className="flex items-center gap-2">
          <p className="text-sm text-mute flex-1">These sources feed Topics of the Day (shared with the hourly awareness sweep — edits change what the whole system monitors).</p>
          <Btn onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Cancel' : 'Add source'}</Btn>
        </div>

        {showAdd && (
          <div className="panel panel-pad rounded-sm space-y-2">
            <div className="flex items-center gap-1 hairline rounded-sm p-1 bg-card w-fit">
              {(['rss', 'gnews'] as const).map((k) => (
                <button key={k} onClick={() => setKind(k)}
                  className={'h-7 px-3 rounded-sm mono text-[10px] uppercase tracking-[0.14em] ' + (kind === k ? 'bg-ink text-paper' : 'text-mute hover:text-ink')}>
                  {k === 'rss' ? 'Active channel (RSS)' : 'Monitored topic (News)'}
                </button>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
                className="sm:w-56 h-9 px-3 rounded-sm bg-paper border border-line text-sm text-ink focus:outline-none focus:border-ink/40" />
              <input value={urlOrQuery} onChange={(e) => setUrlOrQuery(e.target.value)}
                placeholder={kind === 'rss' ? 'Feed URL (https://…/rss)' : 'What to follow (company, market, question…)'}
                className="flex-1 h-9 px-3 rounded-sm bg-paper border border-line text-sm text-ink focus:outline-none focus:border-ink/40" />
              <select value={theme} onChange={(e) => setTheme(e.target.value)}
                className="h-9 px-2 rounded-sm bg-paper border border-line text-sm text-ink focus:outline-none">
                {['general', 'models', 'ai-marketing', 'aeo', 'competitor', 'brand'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <Btn onClick={add} disabled={busy || !name.trim() || !urlOrQuery.trim()}>{busy ? 'Adding…' : 'Add'}</Btn>
            </div>
          </div>
        )}

        {err && <div className="text-xs text-rose-600">{err}</div>}

        {/* How we get the data — the OSINT listener engines, rendered from the
            same component the OSINT page uses. This is one shared control
            surface: a listener paused here is paused there too. */}
        <section>
          <SectionHead open={openHow} onToggle={() => setOpenHow((v) => !v)} label="How we get the data" tone="bg-stone-200 text-stone-700" />
          {openHow && (
            <div className="space-y-2">
              <p className="text-xs text-mute">
                The listener engines that scrape targets for mentions. They reach Hot Takes indirectly —
                their mentions flow into the Digest, which is one of the three inputs to Topics of the Day
                (alongside the feeds and queries below). Same controls as OSINT → Listeners; a change here changes both.
              </p>
              <OsintListeners />
            </div>
          )}
        </section>

        {/* Score gates — the thresholds each item must clear. Editable here
            because they decide what the sources below actually produce. */}
        {gates && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-semibold text-sm text-ink">Score gates</span>
              {gateDirty && <Btn onClick={saveGates} disabled={gateBusy}>{gateBusy ? 'Saving…' : 'Save'}</Btn>}
            </div>
            <div className="panel rounded-sm p-3 flex flex-wrap items-end gap-4">
              {([
                ['enrich_min_relevance', 'Enrich ≥', 'Relevance an item needs before we fetch the full article and re-score it.'],
                ['topics_min_content', 'Topics ≥', 'Content score an item needs to be clustered into a hot topic.'],
                ['digest_min_content', 'Digest ≥', 'Content score an item needs to reach the morning brief.'],
              ] as [keyof HeartbeatGates, string, string][]).map(([k, label, help]) => (
                <label key={k} className="flex flex-col gap-1" title={help}>
                  <span className="mono text-[10px] uppercase tracking-[0.14em] text-mute">{label}</span>
                  <input
                    type="number" min={0} max={100}
                    value={gateDraft[k] !== undefined ? gateDraft[k] : String(gates[k])}
                    onChange={(e) => setGateDraft((m) => ({ ...m, [k]: e.target.value }))}
                    className="w-20 h-8 px-2 rounded-sm bg-paper border border-line text-sm text-ink mono tabular-nums focus:outline-none focus:border-ink/40"
                  />
                </label>
              ))}
              <p className="text-xs text-mute flex-1 min-w-[16rem]">
                Stored in the editable <span className="mono">heartbeat-priorities</span> note, not in code —
                the sweep reads them live, so a change applies on the next run.
              </p>
            </div>
          </section>
        )}

        <section>
          <SectionHead open={openCh} onToggle={() => setOpenCh((v) => !v)} label="Monitored Websites" count={channels.length} tone="bg-sky-100 text-sky-800" />
          {openCh && (channels.length
            ? <MonitoredTable rows={channels} kind="rss" onToggle={toggle} onRemove={remove} />
            : <div className="text-sm text-mute px-1 py-2">No websites yet — add a publication or newsletter feed.</div>)}
        </section>

        <section>
          <SectionHead open={openTo} onToggle={() => setOpenTo((v) => !v)} label="Monitored Topics" count={topics.length} tone="bg-violet-100 text-violet-800" />
          {openTo && (topics.length
            ? <MonitoredTable rows={topics} kind="gnews" onToggle={toggle} onRemove={remove} />
            : <div className="text-sm text-mute px-1 py-2">No monitored topics yet — add a theme, company, or question to follow.</div>)}
        </section>

        <section>
          <SectionHead open={openLib} onToggle={() => setOpenLib((v) => !v)} label="Editorial Library" count={notes ? Object.keys(notes).length : 0} tone="bg-teal-100 text-teal-800" />
          {openLib && notes && (
            <div className="space-y-3">
              <p className="text-xs text-mute">Editable rules the drafter reads live — the Point-of-View Library keeps future articles consistent; patterns guide the brief; quality rules drive the review scan; timing sets the recommended schedule.</p>
              {Object.entries(notes).map(([, doc]) => (
                doc?.slug ? <NoteEditor key={doc.slug} slug={doc.slug} doc={doc} /> : null
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// What a source actually watches, in human terms.
//
// gnews sources are STORED as a built news.google.com/rss/search?q=… URL (see
// writeHeartbeatSource in lib/heartbeat.js), so showing `url` would show the
// machinery instead of the thing being followed. Pull the query back out; fall
// back to the raw URL if it will not parse.
function sourceTarget(s: HotTakeSource): string {
  if (s.kind === 'gnews') {
    try { return new URL(s.url).searchParams.get('q') || s.url; } catch { return s.url; }
  }
  try {
    const u = new URL(s.url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch { return s.url; }
}

// One condensed table of monitored sources — everything being watched, scannable
// in one pass. Top-level ON PURPOSE: defined inside SourcesTab it would remount
// on every parent render (same trap as the social-post row above).
function MonitoredTable({ rows, kind, onToggle, onRemove }: {
  rows: HotTakeSource[];
  kind: 'rss' | 'gnews';
  onToggle: (s: HotTakeSource) => void;
  onRemove: (s: HotTakeSource) => void;
}) {
  return (
    <div className="overflow-x-auto hairline rounded-sm bg-card/80">
      <ul className="min-w-[720px] divide-y divide-line">
        {/* Every column left-aligned, generous gaps — the rows need room to breathe. */}
        <li className="px-5 py-2.5 grid grid-cols-12 gap-4 mono text-[10px] uppercase tracking-[0.18em] text-mute border-b border-line">
          <span className="col-span-1">on</span>
          <span className="col-span-3">name</span>
          <span className="col-span-3">{kind === 'rss' ? 'feed url' : 'query'}</span>
          <span className="col-span-1">theme</span>
          <span className="col-span-2">14d · useful</span>
          <span className="col-span-1">last</span>
          <span className="col-span-1" />
        </li>
        {rows.map((s) => (
          <li key={s.id} className="px-5 py-3.5 grid grid-cols-12 gap-4 items-baseline text-[13px] hover:bg-card transition">
            <span className="col-span-1">
              <button
                onClick={() => onToggle(s)}
                aria-pressed={!!s.enabled}
                title={s.enabled ? 'Pause — stop watching this source' : 'Resume — start watching again'}
                className={'relative h-5 w-9 rounded-full transition ' + (s.enabled ? 'bg-ink' : 'bg-line')}
              >
                <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-paper transition ' + (s.enabled ? 'left-[18px]' : 'left-0.5')} />
              </button>
            </span>
            <span className="col-span-3 min-w-0">
              <span className="font-medium text-ink truncate block">{s.name}</span>
              {s.last_status === 'error' && (
                <span className="mono text-[9px] uppercase text-rose-600" title={s.last_error || ''}>fetch error</span>
              )}
            </span>
            <span className="col-span-3 min-w-0 mono text-[11px] text-mute truncate" title={sourceTarget(s)}>
              {sourceTarget(s)}
            </span>
            <span className="col-span-1 mono text-[10px] text-mute truncate">{s.theme || '—'}</span>
            <span
              className="col-span-2 mono text-[11px] tabular-nums"
              title={`${s.signals_14d} items in the last 14 days · ${s.useful_14d} scored write-worthy`}
            >
              {s.signals_14d}
              <span className="text-mute"> · </span>
              <span className={s.useful_14d > 0 ? 'text-emerald-700' : 'text-mute'}>{s.useful_14d}</span>
            </span>
            <span className="col-span-1 mono text-[10px] text-mute">
              {s.last_signal_at ? timeAgo(s.last_signal_at) : '—'}
            </span>
            <span className="col-span-1">
              <button onClick={() => onRemove(s)} className="text-mute hover:text-rose-600" title="Remove"><X size={14} /></button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
