// Data-chart templates — the chart_* family for in-article figures. PORTED
// from LevNyyon/nyyon-figures src/charts.js (keep the two in sync: the body
// below is identical; only this token header differs — the MCP reads tokens
// from its settings.js, this file carries the cmd brand inline like
// article-figures-templates.js does). Pure SVG builders, unit-renderable in
// Node, no worker-only imports.
//
// Which chart to use when lives in the figure-chart-selection knowledge doc
// (seeded from CHART_GUIDE_DEFAULT in article-figures.js) — the drafter reads
// it live, so editing the note changes chart choices with no deploy.

const PAPER  = '#FAFAF9';
const INK    = '#0A0A0A';
const MUTE   = '#78716C';
const LINE   = '#E7E5E4';
const CARDHI = '#F5F5F4';
const ACCENT = '#6C5CE7';
const ACCENT_WASH = '#ECE9FD';
const SANS = 'Inter';
const MONO = 'JetBrains Mono';
const W = 1200, H = 675;


// ─── shared helpers (mirrors templates.js conventions) ──────────────────────
function esc(s) {
  return String(s ?? '').slice(0, 2000)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function fit(text, maxWidth, baseSize, { mono = false, min = 0.6, ls = 0 } = {}) {
  const factor = mono ? 0.62 : 0.55;
  const n = String(text).length;
  let size = baseSize;
  const floor = Math.max(9, Math.round(baseSize * min));
  while (size > floor && n * size * factor + Math.max(0, n - 1) * ls > maxWidth) size -= 1;
  return size;
}

function svgOpen() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${PAPER}"/>`,
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${LINE}" stroke-width="2"/>`,
  ];
}

function figLabel(labelText) {
  const t = String(labelText || 'FIGURE').toUpperCase();
  return `<text x="48" y="62" font-family="${MONO}" font-weight="700" font-size="19" letter-spacing="2.5" fill="${ACCENT}">FIG.</text>`
       + `<text x="112" y="62" font-family="${MONO}" font-weight="500" font-size="19" letter-spacing="2.5" fill="${MUTE}">${esc(t)}</text>`;
}

function caption(text) {
  if (!text) return '';
  const t = String(text).toUpperCase();
  const size = fit(t, W - 120, 16, { mono: true });
  return `<text x="${W / 2}" y="640" text-anchor="middle" font-family="${MONO}" font-weight="500" font-size="${size}" letter-spacing="1.8" fill="${MUTE}">${esc(t)}</text>`;
}

function label(x, y, t, { size = 18, fill = INK, weight = 600, anchor = 'middle', ls = null, mono = false } = {}) {
  const f = mono ? MONO : SANS;
  const l = ls != null ? ` letter-spacing="${ls}"` : '';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${f}" font-weight="${weight}" font-size="${size}"${l} fill="${fill}">${esc(t)}</text>`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Terse number formatting for tick + value labels: 1.5k / 2.3M / 41% / 0.8.
function fmt(v, unit = '') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  let s;
  if (a >= 1e9) s = `${trim(n / 1e9)}B`;
  else if (a >= 1e6) s = `${trim(n / 1e6)}M`;
  else if (a >= 1e4) s = `${trim(n / 1e3)}k`;
  else s = trim(n);
  return unit === '%' ? `${s}%` : unit ? `${s} ${unit}` : s;
  function trim(x) {
    const r = Math.abs(x) < 10 ? Math.round(x * 10) / 10 : Math.round(x);
    return String(r);
  }
}

// A pleasant tick scale over [rawMin, rawMax]. zero=true clamps the floor to 0
// (bars/columns/areas — length encodes the value, so the base must be zero).
function niceScale(rawMin, rawMax, { zero = false, ticks = 4 } = {}) {
  // Degenerate inputs (empty data → ±Infinity, or an all-equal flat series)
  // must still yield a sane scale — a NaN SVG renders as a blank chart and,
  // worse, can get published. Pad a flat span instead of overprinting ticks.
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) { rawMin = 0; rawMax = 1; }
  if (rawMax - rawMin < 1e-9) {
    const pad = Math.max(1, Math.abs(rawMin) * 0.1);
    rawMax = rawMin + pad;
    if (!zero) rawMin -= pad;
  }
  let min = zero ? Math.min(0, rawMin) : rawMin;
  let max = rawMax;
  const span = max - min;
  const step0 = span / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2.5 : norm > 1 ? 2 : 1) * mag;
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const tickVals = [];
  for (let t = min; t <= max + step / 2; t += step) tickVals.push(Math.round(t * 1e9) / 1e9);
  return { min, max, ticks: tickVals };
}

// Horizontal gridlines + right-anchored mono tick labels for a y scale.
function yAxis(p, scale, x0, x1, yOf, unit) {
  for (const t of scale.ticks) {
    const y = yOf(t);
    p.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${t === 0 ? INK : LINE}" stroke-width="${t === 0 ? 2 : 1.5}"/>`);
    p.push(label(x0 - 12, y + 5, fmt(t, unit), { size: 14, fill: MUTE, mono: true, weight: 500, anchor: 'end' }));
  }
}

// Distinguishable series styles on a monochrome brand: ink, accent, mute, then
// dashed repeats. The FIRST series is the story (ink); accent marks the focus.
function seriesStroke(i, hot) {
  if (hot) return { stroke: ACCENT, width: 4, dash: '' };
  const base = [
    { stroke: INK, width: 3.5, dash: '' },
    { stroke: ACCENT, width: 3.5, dash: '' },
    { stroke: MUTE, width: 3, dash: '' },
    { stroke: INK, width: 2.5, dash: '7 6' },
    { stroke: MUTE, width: 2.5, dash: '7 6' },
  ];
  return base[i % base.length];
}

// Fill palette for stacked segments; PAPER separators keep bands readable.
function segFill(i) {
  const fills = [INK, ACCENT, MUTE, ACCENT_WASH, CARDHI];
  return fills[i % fills.length];
}
function segText(i) {
  return [PAPER, PAPER, PAPER, INK, INK][i % 5];
}

