import type { EventType, LedgerEvent } from "../core/types.js";
import { type Db, toDate, toDateOrNull } from "../db/client.js";
import { redact, redactJson } from "./redact.js";

export type NewEvent = {
  occurred_at: Date;
  ingested_at: Date;
  source: string;
  /** The id in the source system. Together with `source` it makes ingestion idempotent. */
  external_id: string;
  session_id?: string | null;
  agent_id?: string | null;
  type: EventType;
  content?: Record<string, unknown>;
  content_text: string;
  /** Set when the event needs no extraction (an explicit save is already a memory). */
  processed_at?: Date | null;
};

/**
 * Appends one event. Secrets are redacted before anything is stored. Replaying
 * the same (source, external_id) returns the existing row instead of a twin.
 */
export async function appendEvent(db: Db, event: NewEvent): Promise<{ id: string; inserted: boolean }> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO events (occurred_at, ingested_at, source, external_id, session_id, agent_id, type, content, content_text, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING id`,
    [
      event.occurred_at,
      event.ingested_at,
      event.source,
      event.external_id,
      event.session_id ?? null,
      event.agent_id ?? null,
      event.type,
      JSON.stringify(redactJson(event.content ?? {})),
      redact(event.content_text).text,
      event.processed_at ?? null,
    ],
  );
  const id = res.rows[0]?.id;
  if (id) return { id, inserted: true };
  const existing = await db.query<{ id: string }>("SELECT id FROM events WHERE source = $1 AND external_id = $2", [
    event.source,
    event.external_id,
  ]);
  const found = existing.rows[0]?.id;
  if (!found) throw new Error(`event ${event.source}/${event.external_id} was neither inserted nor found`);
  return { id: found, inserted: false };
}

export function mapEvent(row: Record<string, unknown>): LedgerEvent {
  return {
    id: String(row.id),
    occurred_at: toDate(row.occurred_at as Date),
    ingested_at: toDate(row.ingested_at as Date),
    source: String(row.source),
    external_id: (row.external_id as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    type: row.type as EventType,
    content: (row.content as Record<string, unknown>) ?? {},
    content_text: String(row.content_text),
    processed_at: toDateOrNull(row.processed_at as Date | null),
  };
}
