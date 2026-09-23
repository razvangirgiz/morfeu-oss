import { describe, expect, it } from "vitest";
import type { Memory } from "../../src/core/types.js";
import { dream } from "../../src/dream/dream.js";
import type { DreamDecision } from "../../src/dream/schema.js";
import { correctTool } from "../../src/mcp/tools/write.js";
import { requireMemory } from "../../src/memory/chain.js";
import { correctMemory } from "../../src/memory/correct.js";
import { explainMemory } from "../../src/memory/explain.js";
import { exportMarkdown } from "../../src/memory/export.js";
import { forgetMemory } from "../../src/memory/forget.js";
import { pinMemory } from "../../src/memory/pins.js";
import { MEMORY_COLUMNS, mapMemory } from "../../src/memory/row.js";
import { saveMemory } from "../../src/memory/save.js";
import { servingSql } from "../../src/memory/serving.js";
import { insertMemory } from "../../src/memory/write.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp();
const me = { type: "user" as const, id: "me" };
const alex = [{ name: "Alex", type: "person" as const }];

/** What an as-of question at `at` would be served. */
async function servedAt(at: Date, historical = true): Promise<string[]> {
  const res = await app.pool.query(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${servingSql({ timeParam: "$1", historical })} ORDER BY content`,
    [at],
  );
  return res.rows.map(mapMemory).map((m) => m.content);
}

/**
 * The invariant: within one chain, at no point in time are two claims served.
 * Checked on every day of the scenario, in the past and in the present view.
 */
async function assertNoOverlap(from = -5, to = 80): Promise<void> {
  const rows = (await app.pool.query(`SELECT ${MEMORY_COLUMNS} FROM memories`)).rows.map(mapMemory);
  const byId = new Map(rows.map((m) => [m.id, m]));
  const root = (m: Memory): string => {
    let cur = m;
    for (let i = 0; cur.supersedes_id && byId.has(cur.supersedes_id) && i < 50; i++)
      cur = byId.get(cur.supersedes_id) as Memory;
    return cur.id;
  };
  for (let d = from; d <= to; d++) {
    const at = days(d);
    const res = await app.pool.query(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${servingSql({ timeParam: "$1", historical: true })}`,
      [at],
    );
    const chains = res.rows.map(mapMemory).map(root);
    const dupes = chains.filter((c, i) => chains.indexOf(c) !== i);
    expect(dupes, `two claims of one chain served on day ${d}`).toEqual([]);
  }
}

function decide(...decisions: Partial<DreamDecision>[]) {
  app.fakeLlm.on((p) => p.schemaName === "dream_decisions", {
    decisions: decisions.map((d, i) => ({
      candidate_index: i,
      action: "add",
      target_id: null,
      reason: "test",
      content: null,
      valid_from: null,
      valid_until: null,
      ...d,
    })),
  });
}

async function candidate(content: string, at: Date) {
  return insertMemory(
    app,
    app.pool,
    { content, type: "fact", scope: me, origin: "extracted", status: "candidate", observed_at: at, entities: alex },
    at,
  );
}

