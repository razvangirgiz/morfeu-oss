import type { App } from "../app.js";
import {
  ENTITY_TYPES,
  type EntityType,
  type LedgerEvent,
  type MemoryType,
  type Scope,
  VOLATILITIES,
  type Volatility,
} from "../core/types.js";
import { errorMessage, withRunLock, withTx } from "../db/client.js";
import { mapEvent } from "../ledger/events.js";
import { finishRun, startRun } from "../ledger/runs.js";
import { embeddingsEnabled, insertMemory, warnEmbeddingUnavailable } from "../memory/write.js";
import { MaxCallsReachedError } from "../providers/errors.js";
import { dropForbidden } from "./never-extract.js";
import { EXTRACT_SCHEMA, EXTRACTABLE_TYPES, type ExtractedCandidate, extractorPrompt } from "./schema.js";

export type ExtractOptions = {
  now: Date;
  /** Only this session. */
  session?: string;
  /** At most this many sessions, oldest first. */
  limit?: number;
  /** Count the work without calling the LLM. */
  estimate?: boolean;
};

export type ExtractResult = {
  sessions: number;
  chunks: number;
  events: number;
  /** Rough input size, for --estimate. */
  approx_input_tokens: number;
  candidates: number;
  rejected: number;
  forbidden: number;
  /** Set when the LLM call limit ended the run early; the rest waits for the next run. */
  stopped?: "max_calls";
};

const MAX_EVENTS_PER_CHUNK = 100;
const MAX_CHARS_PER_CHUNK = 50_000;
/** One pasted document must not blow up a chunk; longer events are clipped (provenance stays). */
const MAX_EVENT_CHARS = 20_000;

type Session = { id: string | null; project: string; agent: string; chunks: LedgerEvent[][] };

/**
 * Turns unprocessed ledger events into candidate memories, one LLM call per
 * chunk of a session. Candidates wait for the dream to consolidate them.
 * Each chunk commits its candidates and marks its events processed in one
 * transaction, so a crash never duplicates or loses a chunk.
 */
export async function extract(app: App, options: ExtractOptions): Promise<ExtractResult> {
  const sessions = await pendingSessions(app, options);
  const result: ExtractResult = {
    sessions: sessions.length,
    chunks: sessions.reduce((n, s) => n + s.chunks.length, 0),
    events: sessions.reduce((n, s) => n + s.chunks.flat().length, 0),
    approx_input_tokens: Math.ceil(
      sessions.flatMap((s) => s.chunks.flat()).reduce((n, e) => n + clip(e.content_text).length, 0) / 4,
    ),
    candidates: 0,
    rejected: 0,
    forbidden: 0,
  };
  if (options.estimate || sessions.length === 0) return result;

  return withRunLock(app.pool, "morfeu-extract", async () => {
    const runId = await startRun(app.pool, "extract", options.now);
    try {
      for (const session of sessions) {
        for (const chunk of session.chunks) {
          app.llm.checkBudget();
          const r = await extractChunk(app, session, chunk, options.now);
          result.candidates += r.candidates;
          result.rejected += r.rejected;
          result.forbidden += r.forbidden;
        }
      }
    } catch (err) {
      if (!(err instanceof MaxCallsReachedError)) {
        await finishRun(app.pool, runId, options.now, "failed", result, errorMessage(err));
        throw err;
      }
      result.stopped = "max_calls";
    }
    await finishRun(app.pool, runId, options.now, "done", { ...result, llm_calls: app.llm.calls });
    return result;
  });
}

async function pendingSessions(app: App, options: ExtractOptions): Promise<Session[]> {
  const params: unknown[] = [];
  let filter = "";
  if (options.session) {
    params.push(options.session);
    filter = " AND session_id = $1";
  }
  const res = await app.pool.query(
    `SELECT * FROM events WHERE processed_at IS NULL${filter} ORDER BY occurred_at, id`,
    params,
  );
  const bySession = new Map<string | null, LedgerEvent[]>();
  for (const event of res.rows.map(mapEvent)) {
    const list = bySession.get(event.session_id) ?? [];
    list.push(event);
    bySession.set(event.session_id, list);
  }
  const sessions = [...bySession.entries()].map(([id, events]) => ({
    id,
    project: String(events[0]?.content.project ?? ""),
    agent: events[0]?.agent_id ?? "",
    chunks: chunkEvents(events),
  }));
  return options.limit === undefined ? sessions : sessions.slice(0, options.limit);
}

