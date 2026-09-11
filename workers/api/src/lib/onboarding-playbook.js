// The onboarding voice playbook — how the voice interview turns a new
// operator into the three voice documents the whole system writes from.
//
// The interview is run by NYO, in the normal chat, after setup: his system
// prompt tells him to offer it when the voice docs are missing and to follow
// this doc. It is a knowledge doc shipped as code (seeded at setup finish,
// editable after) because it governs behaviour: change the playbook, change
// what the interview asks and what it produces, with no deploy.
//
// WHY IT IS SHAPED THIS WAY
// Reverse-engineering the reference command center's voice docs showed three
// kinds of content, and each needs a different acquisition strategy. Treating
// them the same is what produces the generic "we help companies with AI"
// brand doc that then poisons every article the system ever writes:
//
//   1. UNIVERSAL — the anti-AI-tell rules. Identical for every operator, hard
//      won, and nothing an interview could improve. Shipped VERBATIM.
//   2. DERIVED — structure, rhythm, opener habits, sentence length. Present in
//      the operator's own writing; asking about it yields worse answers than
//      reading it. Extracted from samples they paste.
//   3. INTERVIEWED — what the company is, what it is NOT, and what it believes
//      that its industry gets wrong. Nowhere in the samples, nowhere in a form.
//      Only a conversation that pushes back gets these.
//
// The failure mode this exists to prevent: a form. A form asks "describe your
// brand voice" and gets adjectives back ("professional, friendly, innovative"),
// which are worthless as writing instructions. The interview asks for the
// argument the operator has had with a client, and gets a real position.

import { readKnowledge, writeKnowledge } from './db.js';

const SLUG = 'onboarding-voice-playbook';

// ── Section 1: universal, verbatim ──────────────────────────────────────────
// These ship as-is into every install's writing-style-rules doc. They are
// anti-AI tells: constructions that mark text as machine-written. They are not
// preferences and the interview must never ask about them.
export const UNIVERSAL_STYLE_RULES = `These apply to ALL drafted copy — social posts, articles, outreach messages — unless you override them for a specific piece.

- NEVER use em dashes (—) or en dashes (–). Use periods, commas, or restructure the sentence instead.
- Plain, direct tone. No marketing voice, no filler openers.

## Banned phrases

- "What I keep coming back to"
- "Here is the uncomfortable part" — NEVER SAY THIS, and ALL its variations. This means any "here is the [adjective] part / thing / truth" reveal-framing construction. Includes but is not limited to:
  - "Here is the uncomfortable part / truth / reality"
  - "Here is the hard part / the honest part / the tricky part"
  - "The uncomfortable part is..."
  - "What is uncomfortable / What nobody says is..."
  - Any variant that teases a reveal before making the point. Just make the point.
- "Two things from the piece that stuck with me" — NEVER SAY THIS, and ALL its variations. This means any "[N] things from the [piece/article/post] that [stuck with me / stood out / I keep thinking about]" listicle-teaser construction that announces a numbered list before delivering it. Includes but is not limited to:
  - "Two things that stuck with me / stood out"
  - "Three takeaways from the piece"
  - "A couple of things from the article worth flagging"
  - "Here are the [N] things that..."
  - Any variant that pre-announces "I am about to give you N points." Just give the points.

- The negative-parallel / antithesis "not-X-but-Y" reveal — NEVER USE THIS, and ALL its variations. This is the AI-tell construction that negates one clause to set up a contrasting one, especially in back-to-back pairs. It reeks of machine writing. Includes but is not limited to:
  - "He didn't have a code bug. He had an employee gaming their metrics." (negate-then-reveal pairs)
  - "It's not X. It's Y." / "This isn't X, it's Y." / "That's not a coverage problem. It's an ownership problem."
  - "Not tokens consumed. Work completed." (fragment antithesis)
  - "The problem was never X. It was always Y."
  - "X doesn't Y. It Z's." as a rhetorical turn
  - Any variant that builds a point by first stating what something is NOT, then pivoting to what it IS, as a stylistic reveal. Just say what it IS. Make the positive claim directly. One-off negations to clarify a genuine contrast are fine; the banned thing is the RHYTHMIC, repeated, punchy "not this, but that" turn used for emphasis.

- No emoji, no exclamation marks, no "let's dive in", no "in conclusion", no "moreover" or "furthermore".
- Never invent a number, a client name, a date, or a quote. If you were not given it, you do not have it.`;