function polyline(pts, { stroke = INK, width = 3.5, dash = '' } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<polyline points="${pts.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}"${d} stroke-linejoin="round" stroke-linecap="round"/>`;
}

function hexLerp(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

// Close out an empty-data chart as a clean labeled frame instead of NaN SVG.
function emptyFrame(p, slots) {
  p.push(caption(slots.caption));
  p.push('</svg>');
  return p.join('');
}

// Standard plot frame: [PL..W-PR] x [PT..PB].
const PT = 110, PB = 560, PL = 118, PRD = 70;

// ─── the templates ──────────────────────────────────────────────────────────
export const CHART_TEMPLATES = {

  // ── line chart: change over continuous time ───────────────────────────────
  chart_line: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x (array of 2-12 time labels), series (array of 1-5 { name (<=16 chars), values (array of numbers, same length as x) }), focus (optional: name of the ONE series that is the story — it prints in the accent), unit (optional, e.g. "%"), caption (optional <=72 chars)',
    build(slots) {
      const xs = (slots.x || []).slice(0, 12).map(String);
      const series = (slots.series || []).slice(0, 5)
        .map((s) => ({ name: String(s.name || ''), values: (s.values || []).slice(0, xs.length).map(num) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!xs.length || !series.length || series.every((s) => !s.values.length)) return emptyFrame(p, slots);
      const PR = 210; // room for direct end labels — no legend
      const all = series.flatMap((s) => s.values);
      const sc = niceScale(Math.min(...all), Math.max(...all), { ticks: 4 });
      const yOf = (v) => PB - ((v - sc.min) / (sc.max - sc.min)) * (PB - PT);
      const xOf = (i) => PL + (xs.length > 1 ? (i / (xs.length - 1)) : 0.5) * (W - PL - PR);
      yAxis(p, sc, PL, W - PR + 30, yOf, slots.unit);
      xs.forEach((t, i) => {
        if (xs.length > 8 && i % 2 === 1 && i !== xs.length - 1) return;
        p.push(label(xOf(i), PB + 34, t, { size: 14, fill: MUTE, mono: true, weight: 500 }));
      });
      const focus = String(slots.focus || '').toLowerCase();
      series.forEach((s, i) => {
        const hot = focus && s.name.toLowerCase() === focus;
        const st = seriesStroke(i, hot);
        p.push(polyline(s.values.map((v, j) => [xOf(j), yOf(v)]), st));
        const lastY = yOf(s.values[s.values.length - 1]);
        p.push(`<circle cx="${xOf(s.values.length - 1)}" cy="${lastY}" r="5.5" fill="${st.stroke}"/>`);
        p.push(label(W - PR + 44, lastY + 5, s.name, { size: 16, fill: hot ? ACCENT : st.stroke, weight: hot ? 700 : 600, anchor: 'start' }));
        p.push(label(W - PR + 44, lastY + 24, fmt(s.values[s.values.length - 1], slots.unit), { size: 13, fill: MUTE, mono: true, weight: 500, anchor: 'start' }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── small multiples: many overlapping series, one mini panel each ─────────
  chart_multiples: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x_first (<=8 chars, first time label), x_last (<=8 chars, last time label), series (array of 2-8 { name (<=14 chars), values (array of 4-24 numbers) }), focus (optional: one name to print in the accent), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const series = (slots.series || []).slice(0, 8)
        .map((s) => ({ name: String(s.name || ''), values: (s.values || []).slice(0, 24).map(num) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!series.length || series.every((s) => !s.values.length)) return emptyFrame(p, slots);
      const n = series.length || 1;
      const C = n <= 3 ? n : Math.ceil(n / 2);
      const R = n <= 3 ? 1 : 2;
      const gx = 34, gy = 44, top = 120, bottom = 585;
      const pw = (W - 140 - (C - 1) * gx) / C, ph = (bottom - top - (R - 1) * gy) / R;
      const all = series.flatMap((s) => s.values);
      const sc = niceScale(Math.min(...all), Math.max(...all), { ticks: 2 }); // one SHARED scale — the whole point
      const focus = String(slots.focus || '').toLowerCase();
      series.forEach((s, i) => {
        const cx0 = 70 + (i % C) * (pw + gx), cy0 = top + Math.floor(i / C) * (ph + gy);
        const hot = focus && s.name.toLowerCase() === focus;
        p.push(`<rect x="${cx0}" y="${cy0}" width="${pw}" height="${ph}" fill="${hot ? ACCENT_WASH : PAPER}" stroke="${LINE}" stroke-width="1.5"/>`);
        const yOf = (v) => cy0 + ph - 12 - ((v - sc.min) / (sc.max - sc.min)) * (ph - 46);
        const xOf = (j) => cx0 + 14 + (s.values.length > 1 ? j / (s.values.length - 1) : 0.5) * (pw - 28);
        p.push(polyline(s.values.map((v, j) => [xOf(j), yOf(v)]), { stroke: hot ? ACCENT : INK, width: 2.5 }));
        const last = s.values[s.values.length - 1];
        p.push(`<circle cx="${xOf(s.values.length - 1)}" cy="${yOf(last)}" r="4" fill="${hot ? ACCENT : INK}"/>`);
        p.push(label(cx0 + 12, cy0 + 24, s.name.toUpperCase(), { size: fit(s.name, pw - 80, 13, { mono: true, ls: 1 }), fill: hot ? ACCENT : INK, mono: true, weight: 700, ls: 1, anchor: 'start' }));
        p.push(label(cx0 + pw - 12, cy0 + 24, fmt(last, slots.unit), { size: 13, fill: MUTE, mono: true, weight: 500, anchor: 'end' }));
        if (Math.floor(i / C) === R - 1 || i >= series.length - C) {
          p.push(label(cx0 + 14, cy0 + ph + 22, String(slots.x_first || ''), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'start' }));
          p.push(label(cx0 + pw - 14, cy0 + ph + 22, String(slots.x_last || ''), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'end' }));
        }
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── area chart: how a total's internal breakdown changed over time ────────
  chart_area: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x (array of 3-12 time labels), series (array of 2-5 { name (<=16 chars), values (numbers, same length as x) }, bottom band first), mode ("stacked" absolute | "share" always sums to 100% | "stream" centered, for texture over precision), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const xs = (slots.x || []).slice(0, 12).map(String);
      const series = (slots.series || []).slice(0, 5)
        .map((s) => ({ name: String(s.name || ''), values: (s.values || []).slice(0, xs.length).map(num) }));
      const mode = ['stacked', 'share', 'stream'].includes(slots.mode) ? slots.mode : 'stacked';
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!xs.length || !series.length) return emptyFrame(p, slots);
      const PR = 200;
      const nPts = xs.length;
      // column totals → per-mode band geometry
      const totals = Array.from({ length: nPts }, (_, j) => series.reduce((a, s) => a + Math.max(0, s.values[j] || 0), 0) || 1);
      const vals = (s, j) => Math.max(0, s.values[j] || 0) * (mode === 'share' ? 100 / totals[j] : 1);
      const stackMax = mode === 'share' ? 100 : Math.max(...totals);
      const sc = niceScale(0, stackMax, { zero: true, ticks: 4 });
      const xOf = (j) => PL + (nPts > 1 ? j / (nPts - 1) : 0.5) * (W - PL - PR);
      const plotH = PB - PT;
      const yOf = (v) => PB - (v / sc.max) * plotH;
      if (mode !== 'stream') yAxis(p, sc, PL, W - PR + 30, yOf, mode === 'share' ? '%' : slots.unit);
      // cumulative bands, bottom-up; stream centers the stack per column
      const base = Array.from({ length: nPts }, (_, j) => (mode === 'stream' ? (sc.max - totals[j]) / 2 : 0));
      const cum = base.map((b) => b);
      const mids = [];
      series.forEach((s, i) => {
        const lo = cum.map((c) => c), hi = cum.map((c, j) => c + vals(s, j));
        const up = hi.map((v, j) => `${Math.round(xOf(j))},${Math.round(yOf(v))}`);
        const dn = lo.map((v, j) => `${Math.round(xOf(j))},${Math.round(yOf(v))}`).reverse();
        p.push(`<polygon points="${up.join(' ')} ${dn.join(' ')}" fill="${segFill(i)}" stroke="${PAPER}" stroke-width="2"/>`);
        mids.push({ name: s.name, y: yOf((lo[nPts - 1] + hi[nPts - 1]) / 2), i, last: vals(s, nPts - 1) });
        for (let j = 0; j < nPts; j++) cum[j] = hi[j];
      });
      xs.forEach((t, j) => {
        if (nPts > 8 && j % 2 === 1 && j !== nPts - 1) return;
        p.push(label(xOf(j), PB + 34, t, { size: 14, fill: MUTE, mono: true, weight: 500 }));
      });
      // direct labels at the right edge, nudged apart if bands are thin
      mids.sort((a, b) => a.y - b.y);
      let prevY = 0;
      for (const m of mids) {
        const y = Math.max(m.y, prevY + 22);
        prevY = y;
        p.push(label(W - PR + 44, y + 5, m.name, { size: 15, fill: INK, weight: 600, anchor: 'start' }));
        p.push(label(W - PR + 44, y + 23, fmt(m.last, mode === 'share' ? '%' : slots.unit), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'start' }));
      }
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── column chart: a few points in time ────────────────────────────────────
  chart_column: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x (array of 2-8 period labels), series (array of 1-3 { name (<=14 chars), values (numbers, same length as x) } — ONE series = plain columns), mode ("grouped" | "stacked", only matters with 2+ series), focus_x (optional: one x label whose column prints in the accent), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const xs = (slots.x || []).slice(0, 8).map(String);
      const series = (slots.series || []).slice(0, 3)
        .map((s) => ({ name: String(s.name || ''), values: (s.values || []).slice(0, xs.length).map(num) }));
      const mode = slots.mode === 'stacked' ? 'stacked' : 'grouped';
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!xs.length || !series.length) return emptyFrame(p, slots);
      const PR = PRD;
      const stacked = series.length > 1 && mode === 'stacked';
      const tops = xs.map((_, j) => (stacked
        ? series.reduce((a, s) => a + Math.max(0, s.values[j] || 0), 0)
        : Math.max(...series.map((s) => s.values[j] || 0))));
      const sc = niceScale(0, Math.max(...tops), { zero: true, ticks: 4 });
      const yOf = (v) => PB - (v / sc.max) * (PB - PT);
      yAxis(p, sc, PL, W - PR, yOf, slots.unit);
      const slotW = (W - PL - PR) / xs.length;
      const focusX = String(slots.focus_x || '').toLowerCase();
      xs.forEach((t, j) => {
        const cx = PL + j * slotW + slotW / 2;
        const hot = focusX && t.toLowerCase() === focusX;
        if (stacked) {
          const bw = Math.min(96, slotW * 0.55);
          let y = PB;
          series.forEach((s, i) => {
            const h = (Math.max(0, s.values[j] || 0) / sc.max) * (PB - PT);
            y -= h;
            p.push(`<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${h}" fill="${hot ? ACCENT : segFill(i)}" stroke="${PAPER}" stroke-width="2"/>`);
          });
          p.push(label(cx, y - 10, fmt(tops[j], slots.unit), { size: 15, fill: hot ? ACCENT : INK, mono: true, weight: 700 }));
        } else {
          const k = series.length, bw = Math.min(76, (slotW * 0.7) / k);
          series.forEach((s, i) => {
            const v = Math.max(0, s.values[j] || 0);
            const x = cx - (k * bw) / 2 + i * bw;
            const fill = hot ? ACCENT : (k === 1 ? INK : segFill(i));
            p.push(`<rect x="${x}" y="${yOf(v)}" width="${bw - 4}" height="${PB - yOf(v)}" fill="${fill}"/>`);
            if (k === 1) p.push(label(x + (bw - 4) / 2, yOf(v) - 10, fmt(v, slots.unit), { size: 15, fill: hot ? ACCENT : INK, mono: true, weight: 700 }));
          });
        }
        p.push(label(cx, PB + 34, t, { size: fit(t, slotW - 8, 14, { mono: true }), fill: hot ? INK : MUTE, mono: true, weight: hot ? 700 : 500 }));
      });
      if (series.length > 1) {
        let lx = PL;
        series.forEach((s, i) => {
          p.push(`<rect x="${lx}" y="${84}" width="14" height="14" fill="${segFill(i)}"/>`);
          p.push(label(lx + 22, 96, s.name, { size: 14, fill: INK, weight: 600, anchor: 'start' }));
          lx += 22 + s.name.length * 8.5 + 34;
        });
      }
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── slope chart: just the first and last point, many categories ───────────
  chart_slope: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), start_label (<=10 chars, e.g. "2019"), end_label (<=10 chars), items (array of 2-8 { label (<=16 chars), start (number), end (number) }), focus (optional: one label to print in the accent; default = biggest mover), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const items = (slots.items || []).slice(0, 8)
        .map((it) => ({ label: String(it.label || ''), start: num(it.start), end: num(it.end) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!items.length) return emptyFrame(p, slots);
      const x0 = 360, x1 = W - 360;
      const all = items.flatMap((it) => [it.start, it.end]);
      const sc = niceScale(Math.min(...all), Math.max(...all), { ticks: 3 });
      const yOf = (v) => PB - ((v - sc.min) / (sc.max - sc.min)) * (PB - PT - 20);
      p.push(`<line x1="${x0}" y1="${PT - 10}" x2="${x0}" y2="${PB + 10}" stroke="${LINE}" stroke-width="2"/>`);
      p.push(`<line x1="${x1}" y1="${PT - 10}" x2="${x1}" y2="${PB + 10}" stroke="${LINE}" stroke-width="2"/>`);
      p.push(label(x0, 96, String(slots.start_label || '').toUpperCase(), { size: 16, fill: MUTE, mono: true, weight: 700, ls: 1.5 }));
      p.push(label(x1, 96, String(slots.end_label || '').toUpperCase(), { size: 16, fill: MUTE, mono: true, weight: 700, ls: 1.5 }));
      let focus = String(slots.focus || '').toLowerCase();
      if (!focus && items.length) focus = items.reduce((a, b) => (Math.abs(b.end - b.start) > Math.abs(a.end - a.start) ? b : a)).label.toLowerCase();
      // collision-nudged label ys per side
      const nudge = (arr) => { arr.sort((a, b) => a.y - b.y); let prev = -1e9; for (const o of arr) { o.ly = Math.max(o.y, prev + 21); prev = o.ly; } };
      const L = items.map((it) => ({ it, y: yOf(it.start) })), R = items.map((it) => ({ it, y: yOf(it.end) }));
      nudge(L); nudge(R);
      for (const it of items) {
        const hot = it.label.toLowerCase() === focus;
        const col = hot ? ACCENT : MUTE;
        p.push(`<line x1="${x0}" y1="${yOf(it.start)}" x2="${x1}" y2="${yOf(it.end)}" stroke="${col}" stroke-width="${hot ? 4 : 2.5}"/>`);
        p.push(`<circle cx="${x0}" cy="${yOf(it.start)}" r="${hot ? 6 : 4.5}" fill="${col}"/>`);
        p.push(`<circle cx="${x1}" cy="${yOf(it.end)}" r="${hot ? 6 : 4.5}" fill="${col}"/>`);
      }
      for (const o of L) {
        const hot = o.it.label.toLowerCase() === focus;
        p.push(label(x0 - 16, o.ly + 5, `${o.it.label}  ${fmt(o.it.start, slots.unit)}`, { size: 15, fill: hot ? ACCENT : INK, weight: hot ? 700 : 500, anchor: 'end' }));
      }
      for (const o of R) {
        const hot = o.it.label.toLowerCase() === focus;
        p.push(label(x1 + 16, o.ly + 5, `${fmt(o.it.end, slots.unit)}  ${o.it.label}`, { size: 15, fill: hot ? ACCENT : INK, weight: hot ? 700 : 500, anchor: 'start' }));
      }
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── arrow plot: compact before→after for lots of categories ───────────────
  chart_arrow: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), from_label (<=12 chars, what the tail is, e.g. "2015"), to_label (<=12 chars, the head), items (array of 3-10 { label (<=20 chars), from (number), to (number) }), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const items = (slots.items || []).slice(0, 10)
        .map((it) => ({ label: String(it.label || ''), from: num(it.from), to: num(it.to) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!items.length) return emptyFrame(p, slots);
      const x0 = 330, x1 = W - 90;
      const all = items.flatMap((it) => [it.from, it.to]);
      const sc = niceScale(Math.min(...all), Math.max(...all), { ticks: 4 });
      const xOf = (v) => x0 + ((v - sc.min) / (sc.max - sc.min)) * (x1 - x0);
      for (const t of sc.ticks) {
        p.push(`<line x1="${xOf(t)}" y1="${PT - 6}" x2="${xOf(t)}" y2="${PB}" stroke="${LINE}" stroke-width="1.5"/>`);
        p.push(label(xOf(t), PB + 30, fmt(t, slots.unit), { size: 13, fill: MUTE, mono: true, weight: 500 }));
      }
      const rowH = (PB - PT) / Math.max(1, items.length);
      items.forEach((it, i) => {
        const y = PT + rowH * i + rowH / 2;
        const up = it.to >= it.from, col = up ? ACCENT : MUTE;
        p.push(label(x0 - 20, y + 5, it.label, { size: fit(it.label, 220, 16), fill: INK, weight: 600, anchor: 'end' }));
        const a = xOf(it.from), b = xOf(it.to);
        p.push(`<line x1="${a}" y1="${y}" x2="${b}" y2="${y}" stroke="${col}" stroke-width="3.5"/>`);
        p.push(`<circle cx="${a}" cy="${y}" r="4.5" fill="${PAPER}" stroke="${col}" stroke-width="2.5"/>`);
        const dir = b >= a ? 1 : -1;
        p.push(`<path d="M ${b} ${y} l ${-11 * dir} -6.5 l 0 13 Z" fill="${col}"/>`);
        p.push(label(b + dir * 18, y + 5, fmt(it.to, slots.unit), { size: 13, fill: col, mono: true, weight: 700, anchor: dir > 0 ? 'start' : 'end' }));
      });
      p.push(label(x0 - 20, 96, `${String(slots.from_label || '').toUpperCase()} → ${String(slots.to_label || '').toUpperCase()}`, { size: 14, fill: MUTE, mono: true, weight: 500, ls: 1.5, anchor: 'end' }));
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── bar chart: THE workhorse for comparing amounts and shares ─────────────
  chart_bar: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), items (array of 2-10 { label (<=22 chars), value (number), note (optional <=14 chars, prints after the value) }), sort ("desc" default | "none" to keep given order), accent_label (optional: one label to print in the accent; default = the largest), unit (optional, "%" for shares), caption (optional <=72 chars)',
    build(slots) {
      let items = (slots.items || []).slice(0, 10)
        .map((it) => ({ label: String(it.label || ''), value: num(it.value), note: it.note ? String(it.note) : '' }));
      if (slots.sort !== 'none') items = items.sort((a, b) => b.value - a.value);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const x0 = 340, x1 = W - 200;
      const sc = niceScale(0, Math.max(...items.map((i) => i.value), 1), { zero: true, ticks: 4 });
      const wOf = (v) => (Math.max(0, v) / sc.max) * (x1 - x0);
      const rowH = (PB - PT + 20) / Math.max(1, items.length);
      const bh = Math.min(52, rowH * 0.62);
      const accentLabel = String(slots.accent_label || '').toLowerCase();
      const maxV = Math.max(...items.map((i) => i.value));
      items.forEach((it, i) => {
        const y = PT - 10 + rowH * i + rowH / 2;
        const hot = accentLabel ? it.label.toLowerCase() === accentLabel : it.value === maxV;
        p.push(label(x0 - 18, y + 6, it.label, { size: fit(it.label, 240, 17), fill: INK, weight: hot ? 700 : 500, anchor: 'end' }));
        p.push(`<rect x="${x0}" y="${y - bh / 2}" width="${Math.max(2, wOf(it.value))}" height="${bh}" fill="${hot ? ACCENT : INK}"/>`);
        const vt = fmt(it.value, slots.unit) + (it.note ? `  ${it.note}` : '');
        p.push(label(x0 + wOf(it.value) + 14, y + 6, vt, { size: 15, fill: hot ? ACCENT : INK, mono: true, weight: 700, anchor: 'start' }));
      });
      p.push(`<line x1="${x0}" y1="${PT - 24}" x2="${x0}" y2="${PB + 14}" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── stacked bars: compositions across rows (surveys, splits) ──────────────
  chart_bar_stacked: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), legend (array of 2-5 segment names, <=14 chars each), rows (array of 2-8 { label (<=20 chars), values (numbers, one per legend entry) }), mode ("share" each row scaled to 100% — right for surveys | "absolute" raw values), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const legend = (slots.legend || []).slice(0, 5).map(String);
      const rows = (slots.rows || []).slice(0, 8)
        .map((r) => ({ label: String(r.label || ''), values: (r.values || []).slice(0, legend.length).map(num) }));
      const mode = slots.mode === 'absolute' ? 'absolute' : 'share';
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const x0 = 320, x1 = W - 110;
      const maxTotal = Math.max(...rows.map((r) => r.values.reduce((a, b) => a + Math.max(0, b), 0)), 1);
      let lx = x0;
      legend.forEach((name, i) => {
        p.push(`<rect x="${lx}" y="86" width="14" height="14" fill="${segFill(i)}" stroke="${LINE}" stroke-width="1"/>`);
        p.push(label(lx + 22, 98, name, { size: 14, fill: INK, weight: 600, anchor: 'start' }));
        lx += 22 + name.length * 8.5 + 30;
      });
      const rowH = (PB - PT) / Math.max(1, rows.length);
      const bh = Math.min(50, rowH * 0.6);
      rows.forEach((r, i) => {
        const y = PT + rowH * i + rowH / 2;
        const total = r.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
        const scaleW = (x1 - x0) * (mode === 'share' ? 1 : total / maxTotal);
        p.push(label(x0 - 18, y + 5, r.label, { size: fit(r.label, 220, 16), fill: INK, weight: 500, anchor: 'end' }));
        let x = x0;
        r.values.forEach((v, k) => {
          const w = (Math.max(0, v) / total) * scaleW;
          p.push(`<rect x="${x}" y="${y - bh / 2}" width="${w}" height="${bh}" fill="${segFill(k)}" stroke="${PAPER}" stroke-width="2"/>`);
          const t = mode === 'share' ? `${Math.round((v / total) * 100)}%` : fmt(v, slots.unit);
          if (w > t.length * 9 + 10) p.push(label(x + w / 2, y + 5, t, { size: 13, fill: segText(k), mono: true, weight: 700 }));
          x += w;
        });
        if (mode === 'absolute') p.push(label(x + 12, y + 5, fmt(total, slots.unit), { size: 13, fill: MUTE, mono: true, weight: 700, anchor: 'start' }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── grouped bars: 2-3 values compared within each category ────────────────
  chart_bar_grouped: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), legend (array of 2-3 value names, <=14 chars each), groups (array of 2-6 { label (<=20 chars), values (numbers, one per legend entry) }), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const legend = (slots.legend || []).slice(0, 3).map(String);
      const groups = (slots.groups || []).slice(0, 6)
        .map((g) => ({ label: String(g.label || ''), values: (g.values || []).slice(0, legend.length).map(num) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const x0 = 320, x1 = W - 180;
      const sc = niceScale(0, Math.max(...groups.flatMap((g) => g.values), 1), { zero: true, ticks: 4 });
      const wOf = (v) => (Math.max(0, v) / sc.max) * (x1 - x0);
      let lx = x0;
      legend.forEach((name, i) => {
        p.push(`<rect x="${lx}" y="86" width="14" height="14" fill="${i === 0 ? INK : i === 1 ? ACCENT : MUTE}"/>`);
        p.push(label(lx + 22, 98, name, { size: 14, fill: INK, weight: 600, anchor: 'start' }));
        lx += 22 + name.length * 8.5 + 30;
      });
      const groupH = (PB - PT) / Math.max(1, groups.length);
      const bh = Math.min(20, (groupH * 0.66) / legend.length);
      groups.forEach((g, i) => {
        const yTop = PT + groupH * i + (groupH - bh * legend.length) / 2;
        p.push(label(x0 - 18, yTop + (bh * legend.length) / 2 + 5, g.label, { size: fit(g.label, 220, 16), fill: INK, weight: 600, anchor: 'end' }));
        g.values.forEach((v, k) => {
          const y = yTop + k * (bh + 3);
          const fill = k === 0 ? INK : k === 1 ? ACCENT : MUTE;
          p.push(`<rect x="${x0}" y="${y}" width="${Math.max(2, wOf(v))}" height="${bh}" fill="${fill}"/>`);
          p.push(label(x0 + wOf(v) + 10, y + bh / 2 + 5, fmt(v, slots.unit), { size: 12, fill, mono: true, weight: 700, anchor: 'start' }));
        });
      });
      p.push(`<line x1="${x0}" y1="${PT - 14}" x2="${x0}" y2="${PB + 10}" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── split bars: two components mirrored (incl. population pyramid) ────────
  chart_bar_split: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), left_name (<=14 chars, prints in the accent), right_name (<=14 chars, prints in ink), rows (array of 3-12 { label (<=12 chars, the shared category, e.g. an age band), left (number), right (number) }), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const rows = (slots.rows || []).slice(0, 12)
        .map((r) => ({ label: String(r.label || ''), left: num(r.left), right: num(r.right) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const cx = W / 2, gutter = 62;
      const maxV = Math.max(...rows.flatMap((r) => [r.left, r.right]), 1);
      const span = (W / 2) - gutter - 120;
      const wOf = (v) => (Math.max(0, v) / maxV) * span;
      p.push(label(cx - gutter - span / 2, 96, String(slots.left_name || '').toUpperCase(), { size: 16, fill: ACCENT, mono: true, weight: 700, ls: 1.5 }));
      p.push(label(cx + gutter + span / 2, 96, String(slots.right_name || '').toUpperCase(), { size: 16, fill: INK, mono: true, weight: 700, ls: 1.5 }));
      const rowH = (PB - PT) / Math.max(1, rows.length);
      const bh = Math.min(34, rowH * 0.68);
      rows.forEach((r, i) => {
        const y = PT + rowH * i + rowH / 2;
        p.push(label(cx, y + 5, r.label, { size: fit(r.label, gutter * 2 - 16, 14, { mono: true }), fill: MUTE, mono: true, weight: 600 }));
        p.push(`<rect x="${cx - gutter - wOf(r.left)}" y="${y - bh / 2}" width="${wOf(r.left)}" height="${bh}" fill="${ACCENT}"/>`);
        p.push(`<rect x="${cx + gutter}" y="${y - bh / 2}" width="${wOf(r.right)}" height="${bh}" fill="${INK}"/>`);
        p.push(label(cx - gutter - wOf(r.left) - 10, y + 5, fmt(r.left, slots.unit), { size: 12, fill: ACCENT, mono: true, weight: 700, anchor: 'end' }));
        p.push(label(cx + gutter + wOf(r.right) + 10, y + 5, fmt(r.right, slots.unit), { size: 12, fill: INK, mono: true, weight: 700, anchor: 'start' }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── dot plot: several values per category, space-efficient ────────────────
  chart_dot: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), legend (array of 1-4 value names <=14 chars — dot 1 is ink, dot 2 accent, then mute/hollow), rows (array of 3-10 { label (<=20 chars), values (numbers, one per legend entry) }), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const legend = (slots.legend || []).slice(0, 4).map(String);
      const rows = (slots.rows || []).slice(0, 10)
        .map((r) => ({ label: String(r.label || ''), values: (r.values || []).slice(0, Math.max(1, legend.length)).map(num) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!rows.length || rows.every((r) => !r.values.length)) return emptyFrame(p, slots);
      const x0 = 330, x1 = W - 110;
      const all = rows.flatMap((r) => r.values);
      const sc = niceScale(Math.min(...all), Math.max(...all), { ticks: 4 });
      const xOf = (v) => x0 + ((v - sc.min) / (sc.max - sc.min)) * (x1 - x0);
      for (const t of sc.ticks) {
        p.push(`<line x1="${xOf(t)}" y1="${PT - 6}" x2="${xOf(t)}" y2="${PB}" stroke="${LINE}" stroke-width="1.5"/>`);
        p.push(label(xOf(t), PB + 30, fmt(t, slots.unit), { size: 13, fill: MUTE, mono: true, weight: 500 }));
      }
      const dotStyle = (k) => [
        `fill="${INK}"`,
        `fill="${ACCENT}"`,
        `fill="${MUTE}"`,
        `fill="${PAPER}" stroke="${INK}" stroke-width="2.5"`,
      ][k % 4];
      let lx = x0;
      legend.forEach((name, k) => {
        p.push(`<circle cx="${lx + 7}" cy="92" r="7" ${dotStyle(k)}/>`);
        p.push(label(lx + 22, 98, name, { size: 14, fill: INK, weight: 600, anchor: 'start' }));
        lx += 22 + name.length * 8.5 + 30;
      });
      const rowH = (PB - PT) / Math.max(1, rows.length);
      rows.forEach((r, i) => {
        const y = PT + rowH * i + rowH / 2;
        p.push(label(x0 - 18, y + 5, r.label, { size: fit(r.label, 230, 16), fill: INK, weight: 500, anchor: 'end' }));
        p.push(`<line x1="${xOf(Math.min(...r.values))}" y1="${y}" x2="${xOf(Math.max(...r.values))}" y2="${y}" stroke="${LINE}" stroke-width="2.5"/>`);
        r.values.forEach((v, k) => p.push(`<circle cx="${xOf(v)}" cy="${y}" r="8" ${dotStyle(k)}/>`));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── pie / donut: a simple share of a whole ────────────────────────────────
  chart_pie: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), slices (array of 2-5 { label (<=16 chars), value (number) } — biggest first; the FIRST slice prints in the accent), mode ("donut" default | "pie"), center_stat (optional <=8 chars, prints inside a donut, e.g. "73%"), center_label (optional <=16 chars under the stat), unit (optional, default "%"), caption (optional <=72 chars)',
    build(slots) {
      const slices = (slots.slices || []).slice(0, 5)
        .map((s) => ({ label: String(s.label || ''), value: Math.max(0, num(s.value)) }));
      const mode = slots.mode === 'pie' ? 'pie' : 'donut';
      const unit = slots.unit === undefined ? '%' : slots.unit;
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const cx = 430, cy = 350, R = 185, r = mode === 'donut' ? 108 : 0;
      const total = slices.reduce((a, s) => a + s.value, 0) || 1;
      const fills = [ACCENT, INK, MUTE, ACCENT_WASH, CARDHI];
      let a0 = -Math.PI / 2;
      const legendYs = [];
      slices.forEach((s, i) => {
        const frac = s.value / total;
        const a1 = a0 + frac * Math.PI * 2;
        const large = frac > 0.5 ? 1 : 0;
        const [x0s, y0s] = [cx + R * Math.cos(a0), cy + R * Math.sin(a0)];
        const [x1s, y1s] = [cx + R * Math.cos(a1), cy + R * Math.sin(a1)];
        if (mode === 'donut') {
          const [xi1, yi1] = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
          const [xi0, yi0] = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
          p.push(`<path d="M ${x0s} ${y0s} A ${R} ${R} 0 ${large} 1 ${x1s} ${y1s} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z" fill="${fills[i % 5]}" stroke="${PAPER}" stroke-width="3"/>`);
        } else {
          p.push(`<path d="M ${cx} ${cy} L ${x0s} ${y0s} A ${R} ${R} 0 ${large} 1 ${x1s} ${y1s} Z" fill="${fills[i % 5]}" stroke="${PAPER}" stroke-width="3"/>`);
        }
        legendYs.push({ i, s, frac });
        a0 = a1;
      });
      if (mode === 'donut' && slots.center_stat) {
        p.push(label(cx, cy + 12, String(slots.center_stat), { size: 58, fill: INK, weight: 700, ls: -1 }));
        if (slots.center_label) p.push(label(cx, cy + 44, String(slots.center_label).toUpperCase(), { size: 13, fill: MUTE, mono: true, weight: 500, ls: 1 }));
      }
      // side legend with values — circle sections are hard to compare, so print the numbers
      const ly0 = 350 - legendYs.length * 27;
      legendYs.forEach(({ i, s, frac }, k) => {
        const y = ly0 + k * 54;
        p.push(`<rect x="740" y="${y}" width="18" height="18" fill="${fills[i % 5]}" stroke="${LINE}" stroke-width="1"/>`);
        p.push(label(770, y + 15, s.label, { size: 17, fill: INK, weight: i === 0 ? 700 : 500, anchor: 'start' }));
        p.push(label(W - 90, y + 15, unit === '%' ? `${Math.round(frac * 100)}%` : fmt(s.value, unit), { size: 16, fill: i === 0 ? ACCENT : MUTE, mono: true, weight: 700, anchor: 'end' }));
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── parliament: seats in a hemicycle ──────────────────────────────────────
  chart_parliament: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), parties (array of 2-8 { label (<=14 chars), seats (integer) } in seating order left to right; the FIRST prints in the accent), majority (optional integer — draws the majority line with this number), caption (optional <=72 chars)',
    build(slots) {
      const parties = (slots.parties || []).slice(0, 8)
        .map((x) => ({ label: String(x.label || ''), seats: Math.max(0, Math.round(num(x.seats))) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const total = parties.reduce((a, x) => a + x.seats, 0) || 1;
      const cx = W / 2, cy = 500;
      // choose row count so dots fill a hemicycle nicely
      const rows = Math.max(3, Math.min(9, Math.ceil(Math.sqrt(total / 2))));
      const R0 = 150, R1 = 320;
      const seatsPerRow = [];
      let acc = 0;
      for (let ri = 0; ri < rows; ri++) {
        const rr = R0 + ((R1 - R0) * ri) / Math.max(1, rows - 1);
        seatsPerRow.push(Math.round((rr / ((R0 + R1) / 2)) * (total / rows)));
        acc += seatsPerRow[ri];
      }
      seatsPerRow[rows - 1] += total - acc; // absorb rounding
      // seat angles row by row, then color in party order sweeping left→right
      const seats = [];
      seatsPerRow.forEach((n, ri) => {
        const rr = R0 + ((R1 - R0) * ri) / Math.max(1, rows - 1);
        for (let k = 0; k < Math.max(0, n); k++) {
          const a = Math.PI - (n > 1 ? (k / (n - 1)) : 0.5) * Math.PI;
          seats.push({ a, x: cx + rr * Math.cos(a), y: cy - rr * Math.sin(a) });
        }
      });
      seats.sort((s1, s2) => s2.a - s1.a);
      const fills = [ACCENT, INK, MUTE, ACCENT_WASH, CARDHI, INK, MUTE, ACCENT_WASH];
      let si = 0;
      parties.forEach((party, i) => {
        for (let k = 0; k < party.seats && si < seats.length; k++, si++) {
          const s = seats[si];
          p.push(`<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="9" fill="${fills[i % fills.length]}" stroke="${PAPER}" stroke-width="1.5"/>`);
        }
      });
      if (slots.majority) {
        p.push(`<line x1="${cx}" y1="${cy - R1 - 26}" x2="${cx}" y2="${cy - R0 + 30}" stroke="${INK}" stroke-width="2" stroke-dasharray="6 5"/>`);
        p.push(label(cx, cy - R1 - 40, `MAJORITY ${Math.round(num(slots.majority))}`, { size: 13, fill: MUTE, mono: true, weight: 700, ls: 1 }));
      }
      let lx = 200;
      parties.forEach((party, i) => {
        p.push(`<circle cx="${lx + 8}" cy="${560}" r="8" fill="${fills[i % fills.length]}" stroke="${LINE}" stroke-width="1"/>`);
        p.push(label(lx + 24, 566, `${party.label} ${party.seats}`, { size: 15, fill: INK, weight: i === 0 ? 700 : 500, anchor: 'start' }));
        lx += 24 + (party.label.length + String(party.seats).length) * 9 + 36;
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── waffle: an illustrative 10x10 share of a whole ────────────────────────
  chart_waffle: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), parts (array of 1-4 { label (<=18 chars), value (number) } — of a total; FIRST part prints in the accent), total (optional, default = sum of parts or 100), unit (optional, default "%"), caption (optional <=72 chars)',
    build(slots) {
      const parts = (slots.parts || []).slice(0, 4)
        .map((x) => ({ label: String(x.label || ''), value: Math.max(0, num(x.value)) }));
      const sum = parts.reduce((a, x) => a + x.value, 0);
      const total = Math.max(num(slots.total) || 0, sum) || 100;
      const unit = slots.unit === undefined ? '%' : slots.unit;
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const grid = 10, cell = 40, gap = 6;
      const gx = 300, gy = 130;
      const fills = [ACCENT, INK, MUTE, ACCENT_WASH];
      // unit count per part out of 100 cells, filled bottom-left rows first
      const cells = parts.map((x) => Math.round((x.value / total) * 100));
      let ci = 0;
      for (let idx = 0; idx < 100; idx++) {
        const row = grid - 1 - Math.floor(idx / grid), col = idx % grid;
        let acc = 0, fill = CARDHI, stroke = LINE;
        for (let k = 0; k < parts.length; k++) {
          acc += cells[k];
          if (idx < acc) { fill = fills[k % 4]; stroke = PAPER; break; }
        }
        p.push(`<rect x="${gx + col * (cell + gap)}" y="${gy + row * (cell + gap)}" width="${cell}" height="${cell}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
        ci++;
      }
      const lx = gx + grid * (cell + gap) + 60;
      const ly0 = 300 - parts.length * 30;
      parts.forEach((x, k) => {
        const y = ly0 + k * 62;
        p.push(`<rect x="${lx}" y="${y}" width="18" height="18" fill="${fills[k % 4]}" stroke="${LINE}" stroke-width="1"/>`);
        p.push(label(lx + 30, y + 15, x.label, { size: 17, fill: INK, weight: k === 0 ? 700 : 500, anchor: 'start' }));
        p.push(label(lx + 30, y + 38, unit === '%' ? `${Math.round((x.value / total) * 100)}%` : fmt(x.value, unit), { size: 15, fill: k === 0 ? ACCENT : MUTE, mono: true, weight: 700, anchor: 'start' }));
      });
      p.push(label(gx, gy + grid * (cell + gap) + 26, `EACH SQUARE = ${fmt(total / 100, unit)}`, { size: 12, fill: MUTE, mono: true, weight: 500, ls: 1, anchor: 'start' }));
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── treemap: proportional rectangles, room for more categories than a pie ─
  chart_treemap: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), items (array of 3-12 { label (<=16 chars), value (number) } — biggest prints in the accent), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const items = (slots.items || []).slice(0, 12)
        .map((x) => ({ label: String(x.label || ''), value: Math.max(0.0001, num(x.value)) }))
        .sort((a, b) => b.value - a.value);
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const X = 90, Y = 100, TW = W - 180, TH = 500;
      const total = items.reduce((a, x) => a + x.value, 0);
      // slice-and-dice with alternating direction — simple, stable, readable
      const place = (list, x, y, w, h, horiz) => {
        if (!list.length) return [];
        if (list.length === 1) return [{ ...list[0], x, y, w, h }];
        const sum = list.reduce((a, it) => a + it.value, 0);
        let accV = 0, split = 1;
        for (let i = 0; i < list.length - 1; i++) { accV += list[i].value; if (accV >= sum / 2) { split = i + 1; break; } }
        const first = list.slice(0, split), rest = list.slice(split);
        const fFrac = first.reduce((a, it) => a + it.value, 0) / sum;
        if (horiz) {
          return [...place(first, x, y, w * fFrac, h, !horiz), ...place(rest, x + w * fFrac, y, w * (1 - fFrac), h, !horiz)];
        }
        return [...place(first, x, y, w, h * fFrac, !horiz), ...place(rest, x, y + h * fFrac, w, h * (1 - fFrac), !horiz)];
      };
      const rects = place(items, X, Y, TW, TH, true);
      const cycle = [INK, MUTE, ACCENT_WASH, CARDHI]; // after the accented #1, tokens only
      rects.forEach((r0, i) => {
        const fill = i === 0 ? ACCENT : cycle[(i - 1) % cycle.length];
        const light = fill === ACCENT_WASH || fill === CARDHI;
        p.push(`<rect x="${r0.x.toFixed(1)}" y="${r0.y.toFixed(1)}" width="${r0.w.toFixed(1)}" height="${r0.h.toFixed(1)}" fill="${fill}" stroke="${PAPER}" stroke-width="3"/>`);
        if (r0.w > 90 && r0.h > 54) {
          p.push(label(r0.x + 14, r0.y + 30, r0.label, { size: fit(r0.label, r0.w - 24, 17), fill: light ? INK : PAPER, weight: 700, anchor: 'start' }));
          p.push(label(r0.x + 14, r0.y + 52, `${fmt(r0.value, slots.unit)} · ${Math.round((r0.value / total) * 100)}%`, { size: 13, fill: light ? MUTE : (fill === MUTE ? PAPER : LINE), mono: true, weight: 500, anchor: 'start' }));
        }
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── marimekko: shares AND absolute size at once ───────────────────────────
  chart_marimekko: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), legend (array of 2-4 segment names <=14 chars), columns (array of 2-6 { label (<=14 chars), total (number — sets the column WIDTH), values (numbers, one per legend entry — set the column\'s internal split) }), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const legend = (slots.legend || []).slice(0, 4).map(String);
      const cols = (slots.columns || []).slice(0, 6)
        .map((c) => ({ label: String(c.label || ''), total: Math.max(0.0001, num(c.total)), values: (c.values || []).slice(0, legend.length).map(num) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      const X = 110, Y = 130, MW = W - 220, MH = 420;
      const grand = cols.reduce((a, c) => a + c.total, 0);
      let lx = X;
      legend.forEach((name, i) => {
        p.push(`<rect x="${lx}" y="88" width="14" height="14" fill="${segFill(i)}" stroke="${LINE}" stroke-width="1"/>`);
        p.push(label(lx + 22, 100, name, { size: 14, fill: INK, weight: 600, anchor: 'start' }));
        lx += 22 + name.length * 8.5 + 30;
      });
      let x = X;
      cols.forEach((c) => {
        const cw = (c.total / grand) * MW;
        const colSum = c.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
        let y = Y;
        c.values.forEach((v, k) => {
          const hgt = (Math.max(0, v) / colSum) * MH;
          p.push(`<rect x="${x}" y="${y}" width="${cw}" height="${hgt}" fill="${segFill(k)}" stroke="${PAPER}" stroke-width="2.5"/>`);
          const pct = Math.round((v / colSum) * 100);
          if (hgt > 30 && cw > 62) p.push(label(x + cw / 2, y + hgt / 2 + 5, `${pct}%`, { size: 13, fill: segText(k), mono: true, weight: 700 }));
          y += hgt;
        });
        p.push(label(x + cw / 2, Y + MH + 30, c.label, { size: fit(c.label, cw + 14, 15, { mono: true }), fill: INK, mono: true, weight: 700 }));
        p.push(label(x + cw / 2, Y + MH + 52, fmt(c.total, slots.unit), { size: 12, fill: MUTE, mono: true, weight: 500 }));
        x += cw;
      });
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── scatter: does X relate to Y? (bubble when sizes are given) ────────────
  chart_scatter: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x_label (<=20 chars caps), y_label (<=20 chars caps), points (array of 5-40 { x (number), y (number), label (optional <=14 chars — ONLY the points worth naming), size (optional number — makes it a bubble chart, scaled by AREA), hot (optional true — prints in the accent) }), unit_x (optional), unit_y (optional), caption (optional <=72 chars)',
    build(slots) {
      const pts = (slots.points || []).slice(0, 40)
        .map((q) => ({ x: num(q.x), y: num(q.y), label: q.label ? String(q.label) : '', size: q.size !== undefined ? Math.max(0, num(q.size)) : null, hot: !!q.hot }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!pts.length) return emptyFrame(p, slots);
      const X0 = 150, X1 = W - 90, Y0 = PB, Y1 = PT + 10;
      const sx = niceScale(Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.x)), { ticks: 4 });
      const sy = niceScale(Math.min(...pts.map((q) => q.y)), Math.max(...pts.map((q) => q.y)), { ticks: 4 });
      const xOf = (v) => X0 + ((v - sx.min) / (sx.max - sx.min)) * (X1 - X0);
      const yOf = (v) => Y0 - ((v - sy.min) / (sy.max - sy.min)) * (Y0 - Y1);
      for (const t of sy.ticks) {
        p.push(`<line x1="${X0}" y1="${yOf(t)}" x2="${X1}" y2="${yOf(t)}" stroke="${LINE}" stroke-width="1.5"/>`);
        p.push(label(X0 - 12, yOf(t) + 5, fmt(t, slots.unit_y), { size: 13, fill: MUTE, mono: true, weight: 500, anchor: 'end' }));
      }
      for (const t of sx.ticks) {
        p.push(`<line x1="${xOf(t)}" y1="${Y0}" x2="${xOf(t)}" y2="${Y0 + 8}" stroke="${MUTE}" stroke-width="1.5"/>`);
        p.push(label(xOf(t), Y0 + 30, fmt(t, slots.unit_x), { size: 13, fill: MUTE, mono: true, weight: 500 }));
      }
      const maxSize = Math.max(...pts.map((q) => q.size || 0), 1);
      const rOf = (q) => (q.size == null ? 8 : 7 + Math.sqrt(q.size / maxSize) * 21); // AREA-true bubbles
      for (const q of pts.filter((q0) => !q0.hot)) {
        p.push(`<circle cx="${xOf(q.x).toFixed(1)}" cy="${yOf(q.y).toFixed(1)}" r="${rOf(q).toFixed(1)}" fill="${INK}" fill-opacity="0.55" stroke="${PAPER}" stroke-width="1.5"/>`);
      }
      for (const q of pts.filter((q0) => q0.hot)) {
        p.push(`<circle cx="${xOf(q.x).toFixed(1)}" cy="${yOf(q.y).toFixed(1)}" r="${rOf(q).toFixed(1)}" fill="${ACCENT}" stroke="${PAPER}" stroke-width="2"/>`);
      }
      for (const q of pts.filter((q0) => q0.label)) {
        p.push(label(xOf(q.x), yOf(q.y) - rOf(q) - 8, q.label, { size: 14, fill: q.hot ? ACCENT : INK, weight: 700 }));
      }
      p.push(label((X0 + X1) / 2, Y0 + 56, String(slots.x_label || '').toUpperCase(), { size: 14, fill: MUTE, mono: true, weight: 700, ls: 1.5 }));
      p.push(`<text x="${64}" y="${(Y0 + Y1) / 2}" transform="rotate(-90 64 ${(Y0 + Y1) / 2})" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="14" letter-spacing="1.5" fill="${MUTE}">${esc(String(slots.y_label || '').toUpperCase())}</text>`);
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── heatmap: a matrix of intensity (incl. dense-scatter 2D histograms) ────
  chart_heatmap: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), x (array of 3-14 column labels <=8 chars), y (array of 2-8 row labels <=16 chars), values (array of rows, each an array of numbers matching x — higher = darker), unit (optional), show_values (optional true — print the number in each cell), caption (optional <=72 chars)',
    build(slots) {
      const xs = (slots.x || []).slice(0, 14).map(String);
      const ys = (slots.y || []).slice(0, 8).map(String);
      const rows = (slots.values || []).slice(0, ys.length).map((r) => (r || []).slice(0, xs.length).map(num));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!xs.length || !ys.length || !rows.flat().length) return emptyFrame(p, slots);
      const X = 300, Y = 130, MW2 = W - 400, MH2 = 420;
      const cw = MW2 / Math.max(1, xs.length), ch = MH2 / Math.max(1, ys.length);
      const all = rows.flat();
      const lo = Math.min(...all), hi = Math.max(...all);
      const ramp = (v) => (hi === lo ? ACCENT_WASH : hexLerp(ACCENT_WASH, ACCENT, Math.pow((v - lo) / (hi - lo), 0.85)));
      ys.forEach((yl, i) => {
        p.push(label(X - 16, Y + i * ch + ch / 2 + 5, yl, { size: fit(yl, 200, 15), fill: INK, weight: 500, anchor: 'end' }));
        xs.forEach((xl, j) => {
          const v = rows[i]?.[j] ?? lo;
          p.push(`<rect x="${(X + j * cw).toFixed(1)}" y="${(Y + i * ch).toFixed(1)}" width="${(cw - 3).toFixed(1)}" height="${(ch - 3).toFixed(1)}" fill="${ramp(v)}"/>`);
          if (slots.show_values && cw > 52 && ch > 34) {
            const dark = (v - lo) / ((hi - lo) || 1) > 0.55;
            p.push(label(X + j * cw + (cw - 3) / 2, Y + i * ch + ch / 2 + 4, fmt(v, ''), { size: 12, fill: dark ? PAPER : INK, mono: true, weight: 600 }));
          }
        });
      });
      xs.forEach((xl, j) => {
        p.push(label(X + j * cw + cw / 2, Y + MH2 + 26, xl, { size: fit(xl, cw - 4, 13, { mono: true }), fill: MUTE, mono: true, weight: 500 }));
      });
      // scale strip
      const swX = X, swY = Y - 34;
      for (let k = 0; k < 8; k++) p.push(`<rect x="${swX + k * 22}" y="${swY}" width="22" height="12" fill="${hexLerp(ACCENT_WASH, ACCENT, k / 7)}"/>`);
      p.push(label(swX - 10, swY + 11, fmt(lo, slots.unit), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'end' }));
      p.push(label(swX + 8 * 22 + 10, swY + 11, fmt(hi, slots.unit), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'start' }));
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── sankey: volume flowing from sources to destinations ───────────────────
  chart_sankey: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), flows (array of 2-9 { from (<=16 chars), to (<=16 chars), value (number) } — the LARGEST flow prints in the accent), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const flows = (slots.flows || []).slice(0, 9)
        .map((f) => ({ from: String(f.from || ''), to: String(f.to || ''), value: Math.max(0.0001, num(f.value)) }));
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!flows.length) return emptyFrame(p, slots);
      const X0 = 320, X1 = W - 320, Y = 120, MH3 = 440, NW = 26, GAPN = 18;
      const lefts = [...new Set(flows.map((f) => f.from))];
      const rights = [...new Set(flows.map((f) => f.to))];
      const sumBy = (list, key, name) => list.filter((f) => f[key] === name).reduce((a, f) => a + f.value, 0);
      const grand = flows.reduce((a, f) => a + f.value, 0);
      const scaleH = (MH3 - GAPN * (Math.max(lefts.length, rights.length) - 1)) / grand;
      // node positions
      const nodePos = (names, key, x) => {
        let y = Y + (MH3 - (names.reduce((a, n2) => a + sumBy(flows, key, n2) * scaleH, 0) + GAPN * (names.length - 1))) / 2;
        return names.map((n2) => {
          const h = sumBy(flows, key, n2) * scaleH;
          const o = { name: n2, x, y, h, off: 0 };
          y += h + GAPN;
          return o;
        });
      };
      const L = nodePos(lefts, 'from', X0), R = nodePos(rights, 'to', X1);
      const maxFlow = Math.max(...flows.map((f) => f.value));
      // ribbons first (under the nodes)
      const ordered = [...flows].sort((a, b) => b.value - a.value);
      for (const f of ordered) {
        const ln = L.find((o) => o.name === f.from), rn = R.find((o) => o.name === f.to);
        const h = f.value * scaleH;
        const y0a = ln.y + ln.off, y1a = rn.y + rn.off;
        ln.off += h; rn.off += h;
        const hot = f.value === maxFlow;
        const mx = (X0 + X1) / 2;
        p.push(`<path d="M ${X0 + NW} ${y0a} C ${mx} ${y0a}, ${mx} ${y1a}, ${X1} ${y1a} L ${X1} ${y1a + h} C ${mx} ${y1a + h}, ${mx} ${y0a + h}, ${X0 + NW} ${y0a + h} Z" fill="${hot ? ACCENT : INK}" fill-opacity="${hot ? 0.75 : 0.16}"/>`);
        if (h > 26) p.push(label((X0 + X1) / 2, (y0a + y1a + h) / 2 + 5, fmt(f.value, slots.unit), { size: 13, fill: hot ? PAPER : MUTE, mono: true, weight: 700 }));
      }
      for (const o of L) {
        p.push(`<rect x="${o.x}" y="${o.y}" width="${NW}" height="${o.h}" fill="${INK}"/>`);
        p.push(label(o.x - 14, o.y + o.h / 2 + 2, o.name, { size: fit(o.name, 210, 16), fill: INK, weight: 700, anchor: 'end' }));
        p.push(label(o.x - 14, o.y + o.h / 2 + 20, fmt(sumBy(flows, 'from', o.name), slots.unit), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'end' }));
      }
      for (const o of R) {
        p.push(`<rect x="${o.x}" y="${o.y}" width="${NW}" height="${o.h}" fill="${INK}"/>`);
        p.push(label(o.x + NW + 14, o.y + o.h / 2 + 2, o.name, { size: fit(o.name, 210, 16), fill: INK, weight: 700, anchor: 'start' }));
        p.push(label(o.x + NW + 14, o.y + o.h / 2 + 20, fmt(sumBy(flows, 'to', o.name), slots.unit), { size: 12, fill: MUTE, mono: true, weight: 500, anchor: 'start' }));
      }
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },

  // ── proportional areas: 2-4 magnitudes as area-true shapes ────────────────
  chart_prop_area: {
    width: W, height: H,
    slots: 'fig_label (<=42 chars caps), items (array of 2-4 { label (<=16 chars), value (number) } — biggest first; the LAST (smallest) prints in the accent so the contrast lands), shape ("circle" default | "square"), unit (optional), caption (optional <=72 chars)',
    build(slots) {
      const items = (slots.items || []).slice(0, 4)
        .map((x) => ({ label: String(x.label || ''), value: Math.max(0.0001, num(x.value)) }))
        .sort((a, b) => b.value - a.value);
      const shape = slots.shape === 'square' ? 'square' : 'circle';
      const p = svgOpen();
      p.push(figLabel(slots.fig_label));
      if (!items.length) { p.push(caption(slots.caption)); p.push('</svg>'); return p.join(''); }
      const maxV = items[0].value;
      const maxR = 205;
      const baseY = 480;
      // area-true: r ∝ sqrt(value)
      const rOf = (v) => Math.max(10, Math.sqrt(v / maxV) * maxR);
      const widths = items.map((x) => rOf(x.value) * 2);
      const gap = Math.max(40, (W - 200 - widths.reduce((a, b) => a + b, 0)) / Math.max(1, items.length - 1));
      let x = (W - (widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1))) / 2;
      items.forEach((it, i) => {
        const r = rOf(it.value);
        const cx = x + r;
        const hot = i === items.length - 1;
        const fill = hot ? ACCENT : i === 0 ? INK : MUTE;
        if (shape === 'circle') p.push(`<circle cx="${cx}" cy="${baseY - r}" r="${r}" fill="${fill}" fill-opacity="${hot ? 1 : 0.92}"/>`);
        else p.push(`<rect x="${cx - r}" y="${baseY - 2 * r}" width="${2 * r}" height="${2 * r}" fill="${fill}"/>`);
        p.push(label(cx, baseY + 36, it.label, { size: fit(it.label, Math.max(120, 2 * r), 17), fill: INK, weight: hot ? 700 : 500 }));
        p.push(label(cx, baseY + 60, fmt(it.value, slots.unit), { size: 15, fill: hot ? ACCENT : MUTE, mono: true, weight: 700 }));
        x += 2 * r + gap; // advance past this shape — without this every circle overprints the first
      });
      p.push(`<line x1="90" y1="${baseY}" x2="${W - 90}" y2="${baseY}" stroke="${INK}" stroke-width="2.5"/>`);
      p.push(caption(slots.caption));
      p.push('</svg>');
      return p.join('');
    },
  },
};

export const CHART_TEMPLATE_NAMES = Object.keys(CHART_TEMPLATES);
