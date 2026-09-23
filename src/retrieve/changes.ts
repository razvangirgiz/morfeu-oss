import type { App } from "../app.js";
import type { Memory, MemoryType, Scope } from "../core/types.js";
import { Params, toDate } from "../db/client.js";
import { forgottenSql } from "../memory/forget.js";
import { mapMemory, memoryColumns } from "../memory/row.js";
import { scopeSql } from "../memory/serving.js";
import { resolveScope } from "../memory/write.js";

/**
 * new:       learned in the window and still active (dated by observed_at)
 * changed:   replaced because the world changed (dated by the successor's recorded_at)
 * corrected: found to be wrong and replaced (dated by retracted_at)
 * expired:   stopped being true (dated by valid_until)
 * Forgotten memories are never listed.
 */
export const CHANGE_KINDS = ["new", "changed", "corrected", "expired"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

type Change = { kind: ChangeKind; at: Date; memory: Memory; successor_id: string | null };
export type ChangesResult = { changes: Change[]; summary: Record<ChangeKind, number> };

export type ChangesOptions = {
  since: Date;
  now: Date;
  scopes?: readonly Scope[];
  types?: readonly MemoryType[];
  kind?: ChangeKind;
  limit?: number;
};

// An active row whose valid_until has passed is reported as expired even
// before the dream marks it so.
const classified = (now: string) => `
  SELECT ${memoryColumns("m")}, CASE WHEN ${forgottenSql("s")} THEN NULL ELSE s.id END AS successor_id,
    CASE
      WHEN m.status = 'superseded' AND m.retracted_at IS NOT NULL THEN 'corrected'
      WHEN m.status = 'superseded' THEN 'changed'
      WHEN m.status = 'expired' OR m.valid_until <= ${now} THEN 'expired'
      ELSE 'new'
    END AS kind,
    CASE
      WHEN m.status = 'superseded' AND m.retracted_at IS NOT NULL THEN m.retracted_at
      WHEN m.status = 'superseded' THEN s.recorded_at
      WHEN m.status = 'expired' OR m.valid_until <= ${now} THEN m.valid_until
      ELSE m.observed_at
    END AS at
  FROM memories m LEFT JOIN memories s ON s.id = m.superseded_by_id
  WHERE (m.status IN ('superseded', 'expired') OR (m.status = 'active' AND m.archived_at IS NULL))`;

/** A chronological list of what changed since a date. Not a search: nothing is ranked. */
export async function listChanges(app: App, options: ChangesOptions): Promise<ChangesResult> {
  const summary: Record<ChangeKind, number> = { new: 0, changed: 0, corrected: 0, expired: 0 };
  const scopes = options.scopes?.map((s) => resolveScope(s, app.config.userId));
  if (scopes?.length === 0 || options.types?.length === 0) return { changes: [], summary };
  const p = new Params();
  const now = p.add(options.now);
  const CLASSIFIED = classified(`${now}::timestamptz`);
  const filters = [
    `c.at >= ${p.add(options.since)}`,
    `c.at <= ${now}`,
    scopeSql(scopes, (v) => p.add(v), "c"),
    options.types ? `c.type = ANY(${p.add(options.types)}::text[])` : "TRUE",
  ].join(" AND ");
  const counts = await app.pool.query<{ kind: ChangeKind; n: number }>(
    `SELECT c.kind, count(*)::int AS n FROM (${CLASSIFIED}) c WHERE ${filters} GROUP BY c.kind`,
    p.values,
  );
  for (const row of counts.rows) summary[row.kind] = row.n;
  const kind = options.kind ? ` AND c.kind = ${p.add(options.kind)}` : "";
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = await app.pool.query(
    `SELECT * FROM (${CLASSIFIED}) c WHERE ${filters}${kind} ORDER BY c.at, c.kind = 'new', c.id LIMIT ${limit}`,
    p.values,
  );
  return {
    changes: rows.rows.map((row) => ({
      kind: row.kind as ChangeKind,
      at: toDate(row.at),
      memory: mapMemory(row),
      successor_id: row.successor_id ?? null,
    })),
    summary,
  };
}
