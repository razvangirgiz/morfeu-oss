import type { Scope } from "../core/types.js";

/**
 * The one definition of "which memories answer a question at time t".
 *
 * Present (no as-of): active, not archived, and valid at `now`.
 * Past (as-of t): whatever was valid at t by today's knowledge. Superseded and
 * expired rows count, because they were true then; retracted rows never do,
 * because morfeu has since learned they were wrong. Candidates may be added
 * to the present view on request; they are unconsolidated and never historical.
 */
export type ServingOptions = {
  /** Placeholder holding the time to evaluate validity at (now, or the as-of time). */
  timeParam: string;
  historical: boolean;
  includeCandidates?: boolean;
  /** Table alias, when the query joins memories under a name. */
  alias?: string;
};

export function servingSql(options: ServingOptions): string {
  const c = (column: string) => (options.alias ? `${options.alias}.${column}` : column);
  const t = `${options.timeParam}::timestamptz`;
  const parts: string[] = [];
  if (options.historical) {
    parts.push(`${c("status")} IN ('active', 'superseded', 'expired')`, `${c("retracted_at")} IS NULL`);
  } else {
    parts.push(
      options.includeCandidates ? `${c("status")} IN ('active', 'candidate')` : `${c("status")} = 'active'`,
      `${c("archived_at")} IS NULL`,
    );
  }
  parts.push(
    `(${c("valid_from")} IS NULL OR ${c("valid_from")} <= ${t})`,
    `(${c("valid_until")} IS NULL OR ${c("valid_until")} > ${t})`,
  );
  return parts.join(" AND ");
}

/** Restricts to the given scopes. Undefined means every scope; an empty list matches nothing. */
export function scopeSql(
  scopes: readonly Scope[] | undefined,
  add: (value: unknown) => string,
  alias?: string,
): string {
  if (scopes === undefined) return "TRUE";
  if (scopes.length === 0) return "FALSE";
  const c = (column: string) => (alias ? `${alias}.${column}` : column);
  const tuples = scopes.map((s) => `(${add(s.type)}, ${add(s.id)})`);
  return `(${c("scope_type")}, ${c("scope_id")}) IN (${tuples.join(", ")})`;
}
