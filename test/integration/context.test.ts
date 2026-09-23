import { describe, expect, it } from "vitest";
import { pinMemory } from "../../src/memory/pins.js";
import { saveMemory } from "../../src/memory/save.js";
import { compileContext } from "../../src/retrieve/context.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp();
const me = { type: "user" as const, id: "me" };
const acme = { type: "project" as const, id: "acme-api" };
const agent = { type: "agent" as const, id: "claude-code" };
const opts = { now: days(3), timeZone: "UTC" };

async function seed() {
  const tea = await saveMemory(app, { content: "Alex prefers tea to coffee", type: "preference", scope: me }, T0);
  await pinMemory(app, tea.memory.id, T0);
  await saveMemory(app, { content: "Always answer in British English", type: "instruction", scope: agent }, T0);
  await saveMemory(
    app,
    { content: "Acme API is mid-migration to Fastify", type: "project_state", scope: acme },
    days(1),
  );
  await saveMemory(app, { content: "Acme deploys run on Fridays", type: "decision", scope: acme }, days(2));
  await saveMemory(app, { content: "Globex uses Go", type: "fact", scope: { type: "project", id: "globex" } }, days(2));
}

describe("context", () => {
  it("starts with the clock and lays out each section once", async () => {
    await seed();
    const ctx = await compileContext(app, "when do acme deploys run", { ...opts, scopes: [me, acme, agent] });
    const lines = ctx.markdown.split("\n");
    expect(lines[0]).toBe("[NOW] 2026-03-04 09:00 UTC (Wed)");
    expect(ctx.markdown).toMatch(/\[INSTRUCTIONS\]\n- Always answer in British English/);
    expect(ctx.markdown).toMatch(/\[PINNED\]\n- Alex prefers tea to coffee/);
    expect(ctx.markdown).toMatch(/\[RELEVANT\]\n- Acme deploys run on Fridays/);
    expect(ctx.markdown).toMatch(/\[PROJECT STATE\]\n- Acme API is mid-migration to Fastify/);
    expect(ctx.markdown).not.toContain("Globex");
    // Every memory appears once even when several sections want it.
    expect(new Set(ctx.memoryIds).size).toBe(ctx.memoryIds.length);
  });

  it("shows each memory's age and id", async () => {
    await seed();
    const ctx = await compileContext(app, "tea", { ...opts, scopes: [me] });
    expect(ctx.markdown).toMatch(/- Alex prefers tea to coffee \(1 Mar, 3d ago\) \[[0-9a-f-]{36}\]/);
  });

  it("stays within the budget, dropping ids before memories and keeping the clock", async () => {
    await seed();
    const small = await compileContext(app, "acme", { ...opts, scopes: [me, acme, agent], tokenBudget: 40 });
    expect(small.markdown.length).toBeLessThanOrEqual(40 * 4);
    expect(small.markdown.startsWith("[NOW]")).toBe(true);
    const none = await compileContext(app, "acme", { ...opts, scopes: [me], tokenBudget: 1 });
    expect(none.markdown).toBe("[NOW] 2026-03-04 09:00 UTC (Wed)");
  });

  it("says so when nothing relevant is found", async () => {
    const ctx = await compileContext(app, "helicopter licence", { ...opts, scopes: [me] });
    expect(ctx.markdown).toContain("[RELEVANT]\n- (no relevant memories found)");
  });

  it("serves only the clock for an empty scope list", async () => {
    await seed();
    const ctx = await compileContext(app, "tea", { ...opts, scopes: [] });
    expect(ctx.memoryIds).toEqual([]);
  });

  it("records usage when asked", async () => {
    await seed();
    const ctx = await compileContext(app, "tea", { ...opts, scopes: [me], recordUsage: true });
    const usage = await app.pool.query("SELECT count(*)::int AS n FROM memory_usage");
    expect(usage.rows[0]?.n).toBe(ctx.memoryIds.length);
  });
});