describe("bitemporal invariants", () => {
  it("a correction reaching further back closes the claim before it", async () => {
    const paris = await saveMemory(
      app,
      { content: "Alex lives in Paris", type: "fact", scope: me, valid_from: days(0) },
      days(0),
    );
    const london = await saveMemory(
      app,
      { content: "Alex lives in London", type: "fact", scope: me, supersedes: paris.memory.id },
      days(20),
    );
    await correctMemory(
      app,
      { memoryId: london.memory.id, content: "Alex lives in Berlin", valid_from: days(5) },
      days(30),
    );
    expect(await servedAt(days(10))).toEqual(["Alex lives in Berlin"]);
    expect(await servedAt(days(2))).toEqual(["Alex lives in Paris"]);
    await assertNoOverlap();
  });

  it("superseding never extends a claim that already ended", async () => {
    const trip = await saveMemory(
      app,
      { content: "Alex is in Rome", type: "fact", scope: me, valid_from: days(0), valid_until: days(10) },
      days(0),
    );
    await saveMemory(
      app,
      { content: "Alex is in Oslo", type: "fact", scope: me, supersedes: trip.memory.id, valid_from: days(30) },
      days(1),
    );
    expect(await servedAt(days(20))).toEqual([]);
    expect((await requireMemory(app.pool, trip.memory.id)).valid_until).toEqual(days(10));
    await assertNoOverlap();
  });

  it("a change announced for later keeps the present claim until it happens", async () => {
    const job = await saveMemory(app, { content: "Alex works at Acme", type: "fact", scope: me }, days(0));
    await saveMemory(
      app,
      { content: "Alex works at Globex", type: "fact", scope: me, supersedes: job.memory.id, valid_from: days(40) },
      days(10),
    );
    expect(await servedAt(days(20), false)).toEqual(["Alex works at Acme"]);
    expect(await servedAt(days(50))).toEqual(["Alex works at Globex"]);
    await assertNoOverlap();
  });

  it("a dream rewrite without dates starts when the claim was said", async () => {
    const trip = await insertMemory(
      app,
      app.pool,
      {
        content: "Alex is flying to Rome next week",
        type: "event",
        scope: me,
        origin: "extracted",
        status: "active",
        entities: alex,
      },
      days(0),
    );
    await candidate("Alex flew to Rome", days(10));
    decide({ action: "temporal_update", target_id: trip.id, content: "Alex flew to Rome in March" });
    await dream(app, { now: days(11) });
    expect(await servedAt(days(3))).toEqual(["Alex is flying to Rome next week"]);
    expect(await servedAt(days(12))).toEqual(["Alex flew to Rome in March"]);
    await assertNoOverlap();
  });

  it("a claim the dream expires on arrival ended no later than when it was said", async () => {
    await candidate("Alex lived in Madrid", days(10));
    decide({ action: "expire" });
    await dream(app, { now: days(40) });
    expect(await servedAt(days(20))).toEqual([]);
    expect(await servedAt(days(5))).toEqual(["Alex lived in Madrid"]);
  });

  it("a dream supersede that starts before its target retracts the target instead of hiding it", async () => {
    const late = await insertMemory(
      app,
      app.pool,
      {
        content: "Alex plays chess",
        type: "routine",
        scope: me,
        origin: "extracted",
        status: "active",
        valid_from: days(20),
        entities: alex,
      },
      days(20),
    );
    await insertMemory(
      app,
      app.pool,
      {
        content: "Alex plays go",
        type: "routine",
        scope: me,
        origin: "extracted",
        status: "candidate",
        valid_from: days(5),
        observed_at: days(21),
        entities: alex,
      },
      days(21),
    );
    decide({ action: "supersede", target_id: late.id });
    await dream(app, { now: days(22) });
    expect((await requireMemory(app.pool, late.id)).retracted_at).toEqual(days(22));
    expect(await servedAt(days(25))).toEqual(["Alex plays go"]);
    await assertNoOverlap();
  });
});

describe("pending successors", () => {
  it("a change made while another is announced for later extends the chain instead of forking it", async () => {
    const paris = await saveMemory(app, { content: "Alex lives in Paris", type: "fact", scope: me }, days(0));
    await saveMemory(
      app,
      { content: "Alex lives in Berlin", type: "fact", scope: me, supersedes: paris.memory.id, valid_from: days(40) },
      days(10),
    );
    // Paris is still the present claim and the natural thing to point at.
    await saveMemory(
      app,
      { content: "Alex lives in Rome", type: "fact", scope: me, supersedes: paris.memory.id },
      days(20),
    );
    expect(await servedAt(days(50), false)).toEqual(["Alex lives in Rome"]);
    expect(await servedAt(days(15))).toEqual(["Alex lives in Paris"]);
    await assertNoOverlap();
  });

  it("a dream supersede aimed at the older claim goes to the pending head", async () => {
    const paris = await insertMemory(
      app,
      app.pool,
      {
        content: "Alex lives in Paris",
        type: "fact",
        scope: me,
        origin: "extracted",
        status: "active",
        entities: alex,
      },
      days(0),
    );
    await saveMemory(
      app,
      {
        content: "Alex lives in Berlin",
        type: "fact",
        scope: me,
        supersedes: paris.id,
        valid_from: days(40),
        entities: alex,
      },
      days(10),
    );
    await candidate("Alex lives in Rome", days(20));
    decide({ action: "supersede", target_id: paris.id });
    await dream(app, { now: days(21) });
    expect(await servedAt(days(50), false)).toEqual(["Alex lives in Rome"]);
    await assertNoOverlap();
  });

  it("forgetting a pending or latest successor gives the present back to the claim before it", async () => {
    const paris = await saveMemory(app, { content: "Alex lives in Paris", type: "fact", scope: me }, days(0));
    const berlin = await saveMemory(
      app,
      { content: "Alex lives in Berlin", type: "fact", scope: me, supersedes: paris.memory.id, valid_from: days(40) },
      days(10),
    );
    await forgetMemory(app, berlin.memory.id, "never happened", days(20));
    expect(await servedAt(days(50), false)).toEqual(["Alex lives in Paris"]);
    await assertNoOverlap();
  });
});

