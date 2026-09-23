import { describe, expect, it } from "vitest";
import { containsWord, foldText } from "../../src/memory/entities.js";
import { fakeVector } from "../../src/providers/fake.js";

describe("entity matching", () => {
  it("folds case, accents and stroked letters", () => {
    expect(foldText("Łódź Ștefan Müller")).toBe("lodz stefan muller");
  });

  it("matches whole words only, except in scripts written without spaces", () => {
    expect(containsWord("meet ana tomorrow", "ana")).toBe(true);
    expect(containsWord("banana bread", "ana")).toBe(false);
    expect(containsWord("ai", "a")).toBe(false);
    expect(containsWord("我在东京工作", "东京")).toBe(true);
  });
});

describe("fake embeddings", () => {
  it("are deterministic, unit length, and closer for shared words", () => {
    const a = fakeVector("alex likes green tea");
    const b = fakeVector("alex likes black tea");
    const c = fakeVector("the deploy pipeline failed");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    expect(fakeVector("alex likes green tea")).toEqual(a);
    expect(dot(a, a)).toBeCloseTo(1);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });
});
