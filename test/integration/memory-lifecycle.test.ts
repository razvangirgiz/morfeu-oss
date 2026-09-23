import { describe, expect, it } from "vitest";
import { requireMemory } from "../../src/memory/chain.js";
import { correctMemory } from "../../src/memory/correct.js";
import { forgetMemory } from "../../src/memory/forget.js";
import { listPinned, pinMemory } from "../../src/memory/pins.js";
import { MEMORY_COLUMNS, mapMemory } from "../../src/memory/row.js";
import { saveMemory } from "../../src/memory/save.js";
import { servingSql } from "../../src/memory/serving.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp();
const me = { type: "user" as const, id: "me" };

async function servedAt(at: Date, historical: boolean): Promise<string[]> {
  const res = await app.pool.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${servingSql({ timeParam: "$1", historical })} ORDER BY recorded_at`,
    [at],
  );
  return res.rows.map(mapMemory).map((m) => m.content);
}

describe("save", () => {
  it("resolves user:me to the configured user and deduplicates the same sentence", async () => {
    const first = await saveMemory(app, { content: "Alex  prefers TEA", type: "preference", scope: me }, T0);
    const second = await saveMemory(app, { content: "alex prefers tea", type: "preference", scope: me }, days(1));
    expect(first.memory.scope_id).toBe("alex");
    expect(second.deduplicated).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
  });

  it("redacts secrets before storing them", async () => {
    const { memory } = await saveMemory(
      app,
      { content: "The staging key is sk-proj-abcdefghijklmnopqrstuvwxyz0123", type: "fact", scope: me },
      T0,
    );
    expect(memory.content).toBe("The staging key is [redacted:openai]");
    const events = await app.pool.query("SELECT content_text FROM events");
    expect(events.rows[0]?.content_text).not.toContain("sk-proj");
  });

  it("supersedes: the old claim ends where the new one starts", async () => {
    const old = await saveMemory(app, { content: "Alex lives in Lisbon", type: "fact", scope: me }, T0);
    const moved = await saveMemory(
      app,
      { content: "Alex lives in Berlin", type: "fact", scope: me, supersedes: old.memory.id },
      days(30),
    );
    const before = await requireMemory(app.pool, old.memory.id);
    expect(before.status).toBe("superseded");
    expect(before.valid_until).toEqual(days(30));
    expect(before.retracted_at).toBeNull();
    expect(moved.memory.valid_from).toEqual(days(30));
    expect(await servedAt(days(40), false)).toEqual(["Alex lives in Berlin"]);
    // In the past, the old claim was true and the new one not yet.
    expect(await servedAt(days(10), true)).toEqual(["Alex lives in Lisbon"]);
  });
});

describe("correct", () => {
  it("retracts the wrong claim, so the past no longer returns it either", async () => {
    const wrong = await saveMemory(app, { content: "Alex was born in Porto", type: "fact", scope: me }, T0);
    const fixed = await correctMemory(app, { memoryId: wrong.memory.id, content: "Alex was born in Braga" }, days(5));
    const old = await requireMemory(app.pool, wrong.memory.id);
    expect(old.status).toBe("superseded");
    expect(old.retracted_at).toEqual(days(5));
    expect(fixed.memory.origin).toBe("owner");
    expect(fixed.memory.confidence).toBe(1);
    expect(await servedAt(days(1), true)).toEqual(["Alex was born in Braga"]);
    expect(await servedAt(days(6), false)).toEqual(["Alex was born in Braga"]);
  });

  it("follows the chain to its head and keeps the pin", async () => {
    const a = await saveMemory(app, { content: "Alex drinks green tea", type: "preference", scope: me }, T0);
    await pinMemory(app, a.memory.id, T0);
    const b = await correctMemory(app, { memoryId: a.memory.id, content: "Alex drinks black tea" }, days(1));
    const c = await correctMemory(app, { memoryId: a.memory.id, content: "Alex drinks oolong" }, days(2));
    expect(c.retracted_id).toBe(b.memory.id);
    expect((await listPinned(app.pool, days(3))).map((m) => m.content)).toEqual(["Alex drinks oolong"]);
  });
});

describe("forget", () => {
  it("stops serving the memory now and in history, and keeps the row", async () => {
    const { memory } = await saveMemory(app, { content: "Alex's locker code is 4412", type: "fact", scope: me }, T0);
    await forgetMemory(app, memory.id, "the user asked", days(1));
    expect(await servedAt(days(2), false)).toEqual([]);
    expect(await servedAt(days(0.5), true)).toEqual([]);
    expect((await requireMemory(app.pool, memory.id)).status).toBe("invalidated");
  });

  it("requires a reason", async () => {
    const { memory } = await saveMemory(app, { content: "temporary", type: "fact", scope: me }, T0);
    await expect(forgetMemory(app, memory.id, " ", T0)).rejects.toThrow(/reason/);
  });
});
