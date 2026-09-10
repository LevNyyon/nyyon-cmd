// aeo-taste.js — turns accumulated operator feedback into a living "editorial
// taste" profile, stored as the `nyyon-editorial-taste` knowledge doc.
//
// The loop:
//   1. Operator reacts to Nyo's article/question ideas (love / meh / reject /
//      "make it about X") → recordAeoFeedback logs it.
//   2. refreshTasteProfile distils ALL feedback into a concise profile doc:
//      what the operator likes, dislikes, recurring asks, banned angles.
//   3. The question generators (Sunday Brain, AEO interview) read that doc and
//      fold it into their prompts → Nyo's next ideas are sharper.
//
// The profile is a knowledge doc so it's human-readable AND editable in the
// Knowledge panel — the operator can hand-tune their own taste rules.

import { callOpenAIText } from './openai.js';
import { readKnowledge, writeKnowledge, recentAeoFeedback } from './db.js';

export const TASTE_SLUG = 'nyyon-editorial-taste';

const TASTE_SYSTEM = `You maintain the editorial TASTE PROFILE for Nyyon's founder — the rules Nyo should follow when proposing blog/AEO article ideas, learned from the founder's reactions to past ideas.

You are given: the current taste profile (may be empty) and a list of recent reactions (reaction + the idea + the founder's note). Produce an UPDATED profile that folds in the new signal. Keep it tight, concrete, and prescriptive — it will be pasted into idea-generation prompts.

Output clean markdown with these sections (omit a section if you have no signal for it):

## Angles he loves
(bullets — concrete patterns/topics/framings he reacted well to)

## Angles he rejects
(bullets — what he kills, and why, in his words where possible)

## Recurring asks
(bullets — edits he keeps requesting, e.g. "more specific", "tie to incrementality", "name the mechanism")

## Voice & framing notes
(bullets — how he wants ideas framed: contrarian, proof-led, no listicles, etc.)

Rules: synthesise, don't just list every reaction. Merge duplicates into sharper rules. Keep it under ~250 words. Only assert what the reactions support — do not invent preferences.`;

// Rebuild the taste profile from the latest feedback. Best-effort; callers
// should not fail if this errors (it's an enrichment, not a critical path).
export async function refreshTasteProfile(env) {
  const feedback = await recentAeoFeedback(env, { limit: 80 });
  if (!feedback.length) return null;

  const current = await readKnowledge(env, TASTE_SLUG).catch(() => null);
  const fbLines = feedback.map((f) => {
    const subject = f.idea_title || f.question_slug || '(idea)';
    return `- [${f.reaction}] "${subject}"${f.note ? ` — ${f.note}` : ''}`;
  }).join('\n');

  const prompt = [
    '## Current taste profile',
    current?.body || '(none yet)',
    '',
    '## Recent reactions (newest first)',
    fbLines,
    '',
    'Produce the updated taste profile now.',
  ].join('\n');

  const md = await callOpenAIText(env, { system: TASTE_SYSTEM, prompt, model: 'gpt-4o-mini' });

  await writeKnowledge(env, {
    slug: TASTE_SLUG,
    title: 'AEO · Editorial taste profile',
    body: md.trim(),
    scope: 'global',
    module: 'aeo',
    parent_slug: 'module-aeo',
  });
  return md.trim();
}

// Read the taste profile body for injection into a generation prompt. Returns
// null when there's no profile yet (generators then run without it).
export async function readTasteProfile(env) {
  const doc = await readKnowledge(env, TASTE_SLUG).catch(() => null);
  return doc?.body || null;
}
