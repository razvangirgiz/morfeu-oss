import { createHash } from "node:crypto";
import { type Db, quoteIdent, quoteLiteral, vectorLiteral } from "../db/client.js";

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

async function ensureIndex(db: Db, model: string, dimensions: number): Promise<void> {
  const known = await modelDimensions(db, model);
  if (known === dimensions) return;
  if (known !== undefined) {
    throw new Error(
      `embedding model ${model} returned ${dimensions}-dimensional vectors, but stored vectors have ${known}; ` +
        "use a different model name or keep the model's native dimension",
    );
  }
  if (dimensions > 2000)
    throw new Error(`pgvector indexes vectors of at most 2000 dimensions; ${model} has ${dimensions}`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName(model))} ON memory_embeddings
     USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops)
     WHERE model = ${quoteLiteral(model)}`,
  );
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO NOTHING`,
    [`vector_dims:${model}`, String(dimensions)],
  );
  knownDimensions.set(model, dimensions);
}

export async function storeVector(db: Db, memoryId: string, model: string, vector: readonly number[]): Promise<void> {
  await ensureIndex(db, model, vector.length);
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
