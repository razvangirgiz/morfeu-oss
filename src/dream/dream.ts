import type { App } from "../app.js";
import type { DreamAction, Memory, Scope } from "../core/types.js";
import { errorMessage, withRunLock, withTx } from "../db/client.js";
import { finishRun, startRun } from "../ledger/runs.js";
import { MEMORY_COLUMNS, mapMemory, memoryColumns } from "../memory/row.js";
import { modelDimensions } from "../memory/vectors.js";
import { MaxCallsReachedError } from "../providers/errors.js";
import { applyDecision } from "./apply.js";
import { archiveStale } from "./decay.js";
import { DREAM_PROMPT, DREAM_SCHEMA, type DreamDecision } from "./schema.js";

export type DreamOptions = { now: Date; scope?: Scope };

export type DreamResult = Record<DreamAction, number> & {
  candidates: number;
  /** Active memories whose valid_until passed, marked expired without an LLM call. */
  expired: number;
  archived: number;
  stopped?: "max_calls";
};

const BATCH = 20;
const NEIGHBORS = 8;
/** Cosine similarity above which an active memory is shown as a possible duplicate or predecessor. */
const NEIGHBOR_SIMILARITY = 0.75;

/**
 * Consolidates candidates into the store, a batch of them per LLM call.
 * Each candidate is shown with its neighborhood (similar and entity-linked
 * active memories in the same scope) and the model picks one action for it.
 * Decisions apply one transaction each; anything left undecided becomes
 * active as is. Every decision is recorded in dream_decisions.
 */
export async function dream(app: App, options: DreamOptions): Promise<DreamResult> {
  return withRunLock(app.pool, "morfeu-dream", async () => {
    const { now } = options;
    const result: DreamResult = {
      candidates: 0,
      expired: await expirePassed(app, now),
      archived: app.config.decay ? await archiveStale(app.pool, now) : 0,
      add: 0,
      duplicate: 0,
      supersede: 0,
      temporal_update: 0,
      expire: 0,
      reject: 0,
    };
    const runId = await startRun(app.pool, "dream", now);
    try {
      for (const scope of await candidateScopes(app, options.scope)) {
        const candidates = await candidatesIn(app, scope);
        result.candidates += candidates.length;
        for (let i = 0; i < candidates.length; i += BATCH) {
          app.llm.checkBudget();
          await consolidateBatch(app, runId, candidates.slice(i, i + BATCH), now, result);
        }
      }
    } catch (err) {
      if (!(err instanceof MaxCallsReachedError)) {
        await finishRun(app.pool, runId, now, "failed", result, errorMessage(err));
        throw err;
      }
      result.stopped = "max_calls";
    }
    await finishRun(app.pool, runId, now, "done", { ...result, llm_calls: app.llm.calls });
    return result;
  });
}

async function expirePassed(app: App, now: Date): Promise<number> {
  const res = await app.pool.query(
    "UPDATE memories SET status = 'expired' WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until <= $1",
    [now],
  );
  return res.rowCount ?? 0;
}

async function candidateScopes(app: App, only?: Scope): Promise<Scope[]> {
  if (only) return [only];
  const res = await app.pool.query<Scope>(
    "SELECT DISTINCT scope_type AS type, scope_id AS id FROM memories WHERE status = 'candidate' ORDER BY 1, 2",
  );
  return res.rows;
}

