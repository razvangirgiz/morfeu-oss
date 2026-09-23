import { DREAM_ACTIONS, type DreamAction } from "../core/types.js";

const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });

export const DREAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_index: { type: "integer" },
          action: { type: "string", enum: [...DREAM_ACTIONS] },
          target_id: nullable("string"),
          reason: { type: "string" },
          content: nullable("string"),
          valid_from: nullable("string"),
          valid_until: nullable("string"),
        },
        required: ["candidate_index", "action", "target_id", "reason", "content", "valid_from", "valid_until"],
      },
    },
  },
  required: ["decisions"],
} as const;

export type DreamDecision = {
  candidate_index: number;
  action: DreamAction;
  target_id: string | null;
  reason: string;
  content: string | null;
  valid_from: string | null;
  valid_until: string | null;
};

export const DREAM_PROMPT = `You consolidate new candidate memories into an existing memory store.

Each candidate comes with its neighborhood: active memories that look related (target ids).
Choose exactly one action per candidate:
- add: new information. It becomes active.
- duplicate: says the same as an active memory (target_id). The candidate is dropped; the target gains confidence.
- supersede: the world changed and the candidate is the new truth replacing target_id (a moved home, a new preference, a changed decision). The target stops being valid when the candidate starts.
- temporal_update: the claim is right but its tense or dates are not, given the current date (e.g. "is flying to Rome next week" said a month ago). Put the rewritten claim in "content" and its dates in valid_from / valid_until. If it rewrites an active memory, name it in target_id.
- expire: target_id (or the candidate itself, with target_id null) is no longer true. Put the end date in valid_until when known.
- reject: noise, not worth remembering.

Only use target ids from the candidate's neighborhood. Keep the source language. Dates are ISO 8601.`;
