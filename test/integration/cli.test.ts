import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";
import { saveMemory } from "../../src/memory/save.js";
import { runDemo } from "../../src/ops/demo.js";
import { sessionStartContext } from "../../src/ops/hook.js";
import { runAll } from "../../src/ops/run.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp({ MORFEU_CLAUDE_PROJECTS_DIR: "test/fixtures/claude-projects" });

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    config: app.config,
    now: () => days(1),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli against a database", () => {
  it("saves, searches, corrects and exports", async () => {
    const saved = JSON.parse((await cli("save", "Alex prefers Postgres", "--type", "preference", "--json")).out);
    expect(saved.deduplicated).toBe(false);
    const found = JSON.parse((await cli("search", "postgres", "--scope", "user:me", "--json")).out);
    expect(found.hits[0]).toMatchObject({ id: saved.id, origin: "owner" });
    expect((await cli("correct", saved.id, "Alex prefers SQLite")).out).toMatch(/^corrected:/);
    expect((await cli("export")).out).toContain("- Alex prefers SQLite");
    expect((await cli("changes", "--since", T0.toISOString())).out).toContain("corrected");
  });

  it("explains, pins and forgets", async () => {
    const id = JSON.parse((await cli("save", "Alex works remotely", "--type", "fact", "--json")).out).id;
    expect((await cli("explain", id)).out).toContain("Alex works remotely");
    await cli("pin", id);
    expect((await cli("pins")).out).toContain(id);
    expect((await cli("forget", id)).code).toBe(1);
    expect((await cli("forget", id, "--reason", "outdated")).out).toBe(`forgot ${id}`);
  });

  it("shows context and stats", async () => {
    await cli("save", "Always write tests first", "--type", "instruction", "--scope", "agent:claude-code");
    const context = await cli("context", "write a function", "--scope", "agent:claude-code");
    expect(context.out).toContain("[INSTRUCTIONS]\n- Always write tests first");
    const stats = JSON.parse((await cli("stats", "--json")).out);
    expect(stats.memories.active).toBe(1);
  });
});

describe("run", () => {
  it("ingests, extracts, consolidates and fills vectors in one pass", async () => {
    app.fakeLlm.on((p) => p.schemaName === "extracted_memories", { memories: [] });
    const report = await runAll(app, days(1), { backup: false });
    expect(report.errors).toEqual([]);
    expect(report.ingest?.inserted).toBe(4);
    expect(report.extract?.chunks).toBe(2);
    expect(report.dream?.candidates).toBe(0);
  });
});

describe("session-start hook", () => {
  it("prints context for the session's project and nothing when there is none", async () => {
    await saveMemory(
      app,
      {
        content: "Acme API is mid-migration to Fastify",
        type: "project_state",
        scope: { type: "project", id: "acme-api" },
      },
      T0,
    );
    const text = await sessionStartContext(app, JSON.stringify({ cwd: "/home/alex/code/acme-api" }), days(1), "/");
    expect(text).toContain("[PROJECT STATE]\n- Acme API is mid-migration to Fastify");
    expect(await sessionStartContext(app, "not json", days(1), "/home/alex/code/unknown")).toBe("");
  });
});

describe("demo", () => {
  it("tells the whole story on its own database and cleans up", async () => {
    const lines: string[] = [];
    await runDemo(app.config, (l) => lines.push(l));
    const text = lines.join("\n");
    expect(text).toContain("→ Alex lives in Berlin");
    expect(text).toContain("→ Alex lives in Lisbon");
    expect(text).toContain("→ Alex's sister is called Ioana");
    expect(text).toMatch(/changed\s+Alex lives in Lisbon/);
    const dbs = await app.pool.query("SELECT 1 FROM pg_database WHERE datname = 'morfeu_demo'");
    expect(dbs.rowCount).toBe(0);
  });
});