async function candidatesIn(app: App, scope: Scope): Promise<Memory[]> {
  const res = await app.pool.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories
     WHERE status = 'candidate' AND scope_type = $1 AND scope_id = $2
     ORDER BY observed_at, id`,
    [scope.type, scope.id],
  );
  return res.rows.map(mapMemory);
}

async function consolidateBatch(app: App, runId: string, batch: Memory[], now: Date, result: DreamResult) {
  const neighborhoods = await Promise.all(batch.map((c) => neighborhood(app, c)));
  const raw = (await app.llm.complete({
    system: DREAM_PROMPT,
    user: renderBatch(batch, neighborhoods, now),
    schemaName: "dream_decisions",
    jsonSchema: DREAM_SCHEMA,
  })) as { decisions?: DreamDecision[] };
  const batchIds = batch.map((c) => c.id);
  const decided = new Set<number>();
  // Candidate order, not response order: a later candidate may build on an earlier one.
  const decisions = (raw.decisions ?? [])
    .filter((d) => Number.isInteger(d.candidate_index) && d.candidate_index >= 0 && d.candidate_index < batch.length)
    .sort((a, b) => a.candidate_index - b.candidate_index);
  for (const decision of decisions) {
    if (decided.has(decision.candidate_index)) continue;
    decided.add(decision.candidate_index);
    const candidate = batch[decision.candidate_index] as Memory;
    const allowed = new Set([...batchIds, ...(neighborhoods[decision.candidate_index] ?? []).map((m) => m.id)]);
    const action = await withTx(app.pool, async (client) => {
      const locked = await client.query("SELECT status FROM memories WHERE id = $1 FOR UPDATE", [candidate.id]);
      if (locked.rows[0]?.status !== "candidate") return null;
      return applyDecision({ app, client, runId, candidate, decision, allowed, now });
    });
    if (action) result[action] += 1;
  }
  for (const [i, candidate] of batch.entries()) {
    if (decided.has(i)) continue;
    await withTx(app.pool, async (client) => {
      const res = await client.query("UPDATE memories SET status = 'active' WHERE id = $1 AND status = 'candidate'", [
        candidate.id,
      ]);
      if (res.rowCount === 0) return;
      await client.query(
        "INSERT INTO dream_decisions (run_id, memory_id, action, reason) VALUES ($1, $2, 'add', 'no decision returned')",
        [runId, candidate.id],
      );
      result.add += 1;
    });
  }
}

/** Active memories in the candidate's scope that look similar or share an entity with it. */
async function neighborhood(app: App, candidate: Memory): Promise<Memory[]> {
  const found = new Map<string, Memory>();
  const model = app.embedder.model;
  const dimensions = await modelDimensions(app.pool, model);
  if (dimensions) {
    const cast = (column: string) => `${column}::vector(${dimensions})`;
    const similar = await app.pool.query(
      `SELECT ${memoryColumns("m")}
       FROM memory_embeddings c
       JOIN memory_embeddings e ON e.model = c.model AND e.memory_id <> c.memory_id
       JOIN memories m ON m.id = e.memory_id
       WHERE c.memory_id = $1 AND c.model = $2
         AND m.status = 'active' AND m.scope_type = $3 AND m.scope_id = $4
         AND 1 - (${cast("e.embedding")} <=> ${cast("c.embedding")}) > ${NEIGHBOR_SIMILARITY}
       ORDER BY ${cast("e.embedding")} <=> ${cast("c.embedding")}
       LIMIT ${NEIGHBORS}`,
      [candidate.id, model, candidate.scope_type, candidate.scope_id],
    );
    for (const row of similar.rows.map(mapMemory)) found.set(row.id, row);
  }
  const linked = await app.pool.query(
    `SELECT DISTINCT ${memoryColumns("m")}
     FROM memory_entities mine
     JOIN memory_entities theirs ON theirs.entity_id = mine.entity_id AND theirs.memory_id <> mine.memory_id
     JOIN memories m ON m.id = theirs.memory_id
     WHERE mine.memory_id = $1 AND m.status = 'active' AND m.scope_type = $2 AND m.scope_id = $3
     LIMIT ${NEIGHBORS}`,
    [candidate.id, candidate.scope_type, candidate.scope_id],
  );
  for (const row of linked.rows.map(mapMemory)) if (!found.has(row.id)) found.set(row.id, row);
  return [...found.values()];
}

function renderBatch(batch: readonly Memory[], neighborhoods: readonly Memory[][], now: Date): string {
  const date = (d: Date | null) => d?.toISOString() ?? "null";
  const blocks = batch.map((c, i) => {
    const neighbors = (neighborhoods[i] ?? [])
      .map((n) => `  - ${n.id} (${n.type}, valid ${date(n.valid_from)} to ${date(n.valid_until)}): ${n.content}`)
      .join("\n");
    return [
      `Candidate ${i} (id ${c.id})`,
      `type=${c.type} observed=${c.observed_at.toISOString()} valid_from=${date(c.valid_from)} valid_until=${date(c.valid_until)}`,
      `content: ${c.content}`,
      `neighborhood:\n${neighbors || "  (none)"}`,
    ].join("\n");
  });
  return `Current date: ${now.toISOString()}\n\n${blocks.join("\n\n")}`;
}