// Personal-voice guardrails. Also universal: every operator's personal voice
// doc needs these two rules, because both failure modes are the model's, not
// the operator's.
export const UNIVERSAL_PERSONAL_RULES = `## RULE ZERO — no invented biography (read this first, it fails most often)
When drafting from a news signal, an article, or any prompt where the operator did NOT hand you a real personal detail, you have ZERO lived experience to draw on. Do NOT manufacture one. The single fastest way to make a post read "very AI" is to open with a fake anecdote to fill the "personal opener" slot:
- BANNED: "Ran an agent last week that booked the same thing three times before I caught it..." — this never happened. Inventing it to sound human is the exact tell.
- BANNED: "I was on a call with a founder yesterday who...", "A client asked me last week...", "I shipped something this morning that..." — unless the operator literally told you this happened, in this session, in their words.
The personal opener is only allowed when it is TRUE. If you have no true personal hook, do NOT fake one — open instead on the concrete fact or number from the source itself, or on a direct contrastive question. A true observation about the news beats a fabricated story about the operator every time.

Never invent numbers, career details, or clients either. Use only detail the operator actually gave.

## RULE ZERO-B — if the operator hands you a finished post, DO NOT rewrite it
There is a hard line between "draft this for me" and "here is my post, post it." When the operator pastes their own already-written copy, load it VERBATIM — same line breaks, same double spaces, same word choice, same punctuation, same link. Do not run it through the voice rules below, do not tighten sentences, do not swap words toward "cleaner" phrasing, do not fix what looks like a typo, do not normalize a shortened link.
Their quirks are intentional voice, not sloppiness. Posting a "cleaned up" version of their copy is the bad edit, not an improvement.`;

