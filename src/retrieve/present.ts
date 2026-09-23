import type { Memory } from "../core/types.js";
import { formatWhen } from "./when.js";

/** A memory as agents and scripts see it: the claim, where it lives, and how old it is. */
export function presentMemory(memory: Memory, now: Date, timeZone: string) {
  return {
    id: memory.id,
    content: memory.content,
    type: memory.type,
    scope: `${memory.scope_type}:${memory.scope_id}`,
    status: memory.status,
    origin: memory.origin,
    when: formatWhen(memory, now, timeZone),
    observed_at: memory.observed_at.toISOString(),
    valid_from: memory.valid_from?.toISOString() ?? null,
    valid_until: memory.valid_until?.toISOString() ?? null,
    ...(memory.retracted_at ? { retracted_at: memory.retracted_at.toISOString() } : {}),
    ...(memory.pinned_at ? { pinned: true } : {}),
  };
}
