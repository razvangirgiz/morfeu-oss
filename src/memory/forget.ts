import type { App } from "../app.js";
import { withTx } from "../db/client.js";
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
    await client.query(
      `INSERT INTO runs (kind, started_at, finished_at, status, stats) VALUES ('forget', $1, $1, 'done', $2::jsonb)`,
      [now, JSON.stringify({ memory_id: memory.id, reason: reason.trim() })],
    );
    return { id: memory.id, already: false };
  });
}

export function isForgotten(memory: { status: string; retracted_at: Date | null }): boolean {
  return memory.status === "invalidated" && memory.retracted_at !== null;
}
