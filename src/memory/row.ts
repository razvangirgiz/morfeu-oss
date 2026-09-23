import type { Memory, MemoryOrigin, MemoryStatus, MemoryType, ScopeType, Volatility } from "../core/types.js";
import { toDate, toDateOrNull } from "../db/client.js";

/** Every column of `memories`, for SELECTs that feed mapMemory. */
export const MEMORY_COLUMNS =
  "id, scope_type, scope_id, type, content, attrs, importance, confidence, volatility, origin, status, " +
  "observed_at, valid_from, valid_until, recorded_at, retracted_at, supersedes_id, superseded_by_id, pinned_at, archived_at";

/** MEMORY_COLUMNS qualified with a table alias, for joins. */
export function memoryColumns(alias: string): string {
  return MEMORY_COLUMNS.split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");
}

export function mapMemory(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    scope_type: row.scope_type as ScopeType,
    scope_id: String(row.scope_id),
    type: row.type as MemoryType,
    content: String(row.content),
    attrs: (row.attrs as Record<string, unknown>) ?? {},
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    volatility: row.volatility as Volatility,
    origin: row.origin as MemoryOrigin,
    status: row.status as MemoryStatus,
    observed_at: toDate(row.observed_at as Date),
    valid_from: toDateOrNull(row.valid_from as Date | null),
    valid_until: toDateOrNull(row.valid_until as Date | null),
    recorded_at: toDate(row.recorded_at as Date),
    retracted_at: toDateOrNull(row.retracted_at as Date | null),
    supersedes_id: (row.supersedes_id as string | null) ?? null,
    superseded_by_id: (row.superseded_by_id as string | null) ?? null,
    pinned_at: toDateOrNull(row.pinned_at as Date | null),
    archived_at: toDateOrNull(row.archived_at as Date | null),
  };
}
