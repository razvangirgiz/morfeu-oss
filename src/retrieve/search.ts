import type { App } from "../app.js";
import type { Memory, MemoryType, Scope } from "../core/types.js";
import { errorMessage, Params } from "../db/client.js";
import { entitiesInText } from "../memory/entities.js";
import { MEMORY_COLUMNS, mapMemory } from "../memory/row.js";
import { scopeSql, servingSql } from "../memory/serving.js";
import { lastRetrieved, recordUsage } from "../memory/usage.js";
import { modelDimensions, nearestQuery, similaritySql } from "../memory/vectors.js";
import { embeddingsEnabled, resolveScope } from "../memory/write.js";
import { combine, effectiveWeights, type Signals, toSignals } from "./score.js";

export type SearchOptions = {
  now: Date;
  /** Undefined searches every scope; an empty list finds nothing. */
  scopes?: readonly Scope[];
  types?: readonly MemoryType[];
  /** Answer as of this time: what was true then, by what morfeu knows now. */
  asOf?: Date;
  limit?: number;
  /** Include unconsolidated candidates (present-time searches only). */
  includeCandidates?: boolean;
  /** A precomputed query vector, e.g. from a cache. */
  queryVector?: readonly number[];
  /** Skip semantic retrieval on purpose; keyword and entity retrieval still run. */
  skipSemantic?: boolean;
  /** Count the returned hits as retrieved (feeds recency and decay). */
  recordUsage?: boolean;
};

type SearchHit = { memory: Memory; score: number; signals: Signals };
export type SearchResult = { hits: SearchHit[]; warnings: string[] };

/** Candidates each retrieval pass contributes before scoring. */
const POOL = 50;
export const MAX_LIMIT = 50;

/**
 * Hybrid retrieval. Three passes collect candidates (vector similarity,
 * keyword match in the configured language, entities named in the query),
 * each under the same serving filter; the union is scored on relevance plus
 * recency, importance and confidence.
 */
