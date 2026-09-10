// Daily Planner — the persisted day plan + weekly objectives, one shared pool.
//
// Both the /api/daily-plan routes AND the Nyo/planner tools delegate here, so the
// SQL lives once and every mutation logs to the activity bus. The plan itself is
// a JSON blob (schedule + to-dos), self-contained per day; it is NOT wired into
// the separate `tasks` table (deliberate — the plan is the operator-approved
// day, editable in the panel and by the planner chat).

import { now } from './util.js';
import { logEvent } from './db.js';
import { loadKpiConfig } from './kpi.js';

// Operator-local "today" (YYYY-MM-DD). Reuses the KPI timezone so the plan's day
// boundary matches the outreach counter + work week the operator already set.
export async function todayLocal(env) {
  let tz = 'UTC';
  try { const cfg = await loadKpiConfig(env); if (cfg?.tz) tz = cfg.tz; } catch { /* default UTC */ }
  try { return new Date().toLocaleDateString('en-CA', { timeZone: tz }); } // en-CA → YYYY-MM-DD
  catch { return new Date().toISOString().slice(0, 10); }
}

// The Sunday that anchors the WORKWEEK a date belongs to. The workweek is the
// operator's `work_days` (the editable kpi-outreach knowledge note, default
// Sun–Thu [0..4]) — its last day ends the week, so a later weekend day rolls to
// the NEXT week's Sunday. Reading the note keeps the rule editable (guardrail #5),
// not hardcoded here. Async because it reads that note.
export async function weekAnchor(env, dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  let lastWork = 4; // Thu — matches the default work_days [0..4]
  try {
    const cfg = await loadKpiConfig(env);
    if (Array.isArray(cfg?.work_days) && cfg.work_days.length) lastWork = Math.max(...cfg.work_days);
  } catch { /* default Sun–Thu */ }
  const wd = d.getUTCDay(); // 0=Sun .. 6=Sat
  if (wd > lastWork) d.setUTCDate(d.getUTCDate() + (7 - wd)); // weekend → next week's Sunday
  else d.setUTCDate(d.getUTCDate() - wd);                     // in/before the workweek → this week's Sunday
  return d.toISOString().slice(0, 10);
}

// ── plan shape normalization ────────────────────────────────────────────────
function normalizePlanBody(plan = {}) {
  const schedule = (Array.isArray(plan.schedule) ? plan.schedule : []).map((b, i) => ({
    id: b.id || `b${i + 1}`,
    start: b.start ? String(b.start).slice(0, 10) : null,
    end: b.end ? String(b.end).slice(0, 10) : null,
    title: String(b.title || '').slice(0, 400),
    deliverable: b.deliverable ? String(b.deliverable).slice(0, 400) : null,
    done: !!b.done,
    focus: !!b.focus,   // a ~2h Focus Session (the day's backbone) vs a regular block
  }));
  const todos = (Array.isArray(plan.todos) ? plan.todos : []).map((tk, i) => ({
    id: tk.id || `t${i + 1}`,
    text: String(tk.text || '').slice(0, 400),
    done: !!tk.done,
    star: !!tk.star,    // extra-important to-do
    priority: Number.isFinite(tk.priority) ? tk.priority : i + 1,
  }));
  return {
    summary: String(plan.summary || '').slice(0, 1000),
    weekly_ref: plan.weekly_ref ? String(plan.weekly_ref).slice(0, 10) : null,
    schedule,
    todos,
  };
}

