import type { App } from "../app.js";
import { errorMessage } from "../db/client.js";
import { memoriesWithoutVector, storeVector } from "./vectors.js";

const BATCH = 32;

/**
 * Embeds memories that have no vector for the current model: saved while the
 * embedder was down, or from before a model change. Stops at the first
 * failure and reports it; the rest is picked up next time.
 */
export async function reindexVectors(app: App, limit = 2000): Promise<{ embedded: number; error?: string }> {
  let embedded = 0;
  while (embedded < limit) {
    const batch = await memoriesWithoutVector(app.pool, app.embedder.model, Math.min(BATCH, limit - embedded));
    if (batch.length === 0) break;
    let vectors: number[][];
    try {
      vectors = await app.embedder.embed(batch.map((m) => m.content));
    } catch (err) {
      return { embedded, error: errorMessage(err) };
    }
    for (const [i, memory] of batch.entries()) {
      const vector = vectors[i];
      if (vector) await storeVector(app.pool, memory.id, app.embedder.model, vector);
    }
    embedded += batch.length;
  }
  return { embedded };
}
