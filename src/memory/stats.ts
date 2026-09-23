import type { App } from "../app.js";

export type Stats = {
  events: { total: number; unprocessed: number };
  memories: Record<string, number>;
  pinned: number;
  entities: number;
  vectors: { model: string; indexed: number; missing: number };
  last_runs: { kind: string; status: string; started_at: Date; stats: unknown }[];
};

export async function getStats(app: App): Promise<Stats> {
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    (await app.pool.query(sql, params)).rows[0] as T;
  const events = await one<{ total: number; unprocessed: number }>(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed FROM events",
  );
  const byStatus = await app.pool.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM memories GROUP BY status ORDER BY status",
  );
  const pinned = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM memories WHERE pinned_at IS NOT NULL AND status = 'active'",
  );
  const entities = await one<{ n: number }>("SELECT count(*)::int AS n FROM entities");
  const vectors = await one<{ indexed: number; missing: number }>(
    `SELECT count(e.memory_id)::int AS indexed, count(*) FILTER (WHERE e.memory_id IS NULL)::int AS missing
     FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = $1
     WHERE m.status IN ('active', 'candidate')`,
    [app.embedder.model],
  );
  const runs = await app.pool.query(
    `SELECT DISTINCT ON (kind) kind, status, started_at, stats FROM runs ORDER BY kind, started_at DESC`,
  );
  return {
    events,
    memories: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
    pinned: pinned.n,
    entities: entities.n,
    vectors: { model: app.embedder.model, ...vectors },
    last_runs: runs.rows,
  };
}

export function formatStats(stats: Stats): string {
  const memories =
    Object.entries(stats.memories)
      .map(([status, n]) => `${status} ${n}`)
      .join(", ") || "none";
  const lines = [
    `events      ${stats.events.total} (${stats.events.unprocessed} waiting for extraction)`,
    `memories    ${memories}`,
    `pinned      ${stats.pinned}`,
    `entities    ${stats.entities}`,
    `vectors     ${stats.vectors.indexed} indexed with ${stats.vectors.model}, ${stats.vectors.missing} missing`,
  ];
  for (const run of stats.last_runs) {
    lines.push(`last ${run.kind.padEnd(7)} ${run.status} at ${new Date(run.started_at).toISOString()}`);
  }
  return lines.join("\n");
}
