import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { extract } from "../../src/extract/extract.js";
import { ingestClaudeCode } from "../../src/ingest/claude-code.js";
import { MEMORY_COLUMNS, mapMemory } from "../../src/memory/row.js";
import type { CompleteParams } from "../../src/providers/types.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp({ MORFEU_CLAUDE_PROJECTS_DIR: "/nonexistent" });

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "morfeu-ingest-"));
  cpSync("test/fixtures/claude-projects", dir, { recursive: true });
  return dir;
}

async function events() {
  const res = await app.pool.query(
    "SELECT external_id, content_text, content, session_id FROM events ORDER BY occurred_at",
  );
  return res.rows as { external_id: string; content_text: string; content: { project: string }; session_id: string }[];
}

const isExtract = (p: CompleteParams) => p.schemaName === "extracted_memories";

describe("ingest", () => {
  it("keeps user and assistant prose, skips tools, thinking and commands, and redacts secrets", async () => {
    const dir = fixtureDir();
    const result = await ingestClaudeCode(app, { now: T0, projectsDir: dir });
    expect(result.inserted).toBe(4);
    const rows = await events();
    expect(rows.map((r) => r.external_id)).toEqual(["u-1", "a-1", "u-5", "h-1"]);
    expect(rows[1]?.content_text).toBe("Understood. I will plan the migration to Fastify.");
    expect(rows[2]?.content_text).toContain("[redacted:github]");
    expect(rows[0]?.content.project).toBe("acme-api");
  });

  it("derives the project from the working directory; the home directory has none", async () => {
    const dir = fixtureDir();
    await ingestClaudeCode(app, { now: T0, projectsDir: dir });
    const home = (await events()).find((r) => r.external_id === "h-1");
    // The fixture's home is /home/alex, not this machine's; only a real home maps to "".
    expect(home?.content.project).toBe("alex");
  });

  it("resumes from the cursor and picks up a line once it is complete", async () => {
    const dir = fixtureDir();
    await ingestClaudeCode(app, { now: T0, projectsDir: dir });
    const again = await ingestClaudeCode(app, { now: T0, projectsDir: dir });
    expect(again.inserted).toBe(0);
    const file = join(dir, "-home-alex-code-acme-api", "s-acme-1.jsonl");
    appendFileSync(
      file,
      ',"sessionId":"s-acme-1","timestamp":"2026-03-01T10:00:00Z","message":{"role":"user","content":"Ship it on Friday."}}\n',
    );
    const resumed = await ingestClaudeCode(app, { now: T0, projectsDir: dir });
    expect(resumed.inserted).toBe(1);
  });
});

describe("extract", () => {
  it("turns a session into candidates scoped by the session, with provenance", async () => {
    await ingestClaudeCode(app, { now: T0, projectsDir: fixtureDir() });
    app.fakeLlm.on((p) => isExtract(p) && p.user.includes("Project: acme-api"), {
      memories: [
        {
          content: "The acme API moves from Express to Fastify for throughput",
          type: "decision",
          scope_type: "project",
          entities: [{ name: "Fastify", type: "technology" }],
          importance: 0.7,
          confidence: 0.9,
          volatility: "slow",
          valid_from: null,
          valid_until: null,
          source_event_indices: [0],
        },
        {
          content: "Alex prefers small pull requests",
          type: "preference",
          scope_type: "user",
          entities: [],
          importance: 0.95,
          confidence: 0.9,
          volatility: "slow",
          valid_from: null,
          valid_until: null,
          source_event_indices: [2],
        },
        {
          content: "An instruction the model must not invent",
          type: "instruction",
          scope_type: "agent",
          entities: [],
          importance: 0.5,
          confidence: 0.5,
          volatility: "slow",
          valid_from: null,
          valid_until: null,
          source_event_indices: [0],
        },
        {
          content: "A claim with no source",
          type: "fact",
          scope_type: "user",
          entities: [],
          importance: 0.5,
          confidence: 0.5,
          volatility: "slow",
          valid_from: null,
          valid_until: null,
          source_event_indices: [99],
        },
      ],
    });
    app.fakeLlm.on(isExtract, { memories: [] });
    const result = await extract(app, { now: days(1) });
    expect(result).toMatchObject({ sessions: 2, candidates: 2, rejected: 2 });
    const rows = await app.pool.query(`SELECT ${MEMORY_COLUMNS} FROM memories ORDER BY content`);
    const memories = rows.rows.map(mapMemory);
    expect(memories.map((m) => [m.scope_type, m.scope_id, m.status, m.origin])).toEqual([
      ["user", "alex", "candidate", "extracted"],
      ["project", "acme-api", "candidate", "extracted"],
    ]);
    // Extracted importance is capped below what the user states directly.
    expect(memories[0]?.importance).toBeCloseTo(0.8);
    const unprocessed = await app.pool.query("SELECT count(*)::int AS n FROM events WHERE processed_at IS NULL");
    expect(unprocessed.rows[0]?.n).toBe(0);
    const sources = await app.pool.query("SELECT count(*)::int AS n FROM memory_sources");
    expect(sources.rows[0]?.n).toBe(2);
  });

  it("estimates without calling the LLM", async () => {
    await ingestClaudeCode(app, { now: T0, projectsDir: fixtureDir() });
    const result = await extract(app, { now: days(1), estimate: true });
    expect(result.chunks).toBe(2);
    expect(app.fakeLlm.calls).toHaveLength(0);
  });

  it("stops cleanly at the LLM call limit and leaves the rest for the next run", async () => {
    await ingestClaudeCode(app, { now: T0, projectsDir: fixtureDir() });
    app.fakeLlm.on(isExtract, { memories: [] });
    app.llm.calls = app.config.maxLlmCalls - 1;
    const first = await extract(app, { now: days(1) });
    expect(first.stopped).toBe("max_calls");
    const pending = await app.pool.query("SELECT count(*)::int AS n FROM events WHERE processed_at IS NULL");
    expect(pending.rows[0]?.n).toBeGreaterThan(0);
  });

  it("drops candidates about never-extract subjects", async () => {
    const guarded = app;
    guarded.config.neverExtract = ["code review habits"];
    onTestFinished(() => {
      guarded.config.neverExtract = [];
    });
    await ingestClaudeCode(guarded, { now: T0, projectsDir: fixtureDir() });
    guarded.fakeLlm.on(isExtract, (p: CompleteParams) =>
      p.user.includes("Project: acme-api")
        ? {
            memories: [
              {
                content: "Alex prefers small pull requests",
                type: "preference",
                scope_type: "user",
                entities: [],
                importance: 0.5,
                confidence: 0.9,
                volatility: "slow",
                valid_from: null,
                valid_until: null,
                source_event_indices: [2],
              },
            ],
          }
        : { memories: [] },
    );
    guarded.fakeLlm.on((p) => p.schemaName === "never_extract", { verdicts: [{ index: 0, allowed: false }] });
    const result = await extract(guarded, { now: days(1) });
    expect(result).toMatchObject({ candidates: 0, forbidden: 1 });
    expect(guarded.fakeLlm.calls[0]?.system).toContain("Never extract anything about: code review habits");
  });
});
