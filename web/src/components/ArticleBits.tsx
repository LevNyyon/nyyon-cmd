// Shared article UI — the pieces of the blog experience used by BOTH the Blog
// page and the Hot Takes Publications tab (one implementation, no forks):
// dev-asset URL rewriting, date/number formatting, the cover thumbnail, tag
// chips, KV meta rows, sortable column headers, and the in-place article editor.
// Extracted verbatim from pages/Blog.tsx.

import { useEffect, useRef, useState } from 'react';
import { api, type BlogPostWithTags } from '../lib/api';

// In --local dev the public r2.dev image URLs 404 (figure/cover PNGs live in the
// local R2 sim). Point them at the local worker's /assets route so drafts preview
// WITH their images. Prod (import.meta.env.DEV false) keeps the public URLs, and
// the stored body is never rewritten — this is display-only.
export const DEV_ASSET_BASE = 'http://localhost:8788/assets';
export const devUrl = (url: string | null | undefined): string =>
  !url ? '' : (import.meta.env.DEV ? url.replace(/https?:\/\/[^/]+\.r2\.dev/, DEV_ASSET_BASE) : url);
export const devHtml = (html: string): string =>
  import.meta.env.DEV ? html.replace(/https?:\/\/[^/"'\s]+\.r2\.dev/g, DEV_ASSET_BASE) : html;

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(ts);
}

export function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function Thumb({ post }: { post: BlogPostWithTags }) {
  return post.featured_image_url ? (
    <img
      src={`${devUrl(post.featured_image_url)}?t=${post.featured_image_generated_at ?? 0}`}
      alt=""
      loading="lazy"
      className="h-10 w-[60px] object-cover rounded-sm hairline bg-paper shrink-0"
    />
  ) : (
    <div className="h-10 w-[60px] rounded-sm hairline bg-paper shrink-0 grid place-items-center mono text-[8px] uppercase tracking-[0.18em] text-mute">no img</div>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  return (
    <>
      {tags.length === 0 && <span className="mono text-[10px] text-mute">—</span>}
      {tags.slice(0, 3).map((t) => (
        <span key={t} className="mono text-[9px] uppercase tracking-[0.12em] bg-paper hairline px-1.5 py-0.5 rounded-sm text-mute">{t}</span>
      ))}
      {tags.length > 3 && <span className="mono text-[9px] text-mute">+{tags.length - 3}</span>}
    </>
  );
}

export function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0 min-w-[80px]">{k}</span>
      <span className="mono text-[11px] text-ink">{v}</span>
    </div>
  );
}

export function ColHeader<K extends string>({
  k, label, sortKey, dir, onClick, className,
}: {
  k: K;
  label: string;
  sortKey: K;
  dir: 'asc' | 'desc';
  onClick: (k: K) => void;
  className?: string;
}) {
  const active = k === sortKey;
  return (
    <button
      onClick={() => onClick(k)}
      className={(className || '') + ' text-left flex items-center gap-1 hover:text-ink transition ' + (active ? 'text-ink' : '')}
    >
      <span className={className?.includes('text-right') ? 'ml-auto' : ''}>{label}</span>
      <span className="text-[8px] opacity-70">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
    </button>
  );
}

