// KPI config loader — all that remains of the KPI module. The Daily Planner
// reads tz + work_days + work_hours from the kpi-outreach knowledge doc
// through loadKpiConfig; setup seeds the doc with the OPERATOR's own timezone
// (seedKpiConfig) so a fresh install doesn't plan somebody else's week.
import { readKnowledge, writeKnowledge } from './db.js';

const KPI_SLUG = 'kpi-outreach';

export const KPI_DEFAULTS = {
  daily_target: 20,           // legacy; nothing enforces it now
  tz: 'Asia/Jerusalem',       // fresh installs get their own tz written at setup finish
  work_days: [0, 1, 2, 3, 4], // 0=Sun .. 6=Sat
  work_hours: [8, 22],
};

function kpiSeedBody(cfg) {
  return `Planner rhythm — where the Daily Planner reads its clock.

\`tz\` fixes when "today" rolls over and which weekday it is. \`work_days\` are
the weekdays the planner treats as work (0=Sun..6=Sat). \`work_hours\` frame
the day. \`daily_target\` is legacy and unenforced. Edit the JSON; the planner
reads this doc live, no deploy.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;
}

function sanitizeKpi(src) {
  const out = { ...KPI_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : null);
  const t = num(src.daily_target, 1, 1000); if (t !== null) out.daily_target = Math.round(t);
  if (typeof src.tz === 'string' && src.tz.trim()) out.tz = src.tz.trim();
  if (Array.isArray(src.work_days)) {
    const days = [...new Set(src.work_days.map((d) => num(d, 0, 6)).filter((d) => d !== null))].sort();
    if (days.length) out.work_days = days;
  }
  if (Array.isArray(src.work_hours) && src.work_hours.length === 2) {
    const a = num(src.work_hours[0], 0, 23), b = num(src.work_hours[1], 1, 24);
    if (a !== null && b !== null && a < b) out.work_hours = [a, b];
  }
  return out;
}

export async function loadKpiConfig(env) {
  try {
    const doc = await readKnowledge(env, KPI_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: KPI_SLUG, title: 'Planner rhythm',
        body: kpiSeedBody(KPI_DEFAULTS), parent_slug: 'nyyon-root',
      }).catch(() => {});
      return { ...KPI_DEFAULTS, source: 'defaults' };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...sanitizeKpi(m ? JSON.parse(m[1]) : null), source: m ? 'doc' : 'defaults' };
  } catch {
    return { ...KPI_DEFAULTS, source: 'defaults' };
  }
}

// Setup-finish seed: writes the doc ONCE, with the operator's browser timezone
// and a generic Mon-Fri week, so the code defaults above never leak into a
// fresh install. Existing docs (any live system) are never touched.
export async function seedKpiConfig(env, { tz } = {}) {
  const existing = await readKnowledge(env, KPI_SLUG).catch(() => null);
  if (existing) return { seeded: false };
  let zone = null;
  try { if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); zone = tz; } } catch { zone = null; }
  const cfg = { ...KPI_DEFAULTS, tz: zone || 'UTC', work_days: [1, 2, 3, 4, 5] };
  await writeKnowledge(env, {
    slug: KPI_SLUG, title: 'Planner rhythm',
    body: kpiSeedBody(cfg), parent_slug: 'nyyon-root',
  });
  return { seeded: true, tz: cfg.tz };
}
