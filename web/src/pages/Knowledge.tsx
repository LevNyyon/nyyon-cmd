// Knowledge — a tree. Left pane is the recursive doc tree; right pane is
// the active doc with a breadcrumb above so the operator (and Nyo) can
// trace the "context route" from root down to the leaf.
//
// Editing remains inline: title at the top, body in the textarea, both
// auto-save on type with a 600ms debounce. `parent_slug` is editable via
// a tiny picker under the title so a doc can be re-parented without
// hitting Nyo or the SQL prompt.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, KnowledgeDoc, KnowledgePathStep } from '../lib/api';

const COLLAPSED_KEY = 'nyyon.knowledge.collapsed.v2';
const ROOT_SLUG     = 'nyyon-root';

// ─── tree shape helpers ───────────────────────────────────────
type TreeNode = {
  doc: KnowledgeDoc;
  children: TreeNode[];
};

function buildTree(docs: KnowledgeDoc[]): { roots: TreeNode[]; orphans: TreeNode[] } {
  const bySlug = new Map<string, TreeNode>();
  for (const d of docs) bySlug.set(d.slug, { doc: d, children: [] });
  const roots: TreeNode[]   = [];
  const orphans: TreeNode[] = [];
  for (const node of bySlug.values()) {
    const p = node.doc.parent_slug;
    if (!p) {
      // Promote the well-known root explicitly; everything else with no
      // parent renders under "Unparented" so it''s visible but separated.
      if (node.doc.slug === ROOT_SLUG) roots.push(node);
      else orphans.push(node);
    } else {
      const parent = bySlug.get(p);
      if (parent) parent.children.push(node);
      else orphans.push(node); // parent referenced but doesn''t exist
    }
  }
  const byTitle = (a: TreeNode, b: TreeNode) => a.doc.title.localeCompare(b.doc.title);
  function sortRec(n: TreeNode) { n.children.sort(byTitle); n.children.forEach(sortRec); }
  roots.forEach(sortRec);
  orphans.sort(byTitle).forEach(sortRec);
  return { roots, orphans };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
      className={'text-mute transition-transform shrink-0 ' + (open ? 'rotate-90' : '')}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function TreeRow({
  node, depth, active, collapsed, onToggle, onSelect,
}: {
  node: TreeNode; depth: number; active: string | null;
  collapsed: Set<string>;
  onToggle: (slug: string) => void;
  onSelect: (slug: string) => void;
}) {
  const isActive   = node.doc.slug === active;
  const hasKids    = node.children.length > 0;
  const open       = !collapsed.has(node.doc.slug);
  const pad        = 8 + depth * 14;
  return (
    <>
      <div
        className={
          'group w-full flex items-center gap-1.5 cursor-pointer transition hover:bg-card/70 ' +
          (isActive ? 'bg-card shadow-[inset_0_0_0_1px_var(--color-line)]' : '')
        }
        style={{ paddingLeft: pad, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}
        onClick={() => onSelect(node.doc.slug)}
      >
        {hasKids ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(node.doc.slug); }}
            className="h-4 w-4 grid place-items-center shrink-0 hover:bg-card rounded-sm"
            aria-label={open ? 'collapse' : 'expand'}
          >
            <Chevron open={open} />
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{node.doc.title}</div>
          <div className="mono text-[10px] text-mute truncate">{node.doc.slug}</div>
        </div>
        {hasKids && (
          <span className="mono text-[10px] text-mute tabular-nums shrink-0 pl-1">
            {node.children.length}
          </span>
        )}
      </div>
      {open && node.children.map((child) => (
        <TreeRow
          key={child.doc.slug}
          node={child}
          depth={depth + 1}
          active={active}
          collapsed={collapsed}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function Knowledge() {
  const [docs, setDocs]     = useState<KnowledgeDoc[]>([]);
  const [active, setActive] = useState<string | null>(null);

  // Deep link: other surfaces (e.g. the Digest P-chip's "rules" link) hand a
  // slug over via sessionStorage (survives the page not being mounted yet)
  // and a live event (for when it already is). selectSlug loads the body;
  // the ref stops the mount-time root default from racing over the link.
  const deepLinked = useRef(false);
  useEffect(() => {
    const pending = sessionStorage.getItem('nyyon:open-doc');
    if (pending) { sessionStorage.removeItem('nyyon:open-doc'); deepLinked.current = true; selectSlug(pending); }
    const handler = (e: Event) => {
      const slug = (e as CustomEvent<{ slug?: string }>).detail?.slug;
      if (slug) { deepLinked.current = true; selectSlug(slug); }
    };
    window.addEventListener('nyyon:knowledge-open', handler);
    return () => window.removeEventListener('nyyon:knowledge-open', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [body, setBody]     = useState('');
  const [title, setTitle]   = useState('');
  const [parentSlug, setParentSlug] = useState<string | null>(null);
  const [path, setPath]     = useState<KnowledgePathStep[]>([]);
  const [saved, setSaved]   = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      if (raw) return new Set(JSON.parse(raw));
    } catch { /* ignore */ }
    return new Set();
  });
  const saveT = useRef<number | null>(null);

  const tree = useMemo(() => buildTree(docs), [docs]);
  const childrenOfActive = useMemo(() => {
    if (!active) return [] as KnowledgeDoc[];
    return docs
      .filter((d) => d.parent_slug === active)
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [docs, active]);

  function toggleNode(slug: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* quota */ }
      return next;
    });
  }
  function expandAll() {
    setCollapsed(new Set());
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([])); } catch { /* quota */ }
  }
  function collapseAll() {
    const all = new Set(docs.filter((d) => docs.some((c) => c.parent_slug === d.slug)).map((d) => d.slug));
    setCollapsed(all);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...all])); } catch { /* quota */ }
  }

  useEffect(() => {
    api.listKnowledge().then((d) => {
      setDocs(d);
      if (d.length && !active && !deepLinked.current) selectSlug(d.find((x) => x.slug === ROOT_SLUG)?.slug || d[0].slug);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectSlug(slug: string) {
    setActive(slug);
    const [doc, pth] = await Promise.all([api.readKnowledge(slug), api.readKnowledgePath(slug)]);
    setTitle(doc.title);
    setBody(doc.body);
    setParentSlug(doc.parent_slug);
    setPath(pth);
    setSaved('saved');
  }

  function onChange(next: string) {
    setBody(next);
    setSaved('dirty');
    if (saveT.current) window.clearTimeout(saveT.current);
    saveT.current = window.setTimeout(async () => {
      if (!active) return;
      setSaved('saving');
      const d = await api.writeKnowledge(active, { title, body: next, scope: 'global', parent_slug: parentSlug });
      setSaved('saved');
      setDocs((prev) => prev.map((x) => (x.slug === d.slug ? { ...x, title: d.title, updated_at: d.updated_at, parent_slug: d.parent_slug } : x)));
    }, 600);
  }

  async function onTitleBlur() {
    if (!active) return;
    setSaved('saving');
    const d = await api.writeKnowledge(active, { title, body, scope: 'global', parent_slug: parentSlug });
    setSaved('saved');
    setDocs((prev) => prev.map((x) => (x.slug === d.slug ? { ...x, title: d.title } : x)));
  }

  async function onReparent(nextParent: string | null) {
    if (!active) return;
    setParentSlug(nextParent);
    setSaved('saving');
    const d = await api.writeKnowledge(active, { title, body, scope: 'global', parent_slug: nextParent });
    setSaved('saved');
    setDocs((prev) => prev.map((x) => (x.slug === d.slug ? { ...x, parent_slug: d.parent_slug } : x)));
    setPath(await api.readKnowledgePath(active));
  }

  async function newDoc() {
    const slug = prompt('slug (lowercase-with-dashes)');
    if (!slug) return;
    const t = prompt('title') || slug;
    const d = await api.writeKnowledge(slug, { title: t, body: `# ${t}\n\n`, scope: 'global', parent_slug: active || ROOT_SLUG });
    setDocs(await api.listKnowledge());
    selectSlug(d.slug);
  }

  return (
    <div className="h-full flex flex-col lg:flex-row">
      <aside className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-line overflow-y-auto flex flex-col max-h-[45vh] lg:max-h-none">
        <div className="px-4 h-9 flex items-center justify-between border-b border-line shrink-0">
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-mute">Docs · {docs.length}</span>
          <div className="flex items-center gap-2">
            <button onClick={expandAll}   title="Expand all"   className="mono text-[9px] uppercase tracking-wider text-mute hover:text-ink">expand</button>
            <span className="text-line">|</span>
            <button onClick={collapseAll} title="Collapse all" className="mono text-[9px] uppercase tracking-wider text-mute hover:text-ink">collapse</button>
            <span className="text-line">|</span>
            <button onClick={newDoc} className="mono text-[10px] uppercase tracking-wider text-mute hover:text-ink">+ new</button>
          </div>
        </div>
        <div className="py-1">
          {tree.roots.map((n) => (
            <TreeRow
              key={n.doc.slug}
              node={n}
              depth={0}
              active={active}
              collapsed={collapsed}
              onToggle={toggleNode}
              onSelect={selectSlug}
            />
          ))}
          {tree.orphans.length > 0 && (
            <div className="mt-2 border-t border-line pt-2">
              <div className="px-3 mono text-[9px] uppercase tracking-[0.2em] text-mute mb-1">Unparented · {tree.orphans.length}</div>
              {tree.orphans.map((n) => (
                <TreeRow
                  key={n.doc.slug}
                  node={n}
                  depth={0}
                  active={active}
                  collapsed={collapsed}
                  onToggle={toggleNode}
                  onSelect={selectSlug}
                />
              ))}
            </div>
          )}
        </div>
        {docs.length === 0 && (
          <div className="p-4 text-mute text-sm">
            No docs yet. Click <span className="mono text-ink">+ new</span> or ask Nyo to seed a doc.
          </div>
        )}
      </aside>

      <section className="flex-1 flex flex-col min-w-0">
        {!active ? (
          <div className="m-auto text-mute text-sm">Pick a doc — or + new</div>
        ) : (
          <>
            {/* Breadcrumb — the "context route" from root down to the active doc. */}
            <div className="px-4 sm:px-6 pt-3 pb-2 border-b border-line flex flex-wrap items-center gap-1.5 text-[11px]">
              {path.length === 0 && <span className="text-mute italic">orphaned</span>}
              {path.map((step, i) => (
                <span key={step.slug} className="inline-flex items-center gap-1.5">
                  {i > 0 && <span className="text-mute/60">›</span>}
                  <button
                    onClick={() => selectSlug(step.slug)}
                    className={
                      'mono uppercase tracking-[0.18em] transition ' +
                      (step.slug === active ? 'text-ink font-medium' : 'text-mute hover:text-ink')
                    }
                  >
                    {step.title}
                  </button>
                </span>
              ))}
            </div>

            <div className="px-4 sm:px-6 h-9 flex items-center justify-between border-b border-line">
              <input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setSaved('dirty'); }}
                onBlur={onTitleBlur}
                className="font-semibold text-base bg-transparent focus:outline-none w-full"
              />
              <span className="mono text-[10px] uppercase tracking-wider text-mute shrink-0 pl-4">
                {saved === 'saving' ? '· saving' : saved === 'dirty' ? '· dirty' : '✓ saved'}
              </span>
            </div>

            {/* Parent picker — single-row select over every other doc.
                Lets the operator re-parent without leaving the page. */}
            <div className="px-4 sm:px-6 h-9 flex items-center gap-3 border-b border-line">
              <label className="mono text-[10px] uppercase tracking-[0.18em] text-mute shrink-0">parent</label>
              <select
                value={parentSlug ?? ''}
                onChange={(e) => onReparent(e.target.value || null)}
                className="h-7 px-2 rounded-sm hairline bg-paper text-ink text-[12px] focus:border-ink focus:outline-none flex-1 min-w-0 max-w-md"
              >
                <option value="">(no parent — root level)</option>
                {docs
                  .filter((d) => d.slug !== active)
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .map((d) => (
                    <option key={d.slug} value={d.slug}>{d.title} · {d.slug}</option>
                  ))}
              </select>
            </div>

            <textarea
              value={body}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              className="flex-1 mono p-4 sm:p-6 text-[13px] leading-relaxed bg-card/60 resize-none focus:outline-none"
            />

            {/* Children-of-this-doc tile. Renders only when the doc has
                children — gives the operator (and any LLM reading) the next
                set of branches inside this context. */}
            {childrenOfActive.length > 0 && (
              <div className="border-t border-line bg-paper/60 px-4 sm:px-6 py-3 shrink-0">
                <div className="mono text-[10px] uppercase tracking-[0.18em] text-mute mb-2">
                  Within this branch · {childrenOfActive.length}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {childrenOfActive.map((d) => (
                    <button
                      key={d.slug}
                      onClick={() => selectSlug(d.slug)}
                      className="h-7 px-3 rounded-sm hairline text-[11px] hover:bg-card transition"
                    >
                      {d.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
