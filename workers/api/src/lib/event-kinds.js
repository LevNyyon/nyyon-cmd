// Guard-critical event kinds — the ones a WRITER stamps and a READER later
// queries to gate behavior. If a writer's kind string and a reader's WHERE
// clause ever drift apart, the guard silently stops working (a cap that no
// longer caps, a dedup that no longer dedups). Referencing these constants
// from both sides makes writer == reader by construction, so a rename can't
// desync them.
//
// This is deliberately NOT an exhaustive registry of every event kind (~90 and
// growing); enforcing an allowlist would block legitimate new kinds. The
// integrity guarantee lives in logEvent() itself (lib/db.js), which rejects a
// missing/empty/non-string kind — the class of bug where {type:'x'} was passed
// instead of {kind:'x'} and silently wrote a NULL kind (or threw at the DB).

export const EVENT_KINDS = Object.freeze({
  // Wake-up daily-publish cap: stamped once/UTC-day, read back to block re-fire.
  AEO_AUTOFIRE:      'aeo_autofire',
  // Sunday-brain offer dedup: claimed before sending, read back to avoid re-nag.
  BRAIN_OFFER_SENT:  'brain_offer_sent',
  // Wake-up throttle: the last-wake marker the gating logic reads.
  NYO_WAKE_UP_SENT:  'nyo_wake_up_sent',
  // Social sends (used by post_to_social + approveAndPush; surfaced in Activity).
  SOCIAL_POSTED:     'social_posted',
  SOCIAL_FAILED:     'social_failed',
  // Dev-invoke test bench.
  DEV_INVOKE:        'dev_invoke',
});
