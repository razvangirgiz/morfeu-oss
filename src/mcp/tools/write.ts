import { randomUUID } from "node:crypto";
import { EVENT_TYPES, MEMORY_TYPES } from "../../core/types.js";
import { appendEvent } from "../../ledger/events.js";
import { correctMemory } from "../../memory/correct.js";
import { forgetMemory } from "../../memory/forget.js";
import { listPinned, MAX_PINS, pinMemory, unpinMemory } from "../../memory/pins.js";
import { saveMemory } from "../../memory/save.js";
import { MAX_CONTENT_CHARS } from "../../memory/write.js";
import { presentMemory } from "../../retrieve/present.js";
import { localTimeZone } from "../../retrieve/when.js";
import {
  oneOf,
  optionalDate,
  optionalEntities,
  optionalNumber,
  optionalOneOf,
  optionalText,
  scope,
  text,
} from "../args.js";
import { json, SCOPE_HELP, type Tool } from "../tool.js";

const TYPE_GUIDE =
  "Types: fact, preference (how the user likes things), relationship (a person and who they are to the user), event (something that happened, dated), goal, decision (what and why), routine, project_state (where a project stands now), instruction (a standing rule for an agent).";

export const saveTool: Tool = {
  name: "morfeu_save",
  description: `Save one durable, atomic memory (at most ${MAX_CONTENT_CHARS} characters). Use it when the user states something that should outlast this session. Do not save secrets, transient task state or build output. Saving the same sentence twice returns the existing memory. When a fact or preference changed, pass supersedes with the old memory's id: history keeps both, the present shows the new one. ${TYPE_GUIDE}`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: { type: "string", description: "One self-contained claim; name the subject instead of using pronouns." },
      type: { type: "string", enum: [...MEMORY_TYPES] },
      scope: { type: "string", description: `Where it belongs. ${SCOPE_HELP}` },
      importance: { type: "number", minimum: 0, maximum: 1 },
      valid_from: { type: "string", description: "ISO date the claim starts being true, if known." },
      valid_until: { type: "string", description: "ISO date the claim stops being true, if known." },
      supersedes: { type: "string", description: "Id of a memory this one replaces because something changed." },
      entities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["person", "project", "organization", "technology", "place", "other"] },
          },
          required: ["name", "type"],
        },
      },
    },
    required: ["content", "type", "scope"],
  },
  annotations: {
    title: "Save a memory",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async run(app, args, now) {
    const result = await saveMemory(
      app,
      {
        content: text(args, "content"),
        type: oneOf(args, "type", MEMORY_TYPES),
        scope: scope(args, "scope"),
        importance: optionalNumber(args, "importance"),
        valid_from: optionalDate(args, "valid_from"),
        valid_until: optionalDate(args, "valid_until"),
        supersedes: optionalText(args, "supersedes"),
        entities: optionalEntities(args),
        source: "mcp",
      },
      now,
    );
    return json({ id: result.memory.id, deduplicated: result.deduplicated, superseded_id: result.superseded_id });
  },
};

export const correctTool: Tool = {
  name: "morfeu_correct",
  description:
    "Replace a memory that is wrong with the user's correction. The wrong claim is retracted, so it no longer appears now or in answers about the past. Use it only when the user says a specific memory is wrong and gives the right version; find the id with morfeu_search first. For something that changed (not wrong), use morfeu_save with supersedes instead.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      memory_id: { type: "string" },
      content: { type: "string", description: "The corrected claim." },
      valid_from: { type: "string" },
      valid_until: { type: "string" },
    },
    required: ["memory_id", "content"],
  },
  annotations: {
    title: "Correct a memory",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(app, args, now) {
    const result = await correctMemory(
      app,
      {
        memoryId: text(args, "memory_id"),
        content: text(args, "content"),
        ...(args.valid_from !== undefined ? { valid_from: optionalDate(args, "valid_from") ?? null } : {}),
        ...(args.valid_until !== undefined ? { valid_until: optionalDate(args, "valid_until") ?? null } : {}),
        source: "mcp",
      },
      now,
    );
    return json({ id: result.memory.id, retracted_id: result.retracted_id });
  },
};

export const forgetTool: Tool = {
  name: "morfeu_forget",
  description:
    "Stop serving a memory, now and in answers about the past. Use it when the user asks to forget something. Nothing is deleted; the reason is kept.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { memory_id: { type: "string" }, reason: { type: "string" } },
    required: ["memory_id", "reason"],
  },
  annotations: {
    title: "Forget a memory",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(app, args, now) {
    return json(await forgetMemory(app, text(args, "memory_id"), text(args, "reason"), now));
  },
};

export const pinTool: Tool = {
  name: "morfeu_pin",
  description: `List, pin or unpin memories that are always included in context (at most ${MAX_PINS}). Change pins only when the user asks.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { action: { type: "string", enum: ["list", "pin", "unpin"] }, memory_id: { type: "string" } },
    required: ["action"],
  },
  annotations: {
    title: "Pinned memories",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async run(app, args, now) {
    const timeZone = localTimeZone();
    const action = oneOf(args, "action", ["list", "pin", "unpin"] as const);
    if (action === "pin") await pinMemory(app, text(args, "memory_id"), now);
    if (action === "unpin") await unpinMemory(app, text(args, "memory_id"));
    return json({ pinned: (await listPinned(app.pool, now)).map((m) => presentMemory(m, now, timeZone)) });
  },
};

export const logEventTool: Tool = {
  name: "morfeu_log_event",
  description:
    "Append raw text (a note, or a message from a conversation morfeu does not import itself) to the event ledger. Extraction turns it into memories on its next run. For a finished, atomic memory use morfeu_save instead.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      content_text: { type: "string" },
      type: { type: "string", enum: [...EVENT_TYPES], description: "Default note." },
      session_id: { type: "string", description: "Groups events from one conversation." },
      project: { type: "string", description: "The project the text is about, if any." },
      occurred_at: { type: "string" },
    },
    required: ["content_text"],
  },
  annotations: {
    title: "Log an event",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(app, args, now) {
    const project = optionalText(args, "project");
    const event = await appendEvent(app.pool, {
      occurred_at: optionalDate(args, "occurred_at") ?? now,
      ingested_at: now,
      source: "mcp",
      external_id: randomUUID(),
      session_id: optionalText(args, "session_id") ?? null,
      agent_id: "mcp",
      type: optionalOneOf(args, "type", EVENT_TYPES) ?? "note",
      content: project ? { project: project.toLowerCase() } : {},
      content_text: text(args, "content_text"),
    });
    return json({ event_id: event.id });
  },
};
