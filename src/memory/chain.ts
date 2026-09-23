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
 * The current head of the chain `start` belongs to: follows superseded_by
 * links to the newest claim that is still part of history, including a
 * successor announced for a future date. Returns null when the chain ends in
 * an expired or retracted claim, or in a forgotten one with nothing before it.
 * Rows are locked on the way when the caller is about to change the head.
 */
export async function activeHead(db: Db, start: Memory, options: { lock?: boolean } = {}): Promise<Memory | null> {
  let current: Memory = start;
  const seen = new Set<string>([start.id]);
  while (current.superseded_by_id && !seen.has(current.superseded_by_id) && seen.size < MAX_HOPS) {
    const next = await loadMemory(db, current.superseded_by_id, options);
    if (!next || next.status === "invalidated") break;
    seen.add(next.id);
    current = next;
  }
  return current.status === "active" ? current : null;
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
