// Daily Planner — Nyo/planner tools. Each is { def, run } returning plain JSON;
// assembled in tools/index.js. All delegate to lib/daily-planner.js (single pool,
// every mutation logged). Shared, so Nyo can read/adjust the day too.

import {
  todayLocal, weekAnchor,
  readPlan, savePlan, updatePlan, searchPlans, recentPlans,
  readWeeklyObjectives, saveWeeklyObjectives,
} from '../lib/daily-planner.js';

export const tools = {
  read_daily_plan: {
    def: {
      name: 'read_daily_plan',
      description: "Read a day's plan (schedule + to-dos). date is YYYY-MM-DD; default today. Call before editing or to see what's planned.",
      input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD; default today' } }, required: [] },
    },
    run: async (env, input) => (await readPlan(env, input.date || (await todayLocal(env)))) || { plan: null, note: 'no plan yet for this day' },
  },

  save_daily_plan: {
    def: {
      name: 'save_daily_plan',
      description: "Write (or replace) the day's plan — this is what fills the plan panel. schedule = time blocks [{start:'HH:MM', end:'HH:MM', title, deliverable, focus}]. Mark each ~2-hour FOCUS SESSION block focus:true (the operator says how many can fit) — these are the day's backbone; regular supporting blocks are focus:false. todos = [{text, priority, star}] — set star:true for the extra-important few. mode 'strategic' (aligned to the week's objectives, set weekly_ref = the week's Sunday) or 'wing_it'. date default today.",
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          mode: { type: 'string', enum: ['strategic', 'wing_it'] },
          summary: { type: 'string', description: 'one-line what-this-day-is-about' },
          weekly_ref: { type: 'string', description: "the aligned week's Sunday (YYYY-MM-DD), strategic mode" },
          schedule: { type: 'array', items: { type: 'object' }, description: 'time blocks with a concrete deliverable each' },
          todos: { type: 'array', items: { type: 'object' }, description: 'checklist items' },
        },
        required: ['schedule'],
      },
    },
    run: async (env, input) => savePlan(env, { date: input.date || (await todayLocal(env)), plan: input, mode: input.mode, actor: 'daily-planner' }),
  },

  update_daily_plan: {
    def: {
      name: 'update_daily_plan',
      description: "Edit part of a day's plan during the day (mark a block/to-do done, add a to-do, adjust the schedule). Pass ONLY the keys you're changing; the rest are kept. date default today.",
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          mode: { type: 'string' },
          summary: { type: 'string' },
          weekly_ref: { type: 'string' },
          schedule: { type: 'array', items: { type: 'object' } },
          todos: { type: 'array', items: { type: 'object' } },
        },
        required: [],
      },
    },
    run: async (env, input) => {
      const { date, ...patch } = input || {};
      return updatePlan(env, { date: date || (await todayLocal(env)), patch, actor: 'daily-planner' });
    },
  },

  search_daily_plans: {
    def: {
      name: 'search_daily_plans',
      description: 'Search past daily plans by text (matches summary, to-dos, blocks). Use to recall or reuse an earlier day. Empty query returns the most recent plans.',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: [] },
    },
    run: async (env, input) => searchPlans(env, input || {}),
  },

  list_recent_plans: {
    def: {
      name: 'list_recent_plans',
      description: 'The most recent PAST daily plans (default last 3 days, before today). Call at the start of planning to surface unfinished priorities and ask the operator their status (done / carry over / drop).',
      input_schema: { type: 'object', properties: { days: { type: 'number', description: 'default 3' } }, required: [] },
    },
    run: async (env, input) => recentPlans(env, input || {}),
  },

  read_weekly_objectives: {
    def: {
      name: 'read_weekly_objectives',
      description: "Read the current week's strategic objectives (or a given week_start, YYYY-MM-DD Sunday). Use in strategic mode to align the day.",
      input_schema: { type: 'object', properties: { week_start: { type: 'string' } }, required: [] },
    },
    run: async (env, input) => (await readWeeklyObjectives(env, input.week_start || (await weekAnchor(env, await todayLocal(env))))) || { objectives: [], note: 'no objectives set for this week yet' },
  },

  set_weekly_objectives: {
    def: {
      name: 'set_weekly_objectives',
      description: "Set this week's strategic objectives — the 2-4 outcomes that move the business in the intended direction. objectives is a list of short outcome strings (or {text}). week_start default = the current week's Sunday.",
      input_schema: { type: 'object', properties: { objectives: { type: 'array' }, week_start: { type: 'string' } }, required: ['objectives'] },
    },
    run: async (env, input) => saveWeeklyObjectives(env, { week_start: input.week_start || (await weekAnchor(env, await todayLocal(env))), objectives: input.objectives, actor: 'daily-planner' }),
  },
};
