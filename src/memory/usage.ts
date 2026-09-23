import type { Db } from "../db/client.js";
import { toDate } from "../db/client.js";

/** Counts a retrieval. Recently used memories rank as fresher and are spared by decay. */
export async function recordUsage(db: Db, memoryIds: readonly string[], now: Date): Promise<void> {
  const ids = [...new Set(memoryIds)];
  if (ids.length === 0) return;
  await db.query(
    `INSERT INTO memory_usage (memory_id, retrieval_count, last_retrieved_at)
     SELECT id, 1, $2 FROM unnest($1::uuid[]) AS id
     ON CONFLICT (memory_id) DO UPDATE SET
       retrieval_count = memory_usage.retrieval_count + 1,
       last_retrieved_at = GREATEST(memory_usage.last_retrieved_at, EXCLUDED.last_retrieved_at)`,
    [ids, now],
  );
}

export async function lastRetrieved(db: Db, memoryIds: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (memoryIds.length === 0) return out;
  const res = await db.query<{ memory_id: string; last_retrieved_at: Date }>(
    "SELECT memory_id, last_retrieved_at FROM memory_usage WHERE memory_id = ANY($1::uuid[])",
    [memoryIds],
  );
  for (const row of res.rows) out.set(row.memory_id, toDate(row.last_retrieved_at));
  return out;
}
