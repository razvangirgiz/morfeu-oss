import { createHash } from "node:crypto";
import type { CompleteParams, EmbeddingProvider, LLMProvider } from "./types.js";

const FAKE_DIMENSIONS = 256;

/**
 * Deterministic bag-of-words vectors: texts that share words point the same
 * way. Good enough to exercise semantic retrieval in tests and the demo
 * without a network.
 */
export class FakeEmbeddings implements EmbeddingProvider {
  readonly name = "fake";

  constructor(readonly model = "fake-embedding") {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeVector(t));
  }
}

export function fakeVector(text: string, dimensions = FAKE_DIMENSIONS): number[] {
  const vec = new Float64Array(dimensions);
  const words =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) vec[0] = 1;
  for (const word of words) {
    for (let salt = 0; salt < 4; salt++) {
      const idx = hash(`${salt}:${word}`) % dimensions;
      vec[idx] = (vec[idx] ?? 0) + (hash(`${salt + 100}:${word}`) & 1 ? 1 : -1);
    }
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return Array.from(vec, (v) => v / norm);
}

function hash(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

type Rule = { match: (params: CompleteParams) => boolean; respond: (params: CompleteParams) => unknown };

/** Answers from registered rules, in registration order. Unmatched calls fail loudly. */
export class FakeLLM implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-llm";
  readonly calls: CompleteParams[] = [];
  private rules: Rule[] = [];

  on(match: (params: CompleteParams) => boolean, respond: unknown | ((params: CompleteParams) => unknown)): this {
    this.rules.push({
      match,
      respond: typeof respond === "function" ? (respond as Rule["respond"]) : () => structuredClone(respond),
    });
    return this;
  }

  reset(): void {
    this.rules = [];
    this.calls.length = 0;
  }

  async complete(params: CompleteParams): Promise<unknown> {
    this.calls.push(params);
    const rule = this.rules.find((r) => r.match(params));
    if (!rule) throw new Error(`FakeLLM: no rule for ${params.schemaName}: ${params.user.slice(0, 200)}`);
    return rule.respond(params);
  }
}
