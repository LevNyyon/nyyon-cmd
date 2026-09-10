// Editorial-diagram templates for in-article figures — pure SVG builders, no
// worker-only imports (fonts/wasm/R2 live in article-figures.js) so this file
// can be unit-rendered in Node to verify layout before it ships.
//
// Same brand system as social-cards.js: strict paper/ink monochrome, Inter for
// prose labels, JetBrains Mono for caps labels/FIG markers. Canvas is 1200x675
// (16:9) — the size the hand-drawn figures were approved at.
//
// Six archetypes, each parametric, each reducible from the approved figures:
//   layers    stacked planes/bands with chips + optional cross arrows  (build/operate split, agent stack)
//   contrast  left-vs-right split: a chain or a hub on each side       (chain-vs-callable, map-vs-conversation)
//   cycle     center node + ring of nodes wired in a loop              (event→context→angle→message→learn)
//   fanout    one source → a row of targets (+ optional outcome row)   (one event→many states, one agent→many callers)
//   columns   N captioned columns, each a header + bullet list         (workload routing)
//   grid      2x2 control-room panels, each a header bar + rows        (lifecycle control room)
//
// Each template: { width, height, slots: <LLM description>, build(slots) }.

import { CHART_TEMPLATES } from './article-figures-charts.js';

const PAPER  = '#FAFAF9';
const INK    = '#0A0A0A';
const MUTE   = '#78716C';
const LINE   = '#E7E5E4';
const CARDHI = '#F5F5F4';
// The one accent. Used sparingly as a SIGNAL: the FIG. mark, primary arrowheads,
// and the single focal "point" element of each diagram (the goal, the source,
// the winning quadrant, the apex). Swap this one token to re-theme everything.
// Cool blue-violet, matching the nyyonai brand purple.
const ACCENT = '#6C5CE7';
// A faint accent wash for fills behind focal elements (≈8% accent on paper).
const ACCENT_WASH = '#ECE9FD';

const SANS = 'Inter';
const MONO = 'JetBrains Mono';

const W = 1200, H = 675;

// ─── helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Shrink type that would overflow a width. Mono is fixed ~0.6em, Inter ~0.55em.
// `ls` (letter-spacing px/char) is added in — it's flat per character regardless
// of font size, so leaving it out under-counts wide tracked-out caps labels.
function fit(text, maxWidth, baseSize, { mono = false, min = 0.6, ls = 0 } = {}) {
  const factor = mono ? 0.62 : 0.55;
  const n = String(text).length;
  let size = baseSize;
  const floor = Math.max(9, Math.round(baseSize * min));
  while (size > floor && n * size * factor + Math.max(0, n - 1) * ls > maxWidth) size -= 1;
  return size;
}

// Approx rendered width of a caps mono label including letter-spacing.
function monoWidth(text, size, ls = 0) {
  const n = String(text).length;
  return n * size * 0.62 + Math.max(0, n - 1) * ls;
}

function svgOpen() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>`,
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${LINE}" stroke-width="2"/>`,
  ];
}

function figLabel(label) {
  const t = String(label || 'FIGURE').toUpperCase();
  // The "FIG." mark carries the accent — the brand signature on every figure.
  return `<text x="48" y="62" font-family="${MONO}" font-weight="700" font-size="19" letter-spacing="2.5" fill="${ACCENT}">FIG.</text>`
       + `<text x="112" y="62" font-family="${MONO}" font-weight="500" font-size="19" letter-spacing="2.5" fill="${MUTE}">${esc(t)}</text>`;
}

function caption(text) {
  if (!text) return '';
  const t = String(text).toUpperCase();
  const size = fit(t, W - 120, 16, { mono: true });
  return `<text x="${W / 2}" y="640" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="${size}" letter-spacing="1.8" fill="${MUTE}">${esc(t)}</text>`;
}

function rect(x, y, w, h, fill, stroke = null, sw = 2) {
  const s = stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${s}/>`;
}

function label(x, y, t, { size = 18, fill = INK, font = SANS, weight = 600, anchor = 'middle', ls = null, mono = false } = {}) {
  const f = mono ? MONO : font;
  const lsa = ls != null ? ` letter-spacing="${ls}"` : '';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${f}" font-weight="${weight}" font-size="${size}"${lsa} fill="${fill}">${esc(t)}</text>`;
}

// Centered caps label inside a box, auto-shrunk to the box width.
function boxLabel(cx, cy, boxW, t, { fill = INK, size = 16, ls = 1.5 } = {}) {
  const txt = String(t).toUpperCase();
  const s = fit(txt, boxW - 20, size, { mono: true, ls });
  return label(cx, cy + s * 0.34, txt, { size: s, fill, mono: true, weight: 700, ls, anchor: 'middle' });
}

function arrow(x1, y1, x2, y2, { color = INK, sw = 2.4, dash = null, head = null } = {}) {
  const ang = Math.atan2(y2 - y1, x2 - x1), hl = 11;
  const bx = x2 - hl * Math.cos(ang), by = y2 - hl * Math.sin(ang);
  const p1x = bx + 6 * Math.sin(ang), p1y = by - 6 * Math.cos(ang);
  const p2x = bx - 6 * Math.sin(ang), p2y = by + 6 * Math.cos(ang);
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  // Primary (ink) arrows get an ACCENT head — motion reads in the accent.
  // Secondary/muted arrows keep their own colour. Override with `head`.
  const headColor = head || (color === INK ? ACCENT : color);
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${color}" stroke-width="${sw}"${d}/>`
       + `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${p1x.toFixed(1)},${p1y.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)}" fill="${headColor}"/>`;
}