describe("served head versus announced successor", () => {
  async function parisThenBerlinAt40() {
    const paris = await saveMemory(
      app,
      { content: "Alex lives in Paris", type: "fact", scope: me, entities: alex },
      days(0),
    );
    const berlin = await saveMemory(
      app,
      {
        content: "Alex lives in Berlin",
        type: "fact",
        scope: me,
        supersedes: paris.memory.id,
        valid_from: days(40),
        entities: alex,
      },
      days(10),
    );
    return { paris: paris.memory, berlin: berlin.memory };
  }

  it("a correction fixes the claim served now and keeps the announced move", async () => {
    const { paris } = await parisThenBerlinAt40();
    await correctMemory(app, { memoryId: paris.id, content: "Alex lives in Lyon" }, days(20));
    expect(await servedAt(days(30), false)).toEqual(["Alex lives in Lyon"]);
    expect(await servedAt(days(5))).toEqual(["Alex lives in Lyon"]);
    expect(await servedAt(days(50))).toEqual(["Alex lives in Berlin"]);
    await assertNoOverlap();
  });

  it("an expiry from the dream ends the claim served now, not the announced one", async () => {
    const { paris } = await parisThenBerlinAt40();
    await candidate("Alex left Paris", days(25));
    decide({ action: "expire", target_id: paris.id, valid_until: days(24).toISOString() });
    await dream(app, { now: days(26) });
    expect(await servedAt(days(30))).toEqual([]);
    expect(await servedAt(days(50))).toEqual(["Alex lives in Berlin"]);
    await assertNoOverlap();
  });

  it("pins the claim served now", async () => {
    const { paris } = await parisThenBerlinAt40();
    const pinned = await pinMemory(app, paris.id, days(20));
    expect(pinned.content).toBe("Alex lives in Paris");
  });

  it("a rewrite dated after the announced move comes after it, and never stops the run", async () => {
    const { paris } = await parisThenBerlinAt40();
    await candidate("Alex is in Paris again", days(20));
    decide({
      action: "temporal_update",
      target_id: paris.id,
      content: "Alex lives in Paris again",
      valid_from: days(45).toISOString(),
    });
    const result = await dream(app, { now: days(21) });
    expect(result.failed).toBe(0);
    expect(await servedAt(days(42))).toEqual(["Alex lives in Berlin"]);
    expect(await servedAt(days(50))).toEqual(["Alex lives in Paris again"]);
    await assertNoOverlap();
  });

  it("a correction dated after the announced move comes after it", async () => {
    const { paris } = await parisThenBerlinAt40();
    await correctMemory(app, { memoryId: paris.id, content: "Alex lives in Nice", valid_from: days(50) }, days(20));
    expect(await servedAt(days(45))).toEqual(["Alex lives in Berlin"]);
    expect(await servedAt(days(55))).toEqual(["Alex lives in Nice"]);
    await assertNoOverlap();
  });

  it("a correction reaches past an announced successor that was itself corrected", async () => {
    const { paris, berlin } = await parisThenBerlinAt40();
    const hamburg = await correctMemory(app, { memoryId: berlin.id, content: "Alex lives in Hamburg" }, days(15));
    await correctMemory(app, { memoryId: paris.id, content: "Alex lives in Lyon" }, days(20));
    expect(await servedAt(days(30), false)).toEqual(["Alex lives in Lyon"]);
    expect(await servedAt(days(50), false)).toEqual(["Alex lives in Hamburg"]);
    const next = await saveMemory(
      app,
      { content: "Alex lives in Vienna", type: "fact", scope: me, supersedes: hamburg.memory.id, origin: "owner" },
      days(60),
    );
    expect(next.superseded_id).toBe(hamburg.memory.id);
    await assertNoOverlap(-5, 90);
  });

  it("a change the dream sees before an announced one starts when it was said", async () => {
    const { paris } = await parisThenBerlinAt40();
    await candidate("Alex moved to Rome", days(20));
    decide({ action: "supersede", target_id: paris.id });
    await dream(app, { now: days(21) });
    expect(await servedAt(days(25), false)).toEqual(["Alex moved to Rome"]);
    expect(await servedAt(days(50))).toEqual(["Alex moved to Rome"]);
    await assertNoOverlap();
  });
});