function rowToPlan(row) {
  if (!row) return null;
  let body = {};
  try { body = JSON.parse(row.plan || '{}'); } catch { body = {}; }
  const norm = normalizePlanBody(body);
  return {
    date: row.date,
    mode: row.mode || body.mode || 'wing_it',
    summary: norm.summary,
    weekly_ref: norm.weekly_ref,
    schedule: norm.schedule,
    todos: norm.todos,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── daily plan CRUD ─────────────────────────────────────────────────────────
export async function readPlan(env, date) {
  const row = await env.DB.prepare(
    'SELECT date, plan, mode, created_at, updated_at FROM daily_plans WHERE date = ?',
  ).bind(date).first();
  return rowToPlan(row);
}

export async function savePlan(env, { date, plan = {}, mode, actor = 'daily-planner' }) {
  const t = now();
  const m = mode || plan.mode || 'wing_it';
  const body = normalizePlanBody(plan);
  const json = JSON.stringify({ mode: m, ...body });
  await env.DB.prepare(
    `INSERT INTO daily_plans (date, plan, mode, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET plan = excluded.plan, mode = excluded.mode, updated_at = excluded.updated_at`,
  ).bind(date, json, m, t, t).run();
  await logEvent(env, {
    kind: 'daily_plan_saved', actor,
    payload: { date, mode: m, blocks: body.schedule.length, todos: body.todos.length },
  });
  return readPlan(env, date);
}

// Shallow-merge edit — only the keys passed are changed; the rest are kept. Used
// by inline panel edits (whole-plan PUT) and by the planner's update tool.
export async function updatePlan(env, { date, patch = {}, actor = 'daily-planner' }) {
  const cur = await readPlan(env, date);
  if (!cur) return savePlan(env, { date, plan: patch, mode: patch.mode, actor });
  const merged = {
    summary: patch.summary !== undefined ? patch.summary : cur.summary,
    weekly_ref: patch.weekly_ref !== undefined ? patch.weekly_ref : cur.weekly_ref,
    schedule: patch.schedule !== undefined ? patch.schedule : cur.schedule,
    todos: patch.todos !== undefined ? patch.todos : cur.todos,
  };
  return savePlan(env, { date, plan: merged, mode: patch.mode || cur.mode, actor });
}

export async function searchPlans(env, { query = '', limit = 20 } = {}) {
  const q = String(query || '');
  const like = `%${q.toLowerCase()}%`;
  const lim = Math.min(Math.max(1, Number(limit) || 20), 100);
  const r = await env.DB.prepare(
    `SELECT date, plan, mode, created_at, updated_at FROM daily_plans
     WHERE ? = '' OR LOWER(plan) LIKE ? ORDER BY date DESC LIMIT ?`,
  ).bind(q, like, lim).all();
  return { query: q, results: (r.results || []).map(rowToPlan) };
}

// The most recent PAST plans (strictly before today) — the 3-day follow-up feed.
export async function recentPlans(env, { days = 3, before = null } = {}) {
  const cutoff = before || (await todayLocal(env));
  const lim = Math.min(Math.max(1, Number(days) || 3), 30);
  const r = await env.DB.prepare(
    `SELECT date, plan, mode, created_at, updated_at FROM daily_plans
     WHERE date < ? ORDER BY date DESC LIMIT ?`,
  ).bind(cutoff, lim).all();
  return { days: lim, before: cutoff, results: (r.results || []).map(rowToPlan) };
}

// ── weekly objectives (the strategic layer) ─────────────────────────────────
function rowToObjectives(row) {
  if (!row) return null;
  let objectives = [];
  try { objectives = JSON.parse(row.objectives || '[]'); } catch { objectives = []; }
  if (!Array.isArray(objectives)) objectives = [];
  return { week_start: row.week_start, objectives, created_at: row.created_at, updated_at: row.updated_at };
}

export async function readWeeklyObjectives(env, weekStart) {
  const row = await env.DB.prepare(
    'SELECT week_start, objectives, created_at, updated_at FROM weekly_objectives WHERE week_start = ?',
  ).bind(weekStart).first();
  return rowToObjectives(row);
}

export async function saveWeeklyObjectives(env, { week_start, objectives = [], actor = 'daily-planner' }) {
  const t = now();
  const norm = (Array.isArray(objectives) ? objectives : [])
    .map((o, i) => ({
      id: (o && o.id) || `o${i + 1}`,
      text: String((o && o.text) || o || '').slice(0, 400),
      done: !!(o && o.done),
    }))
    .filter((o) => o.text);
  await env.DB.prepare(
    `INSERT INTO weekly_objectives (week_start, objectives, created_at, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(week_start) DO UPDATE SET objectives = excluded.objectives, updated_at = excluded.updated_at`,
  ).bind(week_start, JSON.stringify(norm), t, t).run();
  await logEvent(env, { kind: 'weekly_objectives_saved', actor, payload: { week_start, count: norm.length } });
  return readWeeklyObjectives(env, week_start);
}
