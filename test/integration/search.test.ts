import { describe, expect, it } from "vitest";
import { correctMemory } from "../../src/memory/correct.js";
import { saveMemory } from "../../src/memory/save.js";
import { insertMemory } from "../../src/memory/write.js";
import { search } from "../../src/retrieve/search.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp();
const me = { type: "user" as const, id: "me" };
const acme = { type: "project" as const, id: "acme-api" };

async function contents(query: string, options: Partial<Parameters<typeof search>[2]> = {}): Promise<string[]> {
  const result = await search(app, query, { now: days(100), ...options });
  return result.hits.map((h) => h.memory.content);
}

describe("search", () => {
  it("matches inflected words through the language's stemmer", async () => {
    await saveMemory(app, { content: "Alex is running the Lisbon marathon", type: "goal", scope: me }, T0);
    await saveMemory(app, { content: "The API uses PostgreSQL", type: "fact", scope: acme }, T0);
    expect((await contents("marathons alex runs"))[0]).toBe("Alex is running the Lisbon marathon");
  });

  it("filters by scope and by type", async () => {
    await saveMemory(app, { content: "Deploys happen on Fridays", type: "decision", scope: acme }, T0);
    await saveMemory(app, { content: "Alex deploys side projects on Fridays", type: "routine", scope: me }, T0);
    expect(await contents("fridays deploys", { scopes: [acme] })).toEqual(["Deploys happen on Fridays"]);
    expect(await contents("fridays deploys", { types: ["routine"] })).toEqual([
      "Alex deploys side projects on Fridays",
    ]);
    expect(await contents("fridays deploys", { scopes: [] })).toEqual([]);
  });

  it("ranks entity matches for names mentioned in the query", async () => {
    await saveMemory(
      app,
      {
        content: "Weekly sync is on Mondays",
        type: "routine",
        scope: me,
        entities: [{ name: "Maria Pop", type: "person" }],
      },
      T0,
    );
    await saveMemory(app, { content: "Alex buys coffee beans on Mondays", type: "routine", scope: me }, T0);
    const hits = await contents("what do I do with maria pop?");
    expect(hits[0]).toBe("Weekly sync is on Mondays");
  });

  it("answers about the past by valid time, without retracted claims", async () => {
    const old = await saveMemory(app, { content: "Alex lives in Lisbon", type: "fact", scope: me }, T0);
    await saveMemory(
      app,
      { content: "Alex lives in Berlin", type: "fact", scope: me, supersedes: old.memory.id },
      days(30),
    );
    const wrong = await saveMemory(app, { content: "Alex has a cat named Olive", type: "fact", scope: me }, T0);
    await correctMemory(app, { memoryId: wrong.memory.id, content: "Alex has a dog named Olive" }, days(60));

    const now = await contents("where does alex live");
    expect(now[0]).toBe("Alex lives in Berlin");
    expect(now).not.toContain("Alex lives in Lisbon");
    const then = await contents("where does alex live", { asOf: days(10) });
    expect(then[0]).toBe("Alex lives in Lisbon");
    expect(then).not.toContain("Alex lives in Berlin");
    // The cat was never true: after the correction, the past shows the dog.
    const olive = await contents("olive", { asOf: days(10) });
    expect(olive[0]).toBe("Alex has a dog named Olive");
    expect(olive).not.toContain("Alex has a cat named Olive");
  });

  it("keeps candidates out unless asked, and never in the past", async () => {
    await insertMemory(
      app,
      app.pool,
      { content: "Alex is learning Portuguese", type: "goal", scope: me, origin: "extracted", status: "candidate" },
      T0,
    );
    expect(await contents("portuguese")).toEqual([]);
    expect(await contents("portuguese", { includeCandidates: true })).toEqual(["Alex is learning Portuguese"]);
    expect(await contents("portuguese", { includeCandidates: true, asOf: days(50) })).toEqual([]);
  });

  it("works on keywords alone when semantic retrieval is off", async () => {
    await saveMemory(app, { content: "The staging database runs Postgres 18", type: "fact", scope: acme }, T0);
    const result = await search(app, "postgres staging", { now: days(1), skipSemantic: true });
    expect(result.hits.map((h) => h.memory.content)).toEqual(["The staging database runs Postgres 18"]);
    expect(result.hits[0]?.signals.semantic).toBe(0);
  });

  it("rejects an out-of-range limit and an empty query", async () => {
    await expect(search(app, "x", { now: T0, limit: 0 })).rejects.toThrow(/limit/);
    await expect(search(app, "  ", { now: T0 })).rejects.toThrow(/empty/);
  });
});

describe("semantic recall under filters", () => {
  it("still finds a scoped match when most near neighbours are filtered out", async () => {
    // Many close neighbours in another scope must not crowd out the one in scope.
    for (let i = 0; i < 120; i++) {
      await saveMemory(app, { content: `acme service ${i} runs on kubernetes cluster`, type: "fact", scope: acme }, T0);
    }
    await saveMemory(app, { content: "alex service runs on kubernetes at home", type: "fact", scope: me }, T0);
    const result = await search(app, "service kubernetes cluster", { now: days(1), scopes: [me], limit: 5 });
    expect(result.hits.map((h) => h.memory.content)).toContain("alex service runs on kubernetes at home");
  });
});
