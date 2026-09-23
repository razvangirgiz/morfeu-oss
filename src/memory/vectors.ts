import { createHash } from "node:crypto";
import pg from "pg";
import { type Db, type Pool, quoteIdent, quoteLiteral, vectorLiteral, withTx } from "../db/client.js";

/**
 * Vectors are stored per (memory, model) in one table whose column has no fixed
 * dimension. Each model gets its own partial HNSW index over a cast to its
 * dimension, created the first time that model writes a vector. Queries must
 * use the same cast and a literal model name for Postgres to pick the index.
 */

const knownDimensions = new Map<string, number>();

function indexName(model: string): string {
  return `memory_embeddings_${createHash("sha256").update(model).digest("hex").slice(0, 12)}`;
}

/** The dimension recorded for a model, or undefined when it has never written a vector. */
export async function modelDimensions(db: Db, model: string): Promise<number | undefined> {
  const cached = knownDimensions.get(model);
  if (cached) return cached;
  const res = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [`vector_dims:${model}`]);
  const value = res.rows[0] ? Number(res.rows[0].value) : undefined;
  if (value) knownDimensions.set(model, value);
  return value;
}

/**
 * Makes sure the model has its index before vectors are stored. The index is
 * created on a separate, short-lived connection and committed on its own, so
 * a rollback elsewhere never leaves this process believing in an index that
 * does not exist, and a caller holding every pooled connection cannot starve
 * it. Returns false when the vectors cannot be indexed (a dimension change, or
 * more than pgvector's 2000), and the caller stores the memory without one.
 */
export async function prepareVectorIndex(databaseUrl: string, model: string, dimensions: number): Promise<boolean> {
  const cached = knownDimensions.get(model);
  if (cached !== undefined) return cached === dimensions;
  if (dimensions < 1 || dimensions > 2000) return false;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('morfeu-vector-index'))");
    const known = await client.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [
      `vector_dims:${model}`,
    ]);
    let stored = known.rows[0] ? Number(known.rows[0].value) : undefined;
    if (stored === undefined) {
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName(model))} ON memory_embeddings
         USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops)
         WHERE model = ${quoteLiteral(model)}`,
      );
      await client.query("INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())", [
        `vector_dims:${model}`,
        String(dimensions),
      ]);
      stored = dimensions;
    }
    await client.query("COMMIT");
    knownDimensions.set(model, stored);
    return stored === dimensions;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** Stores a vector; call prepareVectorIndex for the model first. */
export async function storeVector(db: Db, memoryId: string, model: string, vector: readonly number[]): Promise<void> {
  await db.query(
    `INSERT INTO memory_embeddings (memory_id, model, embedding) VALUES ($1, $2, $3::vector)
     ON CONFLICT (memory_id, model) DO NOTHING`,
    [memoryId, model, vectorLiteral(vector)],
  );
}

/**
 * SQL for the cosine similarity of `memory_embeddings e` to a query vector,
 * written so the model's index applies. `param` is the placeholder holding the
 * vector literal.
 */
export function similaritySql(
  model: string,
  dimensions: number,
  param: string,
): { similarity: string; filter: string; order: string } {
  const cast = `e.embedding::vector(${dimensions})`;
  const query = `${param}::vector(${dimensions})`;
  return {
    similarity: `1 - (${cast} <=> ${query})`,
    filter: `e.model = ${quoteLiteral(model)}`,
    order: `${cast} <=> ${query}`,
  };
}

/** Memories that have no vector for this model yet, e.g. saved while the embedder was down. */
export async function memoriesWithoutVector(
  db: Db,
  model: string,
  limit: number,
): Promise<{ id: string; content: string }[]> {
  const res = await db.query<{ id: string; content: string }>(
    `SELECT m.id, m.content FROM memories m
     WHERE m.status IN ('active', 'candidate')
       AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = $1)
     ORDER BY m.recorded_at, m.id
     LIMIT $2`,
    [model, limit],
  );
  return res.rows;
}

/** For tests: forget cached dimensions after the database is reset. */
export function clearVectorCache(): void {
  knownDimensions.clear();
}

let iterativeScan: boolean | undefined;

/**
 * Runs a nearest-neighbour query so that filters do not silently shrink it.
 * HNSW returns its ef_search closest rows before WHERE clauses apply; with
 * scope, status or as-of filters most of them can be dropped. A larger
 * ef_search, and on pgvector 0.8+ iterative scans, keep the pool full.
 */
export async function nearestQuery<T extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  if (iterativeScan === undefined) {
    const res = await pool.query<{ v: string }>("SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'");
    const [major = 0, minor = 0] = (res.rows[0]?.v ?? "0.0").split(".").map(Number);
    iterativeScan = major > 0 || minor >= 8;
  }
  return withTx(pool, async (client) => {
    await client.query("SET LOCAL hnsw.ef_search = 200");
    if (iterativeScan) await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    return (await client.query<T>(sql, params)).rows;
  });
}
