import { describe, expect, it } from "vitest";
import type { Memory } from "../../src/core/types.js";
import { dream } from "../../src/dream/dream.js";
import type { DreamDecision } from "../../src/dream/schema.js";
import { requireMemory } from "../../src/memory/chain.js";
import { correctMemory } from "../../src/memory/correct.js";
import { saveMemory } from "../../src/memory/save.js";
import { insertMemory } from "../../src/memory/write.js";
import { search } from "../../src/retrieve/search.js";
import { days, T0, useTestApp } from "../support/app.js";

const app = useTestApp();
const me = { type: "user" as const, id: "me" };
// Real extractions name their entities; shared entities put a memory in a candidate's neighborhood.
const alex = [{ name: "Alex", type: "person" as const }];
let tick = 0;

async function candidate(content: string, observed?: Date) {
  // Distinct observation times keep the batch order (and so candidate_index) deterministic.
  const at = observed ?? new Date(days(10).getTime() + ++tick * 1000);
  return insertMemory(
    app,
    app.pool,
    { content, type: "fact", scope: me, origin: "extracted", status: "candidate", observed_at: at, entities: alex },
    at,
  );
}

async function active(content: string, at = T0): Promise<Memory> {
  return insertMemory(
    app,
    app.pool,
    { content, type: "fact", scope: me, origin: "extracted", status: "active", entities: alex },
    at,
  );
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

describe("dream", () => {
  it("adds, rejects, and activates candidates the model left undecided", async () => {
    const a = await candidate("Alex speaks Portuguese");
    const b = await candidate("lol ok");
    const c = await candidate("Alex owns a bicycle");
    app.fakeLlm.on((p) => p.schemaName === "dream_decisions", {
      decisions: [
        {
          candidate_index: 0,
          action: "add",
          target_id: null,
          reason: "new",
          content: null,
          valid_from: null,
          valid_until: null,
        },
        {
          candidate_index: 1,
          action: "reject",
          target_id: null,
          reason: "noise",
          content: null,
          valid_from: null,
          valid_until: null,
        },
      ],
    });
    const result = await dream(app, { now: days(11) });
    expect(result).toMatchObject({ candidates: 3, add: 2, reject: 1 });
    expect((await requireMemory(app.pool, a.id)).status).toBe("active");
    expect((await requireMemory(app.pool, b.id)).status).toBe("invalidated");
    expect((await requireMemory(app.pool, c.id)).status).toBe("active");
    const log = await app.pool.query("SELECT action FROM dream_decisions ORDER BY action");
    expect(log.rows.map((r) => r.action)).toEqual(["add", "add", "reject"]);
  });

  it("duplicate raises the target's confidence and drops the candidate", async () => {
    const target = await active("Alex speaks Portuguese");
    const dup = await candidate("Alex speaks Portuguese fluently");
    decide({ action: "duplicate", target_id: target.id });
    await dream(app, { now: days(11) });
    expect((await requireMemory(app.pool, dup.id)).status).toBe("invalidated");
    expect((await requireMemory(app.pool, target.id)).confidence).toBeCloseTo(0.75);
  });

  it("supersede ends the old claim where the new one starts, so history stays right", async () => {
    const old = await active("Alex works at Acme");
    const next = await candidate("Alex works at Globex", days(20));
    decide({ action: "supersede", target_id: old.id });
    await dream(app, { now: days(21) });
    const before = await requireMemory(app.pool, old.id);
    const after = await requireMemory(app.pool, next.id);
    expect(before).toMatchObject({ status: "superseded", superseded_by_id: next.id, valid_until: days(20) });
    expect(after).toMatchObject({ status: "active", supersedes_id: old.id, valid_from: days(20) });
    const then = await search(app, "where does alex work", { now: days(30), asOf: days(5) });
    expect(then.hits.map((h) => h.memory.content)).toContain("Alex works at Acme");
    expect(then.hits.map((h) => h.memory.content)).not.toContain("Alex works at Globex");
  });

  it("temporal_update rewrites the claim with dates and never serves the stale wording", async () => {
    const stale = await candidate("Alex is flying to Rome next week", days(10));
    decide({
      action: "temporal_update",
      content: "Alex was in Rome in the third week of March 2026",
      valid_from: days(17).toISOString(),
      valid_until: days(24).toISOString(),
    });
    await dream(app, { now: days(40) });
    const original = await requireMemory(app.pool, stale.id);
    expect(original.status).toBe("invalidated");
    const rewritten = await requireMemory(app.pool, original.superseded_by_id as string);
    expect(rewritten).toMatchObject({
      content: "Alex was in Rome in the third week of March 2026",
      valid_from: days(17),
    });
    const during = await search(app, "rome", { now: days(40), asOf: days(20) });
    expect(during.hits.map((h) => h.memory.content)).toEqual(["Alex was in Rome in the third week of March 2026"]);
  });

  it("expire ends an active memory at the given date", async () => {
    const membership = await active("Alex has a gym membership");
    await candidate("Alex cancelled the gym membership", days(15));
    decide({ action: "expire", target_id: membership.id, valid_until: days(14).toISOString() });
    await dream(app, { now: days(16) });
    expect(await requireMemory(app.pool, membership.id)).toMatchObject({ status: "expired", valid_until: days(14) });
  });

  it("never lets the model touch memories it was not shown, in another scope, or stated by the user", async () => {
    const elsewhere = await insertMemory(
      app,
      app.pool,
      {
        content: "Globex uses Go",
        type: "fact",
        scope: { type: "project", id: "globex" },
        origin: "extracted",
        status: "active",
      },
      T0,
    );
    const stated = await saveMemory(
      app,
      { content: "Alex lives in Porto", type: "fact", scope: me, origin: "owner", entities: alex },
      T0,
    );
    const cands = [await candidate("Alex lives in Braga"), await candidate("Globex uses Rust")];
    decide({ action: "supersede", target_id: stated.memory.id }, { action: "supersede", target_id: elsewhere.id });
    const result = await dream(app, { now: days(11) });
    expect(result.add).toBe(2);
    expect((await requireMemory(app.pool, stated.memory.id)).status).toBe("active");
    expect((await requireMemory(app.pool, elsewhere.id)).status).toBe("active");
    const reasons = await app.pool.query("SELECT reason FROM dream_decisions ORDER BY reason");
    expect(reasons.rows.map((r) => r.reason).join(" ")).toMatch(/stated by the user|not in the neighborhood/);
    for (const c of cands) expect((await requireMemory(app.pool, c.id)).status).toBe("active");
  });

  it("marks memories whose validity ended as expired without calling the LLM", async () => {
    await insertMemory(
      app,
      app.pool,
      {
        content: "Alex is on parental leave",
        type: "fact",
        scope: me,
        origin: "saved",
        status: "active",
        valid_until: days(5),
      },
      T0,
    );
    const result = await dream(app, { now: days(6) });
    expect(result.expired).toBe(1);
    expect(app.fakeLlm.calls).toHaveLength(0);
  });

  it("chains two changes in one batch in the order they were observed", async () => {
    const first = await active("Alex drives a Fiat");
    const second = await candidate("Alex drives a Volvo", days(10));
    const third = await candidate("Alex drives a Tesla", days(20));
    decide({ action: "supersede", target_id: first.id }, { action: "supersede", target_id: first.id });
    await dream(app, { now: days(21) });
    expect(await requireMemory(app.pool, first.id)).toMatchObject({
      status: "superseded",
      superseded_by_id: second.id,
    });
    expect(await requireMemory(app.pool, second.id)).toMatchObject({
      status: "superseded",
      superseded_by_id: third.id,
    });
    expect((await requireMemory(app.pool, third.id)).status).toBe("active");
  });

  it("keeps a correction the user made out of the dream's reach", async () => {
    const wrong = await active("Alex's sister is called Ana");
    const fixed = await correctMemory(app, { memoryId: wrong.id, content: "Alex's sister is called Ioana" }, days(1));
    await candidate("Alex's sister is called Ana", days(5));
    decide({ action: "supersede", target_id: fixed.memory.id });
    await dream(app, { now: days(6) });
    expect((await requireMemory(app.pool, fixed.memory.id)).status).toBe("active");
  });
});