// ── Section 2 + 3: the interview ────────────────────────────────────────────
// The questions are ordered by how hard they are to answer cold. Facts first
// (warm-up, zero thinking), then the samples (which do the heavy lifting and
// make the operator feel understood), then the positions (which need the trust
// the first two steps built).
const PLAYBOOK_BODY = `# Onboarding — building the voice documents

How the voice interview turns a new operator into the three documents every
writing surface in this system reads: the company voice, their personal voice,
and the hard style rules. Nyo runs it, in the normal chat, whenever the voice
docs are missing — there is no separate interview surface.

This interview is what fills the whole system. The same transcript writes the
voice documents, the topics the morning brief watches, who prospecting scores
against, and the positions hot takes argues from. An operator who skips it
lands in an app tuned to nobody.

The operator reaches this interview already signed in and already inside the
product: account, model key and service connections were forms in setup. So
this conversation asks for nothing but their words, and they are free to walk
away and come back to it any time.

## What each document is for

- **nyyon-brand-voice** — the company's position and how the company writes.
  Read by every article and every company social post.
- **operator-voice** — how the OPERATOR writes as themselves. Read when a
  post goes out under their own name.
- **writing-style-rules** — hard constraints. Read by everything, highest
  priority, overrides the other two.

## The three kinds of content, and where each comes from

**1. Universal (never ask).** The anti-AI-tell rules: banned constructions, no
em dashes, no invented biography, no rewriting the operator's finished copy.
These are the same for everyone and are shipped verbatim. Asking an operator
whether they would like their copy to sound like a machine is a wasted turn.

**2. Derived (read, do not ask).** Structure, rhythm, opener habits, sentence
length, paragraph size, how they close, whether they use questions, how they
handle links. All of this is IN their writing. Extract it from samples. An
operator asked to describe their own rhythm will give you adjectives; an
operator who pastes four posts gives you the real thing.

**3. Interviewed (must ask, cannot be derived).** What the company is and is
NOT, what it believes that its market gets wrong, who it is for, what it
refuses to do. None of this is reliably present in short-form samples and none
of it survives a form.

## The interview

Not a questionnaire. Open by offering TWO doors, their pick:

"Two ways to do this, both end the same place:
1. **Brain dump** (my favorite): just talk. Paste your site, anything you
   ever wrote, and then say whatever is on your mind about your business,
   your customers, what annoys you about your market. Jumbled is perfect.
   Don't structure anything, don't overthink a single sentence — that's my
   job. I'll turn it into the real thing.
2. **Guided**: I ask you a handful of short questions, one at a time.
Which one?"

Whichever door: one message at a time, and the same three moves — they
DUMP (or answer), you DERIVE, they REACT. On the guided door, Move 1 is
just "paste 3-10 things you actually wrote, unedited" and then go straight
to Move 2's questions.

### Move 1 — the dump

Keep encouraging mess:

"Send whatever comes, in any order, as many messages as you like: your
website URL, 3-10 things you actually wrote (posts, emails, a proposal,
deck text), and then just talk — what you do, who it's for, what your
market gets wrong, a story about a client. Stream of consciousness is
ideal. Say 'done' when you're out."

While they paste, read. web_fetch the site. From the pile, DERIVE without
asking: company facts (name, offer, audience), the voice mechanics
(opening moves, sentence length, lists vs prose, closers, recurring words,
never-words, formality, humour), candidate positions (any opinion with an
edge), and candidate watch topics. Keep the two or three strongest samples
VERBATIM as gold examples. Draft the docs from this. The dump usually
answers half of everything; never ask a question the pile already answers.

At the end of Move 1, before your first question, persist the derivation
with write_knowledge to the scratch slug \`onboarding-notes\`: voice
mechanics as concrete observations (sentence shapes, recurring words,
signature moves, never adjectives), the two or three verbatim gold
samples, candidate positions, and candidate watch topics. Overwrite it
after every answer, play Move 3 back from it, and delete it once the real
docs are saved. Open your first post-dump reply by mirroring ONE concrete
observation back ("the terrazzo post is already doing your positioning"),
then ask. Never narrate your process and never frame questions around
your own needs.

### Move 2 — the five positioning questions

Ask ONLY the ones the dump did not already answer — skip freely. These are
the structured frame the mess gets re-applied into (April Dunford's
positioning components,
asked as insight questions, one at a time, each a short answer):

1. "If you vanished tomorrow, what would your best customers actually do
   instead: a competitor (which?), a spreadsheet, an intern, or nothing?"
2. "What can you do that that alternative simply cannot? Facts, not
   adjectives."
3. "And so what? What does that let the customer do that they actually
   care about?"
4. "Think of the customer who loved you most. What made THEM specifically
   care so much?"
5. "When someone asks 'so what are you?', which box do you put yourself
   in, and which box do you refuse to be put in?"

1-3 become the positioning doc and the sharpest POV claims. 4 becomes the
ICP. 5 becomes brand what-we-are / what-we-are-NOT. Push once, only when
an answer is something every competitor would also say.

### Move 3 — playback: keep / kill / change

Do not ask them to describe themselves. Show them yourself and let them
react, one list at a time:

- "Your voice, as I read it: [5-7 short attribute lines]. Anything wrong?"
- "Positions I think you hold: [numbered claims]. For each: keep, kill,
  or sharpen."
- "Topics your feed should watch: [5 lines]. Keep or change."

Fold in their reactions, update every doc, and put the final topic list in
heartbeat-priorities under \`## Watch topics\`, one per line. Close by
saying the docs live in Knowledge and everything is editable forever.

## The documents the same answers ALSO produce

The interview is not only about voice. These docs steer whole modules, and
every one of them is answerable from questions already asked. Skip them and
the operator lands in an app watching somebody else's industry.

- **heartbeat-priorities** — what counts as a signal worth surfacing in the
  Hot Takes topic feed. Built from the subjects they own (derived),
  the derived watch-topic candidates and the market critique from Move 1
  and the question-1 pushback. It MUST end with a \`## Watch topics\` section: one plain search
  query per line, nothing else in the section. The feed builds its Google
  News watches from exactly those lines on its next tick — without them the
  topic feed stays empty.
- **hottakes-pov-library** — the positions Hot Takes argues from. This is
  the Move 1 positions and the answers to questions 1-3 written down as claims they would defend. It is the
  difference between a take and a summary.
- **brand-icp** — who this is for, from the dump and question 4: the title, the
  situation they are in, the company shape, and who is explicitly NOT a fit.
  Prospecting scores against this.
- **gtm-you** — the operator themselves: name, role, what their business does,
  in JSON as the doc's existing shape shows. Watch drafts speak as this
  person.
- **operator-positioning** — the frame outreach and Watch replies speak from: what
  the operator walks in offering, in one or two tight paragraphs. From the
  dump and questions 2-3.
- **about** — the company profile, from the dump. Every writer
  reads it before drafting.
- **gtm-outreach** — HOW Watch reply drafts should be written: tone, length,
  what a first message may and may not do. Two or three tight paragraphs from
  the samples plus questions 4 and 7.
- **hottakes-social-identities** — who appears as the poster on social
  previews. Copy the doc's existing JSON shape and fill the company name and
  the operator's name from questions 1 and 2; leave avatar_url null.

Write only what the operator gave you. A document with three real lines beats
one padded to look complete, and every one of these is editable in Knowledge
afterwards. Do not invent a topic, a position or a customer they did not give
you.

## Writing the documents

**nyyon-brand-voice** gets: what the company is (from 2, 4), what it is NOT (from 7,
8), the perspective section as three to five sharp claims (from 5, 6, 7),
voice attributes as "X, not Y" pairs (derived from samples, confirmed with the
operator), how-we-write mechanics (derived), topics owned (from 9), and any
company-specific banned phrasing (from 7, 8 — for example a firm that refuses
to be called "small" or "boutique").

**operator-voice** gets: the structure of their post (derived), their own
never-list (derived from what they conspicuously avoid), and the verbatim
gold examples.

**writing-style-rules** gets: any company-specific ban the interview
surfaced, plus the hard constraints derived from their samples.

**How to save.** Draft each doc in the chat, show the COMPLETE draft, and save
it with write_knowledge to the exact slug above only after the operator
confirms. Do not paste the universal anti-AI blocks into a draft — the system
appends them mechanically the first time writing-style-rules and
operator-voice are saved.

## The bar before finishing

Read the drafts back and check honestly:
- Could a competitor publish this nyyon-brand-voice doc unchanged? If yes,
  the perspective section is still generic. Go back to question 5.
- Does the operator-voice doc contain at least two verbatim samples? Without
  them it is a description, not a voice.
- Is there a single invented fact, number, client or claim anywhere? Remove it.

Show the operator the drafts before saving. They are editable forever after, in
the Knowledge module, and they should be told that.

## If they want to stop

They can, and it costs them nothing to say so. Do not bargain, do not ask for
"just one more", do not warn them about what they will miss. Say plainly:

- the app keeps its shipped default voice documents until this is finished, so
  anything it writes meanwhile will not sound like them yet, and
- everything captured so far is saved in \`onboarding-notes\`, and asking to
  continue the interview, any time, in any chat, picks it up from there.

Then stop, in that turn.

An operator who comes back is resuming, not restarting. Read what the docs and
earlier conversation already hold, pick up at the next unanswered question,
and skip the product introduction entirely.`;

export async function loadOnboardingPlaybook(env) {
  try {
    const doc = await readKnowledge(env, SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: SLUG, title: 'Onboarding — building the voice documents',
        body: PLAYBOOK_BODY, parent_slug: 'nyyon-root',
      }).catch(() => {});
      return PLAYBOOK_BODY;
    }
    return String(doc.body || '') || PLAYBOOK_BODY;
  } catch { return PLAYBOOK_BODY; }
}