// ── Inline article editor ───────────────────────────────────────────
// Renders the draft the way it goes live (tags, H1, excerpt, cover, body) and
// lets you edit in place: click any text and type, Enter makes new paragraphs,
// edits autosave (debounced) preserving the draft's published state. The body is
// ONE contentEditable region set imperatively once, so React never re-renders it
// out from under the caret (that was the "stops after one edit" bug). Figures are
// non-editable islands so they can't be mangled.
// fullHeight: fill the parent (the full-screen editor popup) instead of the
// bounded in-page panel the Blog page embeds.
// flow: natural height, no inner scroll — for a popup that scrolls as ONE
// column (article + schedule + social) instead of nesting scroll areas.
// figureControls: decorate each in-article chart with change/delete controls.
// The controls are injected as [data-figui] non-editable DOM (this component
// never lets React into the body), and stripped again in currentBody() so no
// editor furniture ever reaches the stored article.
export function InlineBodyEditor({ post, fullHeight = false, flow = false, figureControls = false }: {
  post: BlogPostWithTags; fullHeight?: boolean; flow?: boolean; figureControls?: boolean;
}) {
  // Public asset base (e.g. https://pub-xxx.r2.dev) captured from the body, so we
  // can show images via the local worker in dev and restore public URLs on save.
  const pubBase    = useRef<string | null>((post.body || '').match(/https?:\/\/[^/"']+\.r2\.dev/)?.[0] || null);
  // Title/excerpt are UNCONTROLLED (defaultValue + ref). A controlled input would
  // let React overwrite the value on every render, which wipes the browser's
  // native undo stack — so Cmd+Z / Cmd+Shift+Z would break. Uncontrolled keeps
  // native undo/redo working in all three fields (title, excerpt, body).
  const titleRef   = useRef(post.title);
  const excerptRef = useRef(post.excerpt || '');
  const bodyRef    = useRef<HTMLDivElement>(null);
  // Element refs for the H1 + excerpt so both AUTO-GROW to their content — the
  // whole title and standfirst always visible, never an inline scroller.
  const titleEl    = useRef<HTMLTextAreaElement>(null);
  const excerptEl  = useRef<HTMLTextAreaElement>(null);
  // Mirror of the body HTML, kept fresh on every input — the unmount flush
  // saves from THIS, because by the time passive cleanup runs the DOM ref may
  // already be detached.
  const lastHtml   = useRef('');
  const alive      = useRef(true);
  const timer      = useRef<number | null>(null);
  // Autosave hold while a chart regenerates server-side — without it, a
  // keystroke's debounced save (still carrying the OLD chart) could land after
  // the server swapped in the new one and silently revert it.
  const suspendSave = useRef(false);
  const [status, setStatus]   = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [figDialog, setFigDialog] = useState<{ mode: 'delete' | 'change'; el: HTMLElement; src: string } | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [figErr, setFigErr] = useState<string | null>(null);

  // Give each in-article chart its control bar (change ⟳ · delete ✕) — plain
  // DOM, non-editable, marked [data-figui] so currentBody() strips it before
  // anything is stored. Only blog-figures images get controls; already-decorated
  // figures are skipped so this is safe to re-run after a swap.
  function decorateFigures(root: HTMLElement | null) {
    if (!root || !figureControls) return;
    root.querySelectorAll('figure').forEach((figNode) => {
      const fig = figNode as HTMLElement;
      const src = fig.querySelector('img')?.getAttribute('src') || '';
      if (!src.includes('blog-figures/')) return;
      if (fig.querySelector(':scope > [data-figui]')) return;
      const bar = document.createElement('div');
      bar.setAttribute('data-figui', '1');
      bar.setAttribute('contenteditable', 'false');
      bar.className = 'flex items-center justify-end gap-1.5 mb-1.5';
      const mk = (label: string, hover: string) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.className = 'mono text-[10px] uppercase tracking-[0.14em] px-2.5 h-7 rounded-sm hairline bg-card text-mute transition ' + hover;
        return b;
      };
      const change = mk('⟳ change', 'hover:text-ink');
      const del = mk('✕ delete', 'hover:text-rose-600');
      change.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const liveSrc = fig.querySelector('img')?.getAttribute('src') || src;
        setFigDialog({ mode: 'change', el: fig, src: liveSrc });
      });
      del.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        setFigDialog({ mode: 'delete', el: fig, src });
      });
      bar.append(change, del);
      fig.insertBefore(bar, fig.firstChild);
    });
  }

  // Fill the body ONCE (dev-rewritten so images load), then never let React touch
  // it again. Mark figures/media as non-editable islands.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = devHtml(post.body || '');
    el.querySelectorAll('figure, img, script, iframe, table').forEach((n) => n.setAttribute('contenteditable', 'false'));
    decorateFigures(el);
    lastHtml.current = el.innerHTML;
    const onInput = () => { lastHtml.current = el.innerHTML; schedule(); };
    // Undo/redo inside the body, driven off the browser's own edit history via
    // execCommand (verified to work), so it doesn't depend on the default key
    // routing. preventDefault avoids a double-undo. Cmd/Ctrl+Z = undo,
    // Cmd/Ctrl+Shift+Z or Ctrl+Y = redo. The input event execCommand fires then
    // autosaves the result. Textareas keep their own native undo (uncontrolled).
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); document.execCommand(e.shiftKey ? 'redo' : 'undo'); }
      else if (k === 'y') { e.preventDefault(); document.execCommand('redo'); }
    };
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Auto-size a textarea to its content (title + excerpt use this). Guard the
  // hidden-container case: scrollHeight is 0 while a css-hidden ancestor hides
  // the editor (the popup's page switch), and writing '0px' would squash the
  // field — leave the default height and re-grow on focus instead.
  function grow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    if (h > 0) el.style.height = `${h}px`;
  }
  useEffect(() => { grow(titleEl.current); grow(excerptEl.current); }, []);

  // Flush a pending debounce on unmount — closing the editor inside the save
  // window must not lose the last keystrokes.
  useEffect(() => () => {
    alive.current = false;
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; void save(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function currentBody(): string {
    const tmp = document.createElement('div');
    tmp.innerHTML = bodyRef.current ? bodyRef.current.innerHTML : lastHtml.current;
    tmp.querySelectorAll('[data-figui]').forEach((n) => n.remove());                                 // strip chart controls — editor furniture, never stored
    tmp.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable')); // drop editing islands
    let html = tmp.innerHTML;
    if (import.meta.env.DEV && pubBase.current) html = html.split(DEV_ASSET_BASE).join(pubBase.current); // restore public image URLs
    return html;
  }
  async function save() {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (alive.current) setStatus('saving');
    try {
      await api.updateBlogPost(post.slug, {
        title: titleRef.current.trim() || post.title,
        excerpt: excerptRef.current.trim() || null,
        body: currentBody(),
        tags: post.tags,                 // preserve
        published: post.published,       // keep the draft a draft
        published_at: post.published_at, // preserve
      });
      if (alive.current) { setStatus('saved'); setSavedAt(Date.now()); }
    } catch { if (alive.current) setStatus('error'); }
  }
  function schedule() {
    if (suspendSave.current) return; // a chart regenerate is in flight — keystrokes stay in the DOM, flushed after
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, 900);
  }

  // ── chart actions (figureControls) ────────────────────────────────
  function deleteFigure(d: { el: HTMLElement }) {
    d.el.remove();
    if (bodyRef.current) lastHtml.current = bodyRef.current.innerHTML;
    setFigDialog(null);
    void save();
  }

  async function regenerateFigure(d: { el: HTMLElement; src: string }, instructions: string | null) {
    setFigDialog(null);
    setFigErr(null);
    setRegenBusy(true);
    suspendSave.current = true;
    d.el.classList.add('opacity-40', 'pointer-events-none');
    try {
      await save(); // flush the operator's latest text FIRST, so the server drafts against it
      const r = await api.regenerateBlogFigure(post.slug, { src: d.src, instructions });
      if (r.error || !r.figure_html) throw new Error(r.error || 'regenerate failed');
      const tmp = document.createElement('div');
      tmp.innerHTML = devHtml(r.figure_html);
      const fresh = tmp.firstElementChild as HTMLElement | null;
      if (fresh && d.el.parentNode) {
        d.el.parentNode.replaceChild(fresh, d.el);
        fresh.setAttribute('contenteditable', 'false');
        fresh.querySelectorAll('img').forEach((n) => n.setAttribute('contenteditable', 'false'));
        decorateFigures(bodyRef.current);
      }
      if (bodyRef.current) lastHtml.current = bodyRef.current.innerHTML;
    } catch (e) {
      setFigErr(e instanceof Error ? e.message : 'chart regenerate failed');
      d.el.classList.remove('opacity-40', 'pointer-events-none');
    } finally {
      suspendSave.current = false;
      setRegenBusy(false);
    }
    void save(); // persist merged text + the new chart
  }

  const statusLabel =
    regenBusy ? 'regenerating chart…'
    : status === 'saving' ? 'saving…'
    : status === 'error' ? 'save failed — keep editing to retry'
    : savedAt ? `saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'click any text to edit · autosaves';

  const editableField = 'focus:outline-none focus:bg-amber-50 dark:focus:bg-amber-500/10 rounded transition ';

  return (
    <div className={fullHeight ? 'h-full flex flex-col' : ''}>
      <div className={'mb-1.5 mono text-[10px] uppercase tracking-[0.2em] ' + (fullHeight || flow ? 'px-4 sm:px-2 pt-2 shrink-0 ' : '') + (status === 'error' ? 'text-rose-600' : 'text-mute')}>{statusLabel}</div>
      {figErr && <div className={'mb-1.5 text-xs text-rose-600 ' + (fullHeight || flow ? 'px-4 sm:px-2' : '')}>{figErr}</div>}
      <div className={
        fullHeight ? 'flex-1 min-h-0 bg-paper overflow-y-auto py-6 sm:py-8'
        : flow ? 'bg-paper py-4 sm:py-6'
        : 'hairline rounded-sm bg-paper max-h-[720px] overflow-y-auto py-8'
      }>
        {/* Reads like the live nyyon.com article: tags, H1, excerpt, cover, body. */}
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          {post.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {post.tags.map((t) => <span key={t} className="mono text-[10px] uppercase tracking-[0.14em] bg-card hairline px-2 py-1 rounded-sm text-mute">{t}</span>)}
            </div>
          )}
          {/* H1 title — editable (uncontrolled, keeps native undo), auto-grows */}
          <textarea
            ref={titleEl}
            defaultValue={post.title}
            onChange={(e) => { titleRef.current = e.target.value; grow(e.currentTarget); schedule(); }}
            onFocus={(e) => grow(e.currentTarget)}
            rows={1}
            spellCheck
            className={'w-full resize-none overflow-hidden bg-transparent text-3xl md:text-4xl font-semibold tracking-tight leading-[1.15] px-1.5 -mx-1.5 ' + editableField}
          />
          {/* excerpt / standfirst — editable (uncontrolled, keeps native undo), auto-grows */}
          <textarea
            ref={excerptEl}
            defaultValue={post.excerpt || ''}
            onChange={(e) => { excerptRef.current = e.target.value; grow(e.currentTarget); schedule(); }}
            onFocus={(e) => grow(e.currentTarget)}
            placeholder="excerpt / standfirst"
            rows={1}
            className={'w-full mt-4 resize-none overflow-hidden bg-transparent text-lg text-mute leading-relaxed px-1.5 -mx-1.5 placeholder:text-mute/50 ' + editableField}
          />
          {/* featured image — as it shows live */}
          {post.featured_image_url && (
            <figure className="mt-8 hairline rounded-sm overflow-hidden bg-paper aspect-[16/9]">
              <img src={`${devUrl(post.featured_image_url)}?t=${post.featured_image_generated_at ?? 0}`} alt="" className="w-full h-full object-cover" />
            </figure>
          )}
          {/* body — one editable article surface. Enter = new paragraph. Set once,
              never re-rendered by React (keeps the caret; fixes edit-stops-after-one). */}
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck
            className={
              'mt-8 text-[16px] leading-[1.8] text-ink focus:outline-none caret-ink ' +
              '[&_h2]:text-[24px] [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:mt-8 [&_h2]:mb-2 [&_h3]:text-[18px] [&_h3]:font-semibold [&_h3]:mt-5 [&_h3]:mb-1 [&_p]:mb-4 ' +
              '[&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-4 [&_li]:mb-1 [&_a]:underline ' +
              '[&_figure]:my-8 [&_figure]:text-center [&_img]:mx-auto [&_img]:max-w-full [&_img]:rounded-md [&_figcaption]:text-[12px] [&_figcaption]:text-mute [&_figcaption]:mt-2 ' +
              '[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-mute [&_[contenteditable=false]]:cursor-default'
            }
          />
        </div>
      </div>

      {/* chart safety popups — rendered above the full-screen editor (z-50) */}
      {figDialog?.mode === 'delete' && (
        <FigDeleteDialog
          onConfirm={() => deleteFigure(figDialog)}
          onCancel={() => setFigDialog(null)}
        />
      )}
      {figDialog?.mode === 'change' && (
        <FigChangeDialog
          busy={regenBusy}
          onRegenerate={(instructions) => regenerateFigure(figDialog, instructions)}
          onCancel={() => setFigDialog(null)}
        />
      )}
    </div>
  );
}

// ── chart popups ────────────────────────────────────────────────────
// Top-level ON PURPOSE: the change dialog holds a textarea — defined inside
// InlineBodyEditor it would remount on every parent render and drop focus
// after one keystroke.
function FigDeleteDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] bg-black/30 grid place-items-center p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-sm hairline bg-paper p-4 space-y-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-ink">Delete this chart?</div>
        <p className="text-[11px] text-mute leading-relaxed">
          The chart is removed from the article and the change autosaves. This can't be undone.
        </p>
        <div className="flex gap-2">
          <button onClick={onConfirm} className="flex-1 h-9 rounded-sm bg-rose-600 text-white text-xs font-medium hover:opacity-90 transition">Delete</button>
          <button onClick={onCancel} className="flex-1 h-9 rounded-sm border border-line text-xs text-mute hover:text-ink transition">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function FigChangeDialog({ busy, onRegenerate, onCancel }: {
  busy: boolean;
  onRegenerate: (instructions: string | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="fixed inset-0 z-[70] bg-black/30 grid place-items-center p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-sm hairline bg-paper p-4 space-y-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-ink">Change this chart</div>
        <p className="text-[11px] text-mute leading-relaxed">
          A new chart is designed from the article text around this spot and replaces the current one.
        </p>
        <button
          onClick={() => onRegenerate(null)}
          disabled={busy}
          className="w-full h-9 rounded-sm bg-ink text-paper text-xs font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          Regenerate
        </button>
        <div className="text-center mono text-[10px] uppercase tracking-[0.18em] text-mute">Or</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="insert specific instructions"
          rows={3}
          className="w-full text-xs px-3 py-2 rounded-sm bg-paper border border-line text-ink placeholder:text-mute/60 focus:outline-none focus:border-ink/40 resize-none"
        />
        {text.trim() !== '' && (
          <button
            onClick={() => onRegenerate(text.trim())}
            disabled={busy}
            className="w-full h-9 rounded-sm bg-ink text-paper text-xs font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            Regenerate with instructions
          </button>
        )}
        <button onClick={onCancel} disabled={busy} className="w-full h-8 rounded-sm border border-line text-xs text-mute hover:text-ink transition">Cancel</button>
      </div>
    </div>
  );
}
