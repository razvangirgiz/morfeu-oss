import type { Memory } from "../core/types.js";
import type { Db } from "../db/client.js";
import { loadMemory } from "./chain.js";

const MAX_HOPS = 50;

/**
 * Keeps a chain free of overlapping claims after `successor` takes over.
 *
 * Walking back through what the successor replaced, each predecessor that is
 * still part of history (not retracted, not invalidated) must end where the
 * successor begins:
 *
 * - it ended earlier already: nothing to do, and older ones ended earlier still;
 * - it started at or after the successor's start (or the successor holds "as
 *   far back as we know"): it never held on its own, so it is retracted;
 * - otherwise its validity is cut to end at the successor's start.
 *
 * A predecessor whose new end is still in the future stays active until then,
 * so a change announced ahead of time does not leave the present empty.
 */
export async function settleChain(db: Db, successor: Memory, now: Date): Promise<void> {
  const start = successor.valid_from;
  let id = successor.supersedes_id;
  for (let hops = 0; id && hops < MAX_HOPS; hops++) {
    const previous = await loadMemory(db, id, { lock: true });
    if (!previous) return;
    id = previous.supersedes_id;
    if (previous.retracted_at || previous.status === "invalidated" || previous.status === "candidate") continue;
    if (start && previous.valid_until && previous.valid_until <= start) return;
    if (!start || (previous.valid_from && previous.valid_from >= start)) {
      await db.query(
        "UPDATE memories SET status = 'superseded', retracted_at = $2, superseded_by_id = COALESCE(superseded_by_id, $3) WHERE id = $1",
        [previous.id, now, successor.id],
      );
      continue;
    }
    const ended = start <= now;
    await db.query(
      `UPDATE memories SET valid_until = $2, superseded_by_id = COALESCE(superseded_by_id, $3),
         status = CASE WHEN $4 AND status = 'active' THEN 'superseded' ELSE status END
       WHERE id = $1`,
      [previous.id, start, successor.id, ended],
    );
  }
}
