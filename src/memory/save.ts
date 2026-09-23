import type { App } from "../app.js";
import type { EntityInput, Memory, MemoryType, Scope, Volatility } from "../core/types.js";
import { withTx } from "../db/client.js";
import { redact } from "../ledger/redact.js";
import { activeHead, requireMemory } from "./chain.js";
import { foldText } from "./entities.js";
import { MEMORY_COLUMNS, mapMemory } from "./row.js";
import { settleChain } from "./validity.js";
import { insertMemory, MAX_CONTENT_CHARS, resolveScope } from "./write.js";

export type SaveInput = {
  content: string;
  type: MemoryType;
  scope: Scope;
  importance?: number;
  volatility?: Volatility;
  valid_from?: Date | null;
  valid_until?: Date | null;
  entities?: readonly EntityInput[];
  attrs?: Record<string, unknown>;
  /** An earlier memory this one replaces because something changed (a new preference, a new decision). */
  supersedes?: string | null;
  /** "owner" when the user states it themselves (CLI); "saved" when an agent records it. */
  origin?: "saved" | "owner";
  source?: string;
  agent_id?: string | null;
  session_id?: string | null;
};

export type SaveResult = { memory: Memory; deduplicated: boolean; superseded_id: string | null };

/**
 * Saves one explicit memory. Saving the same sentence twice in the same scope
 * returns the first row. With `supersedes`, the old memory stops being valid
 * where the new one starts: history keeps both, the present shows the new one.
 */
export async function saveMemory(app: App, input: SaveInput, now: Date): Promise<SaveResult> {
  const content = redact(input.content.trim()).text;
  validateContent(content);
  const scope = resolveScope(input.scope, app.config.userId);
  return withTx(app.pool, async (client) => {
    // Serializes identical saves, so two agents saving the same sentence at once get one row.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `save:${scope.type}:${scope.id}:${input.type}:${foldText(content).replace(/\s+/g, " ")}`,
    ]);
    if (!input.supersedes) {
      const existing = await client.query(
        `SELECT ${MEMORY_COLUMNS} FROM memories
         WHERE scope_type = $1 AND scope_id = $2 AND type = $3 AND status = 'active' AND archived_at IS NULL
           AND morfeu_fold(content) = morfeu_fold($4)
         ORDER BY recorded_at LIMIT 1`,
        [scope.type, scope.id, input.type, content],
      );
      if (existing.rows[0]) return { memory: mapMemory(existing.rows[0]), deduplicated: true, superseded_id: null };
    }
    let target: Memory | null = null;
    if (input.supersedes) {
      const start = await requireMemory(client, input.supersedes, { lock: true });
      target = await activeHead(client, start, { lock: true });
      if (!target) throw new Error(`supersedes: memory ${input.supersedes} is no longer active`);
      if (target.scope_type !== scope.type || target.scope_id !== scope.id) {
        throw new Error(
          `supersedes: memory ${target.id} belongs to ${target.scope_type}:${target.scope_id}, not ${scope.type}:${scope.id}`,
        );
      }
      if (target.origin === "owner" && input.origin !== "owner") {
        throw new Error(`supersedes: memory ${target.id} was stated by the user; change it with morfeu correct`);
      }
    }
    // A replacement starts now unless told otherwise; the old claim ends there (see settleChain).
    const validFrom = input.valid_from ?? (target ? now : null);
    const memory = await insertMemory(
      app,
      client,
      {
        content,
        type: input.type,
        scope,
        origin: input.origin ?? "saved",
        status: "active",
        importance: input.importance,
        confidence: input.origin === "owner" ? 1 : 0.9,
        volatility: input.volatility,
        attrs: input.attrs,
        valid_from: validFrom,
        valid_until: input.valid_until ?? null,
        supersedes_id: target?.id ?? null,
        entities: input.entities,
        source: input.source,
        agent_id: input.agent_id,
        session_id: input.session_id,
      },
      now,
    );
    if (target) {
      await settleChain(client, memory, now);
      if (target.pinned_at)
        await client.query("UPDATE memories SET pinned_at = $2 WHERE id = $1", [memory.id, target.pinned_at]);
    }
    return { memory, deduplicated: false, superseded_id: target?.id ?? null };
  });
}

export function validateContent(content: string): void {
  if (!content) throw new Error("content is required");
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(
      `content has ${content.length} characters (max ${MAX_CONTENT_CHARS}); save one atomic claim per memory`,
    );
  }
}

/** A validity end never before its start: the old claim ends where the new one begins, or at its own start. */
export function clampEnd(end: Date, start: Date | null): Date {
  return start && end < start ? start : end;
}
