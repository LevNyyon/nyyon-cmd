// aeo-interview.js — Nyo-driven expert interview before article writing.
//
// Flow:
//   1. Operator clicks "Interview & Write" in AEO UI (or tells Nyo to start).
//   2. Nyo calls aeo_start_interview(slug) → generates 4 targeted questions,
//      saves them, returns them so Nyo can ask the operator.
//   3. Operator answers in chat (free text, one message or several — Nyo collects).
//   4. Nyo calls aeo_write_with_answers(slug, answers_text) → saves answers,
//      fires the AEO writer with the expert context baked in.
//
// The expert_context is passed to runAeoCron as `expert_context`, which
// injects it into the LLM system prompt so the article reflects real
// first-hand experience instead of generic GPT content.

import { callOpenAIText } from './openai.js';
import { readAeoQuestion, logEvent } from './db.js';
import { now } from './util.js';

// ─── question generator ───────────────────────────────────────────────────
const QUESTION_SYSTEM = `You help a marketing agency operator produce high-quality expert blog articles.

Given an AEO question / topic, generate EXACTLY 4 interview questions to ask the operator before writing.

The questions should extract:
1. The most common mistake they see companies make (gives the article a strong critique angle)
2. The mechanism / framework that actually works, from their experience (gives the article a concrete solution)
3. A specific client example, metric, or data point they can share — even anonymised (gives the article credibility)
4. The counterintuitive or non-obvious thing most people get wrong (gives the article a distinctive edge)

Rules:
- Each question is short, direct, conversational — like a smart editor asking a writer.
- Do NOT ask generic "what is X" questions. Assume the operator already knows the theory.
- The goal is to surface their LIVED EXPERIENCE and OPINION.
- No numbering, no preamble. Output only the 4 questions, one per line.

Example output for "How do AI-native marketing teams make faster decisions?":
What's the single biggest bottleneck you see when teams try to move faster with AI — and why does it persist?
Walk me through the decision-making system you'd build if starting from scratch today.
Is there a client situation where you saw this play out — either working or failing — that you could describe without naming them?
What do most frameworks for "decision velocity" get wrong that nobody is talking about?`;

export async function generateInterviewQuestions(env, { slug, question, target_keyword, notes }) {
  const { readTasteProfile } = await import('./aeo-taste.js');
  const taste = await readTasteProfile(env).catch(() => null);
  const prompt = [
    `AEO question to rank for: "${question}"`,
    target_keyword ? `Primary keyword: ${target_keyword}` : null,
    notes ? `Notes: ${notes}` : null,
    taste ? `\nThe founder's editorial taste (learned — angle the questions to surface what he cares about):\n${taste}` : null,
    '',
    'Generate the 4 interview questions now.',
  ].filter(Boolean).join('\n');

  const raw = await callOpenAIText(env, { system: QUESTION_SYSTEM, prompt, model: 'gpt-4o-mini' });
  // Split on newlines, filter blanks
  const questions = raw.split('\n').map(q => q.trim()).filter(q => q.length > 10).slice(0, 4);
  return questions;
}

// ─── save questions (marks interview as pending) ──────────────────────────
export async function saveInterviewQuestions(env, slug, questions) {
  const t = now();
  await env.DB.prepare(
    `UPDATE aeo_questions SET interview_status = 'pending', expert_context_json = ?, updated_at = ? WHERE slug = ?`
  ).bind(JSON.stringify({ questions, answers: null, started_at: t }), t, slug).run();
  await logEvent(env, { kind: 'aeo_interview_started', actor: 'operator', payload: { slug, questions: questions?.length ?? null } }).catch(() => {});
}

// ─── save answers + mark ready to write ──────────────────────────────────
export async function saveInterviewAnswers(env, slug, answersText) {
  const row = await readAeoQuestion(env, slug);
  if (!row) throw new Error(`AEO question not found: ${slug}`);

  let ctx = {};
  try { ctx = JSON.parse(row.expert_context_json || '{}'); } catch {}

  ctx.answers    = answersText;
  ctx.answered_at = now();

  const t = now();
  await env.DB.prepare(
    `UPDATE aeo_questions SET interview_status = 'ready', expert_context_json = ?, updated_at = ? WHERE slug = ?`
  ).bind(JSON.stringify(ctx), t, slug).run();
  await logEvent(env, { kind: 'aeo_interview_answered', actor: 'operator', payload: { slug } }).catch(() => {});
}

// ─── format context for the article writer ───────────────────────────────
// Returns a markdown block injected into the LLM prompt so the writer
// treats the operator's answers as ground truth to build the article around.
export function formatExpertContext(expertContextJson) {
  if (!expertContextJson) return null;
  let ctx;
  try { ctx = JSON.parse(expertContextJson); } catch { return null; }
  if (!ctx.questions || !ctx.answers) return null;

  const lines = ['## Expert interview — operator answers (treat as authoritative source material)', ''];
  ctx.questions.forEach((q, i) => {
    lines.push(`**Q${i + 1}: ${q}**`);
  });
  lines.push('');
  lines.push('**Operator answers:**');
  lines.push(ctx.answers);
  lines.push('');
  lines.push('Use the operator\'s exact perspective, frameworks, examples, and opinions. This is first-hand expertise — build the article around it, do not dilute or genericise it.');
  return lines.join('\n');
}
