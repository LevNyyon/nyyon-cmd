// Background-safe digest generation.
//
// The naive `await api.generateDigest()` lives inside the Digest page
// component. When the operator clicks "regenerate" and then navigates to
// any other surface, the page unmounts — the local state (`generating`,
// `lastGen`, the in-flight Promise's then-handler) is destroyed. On
// return the user sees a stale brief with no indication that anything is
// running, even though the worker is still mid-fan-out.
//
// This module owns the lifecycle instead. The Promise lives at module
// scope, survives every re-render and route change, and broadcasts state
// transitions via a tiny pub-sub so any component (the Digest page, the
// sidebar badge, a future toast) can mirror the same source of truth.
//
// API:
//   start()             — kick off (idempotent: returns the in-flight
//                         Promise if one is already running).
//   getState()          — current snapshot.
//   subscribe(cb)       — register for state changes; returns unsubscribe.
//
// State machine:
//   idle  → running  → idle (with `result`)
//   idle  → running  → idle (with `error`)

import { api } from './api';

export type DigestGenResult = {
  generated: number;
  // Stale items the prune-pass archived before this run (>7d, not starred,
  // not urgency=1). Surfaced in the Brief header so the operator sees
  // "archived N stale" alongside the +N adds.
  pruned?: number;
  per_source?: Record<string, { count: number; error: string | null; skipped?: string }>;
  ms: number;
  error?: string;
  finished_at: number;
};

export type DigestGenState = {
  running: boolean;
  started_at: number | null;        // ms-epoch when current run started (or last run if !running)
  result: DigestGenResult | null;   // last finished run, success or failure
};

const listeners = new Set<(s: DigestGenState) => void>();
let state: DigestGenState = { running: false, started_at: null, result: null };
let inflight: Promise<DigestGenResult> | null = null;

function emit() {
  const snap = state; // intentional reference copy — listeners see same object until next set
  for (const cb of listeners) cb(snap);
}

function setState(patch: Partial<DigestGenState>) {
  state = { ...state, ...patch };
  emit();
}

export function getDigestGenState(): DigestGenState {
  return state;
}

export function subscribeDigestGen(cb: (s: DigestGenState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function startDigestGeneration(): Promise<DigestGenResult> {
  // Idempotent — if a run is in flight, hand back the same Promise so all
  // callers resolve on the same finish event.
  if (inflight) return inflight;
  const t0 = Date.now();
  setState({ running: true, started_at: t0, result: null });
  inflight = (async () => {
    try {
      const r = await api.generateDigest();
      const finished: DigestGenResult = {
        generated: r.generated,
        pruned: r.pruned,
        per_source: r.per_source,
        ms: Date.now() - t0,
        finished_at: Date.now(),
      };
      setState({ running: false, result: finished });
      return finished;
    } catch (e) {
      const finished: DigestGenResult = {
        generated: 0,
        ms: Date.now() - t0,
        error: String((e as Error)?.message || e),
        finished_at: Date.now(),
      };
      setState({ running: false, result: finished });
      return finished;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
