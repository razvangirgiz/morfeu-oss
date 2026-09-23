import {
  ENTITY_TYPES,
  type EntityInput,
  type EntityType,
  MEMORY_TYPES,
  type MemoryType,
  parseScope,
  type Scope,
} from "../core/types.js";

/**
 * Argument readers for tool calls. Agents send JSON that is often almost
 * right; every error says which argument is wrong and what was expected.
 */
export type Args = Record<string, unknown>;

export function text(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required and must be a non-empty string`);
  return value;
}

export function optionalText(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

export function optionalNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

export function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
  return value;
}

export function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T {
  const value = args[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function optionalOneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  return args[key] === undefined || args[key] === null ? undefined : oneOf(args, key, allowed);
}

/** An ISO 8601 date or timestamp. */
export function optionalDate(args: Args, key: string): Date | undefined {
  const value = optionalText(args, key);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${key} must be an ISO 8601 date, e.g. 2026-03-01`);
  return new Date(ms);
}

export function scope(args: Args, key: string): Scope {
  return parseScope(text(args, key));
}

export function optionalScopes(args: Args, key = "scopes"): Scope[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of "type:id" strings, e.g. ["user:me"]`);
  return value.map((s) => parseScope(String(s)));
}

export function optionalTypes(args: Args, key = "types"): MemoryType[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of memory types`);
  return value.map((t) => {
    if (!(MEMORY_TYPES as readonly unknown[]).includes(t)) throw new Error(`unknown memory type ${String(t)}`);
    return t as MemoryType;
  });
}

export function optionalEntities(args: Args, key = "entities"): EntityInput[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of {name, type}`);
  return value.map((e) => {
    const name = (e as { name?: unknown })?.name;
    const type = (e as { type?: unknown })?.type;
    if (typeof name !== "string" || !name.trim()) throw new Error("every entity needs a name");
    if (!(ENTITY_TYPES as readonly unknown[]).includes(type)) {
      throw new Error(`entity type must be one of: ${ENTITY_TYPES.join(", ")}`);
    }
    return { name, type: type as EntityType };
  });
}
