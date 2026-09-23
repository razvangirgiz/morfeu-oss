import { MEMORY_TYPES } from "../../core/types.js";
import { explainMemory } from "../../memory/explain.js";
import { getStats } from "../../memory/stats.js";
import { CHANGE_KINDS, listChanges } from "../../retrieve/changes.js";
import { compileContext, DEFAULT_TOKEN_BUDGET } from "../../retrieve/context.js";
import { presentMemory } from "../../retrieve/present.js";
import { MAX_LIMIT, search } from "../../retrieve/search.js";
import { formatNow, localTimeZone } from "../../retrieve/when.js";
import {
  optionalBoolean,
  optionalDate,
  optionalNumber,
  optionalOneOf,
  optionalScopes,
  optionalTypes,
  text,
} from "../args.js";
import { json, scopesSchema, type Tool } from "../tool.js";

const typesSchema = { type: "array", items: { type: "string", enum: [...MEMORY_TYPES] } };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const contextTool: Tool = {
  name: "morfeu_context",
  description:
    "Get what morfeu remembers that matters for a task, as compact markdown: the current time, standing instructions, pinned memories, project state, relevant memories and recent ones. Call it at the start of a task with the user scope and the current project scope. Each memory ends with its age and id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      task: { type: "string", description: "What you are about to do, in a sentence." },
      scopes: scopesSchema,
      types: { ...typesSchema, description: "Only these memory types in the RELEVANT section." },
      token_budget: { type: "number", description: `Approximate size limit. Default ${DEFAULT_TOKEN_BUDGET}.` },
      include_candidates: { type: "boolean", description: "Also show memories not yet consolidated." },
    },
    required: ["task"],
  },
  annotations: { title: "Memory context", ...readOnly },
  async run(app, args, now) {
    const result = await compileContext(app, text(args, "task"), {
      now,
      scopes: optionalScopes(args),
      types: optionalTypes(args),
      tokenBudget: optionalNumber(args, "token_budget"),
      includeCandidates: optionalBoolean(args, "include_candidates"),
      recordUsage: true,
    });
    return result.warnings.length ? `${result.markdown}\n\n(${result.warnings.join("; ")})` : result.markdown;
  },
};

export const searchTool: Tool = {
  name: "morfeu_search",
  description:
    "Search memories by meaning, keywords and named entities, ranked. Use it before stating or contradicting something about the user, or for a specific question. With as_of, answers what was true at that time (by what morfeu knows now). No hits does not prove the information does not exist.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      scopes: scopesSchema,
      types: { ...typesSchema, description: 'Only these types, e.g. ["goal"] for "what are my goals".' },
      as_of: { type: "string", description: "ISO date: answer as of this time instead of now." },
      limit: { type: "number", description: `1 to ${MAX_LIMIT}, default 10.` },
      include_candidates: { type: "boolean", description: "Also search memories not yet consolidated." },
    },
    required: ["query"],
  },
  annotations: { title: "Search memory", ...readOnly },
  async run(app, args, now) {
    const timeZone = localTimeZone();
    const result = await search(app, text(args, "query"), {
      now,
      scopes: optionalScopes(args),
      types: optionalTypes(args),
      asOf: optionalDate(args, "as_of"),
      limit: optionalNumber(args, "limit"),
      includeCandidates: optionalBoolean(args, "include_candidates"),
      recordUsage: true,
    });
    return json({
      now: formatNow(now, timeZone),
      hits: result.hits.map((h) => ({ ...presentMemory(h.memory, now, timeZone), score: Number(h.score.toFixed(3)) })),
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    });
  },
};

export const changesTool: Tool = {
  name: "morfeu_changes",
  description:
    "List what changed since a date, oldest first: new memories, memories replaced because something changed, memories corrected because they were wrong, and memories that expired. Use it for 'what is new' or 'what changed since'. Not ranked.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      since: { type: "string", description: "ISO date or timestamp." },
      scopes: scopesSchema,
      types: typesSchema,
      kind: { type: "string", enum: [...CHANGE_KINDS], description: "Only this kind. The summary still counts all." },
      limit: { type: "number", description: "Default 50, at most 500." },
    },
    required: ["since"],
  },
  annotations: { title: "Memory changes", ...readOnly },
  async run(app, args, now) {
    const since = optionalDate(args, "since");
    if (!since) throw new Error("since is required");
    const timeZone = localTimeZone();
    const result = await listChanges(app, {
      since,
      now,
      scopes: optionalScopes(args),
      types: optionalTypes(args),
      kind: optionalOneOf(args, "kind", CHANGE_KINDS),
      limit: optionalNumber(args, "limit"),
    });
    return json({
      now: formatNow(now, timeZone),
      summary: result.summary,
      changes: result.changes.map((c) => ({
        kind: c.kind,
        at: c.at.toISOString(),
        ...presentMemory(c.memory, now, timeZone),
        ...(c.successor_id ? { replaced_by: c.successor_id } : {}),
      })),
    });
  },
};

export const explainTool: Tool = {
  name: "morfeu_explain",
  description:
    "Show why morfeu believes a memory: its history (what it replaced and what replaced it), the conversation events it came from, and what consolidation decided. Use it when the user asks where something came from.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { memory_id: { type: "string" } },
    required: ["memory_id"],
  },
  annotations: { title: "Explain a memory", ...readOnly },
  async run(app, args, now) {
    const timeZone = localTimeZone();
    const e = await explainMemory(app.pool, text(args, "memory_id"));
    return json({
      memory: presentMemory(e.memory, now, timeZone),
      history: e.chain.map((m) => presentMemory(m, now, timeZone)),
      entities: e.entities,
      sources: e.sources.map((s) => ({ ...s, occurred_at: s.occurred_at.toISOString() })),
      decisions: e.decisions,
    });
  },
};

export const statsTool: Tool = {
  name: "morfeu_stats",
  description: "Counts of events and memories, vector coverage, and when extraction and consolidation last ran.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  annotations: { title: "Memory stats", ...readOnly },
  async run(app) {
    return json(await getStats(app));
  },
};
