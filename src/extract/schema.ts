import { ENTITY_TYPES, MEMORY_TYPES, SCOPE_TYPES, VOLATILITIES } from "../core/types.js";

/** Instructions for the agent are an explicit human act, never inferred from a conversation. */
export const EXTRACTABLE_TYPES = MEMORY_TYPES.filter((t) => t !== "instruction");

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          type: { type: "string", enum: [...EXTRACTABLE_TYPES] },
          scope_type: { type: "string", enum: [...SCOPE_TYPES] },
          entities: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" }, type: { type: "string", enum: [...ENTITY_TYPES] } },
              required: ["name", "type"],
            },
          },
          importance: { type: "number" },
          confidence: { type: "number" },
          volatility: { type: "string", enum: [...VOLATILITIES] },
          valid_from: nullableString,
          valid_until: nullableString,
          source_event_indices: { type: "array", items: { type: "integer" } },
        },
        required: [
          "content",
          "type",
          "scope_type",
          "entities",
          "importance",
          "confidence",
          "volatility",
          "valid_from",
          "valid_until",
          "source_event_indices",
        ],
      },
    },
  },
  required: ["memories"],
} as const;

export type ExtractedCandidate = {
  content: string;
  type: string;
  scope_type: string;
  entities: { name: string; type: string }[];
  importance: number;
  confidence: number;
  volatility: string;
  valid_from: string | null;
  valid_until: string | null;
  source_event_indices: number[];
};

export function extractorPrompt(neverExtract: readonly string[]): string {
  const lines = [
    "You extract durable, atomic memories from a conversation between a user and an AI agent.",
    "",
    "Rules:",
    "- One memory is one self-contained claim that still makes sense out of context. Name the subject; avoid pronouns.",
    "- Keep what will matter in later sessions: facts about the user and their world, preferences, relationships, goals, decisions and their reasons, routines, the state of projects.",
    "- Skip small talk, transient task state, build output, counts and metrics that change by the hour.",
    "- Never include credentials, API keys, tokens or passwords, even when they appear in the text.",
    "- Keep the language of the source; do not translate.",
    "- scope_type: user for facts about the user; project for facts about the project the session works on; agent for how this agent should behave.",
    "- valid_from / valid_until: ISO dates when the text says when the claim starts or stops being true, relative to the current date given below; otherwise null.",
    "- importance: 0 to 1, how much it matters later. confidence: 0 to 1, how clearly the text states it.",
    "- volatility: stable (rarely changes), slow (months), fast (days or weeks).",
    "- source_event_indices: the [n] indices of the events that state the claim. Every memory needs at least one.",
    "- Return an empty list when nothing is worth keeping.",
  ];
  if (neverExtract.length > 0) lines.push(`- Never extract anything about: ${neverExtract.join("; ")}.`);
  return lines.join("\n");
}
