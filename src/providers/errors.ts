/** The per-run LLM call ceiling (MORFEU_MAX_LLM_CALLS) is used up. A clean stop: the rest waits for the next run. */
export class MaxCallsReachedError extends Error {
  constructor(max: number) {
    super(`LLM call limit reached (MORFEU_MAX_LLM_CALLS=${max}); the remaining work continues on the next run`);
    this.name = "MaxCallsReachedError";
  }
}

/** The provider is switched off (`none`) or cannot be reached. */
export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}
