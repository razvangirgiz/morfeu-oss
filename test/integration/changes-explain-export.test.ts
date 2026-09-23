import { describe, expect, it } from "vitest";
import { correctMemory } from "../../src/memory/correct.js";
import { explainMemory } from "../../src/memory/explain.js";
import { exportMarkdown } from "../../src/memory/export.js";
import { forgetMemory } from "../../src/memory/forget.js";
import { saveMemory } from "../../src/memory/save.js";
import { listChanges } from "../../src/retrieve/changes.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp();
const me = { type: "user" as const, id: "me" };

describe("changes", () => {
  it("lists new, changed, corrected and expired memories in order, never forgotten ones", async () => {
    const home = await saveMemory(app, { content: "Alex lives in Lisbon", type: "fact", scope: me }, T0);
    await saveMemory(
      app,
      { content: "Alex lives in Berlin", type: "fact", scope: me, supersedes: home.memory.id },
      days(2),
    );
    const pet = await saveMemory(app, { content: "Alex has a cat", type: "fact", scope: me }, days(1));
    await correctMemory(app, { memoryId: pet.memory.id, content: "Alex has a dog" }, days(3));
    await saveMemory(app, { content: "Alex is on leave", type: "fact", scope: me, valid_until: days(4) }, days(1));
    const secret = await saveMemory(app, { content: "Alex's PIN is 1234", type: "fact", scope: me }, days(1));
    await forgetMemory(app, secret.memory.id, "asked", days(2));

    const result = await listChanges(app, { since: days(0.5), now: days(5) });
    expect(result.changes.map((c) => [c.kind, c.memory.content])).toEqual([
      ["changed", "Alex lives in Lisbon"],
      ["new", "Alex lives in Berlin"],
      ["corrected", "Alex has a cat"],
      ["new", "Alex has a dog"],
      ["expired", "Alex is on leave"],
    ]);
    expect(result.summary).toEqual({ new: 2, changed: 1, corrected: 1, expired: 1 });
    const onlyCorrected = await listChanges(app, { since: T0, now: days(5), kind: "corrected" });
    expect(onlyCorrected.changes).toHaveLength(1);
  });
});

describe("explain", () => {
  it("shows the chain, sources and entities", async () => {
    const first = await saveMemory(
      app,
      { content: "Alex works at Acme", type: "fact", scope: me, entities: [{ name: "Acme", type: "organization" }] },
      T0,
    );
    const second = await correctMemory(app, { memoryId: first.memory.id, content: "Alex works at Acme Labs" }, days(1));
    const explanation = await explainMemory(app.pool, second.memory.id);
    expect(explanation.chain.map((m) => m.content)).toEqual(["Alex works at Acme", "Alex works at Acme Labs"]);
    expect(explanation.entities).toEqual([{ name: "Acme", type: "organization" }]);
    expect(explanation.sources).toHaveLength(1);
    expect(explanation.sources[0]?.text).toBe("Alex works at Acme");
  });
});

describe("export", () => {
  it("writes active memories as markdown grouped by scope and type", async () => {
    await saveMemory(app, { content: "Alex prefers tea", type: "preference", scope: me }, T0);
    await saveMemory(
      app,
      { content: "Acme uses Postgres", type: "fact", scope: { type: "project", id: "acme-api" } },
      T0,
    );
    const md = await exportMarkdown(app.pool);
    expect(md).toContain("# project:acme-api\n\n## fact\n\n- Acme uses Postgres (observed 2026-03-01, saved)");
    expect(md).toContain("# user:alex\n\n## preference\n\n- Alex prefers tea");
    expect(md.split("\n").at(-1)).toBe("active 2");
  });
});
