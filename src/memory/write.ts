import { randomUUID } from "node:crypto";
import type { App } from "../app.js";
import {
  defaultVolatility,
  type EntityInput,
  type Memory,
  type MemoryOrigin,
  type MemoryType,
  type Scope,
  type Volatility,
} from "../core/types.js";
import { type Db, errorMessage } from "../db/client.js";
import { appendEvent } from "../ledger/events.js";
import { redact } from "../ledger/redact.js";
import { linkEntities } from "./entities.js";
import { MEMORY_COLUMNS, mapMemory } from "./row.js";
import { prepareVectorIndex, storeVector } from "./vectors.js";

export type NewMemory = {
  content: string;
  type: MemoryType;
  scope: Scope;
  origin: MemoryOrigin;
  status: "candidate" | "active";
  importance?: number;
  confidence?: number;
  volatility?: Volatility;
  attrs?: Record<string, unknown>;
  observed_at?: Date;
  valid_from?: Date | null;
  valid_until?: Date | null;
  supersedes_id?: string | null;
  entities?: readonly EntityInput[];
  /** Ledger events the memory comes from. Without any, a note event is appended so every memory has a source. */
  sourceEventIds?: readonly string[];
  /** Ledger source for that note event, e.g. "mcp" or "cli". */
  source?: string;
  session_id?: string | null;
  agent_id?: string | null;
  /** A vector computed by the caller for this exact content; null when the embedder already failed. */
  vector?: readonly number[] | null;
};

export type WriteDeps = Pick<App, "config" | "embedder" | "log">;

/** Explicit saves longer than this are nearly always a pasted document, not one claim. */
export const MAX_CONTENT_CHARS = 1000;

/** Extracted and saved memories never outrank what the user said about themselves. */
const NON_OWNER_IMPORTANCE_CAP = 0.8;

/**
 * Writes one memory with its provenance, entities and vector. Secrets are
 * redacted first. The vector is best effort: if the embedder is unavailable
 * the memory is stored without one and `morfeu reindex` fills it in later.
 */
export async function insertMemory(deps: WriteDeps, db: Db, input: NewMemory, now: Date): Promise<Memory> {
  const content = redact(input.content.trim()).text;
  if (!content) throw new Error("memory content is empty");
  const scope = resolveScope(input.scope, deps.config.userId);
  const observedAt = input.observed_at ?? now;
  const validFrom = input.valid_from ?? null;
  const validUntil = input.valid_until ?? null;
  if (validFrom && validUntil && validUntil < validFrom) {
    throw new Error(`valid_until (${validUntil.toISOString()}) is before valid_from (${validFrom.toISOString()})`);
  }
  const importance = clamp01(input.importance ?? 0.5, "importance");
  const sourceIds = [...(input.sourceEventIds ?? [])];
  if (sourceIds.length === 0) {
    const event = await appendEvent(db, {
      occurred_at: observedAt,
      ingested_at: now,
      source: input.source ?? "manual",
      external_id: randomUUID(),
      session_id: input.session_id ?? null,
      agent_id: input.agent_id ?? null,
      type: "note",
      content: scope.type === "project" ? { project: scope.id } : {},
      content_text: content,
      // Already distilled into this memory; extraction must not read it again.
      processed_at: now,
    });
    sourceIds.push(event.id);
  }
  const res = await db.query(
    `INSERT INTO memories (scope_type, scope_id, type, content, attrs, importance, confidence, volatility, origin,
                           status, observed_at, valid_from, valid_until, recorded_at, supersedes_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${MEMORY_COLUMNS}`,
    [
      scope.type,
      scope.id,
      input.type,
      content,
      JSON.stringify(input.attrs ?? {}),
      input.origin === "owner" ? importance : Math.min(importance, NON_OWNER_IMPORTANCE_CAP),
      clamp01(input.confidence ?? 0.7, "confidence"),
      input.volatility ?? defaultVolatility(input.type),
      input.origin,
      input.status,
      observedAt,
      validFrom,
      validUntil,
      now,
      input.supersedes_id ?? null,
    ],
  );
  const memory = mapMemory(res.rows[0]);
  for (const eventId of sourceIds) {
    await db.query("INSERT INTO memory_sources (memory_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      memory.id,
      eventId,
    ]);
  }
  if (input.entities?.length) await linkEntities(db, memory.id, input.entities);
  const vector =
    content === input.content.trim() && input.vector !== undefined ? input.vector : await embedOrNull(deps, content);
  if (vector) {
    if (await prepareVectorIndex(deps.config.databaseUrl, deps.embedder.model, vector.length)) {
      await storeVector(db, memory.id, deps.embedder.model, vector);
    } else {
      warnEmbeddingUnavailable(
        deps,
        new Error(`${deps.embedder.model} vectors of ${vector.length} dimensions cannot be indexed`),
      );
    }
  }
  return memory;
}

let warnedUnavailable = false;

/** False when the user chose no embedder (MORFEU_EMBEDDING_PROVIDER=none): no vectors, and no warnings about it. */
export function embeddingsEnabled(deps: Pick<App, "embedder">): boolean {
  return deps.embedder.name !== "none";
}

/** Embeds one text, or returns null (and warns once per process) when the embedder is unavailable. */
async function embedOrNull(deps: Pick<App, "embedder" | "log">, text: string): Promise<number[] | null> {
  if (!embeddingsEnabled(deps)) return null;
  try {
    return (await deps.embedder.embed([text]))[0] ?? null;
  } catch (err) {
    warnEmbeddingUnavailable(deps, err);
    return null;
  }
}

export function warnEmbeddingUnavailable(deps: Pick<App, "log">, err: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  deps.log.warn(`embeddings unavailable, storing without vectors; run \`morfeu reindex\` later (${errorMessage(err)})`);
}

/** `user:me` is an alias for the configured user id. */
export function resolveScope(scope: Scope, userId: string): Scope {
  if (scope.type === "user" && scope.id === "me" && userId) return { type: "user", id: userId };
  if (scope.type === "agent") return { type: "agent", id: scope.id.toLowerCase() };
  return scope;
}

/** The events a memory was distilled from; a successor inherits them. */
export async function sourcesOf(db: Db, memoryId: string): Promise<string[]> {
  const res = await db.query<{ event_id: string }>("SELECT event_id FROM memory_sources WHERE memory_id = $1", [
    memoryId,
  ]);
  return res.rows.map((r) => r.event_id);
}

function clamp01(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  return value;
}