describe("forget inside a chain", () => {
  it("forgetting a middle claim links its neighbours and never revives an old one", async () => {
    const fiat = await saveMemory(app, { content: "Alex drives a Fiat", type: "fact", scope: me }, days(0));
    const ford = await saveMemory(
      app,
      { content: "Alex drives a Ford", type: "fact", scope: me, supersedes: fiat.memory.id },
      days(10),
    );
    const tesla = await saveMemory(
      app,
      { content: "Alex drives a Tesla", type: "fact", scope: me, supersedes: ford.memory.id },
      days(20),
    );
    await forgetMemory(app, ford.memory.id, "private", days(25));
    expect(await servedAt(days(30), false)).toEqual(["Alex drives a Tesla"]);
    expect(await servedAt(days(15))).toEqual([]);
    expect((await requireMemory(app.pool, tesla.memory.id)).supersedes_id).toBe(fiat.memory.id);
    await assertNoOverlap();
  });

  it("forgetting the latest claims one after another brings the chain back to life", async () => {
    const fiat = await saveMemory(app, { content: "Alex drives a Fiat", type: "fact", scope: me }, days(0));
    const ford = await saveMemory(
      app,
      { content: "Alex drives a Ford", type: "fact", scope: me, supersedes: fiat.memory.id },
      days(10),
    );
    const tesla = await saveMemory(
      app,
      { content: "Alex drives a Tesla", type: "fact", scope: me, supersedes: ford.memory.id },
      days(20),
    );
    await forgetMemory(app, ford.memory.id, "private", days(25));
    await forgetMemory(app, tesla.memory.id, "private", days(26));
    expect(await servedAt(days(30), false)).toEqual(["Alex drives a Fiat"]);
    const again = await saveMemory(
      app,
      { content: "Alex drives a Volvo", type: "fact", scope: me, supersedes: fiat.memory.id },
      days(40),
    );
    expect(again.superseded_id).toBe(fiat.memory.id);
    await assertNoOverlap();
  });

  it("forgetting a corrected claim leaves the correction in place", async () => {
    const cat = await saveMemory(app, { content: "Alex has a cat", type: "fact", scope: me }, days(0));
    const dog = await saveMemory(
      app,
      { content: "Alex has a dog", type: "fact", scope: me, supersedes: cat.memory.id },
      days(10),
    );
    await correctMemory(app, { memoryId: dog.memory.id, content: "Alex has a parrot" }, days(15));
    await forgetMemory(app, dog.memory.id, "private", days(20));
    expect(await servedAt(days(30), false)).toEqual(["Alex has a parrot"]);
    await assertNoOverlap();
  });
});

