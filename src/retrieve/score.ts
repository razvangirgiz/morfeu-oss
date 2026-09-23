import type { Volatility } from "../core/types.js";

/** The signals a hit is ranked on, each in [0, 1]. */
export type Signals = {
  semantic: number;
  keyword: number;
  entity: number;
  recency: number;
  importance: number;
  confidence: number;
};

/**
 * Relevance (semantic, keyword, entity) carries 70% of the score; priors
 * (recency, importance, confidence) the rest, so a strong prior never lifts an
 * irrelevant memory above a relevant one.
 */
export const WEIGHTS: Readonly<Signals> = {
  semantic: 0.3,
  keyword: 0.2,
  entity: 0.2,
  recency: 0.15,
  importance: 0.1,
  confidence: 0.05,
};

/** How long until a memory of each volatility is half as "recent". */
const HALF_LIFE_DAYS: Record<Volatility, number> = { stable: 365, slow: 90, fast: 14 };

/** Rows that also match every query word (the strict pass) get this on top of their keyword rank. */
const STRICT_KEYWORD_BONUS = 0.25;

const DAY_MS = 86_400_000;

export type Availability = { semantic: boolean; keyword: boolean; entity: boolean };

/**
 * A relevance signal the query could not produce at all (no embedder, no
 * content words, no named entities) must not hand its weight to the priors:
 * the remaining relevance signals are scaled up to keep the group's share.
 */
export function effectiveWeights(available: Availability, weights: Readonly<Signals> = WEIGHTS): Signals {
  const group = weights.semantic + weights.keyword + weights.entity;
  const present =
    (available.semantic ? weights.semantic : 0) +
    (available.keyword ? weights.keyword : 0) +
    (available.entity ? weights.entity : 0);
  const scale = present > 0 ? group / present : 0;
  return {
    ...weights,
    semantic: available.semantic ? weights.semantic * scale : 0,
    keyword: available.keyword ? weights.keyword * scale : 0,
    entity: available.entity ? weights.entity * scale : 0,
  };
}

export function combine(signals: Signals, weights: Signals): number {
  return (
    weights.semantic * signals.semantic +
    weights.keyword * signals.keyword +
    weights.entity * signals.entity +
    weights.recency * signals.recency +
    weights.importance * signals.importance +
    weights.confidence * signals.confidence
  );
}

/** Exponential decay by age; a recent retrieval counts as fresh as a recent observation. */
export function recency(
  observedAt: Date,
  lastRetrievedAt: Date | undefined,
  now: Date,
  volatility: Volatility,
): number {
  const reference = lastRetrievedAt && lastRetrievedAt > observedAt ? lastRetrievedAt : observedAt;
  const ageDays = Math.max(0, (now.getTime() - reference.getTime()) / DAY_MS);
  return Math.exp((-Math.LN2 * ageDays) / HALF_LIFE_DAYS[volatility]);
}

export type RawSignals = {
  similarity: number | undefined;
  semanticFloor: number;
  keywordRank: number | undefined;
  keywordMax: number;
  strictMatch: boolean;
  entityHits: number;
  entityTotal: number;
  importance: number;
  confidence: number;
  observedAt: Date;
  lastRetrievedAt: Date | undefined;
  now: Date;
  volatility: Volatility;
};

export function toSignals(raw: RawSignals): Signals {
  const lenient = raw.keywordRank && raw.keywordMax > 0 ? raw.keywordRank / raw.keywordMax : 0;
  const similarity = raw.similarity ?? 0;
  return {
    semantic: clamp01(similarity >= raw.semanticFloor ? similarity : 0),
    keyword: clamp01(lenient > 0 && raw.strictMatch ? lenient + STRICT_KEYWORD_BONUS : lenient),
    entity: raw.entityTotal > 0 ? clamp01(raw.entityHits / raw.entityTotal) : 0,
    recency: recency(raw.observedAt, raw.lastRetrievedAt, raw.now, raw.volatility),
    importance: clamp01(raw.importance),
    confidence: clamp01(raw.confidence),
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
