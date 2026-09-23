import { describe, expect, it } from "vitest";
import { combine, effectiveWeights, recency, toSignals, WEIGHTS } from "../../src/retrieve/score.js";

const now = new Date("2026-03-01T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("score", () => {
  it("halves recency at each volatility's half-life", () => {
    expect(recency(daysAgo(14), undefined, now, "fast")).toBeCloseTo(0.5);
    expect(recency(daysAgo(90), undefined, now, "slow")).toBeCloseTo(0.5);
    expect(recency(daysAgo(365), undefined, now, "stable")).toBeCloseTo(0.5);
  });

  it("counts a recent retrieval as fresh", () => {
    expect(recency(daysAgo(365), daysAgo(0), now, "fast")).toBeCloseTo(1);
  });

  it("gives a missing relevance signal's weight to the others, not to the priors", () => {
    const w = effectiveWeights({ semantic: false, keyword: true, entity: false });
    expect(w.keyword).toBeCloseTo(WEIGHTS.semantic + WEIGHTS.keyword + WEIGHTS.entity);
    expect(w.recency).toBe(WEIGHTS.recency);
    const none = effectiveWeights({ semantic: false, keyword: false, entity: false });
    expect(none.semantic + none.keyword + none.entity).toBe(0);
  });

  it("drops similarity below the noise floor and rewards strict keyword matches", () => {
    const base = {
      semanticFloor: 0.3,
      keywordMax: 2,
      entityHits: 1,
      entityTotal: 2,
      importance: 0.5,
      confidence: 0.7,
      observedAt: now,
      lastRetrievedAt: undefined,
      now,
      volatility: "slow" as const,
    };
    const weak = toSignals({ ...base, similarity: 0.2, keywordRank: 1, strictMatch: false });
    expect(weak).toMatchObject({ semantic: 0, keyword: 0.5, entity: 0.5 });
    const strict = toSignals({ ...base, similarity: 0.8, keywordRank: 1, strictMatch: true });
    expect(strict.keyword).toBeCloseTo(0.75);
    expect(combine(strict, WEIGHTS)).toBeGreaterThan(combine(weak, WEIGHTS));
  });
});