describe("dates from agents and models", () => {
  it("a correction with null dates keeps the corrected claim's period", async () => {
    const paris = await saveMemory(app, { content: "Alex lives in Paris", type: "fact", scope: me }, days(0));
    const london = await saveMemory(
      app,
      { content: "Alex lives in London", type: "fact", scope: me, supersedes: paris.memory.id },
      days(20),
    );
    await correctTool.run(
      app,
      { memory_id: london.memory.id, content: "Alex lives in Leeds", valid_from: null },
      days(30),
    );
    expect(await servedAt(days(10))).toEqual(["Alex lives in Paris"]);
    expect(await servedAt(days(25))).toEqual(["Alex lives in Leeds"]);
  });

  it("an agent cannot correct what the user stated", async () => {
    const stated = await saveMemory(
      app,
      { content: "Alex is vegetarian", type: "fact", scope: me, origin: "owner" },
      days(0),
    );
    await expect(
      correctTool.run(app, { memory_id: stated.memory.id, content: "Alex eats fish" }, days(1)),
    ).rejects.toThrow(/stated by the user/);
  });

  it("a rewrite dated before its target cannot erase the target's history", async () => {
    const paris = await insertMemory(
      app,
      app.pool,
      {
        content: "Alex lives in Paris",
        type: "fact",
        scope: me,
        origin: "extracted",
        status: "active",
        valid_from: days(0),
        entities: alex,
      },
      days(0),
    );
    const berlin = await saveMemory(
      app,
      {
        content: "Alex lives in Berlin",
        type: "fact",
        scope: me,
        supersedes: paris.id,
        valid_from: days(20),
        entities: alex,
      },
      days(20),
    );
    await candidate("Alex moved to Berlin", days(30));
    decide({
      action: "temporal_update",
      target_id: berlin.memory.id,
      content: "Alex has lived in Berlin since March",
      valid_from: days(-100).toISOString(),
    });
    await dream(app, { now: days(31) });
    expect(await servedAt(days(10))).toEqual(["Alex lives in Paris"]);
    await assertNoOverlap();
  });
});

describe("forget", () => {
  it("forgets exactly the memory asked for, even an older version", async () => {
    const dating = await saveMemory(app, { content: "Alex dates Sam", type: "relationship", scope: me }, days(0));
    const single = await saveMemory(
      app,
      { content: "Alex is single", type: "relationship", scope: me, supersedes: dating.memory.id },
      days(10),
    );
    await forgetMemory(app, dating.memory.id, "private", days(20));
    expect(await servedAt(days(5))).toEqual([]);
    expect(await servedAt(days(25), false)).toEqual(["Alex is single"]);
    expect((await requireMemory(app.pool, single.memory.id)).status).toBe("active");
  });

  it("hides forgotten text from explain, chains and export", async () => {
    const a = await saveMemory(
      app,
      { content: "Alex's old address is 12 Rua Augusta", type: "fact", scope: me },
      days(0),
    );
    const b = await saveMemory(
      app,
      { content: "Alex's address is 3 Unter den Linden", type: "fact", scope: me, supersedes: a.memory.id },
      days(10),
    );
    await forgetMemory(app, a.memory.id, "private", days(11));
    await expect(explainMemory(app.pool, a.memory.id)).rejects.toThrow(/forgotten/);
    const chain = (await explainMemory(app.pool, b.memory.id)).chain.map((m) => m.content);
    expect(chain).toEqual(["Alex's address is 3 Unter den Linden"]);
    expect(await exportMarkdown(app.pool, { all: true })).not.toContain("Rua Augusta");
  });

  it("is idempotent", async () => {
    const { memory } = await saveMemory(app, { content: "temporary note", type: "fact", scope: me }, days(0));
    await forgetMemory(app, memory.id, "done", days(1));
    expect((await forgetMemory(app, memory.id, "again", days(2))).already).toBe(true);
  });
});

describe("resilience", () => {
  it("survives the database dropping idle connections", async () => {
    await saveMemory(app, { content: "Alex likes jazz", type: "preference", scope: me }, T0);
    await app.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = await saveMemory(app, { content: "Alex likes blues", type: "preference", scope: me }, T0);
    expect(again.deduplicated).toBe(false);
  });

  it("deduplicates concurrent identical saves", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => saveMemory(app, { content: "Alex uses Linux", type: "fact", scope: me }, T0)),
    );
    expect(new Set(results.map((r) => r.memory.id)).size).toBe(1);
  });
});