export async function search(app: App, query: string, options: SearchOptions): Promise<SearchResult> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const text = query.trim();
  if (!text) throw new Error("query is empty");
  const warnings: string[] = [];
  const scopes = options.scopes?.map((s) => resolveScope(s, app.config.userId));
  if (scopes?.length === 0 || options.types?.length === 0) return { hits: [], warnings };

  const at = options.asOf ?? options.now;
  const where = (p: Params, alias?: string) =>
    [
      servingSql({
        timeParam: p.add(at),
        historical: Boolean(options.asOf),
        includeCandidates: options.includeCandidates && !options.asOf,
        alias,
      }),
      scopeSql(scopes, (v) => p.add(v), alias),
      options.types ? `${alias ? `${alias}.` : ""}type = ANY(${p.add(options.types)}::text[])` : "TRUE",
    ].join(" AND ");

  const vector =
    options.skipSemantic || !embeddingsEnabled(app)
      ? undefined
      : (options.queryVector ?? (await embedQuery(app, text, warnings)));
  const semantic = vector ? await semanticPool(app, vector, where) : new Map<string, number>();
  const { ranks: keyword, strict, available: keywordAvailable } = await keywordPool(app, text, where);
  const entities = await entitiesInText(app.pool, text);
  const entityIds = entities.map((e) => e.id);
  const entityHits = await entityPool(app, entityIds, where);

  const ids = new Set([...semantic.keys(), ...keyword.keys(), ...entityHits.keys()]);
  // A row that came only from the vector pass and sits below the model's
  // noise floor carries no relevance at all.
  for (const [id, similarity] of semantic) {
    if (similarity < app.config.semanticFloor && !keyword.has(id) && !entityHits.has(id)) ids.delete(id);
  }
  if (ids.size === 0) return { hits: [], warnings };

  const rows = await app.pool.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ANY($1::uuid[])`, [[...ids]]);
  const memories = rows.rows.map(mapMemory);
  const retrieved = await lastRetrieved(
    app.pool,
    memories.map((m) => m.id),
  );
  const keywordMax = Math.max(0, ...keyword.values());
  const weights = effectiveWeights({
    semantic: vector !== undefined,
    keyword: keywordAvailable,
    entity: entityIds.length > 0,
  });
  const hits = memories
    .map((memory) => {
      const signals = toSignals({
        similarity: semantic.get(memory.id),
        semanticFloor: app.config.semanticFloor,
        keywordRank: keyword.get(memory.id),
        keywordMax,
        strictMatch: strict.has(memory.id),
        entityHits: entityHits.get(memory.id) ?? 0,
        entityTotal: entityIds.length,
        importance: memory.importance,
        confidence: memory.confidence,
        observedAt: memory.observed_at,
        lastRetrievedAt: retrieved.get(memory.id),
        now: at,
        volatility: memory.volatility,
      });
      return { memory, score: combine(signals, weights), signals };
    })
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
    .slice(0, limit);

  if (options.recordUsage) {
    await recordUsage(
      app.pool,
      hits.map((h) => h.memory.id),
      options.now,
    ).catch((err) => app.log.warn(`could not record memory usage: ${errorMessage(err)}`));
  }
  return { hits, warnings };
}

async function embedQuery(app: App, text: string, warnings: string[]): Promise<readonly number[] | undefined> {
  try {
    return app.embedder.embedQuery ? await app.embedder.embedQuery(text) : (await app.embedder.embed([text]))[0];
  } catch (err) {
    warnings.push(`semantic retrieval unavailable, used keyword and entity retrieval (${errorMessage(err)})`);
    return undefined;
  }
}

type Where = (p: Params, alias?: string) => string;

async function semanticPool(app: App, vector: readonly number[], where: Where): Promise<Map<string, number>> {
  const model = app.embedder.model;
  const dimensions = await modelDimensions(app.pool, model);
  if (dimensions === undefined || dimensions !== vector.length) return new Map();
  const p = new Params();
  const sim = similaritySql(model, dimensions, p.add(`[${vector.join(",")}]`));
  const rows = await nearestQuery<{ id: string; similarity: number }>(
    app.pool,
    `SELECT m.id, ${sim.similarity} AS similarity
     FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
     WHERE ${sim.filter} AND ${where(p, "m")}
     ORDER BY ${sim.order}
     LIMIT ${POOL}`,
    p.values,
  );
  return new Map(rows.map((r) => [r.id, Number(r.similarity)]));
}

/**
 * Two keyword passes in the configured language. Strict: every word must
 * match (websearch syntax, phrases, -negation). Lenient: any content word;
 * stopwords are dropped by the language's dictionary. Ranking divides by
 * log length so a short atomic memory can beat a long one that repeats words.
 */
async function keywordPool(
  app: App,
  text: string,
  where: Where,
): Promise<{ ranks: Map<string, number>; strict: Set<string>; available: boolean }> {
  const lenient = await app.pool.query<{ q: string }>("SELECT plainto_tsquery('morfeu_fts', $1)::text AS q", [text]);
  const lexemes = lenient.rows[0]?.q ?? "";
  if (!lexemes) return { ranks: new Map(), strict: new Set(), available: false };
  const anyWord = lexemes.replace(/\s&\s/g, " | ");

  const p = new Params();
  const q = p.add(anyWord);
  const ranked = await app.pool.query<{ id: string; rank: number }>(
    `SELECT id, ts_rank_cd(to_tsvector('morfeu_fts', content), to_tsquery('simple', ${q}), 1) AS rank
     FROM memories
     WHERE to_tsvector('morfeu_fts', content) @@ to_tsquery('simple', ${q}) AND ${where(p)}
     ORDER BY rank DESC, id
     LIMIT ${POOL}`,
    p.values,
  );
  const strictParams = new Params();
  const sq = strictParams.add(text);
  const strict = await app.pool
    .query<{ id: string }>(
      `SELECT id FROM memories
       WHERE to_tsvector('morfeu_fts', content) @@ websearch_to_tsquery('morfeu_fts', ${sq}) AND ${where(strictParams)}
       LIMIT ${POOL}`,
      strictParams.values,
    )
    .catch(() => ({ rows: [] as { id: string }[] }));
  return {
    ranks: new Map(ranked.rows.map((r) => [r.id, Number(r.rank)])),
    strict: new Set(strict.rows.map((r) => r.id)),
    available: true,
  };
}

/** Memories linked to entities named in the query, with how many of them each mentions. */
async function entityPool(app: App, entityIds: readonly string[], where: Where): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  const p = new Params();
  const res = await app.pool.query<{ id: string; hits: string }>(
    `SELECT m.id, COUNT(*)::text AS hits
     FROM memory_entities me JOIN memories m ON m.id = me.memory_id
     WHERE me.entity_id = ANY(${p.add(entityIds)}::uuid[]) AND ${where(p, "m")}
     GROUP BY m.id
     ORDER BY COUNT(*) DESC, m.id
     LIMIT ${POOL}`,
    p.values,
  );
  return new Map(res.rows.map((r) => [r.id, Number(r.hits)]));
}
