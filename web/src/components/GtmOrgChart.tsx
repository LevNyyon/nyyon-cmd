// GtmOrgChart — boxed org-tree cards with connector lines, ported from the
// dedicated gtm app's OrgChart.jsx (gtm-blackbox/web/src/components/OrgChart.jsx).
// Renders the real theorg tree: people with parent_node_id hierarchy, photos,
// the prospect (matched by name) highlighted, and your warm contacts in green.
// Roots are anyone whose parent isn't in the fetched set — so orphaned subtrees
// still render instead of being dropped.

import { useState } from 'react';
import type { GtmOrgPerson } from '../lib/api';

// Only the three fields the chart actually reads, rather than a whole green
// lead: the cohort sheet draws this same tree for an enrolled prospect, which
// is not a GtmGreenLead. A GtmGreenLead still satisfies this structurally, so
// the GTM page passes one unchanged.
type OrgChartLead = {
  name: string | null;
  company: string | null;
  contacts?: { name: string; role: string }[];
};

type Node = {
  id: string;
  nodeId: string | null;
  parentId: string | null;
  name: string;
  role: string;
  photo: string | null;
  contact: boolean;
};

const initials = (name: string | null | undefined) =>
  String(name || '?').trim().split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

function Avatar({ photo, name }: { photo: string | null; name: string }) {
  const [err, setErr] = useState(false);
  return (
    <span className="ocx-av">
      {photo && !err ? <img src={photo} alt="" onError={() => setErr(true)} /> : <span className="ocx-ini">{initials(name)}</span>}
    </span>
  );
}

function TreeNode({ p, childrenOf, meName }: { p: Node; childrenOf: Record<string, Node[]>; meName: string | null }) {
  const kids = (p.nodeId && childrenOf[p.nodeId]) || [];
  const me = !!(meName && p.name && p.name.toLowerCase() === meName.toLowerCase());
  return (
    <div className="ocx-node">
      <div className={`ocx-card ${me ? 'me' : ''} ${p.contact ? 'contact' : ''}`}>
        <Avatar photo={p.photo} name={p.name} />
        <span className="ocx-name" title={p.name}>{p.name}</span>
        {p.role && <span className="ocx-title" title={p.role}>{p.role}</span>}
        {p.contact && <span className="ocx-contact">your contact</span>}
      </div>
      {kids.length > 0 && (
        <>
          <div className="ocx-down" />
          <div className="ocx-kids">
            {kids.map((k) => <TreeNode key={k.id} p={k} childrenOf={childrenOf} meName={meName} />)}
          </div>
        </>
      )}
    </div>
  );
}

export function GtmOrgChart({ people, lead, loading }: { people: GtmOrgPerson[] | null; lead: OrgChartLead; loading?: boolean }) {
  if (loading) return <div className="mono text-[10px] text-mute animate-pulse my-2">⟳ reading theorg…</div>;
  if (!people) return <div className="text-[11px] text-mute">Not loaded.</div>;
  if (!people.length) return <div className="text-[11px] text-mute">{lead.company ? `${lead.company} not found on theorg.` : 'No company.'}</div>;

  // Contacts come as {name, role} on the green lead; mark matching tree nodes
  // by case-insensitive name (the dedicated app gets this server-side).
  const contactNames = new Set((lead.contacts || []).map((c) => String(c.name || '').trim().toLowerCase()).filter(Boolean));
  const nodes: Node[] = people.map((p) => ({
    id: p.id,
    nodeId: p.node_id,
    parentId: p.parent_node_id,
    name: p.name || '',
    role: p.role || '',
    photo: p.photo_url,
    contact: !!(p.name && contactNames.has(p.name.trim().toLowerCase())),
  }));

  const ids = new Set(nodes.map((n) => n.nodeId).filter((x): x is string => !!x));
  const childrenOf: Record<string, Node[]> = {};
  const roots: Node[] = [];
  for (const n of nodes) {
    if (n.parentId && ids.has(n.parentId)) (childrenOf[n.parentId] = childrenOf[n.parentId] || []).push(n);
    else roots.push(n);
  }
  const contacts = nodes.filter((n) => n.contact);
  return (
    <>
      {contacts.length > 0 && (
        <div className="ocx-contacts-note">
          {contacts.length === 1 ? 'A contact of yours is here' : `${contacts.length} of your contacts are here`}: {contacts.map((n) => n.name).join(', ')}
        </div>
      )}
      <div className="ocx-scroll">
        <div className="ocx-tree">
          {roots.map((r) => <TreeNode key={r.id} p={r} childrenOf={childrenOf} meName={lead.name} />)}
        </div>
      </div>
    </>
  );
}
