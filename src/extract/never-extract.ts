import type { App } from "../app.js";
import type { ExtractedCandidate } from "./schema.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { index: { type: "integer" }, allowed: { type: "boolean" } },
        required: ["index", "allowed"],
      },
    },
  },
  required: ["verdicts"],
} as const;

const PROMPT = `You check memory candidates against subjects the user never wants remembered.
For each candidate index, set allowed to false if it is about any listed subject, or if unsure.`;

/**
 * A second, independent check for the subjects in MORFEU_NEVER_EXTRACT. The
 * extractor is told about them too; this pass catches what it lets through.
 * A candidate without an explicit "allowed" verdict is dropped.
 */
export async function dropForbidden(
  app: App,
  candidates: ExtractedCandidate[],
): Promise<{ kept: ExtractedCandidate[]; dropped: number }> {
  const subjects = app.config.neverExtract;
  if (subjects.length === 0 || candidates.length === 0) return { kept: candidates, dropped: 0 };
  const raw = (await app.llm.complete({
    system: PROMPT,
    user: `Subjects:\n${subjects.map((s) => `- ${s}`).join("\n")}\n\nCandidates:\n${candidates
      .map((c, i) => `[${i}] ${c.content}`)
      .join("\n")}`,
    schemaName: "never_extract",
    jsonSchema: SCHEMA,
  })) as { verdicts?: { index?: unknown; allowed?: unknown }[] };
  const allowed = new Set(
    (raw.verdicts ?? []).filter((v) => v.allowed === true && typeof v.index === "number").map((v) => v.index as number),
  );
  const kept = candidates.filter((_, i) => allowed.has(i));
  return { kept, dropped: candidates.length - kept.length };
}
