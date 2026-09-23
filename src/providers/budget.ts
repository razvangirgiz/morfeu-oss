import { MaxCallsReachedError } from "./errors.js";
import type { CompleteParams, LLMProvider } from "./types.js";

/**
 * Counts LLM calls against the per-run ceiling. Callers check the budget before
 * the first call of a unit of work (a chunk, a batch), so a run never stops
 * halfway through one.
 */
export class BudgetedLLM implements LLMProvider {
  calls = 0;

  constructor(
    readonly inner: LLMProvider,
    readonly maxCalls: number,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  checkBudget(): void {
    if (this.calls >= this.maxCalls) throw new MaxCallsReachedError(this.maxCalls);
  }

  complete(params: CompleteParams): Promise<unknown> {
    this.calls += 1;
    return this.inner.complete(params);
  }
}