// Arrow between two box centers that stops at each box's border (+pad). Boxes
// given as {cx,cy,hw,hh}. Prevents the corner-piercing the first pass had.
function arrowBetween(a, b, { pad = 8, color = INK, sw = 2.4, dash = null } = {}) {
  const vx = b.cx - a.cx, vy = b.cy - a.cy, L = Math.hypot(vx, vy) || 1;
  const ux = vx / L, uy = vy / L;
  const tOut = 1 / Math.max(Math.abs(ux) / a.hw, Math.abs(uy) / a.hh) + pad;
  const tIn  = 1 / Math.max(Math.abs(ux) / b.hw, Math.abs(uy) / b.hh) + pad;
  return arrow(a.cx + ux * tOut, a.cy + uy * tOut, b.cx - ux * tIn, b.cy - uy * tIn, { color, sw, dash });
}

// ─── templates ────────────────────────────────────────────────────────────────
export const FIGURE_TEMPLATES = {
  // ── stacked planes ──────────────────────────────────────────────────────────
  layers: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), layers (array of 2-3 objects, top to bottom, each { band_label (<=40 chars caps), items (array of 2-5 short CAPS chips <=14 chars each), dark (bool — true paints the band solid ink) }), boundary_label (optional <=22 chars caps — a dashed trust/handoff line drawn after the first band), caption (optional <=72 chars)',
    build(slots) {
      const layers = (slots.layers || []).slice(0, 3);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const top = 100, bottom = slots.caption ? 600 : 622;
      const n = layers.length || 1;
      const bandGap = slots.boundary_label ? 54 : 40;
      const bandH = Math.min(190, Math.floor((bottom - top - (n - 1) * bandGap) / n));
      let y = top;
      layers.forEach((lyr, li) => {
        const dark = !!lyr.dark;
        p.push(rect(80, y, W - 160, bandH, dark ? INK : PAPER, INK, 2.5));
        p.push(label(104, y + 34, String(lyr.band_label || '').toUpperCase(),
          { size: fit(String(lyr.band_label || ''), W - 260, 18, { mono: true }), fill: dark ? PAPER : INK, mono: true, weight: 700, ls: 2.5, anchor: 'start' }));
        const items = (lyr.items || []).slice(0, 5);
        if (items.length) {
          const innerW = W - 160 - 120;
          const cw = Math.min(210, Math.floor((innerW - (items.length - 1) * 16) / items.length));
          const chipY = y + bandH - 62;
          let cx = 140;
          items.forEach((it) => {
            p.push(rect(cx, chipY, cw, 50, dark ? INK : CARDHI, dark ? PAPER : INK, 2));
            p.push(boxLabel(cx + cw / 2, chipY + 25, cw, it, { fill: dark ? PAPER : INK, size: 16, ls: 1 }));
            cx += cw + 16;
          });
        }
        y += bandH;
        // dashed boundary + cross arrows after the first band only
        if (li === 0 && layers.length > 1) {
          const midGapY = y + bandGap / 2;
          if (slots.boundary_label) {
            p.push(`<line x1="80" y1="${midGapY}" x2="${W - 80}" y2="${midGapY}" stroke="${INK}" stroke-width="2" stroke-dasharray="10 8"/>`);
            p.push(label(W - 84, midGapY - 10, String(slots.boundary_label).toUpperCase(),
              { size: 14, fill: ACCENT, mono: true, weight: 700, ls: 2, anchor: 'end' }));
          }
          // a down arrow (rules ship down) on the left, an up arrow (escalate) on the right
          p.push(arrow(300, y + 4, 300, y + bandGap - 4));
          p.push(arrow(W - 300, y + bandGap - 4, W - 300, y + 4));
        }
        y += bandGap;
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── left-vs-right contrast ───────────────────────────────────────────────────
  contrast: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), left & right (each { heading (<=34 chars caps), mode ("chain" = a vertical stack of step boxes, or "hub" = a center label ringed by nodes), nodes (array of short CAPS labels <=14 chars — 2-4 for chain, 3-6 for hub), center (<=10 chars caps, only for hub mode), note (optional <=40 chars caps, small print under the side) }), caption (optional <=72 chars)',
    build(slots) {
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      p.push(`<line x1="${W / 2}" y1="106" x2="${W / 2}" y2="600" stroke="${INK}" stroke-width="2.5"/>`);
      const sides = [['left', slots.left, W * 0.25], ['right', slots.right, W * 0.75]];
      sides.forEach(([, side, cx]) => {
        if (!side) return;
        p.push(label(cx, 128, String(side.heading || '').toUpperCase(),
          { size: fit(String(side.heading || ''), W / 2 - 70, 16, { mono: true }), fill: INK, mono: true, weight: 700, ls: 2, anchor: 'middle' }));
        const nodes = (side.nodes || []).slice(0, side.mode === 'hub' ? 6 : 4);
        let sideBottomY = 560;  // y to drop the side note below, per layout
        if (side.mode === 'hub') {
          const cy = 360, r = 150;
          nodes.forEach((nLabel, i) => {
            const a = (-90 + i * (360 / Math.max(nodes.length, 1))) * Math.PI / 180;
            const nx = cx + r * Math.cos(a), ny = cy + r * Math.sin(a);
            p.push(rect(nx - 70, ny - 25, 140, 50, PAPER, INK, 2.5));
            p.push(boxLabel(nx, ny, 140, nLabel, { fill: INK, size: 14, ls: 1 }));
          });
          p.push(`<circle cx="${cx}" cy="${cy}" r="58" fill="${ACCENT}"/>`);
          p.push(boxLabel(cx, cy, 110, String(side.center || 'CORE'), { fill: PAPER, size: 16, ls: 1.5 }));
          nodes.forEach((_, i) => {
            const a = (-90 + i * (360 / Math.max(nodes.length, 1))) * Math.PI / 180;
            const nx = cx + r * Math.cos(a), ny = cy + r * Math.sin(a);
            p.push(arrowBetween({ cx, cy, hw: 58, hh: 58 }, { cx: nx, cy: ny, hw: 70, hh: 25 }, { color: MUTE, sw: 2, dash: '4 5', pad: 6 }));
          });
        } else {
          // chain: entry dot → boxes → exit dot, vertical. Tighten box/gap for
          // 4 nodes so the chain + exit dot stay clear of the side note.
          const bw = 230;
          const many = nodes.length >= 4;
          const bh = many ? 50 : 58;
          const gap = many ? 30 : 38;
          const total = nodes.length * bh + (nodes.length + 1) * gap;
          let y = Math.max(165, 360 - total / 2) + gap;
          p.push(`<circle cx="${cx}" cy="${y - gap + 6}" r="7" fill="${INK}"/>`);
          nodes.forEach((nLabel, i) => {
            if (i === 0) p.push(arrow(cx, y - gap + 14, cx, y - 4));
            p.push(rect(cx - bw / 2, y, bw, bh, INK));
            p.push(boxLabel(cx, y + bh / 2, bw, nLabel, { fill: PAPER, size: 16, ls: 1.5 }));
            y += bh;
            if (i < nodes.length - 1) { p.push(arrow(cx, y + 4, cx, y + gap - 4)); y += gap; }
          });
          p.push(arrow(cx, y + 4, cx, y + gap - 4));
          const exitDotY = y + gap + 6;
          p.push(`<circle cx="${cx}" cy="${exitDotY}" r="7" fill="${INK}"/>`);
          sideBottomY = exitDotY + 28;
        }
        if (side.note) {
          p.push(label(cx, Math.min(608, sideBottomY), String(side.note).toUpperCase(),
            { size: fit(String(side.note), W / 2 - 70, 14, { mono: true, ls: 1.2 }), fill: MUTE, mono: true, weight: 500, ls: 1.2, anchor: 'middle' }));
        }
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── loop ─────────────────────────────────────────────────────────────────────
  cycle: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), center (<=12 chars caps — the goal the loop serves), nodes (array of 3-6 short CAPS labels <=14 chars, in loop order), caption (optional <=72 chars)',
    build(slots) {
      const nodes = (slots.nodes || []).slice(0, 6);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const cx = W / 2, cy = 360, r = 195;
      const pos = nodes.map((_, i) => {
        const a = (-90 + i * (360 / Math.max(nodes.length, 1))) * Math.PI / 180;
        return { cx: cx + r * Math.cos(a), cy: cy + r * Math.sin(a), hw: 84, hh: 28 };
      });
      // arrows around the ring first (under the boxes)
      pos.forEach((a, i) => {
        const b = pos[(i + 1) % pos.length];
        p.push(arrowBetween(a, b, { sw: 2.3, pad: 10 }));
      });
      p.push(`<circle cx="${cx}" cy="${cy}" r="60" fill="${ACCENT}"/>`);
      p.push(boxLabel(cx, cy, 112, String(slots.center || 'GOAL'), { fill: PAPER, size: 18, ls: 1.5 }));
      nodes.forEach((nLabel, i) => {
        const n = pos[i];
        p.push(rect(n.cx - n.hw, n.cy - n.hh, n.hw * 2, n.hh * 2, PAPER, INK, 2.5));
        p.push(boxLabel(n.cx, n.cy, n.hw * 2, nLabel, { fill: INK, size: 16, ls: 1.2 }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── source → row of targets ───────────────────────────────────────────────────
  fanout: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), source (<=22 chars caps — the one event/agent at the top), targets (array of 2-4 objects { label (<=18 chars caps), sub (optional <=22 chars), outcome (optional <=24 chars — draws a second box below for the resulting angle/state) }), caption (optional <=72 chars)',
    build(slots) {
      const targets = (slots.targets || []).slice(0, 4);
      const hasOutcome = targets.some((t) => t.outcome);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const srcW = 280, srcH = 64, srcCx = W / 2, srcCy = 150;
      p.push(rect(srcCx - srcW / 2, srcCy - srcH / 2, srcW, srcH, ACCENT));
      p.push(boxLabel(srcCx, srcCy, srcW, String(slots.source || 'EVENT'), { fill: PAPER, size: 19, ls: 2 }));
      const n = targets.length || 1;
      const colW = Math.min(300, Math.floor((W - 160 - (n - 1) * 36) / n));
      const x0 = (W - (n * colW + (n - 1) * 36)) / 2;
      const tTop = 300, tH = targets.some((t) => t.sub) ? 96 : 70;
      targets.forEach((t, i) => {
        const x = x0 + i * (colW + 36), cx = x + colW / 2, cy = tTop + tH / 2;
        p.push(arrowBetween({ cx: srcCx, cy: srcCy, hw: srcW / 2, hh: srcH / 2 }, { cx, cy, hw: colW / 2, hh: tH / 2 }, { pad: 8 }));
        p.push(rect(x, tTop, colW, tH, PAPER, INK, 2.5));
        if (t.sub) {
          p.push(boxLabel(cx, tTop + 32, colW, t.label, { fill: INK, size: 16, ls: 1.2 }));
          p.push(label(cx, tTop + 64, String(t.sub).toUpperCase(),
            { size: fit(String(t.sub), colW - 20, 14, { mono: true }), fill: MUTE, mono: true, weight: 500, ls: 0.8, anchor: 'middle' }));
        } else {
          p.push(boxLabel(cx, cy, colW, t.label, { fill: INK, size: 16, ls: 1.2 }));
        }
        if (hasOutcome && t.outcome) {
          const oTop = tTop + tH + 50, oH = 76;
          p.push(arrow(cx, tTop + tH + 4, cx, oTop - 4));
          p.push(rect(x, oTop, colW, oH, CARDHI, LINE, 2));
          p.push(label(cx, oTop + 26, 'ANGLE', { size: 12, fill: MUTE, mono: true, weight: 500, ls: 2.5, anchor: 'middle' }));
          p.push(boxLabel(cx, oTop + 52, colW, t.outcome, { fill: INK, size: 15, ls: 0.4 }));
        }
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── captioned columns ─────────────────────────────────────────────────────────
  columns: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), header (optional <=24 chars caps — a routing box above the columns), columns (array of 2-4 objects { title (<=18 chars caps), items (array of 2-5 short CAPS labels <=18 chars), style ("ink" solid | "outline" | "ghost") }), caption (optional <=72 chars)',
    build(slots) {
      const cols = (slots.columns || []).slice(0, 4);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      let colTop = 130;
      let headCx = W / 2, headBottom = 130;
      if (slots.header) {
        // size the box to the fitted text (+padding) so long headers never clip
        const htxt = String(slots.header).toUpperCase();
        const hs = fit(htxt, W - 240, 18, { mono: true, ls: 2 });
        const hw = Math.min(W - 160, Math.max(300, Math.round(monoWidth(htxt, hs, 2) + 56)));
        p.push(rect(W / 2 - hw / 2, 104, hw, 56, INK));
        p.push(label(W / 2, 132 + hs * 0.34, htxt, { size: hs, fill: PAPER, mono: true, weight: 700, ls: 2, anchor: 'middle' }));
        colTop = 236; headBottom = 160;
      }
      const n = cols.length || 1;
      const colW = Math.min(300, Math.floor((W - 160 - (n - 1) * 36) / n));
      const x0 = (W - (n * colW + (n - 1) * 36)) / 2;
      const colH = 360;
      cols.forEach((c, i) => {
        const x = x0 + i * (colW + 36), cx = x + colW / 2;
        const style = c.style || (i === 0 ? 'outline' : i === n - 1 ? 'ghost' : 'ink');
        let fillCol, stroke, titleCol, itemCol;
        if (style === 'ink')      { fillCol = INK;    stroke = INK;  titleCol = PAPER; itemCol = PAPER; }
        else if (style === 'ghost') { fillCol = CARDHI; stroke = LINE; titleCol = INK;  itemCol = MUTE; }
        else                      { fillCol = PAPER;  stroke = INK;  titleCol = INK;  itemCol = MUTE; }
        if (slots.header) p.push(arrow(headCx + (i - (n - 1) / 2) * 60, headBottom, cx, colTop - 14, { sw: 2 }));
        p.push(rect(x, colTop, colW, colH, fillCol, stroke, style === 'ghost' ? 2 : 2.5));
        p.push(boxLabel(cx, colTop + 40, colW, c.title, { fill: titleCol, size: 18, ls: 1.5 }));
        p.push(`<line x1="${x + 36}" y1="${colTop + 62}" x2="${x + colW - 36}" y2="${colTop + 62}" stroke="${itemCol}" stroke-width="1.5"/>`);
        const items = (c.items || []).slice(0, 5);
        items.forEach((it, j) => {
          const iy = colTop + 100 + j * 48;
          p.push(label(cx, iy, String(it).toUpperCase(),
            { size: fit(String(it), colW - 30, 16, { mono: true }), fill: itemCol, mono: true, weight: 500, ls: 1.2, anchor: 'middle' }));
        });
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── 2x2 control room ───────────────────────────────────────────────────────────
  grid: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), panels (array of exactly 4 objects { title (<=22 chars caps), rows (array of 2-5 short strings <=40 chars) }), caption (optional <=72 chars)',
    build(slots) {
      const panels = (slots.panels || []).slice(0, 4);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const pw = 510, ph = 222, gx = 40, gy = 34;
      const x0 = (W - 2 * pw - gx) / 2, y0 = 104;
      panels.forEach((panel, idx) => {
        const col = idx % 2, row = Math.floor(idx / 2);
        const x = x0 + col * (pw + gx), y = y0 + row * (ph + gy);
        p.push(rect(x, y, pw, ph, PAPER, INK, 2.5));
        p.push(rect(x, y, pw, 44, INK));
        p.push(boxLabel(x + pw / 2, y + 22, pw, String(panel.title || ''), { fill: PAPER, size: 16, ls: 2 }));
        const rows = (panel.rows || []).slice(0, 5);
        rows.forEach((r, j) => {
          const ry = y + 80 + j * 30;
          p.push(`<circle cx="${x + 34}" cy="${ry - 5}" r="4.5" fill="${INK}"/>`);
          p.push(label(x + 54, ry, String(r),
            { size: fit(String(r), pw - 90, 15), fill: MUTE, weight: 500, ls: 0.2, anchor: 'start' }));
        });
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── narrowing conversion funnel ─────────────────────────────────────────────
  funnel: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), stages (array of 3-5 objects top to bottom, each { label (<=20 chars caps), sub (optional <=16 chars — a count or drop-off note) }), caption (optional <=72 chars)',
    build(slots) {
      const stages = (slots.stages || []).slice(0, 5);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const n = stages.length || 1;
      const top = 124, bottomLimit = slots.caption ? 596 : 616, gap = 10;
      const bandH = Math.min(106, Math.floor((bottomLimit - top - (n - 1) * gap) / n));
      const wTop = 780, wBot = 240, cx = W / 2;
      let y = top;
      stages.forEach((st, i) => {
        const wt = wTop + (wBot - wTop) * (i / n);
        const wb = wTop + (wBot - wTop) * ((i + 1) / n);
        const dark = i === n - 1;          // the final (won) stage carries the accent
        const fillc = dark ? ACCENT : (i % 2 ? CARDHI : PAPER);
        p.push(`<polygon points="${(cx - wt / 2).toFixed(1)},${y} ${(cx + wt / 2).toFixed(1)},${y} ${(cx + wb / 2).toFixed(1)},${y + bandH} ${(cx - wb / 2).toFixed(1)},${y + bandH}" fill="${fillc}" stroke="${INK}" stroke-width="2.5"/>`);
        p.push(boxLabel(cx, y + bandH / 2, Math.min(wt, wb), st.label, { fill: dark ? PAPER : INK, size: 18, ls: 1.5 }));
        if (st.sub) p.push(label(cx + wt / 2 + 18, y + bandH / 2 + 5, String(st.sub).toUpperCase(),
          { size: 14, fill: MUTE, mono: true, weight: 500, ls: 1, anchor: 'start' }));
        y += bandH + gap;
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── horizontal milestone timeline ───────────────────────────────────────────
  timeline: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), milestones (array of 3-5 objects left to right, each { label (<=16 chars caps), sub (optional <=18 chars — a date or note) }), caption (optional <=72 chars)',
    build(slots) {
      const ms = (slots.milestones || []).slice(0, 5);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const n = ms.length || 1;
      const x0 = 150, x1 = W - 150, midY = 360;
      p.push(`<line x1="${x0}" y1="${midY}" x2="${x1 - 8}" y2="${midY}" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(arrow(x1 - 30, midY, x1, midY));
      // keep the last milestone clear of the arrowhead
      const step = n > 1 ? (x1 - x0 - 110) / (n - 1) : 0;
      ms.forEach((m, i) => {
        const x = n > 1 ? x0 + 20 + i * step : (x0 + x1) / 2;
        const above = i % 2 === 0;
        const boxW = 190, boxH = 50;
        const by = above ? midY - 44 - boxH : midY + 44;
        p.push(`<line x1="${x}" y1="${above ? midY - 9 : midY + 9}" x2="${x}" y2="${above ? by + boxH : by}" stroke="${INK}" stroke-width="2"/>`);
        p.push(`<circle cx="${x}" cy="${midY}" r="9" fill="${ACCENT}"/>`);   // milestone markers carry the accent
        p.push(rect(x - boxW / 2, by, boxW, boxH, PAPER, INK, 2.5));
        p.push(boxLabel(x, by + boxH / 2, boxW, m.label, { fill: INK, size: 15, ls: 1 }));
        if (m.sub) p.push(label(x, above ? by - 14 : by + boxH + 26, String(m.sub).toUpperCase(),
          { size: 13, fill: MUTE, mono: true, weight: 500, ls: 1, anchor: 'middle' }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── 2x2 positioning matrix with axes ────────────────────────────────────────
  quadrant: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x_axis (<=18 chars caps — horizontal axis name), y_axis (<=18 chars caps — vertical axis name), quadrants (array of EXACTLY 4 objects in order top-left, top-right, bottom-left, bottom-right, each { label (<=22 chars caps), highlight (bool — paints it solid ink as the target) }), caption (optional <=72 chars)',
    build(slots) {
      const q = (slots.quadrants || []).slice(0, 4);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const left = 280, right = 920, top = 130, bot = 540;
      const midX = (left + right) / 2, midY = (top + bot) / 2;
      const cw = (right - left) / 2, ch = (bot - top) / 2;
      const cells = [[left, top], [midX, top], [left, midY], [midX, midY]];
      q.forEach((qq, i) => {
        const [x, y] = cells[i];
        const hl = !!qq.highlight;          // the target quadrant carries the accent
        p.push(rect(x, y, cw, ch, hl ? ACCENT : PAPER, LINE, 1.5));
        p.push(boxLabel(x + cw / 2, y + ch / 2, cw, qq.label, { fill: hl ? PAPER : INK, size: 16, ls: 1 }));
      });
      p.push(`<line x1="${left}" y1="${midY}" x2="${right}" y2="${midY}" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(`<line x1="${midX}" y1="${top}" x2="${midX}" y2="${bot}" stroke="${INK}" stroke-width="2.5"/>`);
      if (slots.x_axis) p.push(label(right + 14, midY + 5, String(slots.x_axis).toUpperCase(),
        { size: fit(String(slots.x_axis), 250, 14, { mono: true, ls: 1.5 }), fill: MUTE, mono: true, weight: 700, ls: 1.5, anchor: 'start' }));
      if (slots.y_axis) p.push(label(midX, top - 18, String(slots.y_axis).toUpperCase(),
        { size: 14, fill: MUTE, mono: true, weight: 700, ls: 1.5, anchor: 'middle' }));
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── hierarchy pyramid (wide base → narrow apex) ─────────────────────────────
  pyramid: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), tiers (array of 3-5 objects TOP apex to BOTTOM base, each { label (<=24 chars caps), sub (optional <=30 chars) }), caption (optional <=72 chars)',
    build(slots) {
      const tiers = (slots.tiers || []).slice(0, 5);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const n = tiers.length || 1;
      const top = 124, bottomLimit = slots.caption ? 596 : 612, gap = 10;
      const bandH = Math.min(110, Math.floor((bottomLimit - top - (n - 1) * gap) / n));
      const cx = W / 2, wTop = 220, wBot = 860;
      let y = top;
      tiers.forEach((t, i) => {
        const wt = wTop + (wBot - wTop) * (i / n);
        const wb = wTop + (wBot - wTop) * ((i + 1) / n);
        const dark = i === 0;              // the apex carries the accent
        const fillc = dark ? ACCENT : (i % 2 ? PAPER : CARDHI);
        p.push(`<polygon points="${(cx - wt / 2).toFixed(1)},${y} ${(cx + wt / 2).toFixed(1)},${y} ${(cx + wb / 2).toFixed(1)},${y + bandH} ${(cx - wb / 2).toFixed(1)},${y + bandH}" fill="${fillc}" stroke="${INK}" stroke-width="2.5"/>`);
        p.push(boxLabel(cx, y + bandH / 2 - (t.sub ? 8 : 0), Math.min(wt, wb) + 50, t.label, { fill: dark ? PAPER : INK, size: 17, ls: 1.2 }));
        if (t.sub) p.push(label(cx, y + bandH / 2 + 16, String(t.sub).toUpperCase(),
          { size: 12, fill: dark ? LINE : MUTE, mono: true, weight: 500, ls: 0.8, anchor: 'middle' }));
        y += bandH + gap;
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── two-circle Venn (intersection) ──────────────────────────────────────────
  venn: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), left_label (<=16 chars caps), right_label (<=16 chars caps), overlap_label (<=14 chars caps — what the two share), caption (optional <=72 chars)',
    build(slots) {
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const cy = 358, r = 200, off = 118, cx = W / 2;
      const lc = cx - off, rc = cx + off;
      p.push(`<circle cx="${lc}" cy="${cy}" r="${r}" fill="${INK}" fill-opacity="0.05" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(`<circle cx="${rc}" cy="${cy}" r="${r}" fill="${INK}" fill-opacity="0.05" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(label(lc - r / 2 - 4, cy + 6, String(slots.left_label || '').toUpperCase(),
        { size: fit(String(slots.left_label || ''), r - 10, 18, { mono: true, ls: 1 }), fill: INK, mono: true, weight: 700, ls: 1, anchor: 'middle' }));
      p.push(label(rc + r / 2 + 4, cy + 6, String(slots.right_label || '').toUpperCase(),
        { size: fit(String(slots.right_label || ''), r - 10, 18, { mono: true, ls: 1 }), fill: INK, mono: true, weight: 700, ls: 1, anchor: 'middle' }));
      // the shared zone (the whole point of a Venn) carries the accent label
      if (slots.overlap_label) {
        p.push(label(cx, cy + 5, String(slots.overlap_label).toUpperCase(),
          { size: fit(String(slots.overlap_label), 2 * off - 24, 16, { mono: true, ls: 0.5 }), fill: ACCENT, mono: true, weight: 700, ls: 0.5, anchor: 'middle' }));
      }
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── comparison table (criteria × options) ───────────────────────────────────
  table: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), columns (array of 2-3 option header strings <=16 chars caps), rows (array of 3-6 objects { label (<=26 chars — the criterion), cells (array matching columns length, each <=14 chars or "YES"/"NO") }), caption (optional <=72 chars)',
    build(slots) {
      const cols = (slots.columns || []).slice(0, 3);
      const rows = (slots.rows || []).slice(0, 6);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const nCol = cols.length || 2;
      const tableW = 1000, x0 = (W - tableW) / 2, critW = 360;
      const cellW = (tableW - critW) / nCol;
      const headH = 56, rowH = rows.length > 4 ? 54 : 64, startY = 124;
      let y = startY;
      p.push(rect(x0 + critW, y, tableW - critW, headH, INK));
      // the right-most (preferred) option header carries the accent
      p.push(rect(x0 + critW + (nCol - 1) * cellW, y, cellW, headH, ACCENT));
      cols.forEach((c, i) => p.push(boxLabel(x0 + critW + i * cellW + cellW / 2, y + headH / 2, cellW, c, { fill: PAPER, size: 16, ls: 1 })));
      y += headH;
      rows.forEach((r, ri) => {
        if (ri % 2 === 1) p.push(rect(x0, y, tableW, rowH, CARDHI));
        p.push(label(x0 + 22, y + rowH / 2 + 5, String(r.label),
          { size: fit(String(r.label), critW - 36, 16), fill: INK, weight: 600, anchor: 'start' }));
        (r.cells || []).slice(0, nCol).forEach((cell, ci) => {
          const ccx = x0 + critW + ci * cellW + cellW / 2;
          p.push(label(ccx, y + rowH / 2 + 5, String(cell).toUpperCase(),
            { size: fit(String(cell), cellW - 24, 15, { mono: true, ls: 0.5 }), fill: MUTE, mono: true, weight: 500, ls: 0.5, anchor: 'middle' }));
        });
        y += rowH;
      });
      for (let i = 0; i <= nCol; i++) {
        const vx = x0 + critW + i * cellW;
        p.push(`<line x1="${vx}" y1="${startY}" x2="${vx}" y2="${y}" stroke="${LINE}" stroke-width="1.5"/>`);
      }
      p.push(`<rect x="${x0}" y="${startY}" width="${tableW}" height="${y - startY}" fill="none" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── linear left→right pipeline (a process, not a loop) ──────────────────────
  pipeline: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), stages (array of 3-5 short CAPS labels <=12 chars each), stage_caption (optional <=56 chars caps), caption (optional <=72 chars)',
    build(slots) {
      const stages = (slots.stages || []).slice(0, 5);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const n = stages.length || 1, midY = 330, gap = 40, avail = W - 200;
      const bw = Math.min(190, Math.floor((avail - (n - 1) * gap - 60) / n)), bh = 70;
      const chainW = n * bw + (n - 1) * gap;
      let x = (W - chainW) / 2;
      p.push(`<circle cx="${x - 34}" cy="${midY}" r="7" fill="${INK}"/>`);
      p.push(arrow(x - 27, midY, x - 4, midY));
      stages.forEach((s, i) => {
        p.push(rect(x, midY - bh / 2, bw, bh, INK));
        p.push(boxLabel(x + bw / 2, midY, bw, s, { fill: PAPER, size: 16, ls: 1.5 }));
        x += bw;
        if (i < n - 1) { p.push(arrow(x + 4, midY, x + gap - 4, midY)); x += gap; }
      });
      p.push(arrow(x + 4, midY, x + 27, midY));
      p.push(`<circle cx="${x + 34}" cy="${midY}" r="7" fill="${INK}"/>`);
      if (slots.stage_caption) p.push(label(W / 2, midY + 82, String(slots.stage_caption).toUpperCase(),
        { size: fit(String(slots.stage_caption), W - 160, 16, { mono: true, ls: 1.5 }), fill: MUTE, mono: true, weight: 500, ls: 1.5, anchor: 'middle' }));
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── central concept with radiating spokes (ecosystem/dependencies) ──────────
  radial: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), center (<=14 chars caps), spokes (array of 3-6 objects { label (<=16 chars caps), sub (optional <=16 chars) }), caption (optional <=72 chars)',
    build(slots) {
      const spokes = (slots.spokes || []).slice(0, 6);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const cx = W / 2, cy = 360, r = 210, n = spokes.length || 1;
      const pos = spokes.map((_, i) => {
        const a = (-90 + i * (360 / n)) * Math.PI / 180;
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      });
      pos.forEach((pt) => {           // plain connectors (membership, not flow)
        const vx = pt.x - cx, vy = pt.y - cy, L = Math.hypot(vx, vy) || 1;
        p.push(`<line x1="${(cx + vx / L * 66).toFixed(1)}" y1="${(cy + vy / L * 66).toFixed(1)}" x2="${(pt.x - vx / L * 74).toFixed(1)}" y2="${(pt.y - vy / L * 40).toFixed(1)}" stroke="${INK}" stroke-width="2"/>`);
      });
      p.push(`<circle cx="${cx}" cy="${cy}" r="64" fill="${ACCENT}"/>`);
      p.push(boxLabel(cx, cy, 116, String(slots.center || 'CORE'), { fill: PAPER, size: 17, ls: 1 }));
      spokes.forEach((s, i) => {
        const pt = pos[i], bw = 152, bh = s.sub ? 64 : 50;
        p.push(rect(pt.x - bw / 2, pt.y - bh / 2, bw, bh, PAPER, INK, 2.5));
        if (s.sub) {
          p.push(boxLabel(pt.x, pt.y - 8, bw, s.label, { fill: INK, size: 14, ls: 0.8 }));
          p.push(label(pt.x, pt.y + 18, String(s.sub).toUpperCase(), { size: 12, fill: MUTE, mono: true, weight: 500, ls: 0.5, anchor: 'middle' }));
        } else {
          p.push(boxLabel(pt.x, pt.y, bw, s.label, { fill: INK, size: 14, ls: 0.8 }));
        }
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── oversized stat callouts ─────────────────────────────────────────────────
  bigstat: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), stats (array of 2-4 objects { value (<=8 chars — the number, e.g. "10X", "73%", "1/2"), label (<=28 chars — what it measures) }), caption (optional <=72 chars)',
    build(slots) {
      const stats = (slots.stats || []).slice(0, 4);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const n = stats.length || 1, colW = (W - 120) / n, y = 340;
      stats.forEach((s, i) => {
        const cx = 60 + i * colW + colW / 2;
        if (i > 0) p.push(`<line x1="${60 + i * colW}" y1="210" x2="${60 + i * colW}" y2="470" stroke="${LINE}" stroke-width="2"/>`);
        const vs = fit(String(s.value), colW - 90, 116);
        // the first (hero) stat carries the accent
        p.push(label(cx, y, String(s.value), { size: vs, fill: i === 0 ? ACCENT : INK, font: SANS, weight: 700, ls: -2, anchor: 'middle' }));
        p.push(label(cx, y + 54, String(s.label).toUpperCase(),
          { size: fit(String(s.label), colW - 30, 17, { mono: true, ls: 1 }), fill: MUTE, mono: true, weight: 500, ls: 1, anchor: 'middle' }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── ascending step blocks (growth / escalation) ─────────────────────────────
  progression: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), steps (array of 3-5 objects left to right, ascending, each { label (<=16 chars caps), sub (optional <=18 chars) }), caption (optional <=72 chars)',
    build(slots) {
      const steps = (slots.steps || []).slice(0, 5);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const n = steps.length || 1, baseY = 560, gap = 28, avail = W - 160;
      const bw = Math.floor((avail - (n - 1) * gap) / n), minH = 130, maxH = 410;
      let x = 80;
      steps.forEach((s, i) => {
        const h = minH + (maxH - minH) * (n > 1 ? i / (n - 1) : 1), y = baseY - h;
        const dark = i === n - 1;          // the top (leveraged) step carries the accent
        p.push(rect(x, y, bw, h, dark ? ACCENT : (i % 2 ? CARDHI : PAPER), INK, 2.5));
        p.push(boxLabel(x + bw / 2, y + 36, bw, s.label, { fill: dark ? PAPER : INK, size: 15, ls: 1 }));
        if (s.sub) p.push(label(x + bw / 2, y + 62, String(s.sub).toUpperCase(),
          { size: fit(String(s.sub), bw - 16, 12, { mono: true, ls: 0.5 }), fill: dark ? LINE : MUTE, mono: true, weight: 500, ls: 0.5, anchor: 'middle' }));
        x += bw + gap;
      });
      p.push(`<line x1="70" y1="${baseY}" x2="${W - 70}" y2="${baseY}" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },
  // ── data charts (Datawrapper-guide types; see article-figures-charts.js) ──
  ...CHART_TEMPLATES,
};

export const FIGURE_TEMPLATE_NAMES = Object.keys(FIGURE_TEMPLATES);

// ─── featured cover ─────────────────────────────────────────────────────────
// A dedicated 1200x630 (OG ratio) hero image — NOT an in-body figure, so it
// lives outside FIGURE_TEMPLATES (the LLM never picks it for the article body).
// It's built from the same kit as the diagrams: the nyyon wordmark, mono
// kickers, ink nodes wired by connectors, and the accent as the focal hub —
// recomposed as a magazine cover. One headline word prints in the accent.

const LOGO_PATH = 'M33,0 L64,0 L64,66 L33,50 L33,0 Z M0,4 L31,20 L31,70 L0,70 L0,4 Z';

function wordmarkAt(x, baselineY, h = 30, markFill = '#262424', textFill = INK) {
  const mw = Math.round(h * (64 / 70));
  return `<g transform="translate(${x} ${baselineY - h}) scale(${(h / 70).toFixed(4)})"><path d="${LOGO_PATH}" fill="${markFill}"/></g>`
       + `<text x="${x + mw + 12}" y="${baselineY - 4}" font-family="${SANS}" font-weight="700" font-size="${Math.round(h * 0.8)}" letter-spacing="-0.5" fill="${textFill}">Nyyon</text>`;
}

// Greedy word-wrap. Returns lines (arrays of {word, hot}) where `hot` words are
// part of the highlight phrase and should print in the accent.
function wrapTitle(title, maxWidth, size, hotSet) {
  const words = String(title).split(/\s+/).filter(Boolean);
  const space = size * 0.30;
  const wWidth = (w) => w.length * size * 0.56;
  const lines = [];
  let cur = [], curW = 0;
  for (const w of words) {
    const ww = wWidth(w);
    if (cur.length && curW + space + ww > maxWidth) { lines.push(cur); cur = []; curW = 0; }
    cur.push({ word: w, hot: hotSet.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')) });
    curW += (cur.length > 1 ? space : 0) + ww;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

export const FEATURED_TEMPLATE = {
  width: 1200, height: 630,
  slots: 'kicker (<=26 chars caps — a topic/section label), title (the headline, <=90 chars — usually the article title), highlight (optional — one word or short phrase copied EXACTLY from the title, printed in the accent colour, <=24 chars), sub (<=84 chars — one-line standfirst, usually the excerpt)',
  build(slots) {
    const Wc = 1200, Hc = 630;
    const title = String(slots.title || '').trim();
    const hotSet = new Set(
      String(slots.highlight || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean),
    );
    const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Wc}" height="${Hc}" viewBox="0 0 ${Wc} ${Hc}">`];
    p.push(`<rect width="${Wc}" height="${Hc}" fill="${PAPER}"/>`);
    p.push(`<rect x="1" y="1" width="${Wc - 2}" height="${Hc - 2}" fill="none" stroke="${LINE}" stroke-width="2"/>`);

    // ── right-side motif: kit shapes wired to the accent hub ──
    const hub = { x: 1012, y: 318 }, R = 92;
    const sats = [
      { kind: 'sq',  x: 1132, y: 168 },
      { kind: 'ci',  x: 1148, y: 470 },
      { kind: 'tri', x: 872,  y: 486 },
    ];
    sats.forEach((s) => p.push(`<line x1="${hub.x}" y1="${hub.y}" x2="${s.x}" y2="${s.y}" stroke="${LINE}" stroke-width="2"/>`));
    p.push(`<circle cx="${hub.x}" cy="${hub.y}" r="${R}" fill="${ACCENT}"/>`);
    p.push(`<g transform="translate(${hub.x - 24} ${hub.y - 28}) scale(${(56 / 70).toFixed(4)})"><path d="${LOGO_PATH}" fill="${PAPER}"/></g>`);
    sats.forEach((s) => {
      if (s.kind === 'sq') p.push(`<rect x="${s.x - 26}" y="${s.y - 26}" width="52" height="52" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>`);
      else if (s.kind === 'ci') p.push(`<circle cx="${s.x}" cy="${s.y}" r="28" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>`);
      else p.push(`<polygon points="${s.x},${s.y - 30} ${s.x + 28},${s.y + 20} ${s.x - 28},${s.y + 20}" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>`);
    });

    // ── top bar: wordmark + kicker ──
    p.push(wordmarkAt(64, 90, 30));
    if (slots.kicker) {
      p.push(`<rect x="64" y="120" width="13" height="13" fill="${ACCENT}"/>`);
      p.push(label(88, 131, String(slots.kicker).toUpperCase(), { size: 16, fill: MUTE, mono: true, weight: 700, ls: 3, anchor: 'start' }));
    }
    // accent signal rule above the headline
    p.push(`<rect x="64" y="162" width="84" height="10" fill="${ACCENT}"/>`);

    // ── headline: wrapped, highlight word in accent ──
    const maxW = 700;
    let size = 78;
    let lines = wrapTitle(title, maxW, size, hotSet);
    while (size > 40 && lines.length > 4) { size -= 4; lines = wrapTitle(title, maxW, size, hotSet); }
    const lineH = Math.round(size * 1.08);
    const blockTop = Math.round(372 - ((lines.length - 1) * lineH) / 2);
    lines.forEach((ln, i) => {
      const ly = blockTop + i * lineH;
      const tspans = ln.map((t) => `<tspan fill="${t.hot ? ACCENT : INK}">${esc(t.word)}</tspan>`).join(' ');
      p.push(`<text x="64" y="${ly}" font-family="${SANS}" font-weight="700" font-size="${size}" letter-spacing="-1.6" fill="${INK}">${tspans}</text>`);
    });

    // ── footer: standfirst + URL ──
    if (slots.sub) {
      const s = String(slots.sub);
      p.push(label(64, 572, s, { size: fit(s, 760, 19), fill: MUTE, weight: 500, anchor: 'start' }));
    }
    p.push(label(Wc - 64, 572, 'NYYON.COM', { size: 15, fill: MUTE, mono: true, weight: 700, ls: 2, anchor: 'end' }));

    p.push('</svg>');
    return p.join('');
  },
};
