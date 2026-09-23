/**
 * Domain vocabulary shared by every layer. Nothing here touches the database,
 * the network or the clock.
 */

export const SCOPE_TYPES = ["user", "agent", "project"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
export type Scope = { type: ScopeType; id: string };

export const MEMORY_TYPES = [
  "fact",
  "preference",
  "relationship",
  "event",
  "goal",
  "decision",
  "routine",
  "project_state",
  "instruction",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** How fast a memory of this kind stops describing the present. Drives recency decay. */
export const VOLATILITIES = ["stable", "slow", "fast"] as const;
export type Volatility = (typeof VOLATILITIES)[number];

/**
 * candidate: extracted, waiting for consolidation.
 * active: served as current truth.
 * superseded: replaced by a newer memory (see superseded_by_id).
 * expired: stopped being true (valid_until passed or the dream said so).
 * invalidated: rejected, a duplicate, or forgotten. Never served.
 */
const MEMORY_STATUSES = ["candidate", "active", "superseded", "expired", "invalidated"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Who put the claim into memory: the extractor, an agent's explicit save, or the user's own correction. */
const MEMORY_ORIGINS = ["extracted", "saved", "owner"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export const EVENT_TYPES = ["user_message", "assistant_message", "note"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ENTITY_TYPES = ["person", "project", "organization", "technology", "place", "other"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export type EntityInput = { name: string; type: EntityType };

export const DREAM_ACTIONS = ["add", "duplicate", "supersede", "temporal_update", "expire", "reject"] as const;
export type DreamAction = (typeof DREAM_ACTIONS)[number];

/**
 * One atomic claim. Two clocks:
 * - valid time (`valid_from`, `valid_until`): when the claim holds in the world;
 * - record time (`recorded_at`, `retracted_at`): when morfeu learned it, and when
 *   it learned the claim was wrong.
 * A correction retracts the old row; a change in the world ends its validity.
 */
export type Memory = {
  id: string;
  scope_type: ScopeType;
  scope_id: string;
  type: MemoryType;
  content: string;
  attrs: Record<string, unknown>;
  importance: number;
  confidence: number;
  volatility: Volatility;
  origin: MemoryOrigin;
  status: MemoryStatus;
  observed_at: Date;
  valid_from: Date | null;
  valid_until: Date | null;
  recorded_at: Date;
  retracted_at: Date | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  pinned_at: Date | null;
  archived_at: Date | null;
};

export type LedgerEvent = {
  id: string;
  occurred_at: Date;
  ingested_at: Date;
  source: string;
  external_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  type: EventType;
  content: Record<string, unknown>;
  content_text: string;
  processed_at: Date | null;
};

function isScopeType(value: unknown): value is ScopeType {
  return typeof value === "string" && (SCOPE_TYPES as readonly string[]).includes(value);
}

/** `user:me`, `project:acme-api`, `agent:claude-code`. Agent ids are case-insensitive. */
export function parseScope(raw: string): Scope {
  const i = raw.indexOf(":");
  if (i <= 0) throw new Error(`invalid scope "${raw}": expected type:id, e.g. user:me`);
  const type = raw.slice(0, i);
  const id = raw.slice(i + 1).trim();
  if (!isScopeType(type)) throw new Error(`invalid scope type "${type}": expected user, agent or project`);
  if (!id) throw new Error(`invalid scope "${raw}": missing id`);
  return normalizeScope({ type, id });
}

function normalizeScope(scope: Scope): Scope {
  return scope.type === "agent" ? { type: "agent", id: scope.id.toLowerCase() } : scope;
}

/** How fast a memory of a given type goes stale when the caller does not say. */
export function defaultVolatility(type: MemoryType): Volatility {
  switch (type) {
    case "fact":
    case "event":
      return "stable";
    case "project_state":
      return "fast";
    case "preference":
    case "relationship":
    case "goal":
    case "decision":
    case "routine":
    case "instruction":
      return "slow";
  }
}
