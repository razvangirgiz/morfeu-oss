import type { Db } from "../db/client.js";

export type RunStatus = "done" | "failed";

/** Records the start of a background run (extract, dream, reindex...) in the audit trail. */
export async function startRun(db: Db, kind: string, now: Date): Promise<string> {
  const res = await db.query<{ id: string }>(
    "INSERT INTO runs (kind, started_at, status) VALUES ($1, $2, 'running') RETURNING id",
    [kind, now],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`could not record the start of a ${kind} run`);
  return id;
}

export async function finishRun(
  db: Db,
  id: string,
  finishedAt: Date,
  status: RunStatus,
  stats: object,
  error?: string,
): Promise<void> {
  await db.query("UPDATE runs SET finished_at = $2, status = $3, stats = $4::jsonb, error = $5 WHERE id = $1", [
    id,
    finishedAt,
    status,
    JSON.stringify(stats),
    error ?? null,
  ]);
}
