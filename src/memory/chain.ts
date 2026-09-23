import type { Memory } from "../core/types.js";
import type { Db } from "../db/client.js";
import { MEMORY_COLUMNS, mapMemory } from "./row.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HOPS = 50;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function loadMemory(db: Db, id: string, options: { lock?: boolean } = {}): Promise<Memory | null> {
  if (!isUuid(id)) return null;
  const res = await db.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return res.rows[0] ? mapMemory(res.rows[0]) : null;
}

export async function requireMemory(db: Db, id: string, options: { lock?: boolean } = {}): Promise<Memory> {
  const memory = await loadMemory(db, id, options);
  if (!memory) throw new Error(`memory not found: ${id}`);
  return memory;
}

/**
 * The head of the chain `start` belongs to, following superseded_by links.
 *
 * Without `servedAt`, this is the newest claim, including a successor
 * announced for a future date: what a new change must replace. With
 * `servedAt`, it stops at the claim served at that time: what a correction,
 * an expiry or a pin is about. Returns null when that claim is not active
 * (the chain ended in an expired or retracted claim).
 */
export async function activeHead(
  db: Db,
  start: Memory,
  options: { lock?: boolean; servedAt?: Date } = {},
): Promise<Memory | null> {
  let current: Memory = start;
  const seen = new Set<string>([start.id]);
  while (current.superseded_by_id && !seen.has(current.superseded_by_id) && seen.size < MAX_HOPS) {
    const next = await loadMemory(db, current.superseded_by_id, options);
    if (!next || next.status === "invalidated") break;
    if (options.servedAt && current.status === "active" && next.valid_from && next.valid_from > options.servedAt) break;
    seen.add(next.id);
    current = next;
  }
  return current.status === "active" ? current : null;
}

/**
 * When `replacement` takes the place of `old` (a correction, a rewrite), a
 * successor already announced for `old` now follows the replacement instead,
 * and the replacement ends where that successor begins.
 */
export async function handOverSuccessor(db: Db, old: Memory, replacement: Memory): Promise<void> {
  if (!old.superseded_by_id || old.superseded_by_id === replacement.id) return;
  const next = await loadMemory(db, old.superseded_by_id, { lock: true });
  if (!next || next.status === "invalidated" || next.retracted_at) return;
  await db.query("UPDATE memories SET supersedes_id = $2 WHERE id = $1", [next.id, replacement.id]);
  await db.query(
    `UPDATE memories SET superseded_by_id = $2,
       valid_until = CASE WHEN $3::timestamptz IS NULL THEN valid_until ELSE LEAST(COALESCE(valid_until, $3), $3) END
     WHERE id = $1`,
    [replacement.id, next.id, next.valid_from],
  );
}

/** The chain around a memory, oldest first: its predecessors, itself, and its successors. */
export async function chainOf(db: Db, memory: Memory): Promise<Memory[]> {
  const before: Memory[] = [];
  const after: Memory[] = [];
  const seen = new Set([memory.id]);
  for (let id = memory.supersedes_id; id && !seen.has(id) && seen.size < MAX_HOPS; ) {
    seen.add(id);
    const row = await loadMemory(db, id);
    if (!row) break;
    before.unshift(row);
    id = row.supersedes_id;
  }
  for (let id = memory.superseded_by_id; id && !seen.has(id) && seen.size < MAX_HOPS; ) {
    seen.add(id);
    const row = await loadMemory(db, id);
    if (!row) break;
    after.push(row);
    id = row.superseded_by_id;
  }
  return [...before, memory, ...after];
}
