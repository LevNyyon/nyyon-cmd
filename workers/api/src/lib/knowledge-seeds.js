// Placeholder bodies for EVERY operator knowledge doc — the one source file
// that says which docs exist and what shape each should take. Seeded at setup
// finish (only if missing), so a fresh install's Knowledge module shows the
// full set as fillable scaffolds and the interview UPDATES docs instead of
// inventing them. The universal anti-AI blocks are baked into the two voice
// scaffolds here, because the write_knowledge weld only fires on CREATE.

import { UNIVERSAL_STYLE_RULES, UNIVERSAL_PERSONAL_RULES } from './onboarding-playbook.js';
import { readKnowledge, writeKnowledge } from './db.js';

const FILL = '_Placeholder — the voice interview with Nyo fills this. Edit freely any time._';

export const OPERATOR_DOC_SEEDS = [
  { slug: 'about', title: 'Company profile', body: `# Company profile\n\n${FILL}\n\n- **Company name** —\n- **URL** —\n- **What we do** —\n- **Audience** —\n- **Offer** —` },
  { slug: 'nyyon-brand-voice', title: 'Brand voice', body: `# Brand voice\n\n${FILL}\n\n## What we are\n\n## What we are NOT\n\n## Perspective (3-5 sharp claims)\n\n## How we write` },
  { slug: 'operator-voice', title: 'Personal voice', body: `# Personal voice\n\n${FILL}\n\n${UNIVERSAL_PERSONAL_RULES}\n\n## Structure of a post\n\n## Never-list\n\n## Gold examples (verbatim)` },
  { slug: 'writing-style-rules', title: 'Writing style rules', body: `# Writing style rules\n\n${FILL}\n\n## Company-specific bans\n\n## Universal rules\n\n${UNIVERSAL_STYLE_RULES}` },
  { slug: 'heartbeat-priorities', title: 'Heartbeat priorities', body: `# Heartbeat priorities\n\n${FILL}\n\nWhat counts as a signal worth surfacing; what to ignore.\n\n## Watch topics\n\n_(one plain search query per line — the topic feed builds its Google News watches from these)_` },
  { slug: 'hottakes-pov-library', title: 'Point-of-View Library', body: `# Point-of-View Library\n\n${FILL}\n\n## Positions (claims we would defend)\n-` },
  { slug: 'brand-icp', title: 'ICP', body: `# ICP\n\n${FILL}\n\nWho this is for: title, situation, company shape. Who is explicitly NOT a fit.` },
  { slug: 'gtm-you', title: 'Operator profile', body: `Operator profile — drives outreach drafts.\n\n${FILL}\n\n\`\`\`json\n{"name": "", "role": "", "business": "", "location": ""}\n\`\`\`` },
  { slug: 'operator-positioning', title: 'Positioning', body: `# Positioning\n\n${FILL}\n\nThe frame outreach and Watch replies speak from: what the operator walks in offering, in one or two tight paragraphs.` },
  { slug: 'gtm-outreach', title: 'Watch drafting voice', body: `# Watch drafting voice\n\n${FILL}\n\nHow Watch reply drafts are written: tone, length, what a first message may and may not do.` },
];

export async function seedOperatorDocs(env) {
  let seeded = 0;
  for (const d of OPERATOR_DOC_SEEDS) {
    try {
      if (await readKnowledge(env, d.slug)) continue;
      await writeKnowledge(env, { ...d, parent_slug: 'nyyon-root' });
      seeded++;
    } catch { /* one bad doc must not block the rest */ }
  }
  return { seeded };
}