function chunkEvents(events: readonly LedgerEvent[]): LedgerEvent[][] {
  const chunks: LedgerEvent[][] = [];
  let current: LedgerEvent[] = [];
  let chars = 0;
  for (const event of events) {
    const length = clip(event.content_text).length;
    if (current.length > 0 && (current.length >= MAX_EVENTS_PER_CHUNK || chars + length > MAX_CHARS_PER_CHUNK)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(event);
    chars += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function clip(text: string): string {
  return text.length <= MAX_EVENT_CHARS
    ? text
    : `${text.slice(0, MAX_EVENT_CHARS)}\n[... ${text.length - MAX_EVENT_CHARS} characters clipped]`;
}

function renderChunk(session: Session, chunk: readonly LedgerEvent[], now: Date): string {
  const events = chunk.map((e, i) => `[${i}] ${e.occurred_at.toISOString()} ${e.type}\n${clip(e.content_text)}`);
  return `Current date: ${now.toISOString()}\nProject: ${session.project || "(none)"}\n\nEvents:\n${events.join("\n\n")}`;
}

async function extractChunk(
  app: App,
  session: Session,
  chunk: readonly LedgerEvent[],
  now: Date,
): Promise<{ candidates: number; rejected: number; forbidden: number }> {
  const raw = (await app.llm.complete({
    system: extractorPrompt(app.config.neverExtract),
    user: renderChunk(session, chunk, now),
    schemaName: "extracted_memories",
    jsonSchema: EXTRACT_SCHEMA,
  })) as { memories?: ExtractedCandidate[] };
  const proposed = Array.isArray(raw.memories) ? raw.memories : [];
  const { kept, dropped } = await dropForbidden(app, proposed);
  const vectors = await embedAll(
    app,
    kept.map((c) => c.content),
  );
  let candidates = 0;
  let rejected = 0;

  await withTx(app.pool, async (client) => {
    // Claim the chunk; if another run processed these events first, drop ours.
    const claim = await client.query(
      "SELECT id FROM events WHERE id = ANY($1::uuid[]) AND processed_at IS NULL FOR UPDATE",
      [chunk.map((e) => e.id)],
    );
    if ((claim.rowCount ?? 0) < chunk.length) return;
    for (const [i, candidate] of kept.entries()) {
      const valid = validate(candidate, chunk, session, app.config.userId);
      if (!valid) {
        rejected += 1;
        continue;
      }
      await insertMemory(
        app,
        client,
        {
          ...valid,
          origin: "extracted",
          status: "candidate",
          observed_at: valid.observed_at,
          vector: vectors[i] ?? null,
        },
        now,
      );
      candidates += 1;
    }
    await client.query("UPDATE events SET processed_at = $1 WHERE id = ANY($2::uuid[])", [now, chunk.map((e) => e.id)]);
  });
  return { candidates, rejected, forbidden: dropped };
}

async function embedAll(app: App, texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0 || !embeddingsEnabled(app)) return texts.map(() => null);
  try {
    return await app.embedder.embed(texts);
  } catch (err) {
    warnEmbeddingUnavailable(app, err);
    return texts.map(() => null);
  }
}

/**
 * Model output is untrusted: types and dates are checked, scope ids come from
 * the session, and every claim must point at an event it came from.
 */
function validate(candidate: ExtractedCandidate, chunk: readonly LedgerEvent[], session: Session, userId: string) {
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  if (!content || !(EXTRACTABLE_TYPES as readonly string[]).includes(candidate.type)) return null;
  const sources = (candidate.source_event_indices ?? [])
    .filter((i) => Number.isInteger(i) && i >= 0 && i < chunk.length)
    .map((i) => chunk[i] as LedgerEvent);
  if (sources.length === 0) return null;
  let scope: Scope;
  if (candidate.scope_type === "project") {
    if (!session.project) return null;
    scope = { type: "project", id: session.project };
  } else if (candidate.scope_type === "agent") {
    scope = { type: "agent", id: session.agent || "default" };
  } else {
    scope = { type: "user", id: userId };
  }
  const validFrom = parseDate(candidate.valid_from);
  let validUntil = parseDate(candidate.valid_until);
  if (validFrom && validUntil && validUntil < validFrom) validUntil = null;
  return {
    content,
    type: candidate.type as MemoryType,
    scope,
    importance: unit(candidate.importance, 0.5),
    confidence: unit(candidate.confidence, 0.7),
    volatility: (VOLATILITIES as readonly string[]).includes(candidate.volatility)
      ? (candidate.volatility as Volatility)
      : undefined,
    valid_from: validFrom,
    valid_until: validUntil,
    observed_at: sources.reduce(
      (latest, e) => (e.occurred_at > latest ? e.occurred_at : latest),
      sources[0]!.occurred_at,
    ),
    entities: (candidate.entities ?? [])
      .filter((e) => typeof e?.name === "string" && (ENTITY_TYPES as readonly string[]).includes(e.type))
      .map((e) => ({ name: e.name, type: e.type as EntityType })),
    sourceEventIds: sources.map((e) => e.id),
    session_id: session.id,
    agent_id: session.agent || null,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function unit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}
