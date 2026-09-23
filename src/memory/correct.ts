import type { App } from "../app.js";
import type { Memory } from "../core/types.js";
import { withTx } from "../db/client.js";
import { redact } from "../ledger/redact.js";
import { activeHead, requireMemory } from "./chain.js";
import { entitiesOf } from "./entities.js";
import { validateContent } from "./save.js";
import { settleChain } from "./validity.js";
import { insertMemory, sourcesOf } from "./write.js";

export type CorrectInput = {
  memoryId: string;
  content: string;
  /** When the corrected claim holds; defaults to the period of the claim it replaces. */
  valid_from?: Date | null;
  valid_until?: Date | null;
  importance?: number;
  source?: string;
  /** "owner" when the user corrects it themselves (CLI); "saved" when an agent relays it (MCP). */
  origin?: "owner" | "saved";
};

export type CorrectResult = { memory: Memory; retracted_id: string };

/**
 * Replaces a wrong memory with the user's correction.
 *
 * Unlike a change in the world, a correction means the old claim was never
 * true: it is retracted (retracted_at = now) rather than ended, so questions
 * about the past no longer return it either. The correction covers the same
 * period unless told otherwise, and keeps the old row's sources, entities and pin.
 */
export async function correctMemory(app: App, input: CorrectInput, now: Date): Promise<CorrectResult> {
  const content = redact(input.content.trim()).text;
  validateContent(content);
  return withTx(app.pool, async (client) => {
    const start = await requireMemory(client, input.memoryId, { lock: true });
    const head = await activeHead(client, start, { lock: true });
    if (!head) throw new Error(`memory ${input.memoryId} is no longer active; nothing to correct`);
    const memory = await insertMemory(
      app,
      client,
      {
        content,
        type: head.type,
        scope: { type: head.scope_type, id: head.scope_id },
        origin: input.origin ?? "owner",
        status: "active",
        importance: input.importance ?? head.importance,
        confidence: input.origin === "saved" ? 0.9 : 1,
        volatility: head.volatility,
        attrs: { ...head.attrs, corrects: head.id },
        observed_at: now,
        valid_from: input.valid_from === undefined ? head.valid_from : input.valid_from,
        valid_until: input.valid_until === undefined ? head.valid_until : input.valid_until,
        supersedes_id: head.id,
        entities: await entitiesOf(client, head.id),
        sourceEventIds: await sourcesOf(client, head.id),
      },
      now,
    );
    await client.query(
      `UPDATE memories SET status = 'superseded', superseded_by_id = $2, retracted_at = $3, pinned_at = NULL
       WHERE id = $1`,
      [head.id, memory.id, now],
    );
    // A correction reaching further back than the wrong claim also overrides what came before it.
    await settleChain(client, memory, now);
    if (head.pinned_at)
      await client.query("UPDATE memories SET pinned_at = $2 WHERE id = $1", [memory.id, head.pinned_at]);
    return { memory, retracted_id: head.id };
  });
}
