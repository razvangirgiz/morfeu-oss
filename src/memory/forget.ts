import type { App } from "../app.js";
import type { Memory } from "../core/types.js";
import { type Db, withTx } from "../db/client.js";
import { requireMemory } from "./chain.js";

export type ForgetResult = { id: string; already: boolean };

/** SQL condition for a forgotten memory: its content is never shown again anywhere. */
export function forgottenSql(alias?: string): string {
  const c = (column: string) => (alias ? `${alias}.${column}` : column);
  return `(${c("status")} = 'invalidated' AND ${c("retracted_at")} IS NOT NULL)`;
}

/**
 * Stops serving exactly this memory, now and in every historical view, and
 * hides its text from explain, changes and export. Nothing is deleted: the row
 * is invalidated and retracted, and the reason is kept in the run log. To
 * forget the current version of something, pass the current memory's id.
 */
export async function forgetMemory(app: App, memoryId: string, reason: string, now: Date): Promise<ForgetResult> {
  if (!reason.trim()) throw new Error("a reason is required to forget a memory");
  return withTx(app.pool, async (client) => {
    const memory = await requireMemory(client, memoryId, { lock: true });
    if (memory.status === "invalidated" && memory.retracted_at) return { id: memory.id, already: true };
    await client.query(
      "UPDATE memories SET status = 'invalidated', retracted_at = $2, pinned_at = NULL WHERE id = $1",
      [memory.id, now],
    );
    await closeGap(client, memory);
    await client.query(
      `INSERT INTO runs (kind, started_at, finished_at, status, stats) VALUES ('forget', $1, $1, 'done', $2::jsonb)`,
      [now, JSON.stringify({ memory_id: memory.id, reason: reason.trim() })],
    );
    return { id: memory.id, already: false };
  });
}

/**
 * Keeps the chain whole around a forgotten memory. In the middle of a chain,
 * its neighbours are linked to each other (the forgotten claim's period
 * simply becomes unknown). At the head, the claim it had replaced is the
 * latest again and gets back the open end it lost to it.
 */
async function closeGap(db: Db, forgotten: Memory): Promise<void> {
  const before = forgotten.supersedes_id;
  const after = forgotten.superseded_by_id;
  if (after) {
    await db.query("UPDATE memories SET supersedes_id = $2 WHERE id = $1 AND supersedes_id = $3", [
      after,
      before,
      forgotten.id,
    ]);
    if (before) {
      await db.query("UPDATE memories SET superseded_by_id = $2 WHERE id = $1 AND superseded_by_id = $3", [
        before,
        after,
        forgotten.id,
      ]);
    }
    return;
  }
  if (!before || forgotten.retracted_at) return;
  await db.query(
    `UPDATE memories
     SET superseded_by_id = NULL,
         valid_until = CASE WHEN valid_until IS NOT DISTINCT FROM $3 THEN NULL ELSE valid_until END,
         status = CASE WHEN status = 'superseded' AND valid_until IS NOT DISTINCT FROM $3 THEN 'active' ELSE status END
     WHERE id = $1 AND superseded_by_id = $2 AND retracted_at IS NULL AND status IN ('active', 'superseded')`,
    [before, forgotten.id, forgotten.valid_from],
  );
}

export function isForgotten(memory: { status: string; retracted_at: Date | null }): boolean {
  return memory.status === "invalidated" && memory.retracted_at !== null;
}
