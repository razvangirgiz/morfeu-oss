import type { App } from "../app.js";
import { withTx } from "../db/client.js";
import { activeHead, requireMemory } from "./chain.js";

export type ForgetResult = { id: string };

/**
 * Stops serving a memory, now and in every historical view. Nothing is
 * deleted: the row is invalidated and retracted, and the reason is kept in
 * the run log. Given any row of a chain, the current head is forgotten.
 */
export async function forgetMemory(app: App, memoryId: string, reason: string, now: Date): Promise<ForgetResult> {
  if (!reason.trim()) throw new Error("a reason is required to forget a memory");
  return withTx(app.pool, async (client) => {
    const start = await requireMemory(client, memoryId, { lock: true });
    const target =
      start.status === "active" || start.status === "candidate"
        ? start
        : await activeHead(client, start, { lock: true });
    if (!target) throw new Error(`memory ${memoryId} is not served; nothing to forget`);
    await client.query(
      "UPDATE memories SET status = 'invalidated', retracted_at = $2, pinned_at = NULL WHERE id = $1",
      [target.id, now],
    );
    await client.query(
      `INSERT INTO runs (kind, started_at, finished_at, status, stats) VALUES ('forget', $1, $1, 'done', $2::jsonb)`,
      [now, JSON.stringify({ memory_id: target.id, reason: reason.trim() })],
    );
    return { id: target.id };
  });
}
