import type { Db } from "../db/client.js";

/**
 * Archives extracted memories that nobody has retrieved for a long time and
 * that were never important. Archived memories stay in history and come back
 * if the dream sees the same claim again. Off unless MORFEU_DECAY=on.
 */
export async function archiveStale(db: Db, now: Date, importanceAtMost = 0.5): Promise<number> {
  const res = await db.query(
    `UPDATE memories m SET archived_at = $1
     WHERE m.status = 'active' AND m.archived_at IS NULL AND m.pinned_at IS NULL
       AND m.origin = 'extracted' AND m.importance <= $2
       AND COALESCE((SELECT u.last_retrieved_at FROM memory_usage u WHERE u.memory_id = m.id), m.observed_at)
           < $1::timestamptz - CASE m.volatility WHEN 'stable' THEN interval '365 days'
                                                 WHEN 'fast' THEN interval '30 days'
                                                 ELSE interval '180 days' END`,
    [now, importanceAtMost],
  );
  return res.rowCount ?? 0;
}
