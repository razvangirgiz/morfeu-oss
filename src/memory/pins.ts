import type { App } from "../app.js";
import type { Memory, Scope } from "../core/types.js";
import { type Db, withTx } from "../db/client.js";
import { activeHead, requireMemory } from "./chain.js";
import { MEMORY_COLUMNS, mapMemory } from "./row.js";
import { servingSql } from "./serving.js";

/** Pinned memories are always in context; keep the set small enough to stay useful. */
export const MAX_PINS = 20;

export async function listPinned(db: Db, now: Date, scopes?: readonly Scope[]): Promise<Memory[]> {
  const params: unknown[] = [now];
  let scopeFilter = "";
  if (scopes) {
    if (scopes.length === 0) return [];
    const tuples = scopes.map((s) => {
      params.push(s.type, s.id);
      return `($${params.length - 1}, $${params.length})`;
    });
    scopeFilter = ` AND (scope_type, scope_id) IN (${tuples.join(", ")})`;
  }
  const res = await db.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories
     WHERE pinned_at IS NOT NULL AND ${servingSql({ timeParam: "$1", historical: false })}${scopeFilter}
     ORDER BY pinned_at, id`,
    params,
  );
  return res.rows.map(mapMemory);
}

export async function pinMemory(app: App, memoryId: string, now: Date): Promise<Memory> {
  return withTx(app.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('morfeu-pins'))");
    const head = await activeHead(client, await requireMemory(client, memoryId, { lock: true }), { lock: true });
    if (!head) throw new Error(`memory ${memoryId} is not active; only active memories can be pinned`);
    if (head.pinned_at) return head;
    const pinned = await listPinned(client, now);
    if (pinned.length >= MAX_PINS) throw new Error(`already ${MAX_PINS} pinned memories; unpin one first`);
    const res = await client.query(`UPDATE memories SET pinned_at = $2 WHERE id = $1 RETURNING ${MEMORY_COLUMNS}`, [
      head.id,
      now,
    ]);
    return mapMemory(res.rows[0]);
  });
}

export async function unpinMemory(app: App, memoryId: string): Promise<Memory> {
  return withTx(app.pool, async (client) => {
    const start = await requireMemory(client, memoryId, { lock: true });
    const head = (await activeHead(client, start, { lock: true })) ?? start;
    const res = await client.query(`UPDATE memories SET pinned_at = NULL WHERE id = $1 RETURNING ${MEMORY_COLUMNS}`, [
      head.id,
    ]);
    return mapMemory(res.rows[0]);
  });
}
