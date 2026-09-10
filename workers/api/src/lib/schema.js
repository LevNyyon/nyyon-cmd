// Self-provisioning schema. A fresh D1 is empty; the first request (or cron
// tick) that lands on an install applies schema.sql — the same consolidated
// file the bootstrap script uses — so EVERY deploy path boots into a working
// database: the one-click Deploy button, a CI push from a fork, or the
// bootstrap. Idempotent (IF NOT EXISTS throughout); cached per isolate.
// ponytail: probe = one table; a partially-created schema would re-run
// everything, which is harmless.
import SCHEMA from '../../schema.sql';

let ensured = false;

export async function ensureSchema(env) {
  if (ensured || !env?.DB) return;
  try {
    await env.DB.prepare('SELECT 1 FROM knowledge_docs LIMIT 1').first();
    ensured = true;
    return;
  } catch { /* empty database — provision it */ }
  const stmts = String(SCHEMA)
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  // Chunked batches: one round trip per chunk instead of one per statement.
  for (let i = 0; i < stmts.length; i += 40) {
    const chunk = stmts.slice(i, i + 40).map((s) => env.DB.prepare(s));
    try { await env.DB.batch(chunk); }
    catch { for (const p of chunk) await p.run().catch(() => {}); } // isolate a bad statement, keep going
  }
  ensured = true;
}
