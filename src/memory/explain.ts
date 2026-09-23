import type { DreamAction, Memory } from "../core/types.js";
import type { Db } from "../db/client.js";
import { toDate } from "../db/client.js";
import { chainOf, requireMemory } from "./chain.js";
import { entitiesOf } from "./entities.js";
import { isForgotten } from "./forget.js";

export type Explanation = {
  memory: Memory;
  /** The whole supersede chain, oldest first, including this memory. */
  chain: Memory[];
  entities: { name: string; type: string }[];
  sources: {
    event_id: string;
    source: string;
    type: string;
    occurred_at: Date;
    session_id: string | null;
    text: string;
  }[];
  decisions: { action: DreamAction; reason: string; target_id: string | null }[];
};

const MAX_SOURCE_CHARS = 2000;

/** Why morfeu believes something: the chain, the events it came from, and what consolidation decided. */
export async function explainMemory(db: Db, memoryId: string): Promise<Explanation> {
  const memory = await requireMemory(db, memoryId);
  if (isForgotten(memory)) throw new Error(`memory ${memoryId} was forgotten`);
  const sources = await db.query(
    `SELECT e.id, e.source, e.type, e.occurred_at, e.session_id, e.content_text
     FROM memory_sources ms JOIN events e ON e.id = ms.event_id
     WHERE ms.memory_id = $1 ORDER BY e.occurred_at, e.id LIMIT 20`,
    [memoryId],
  );
  const decisions = await db.query(
    "SELECT action, reason, target_id FROM dream_decisions WHERE memory_id = $1 ORDER BY id",
    [memoryId],
  );
  return {
    memory,
    chain: (await chainOf(db, memory)).filter((m) => !isForgotten(m)),
    entities: await entitiesOf(db, memoryId),
    sources: sources.rows.map((r) => ({
      event_id: r.id,
      source: r.source,
      type: r.type,
      occurred_at: toDate(r.occurred_at),
      session_id: r.session_id,
      text: r.content_text.length > MAX_SOURCE_CHARS ? `${r.content_text.slice(0, MAX_SOURCE_CHARS)}…` : r.content_text,
    })),
    decisions: decisions.rows,
  };
}
