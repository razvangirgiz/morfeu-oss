import { type Config, loadConfig } from "./config/config.js";
import { createLogger, type Logger } from "./core/log.js";
import { createPool, type Pool } from "./db/client.js";
import { BudgetedLLM } from "./providers/budget.js";
import { createEmbedder, createLlm } from "./providers/index.js";
import type { EmbeddingProvider, LLMProvider } from "./providers/types.js";

/** Everything a command needs, built once per process and passed down explicitly. */
export type App = {
  config: Config;
  pool: Pool;
  embedder: EmbeddingProvider;
  /** Every LLM call is counted against config.maxLlmCalls for the life of the process. */
  llm: BudgetedLLM;
  log: Logger;
};

export type AppOverrides = {
  config?: Config;
  pool?: Pool;
  embedder?: EmbeddingProvider;
  llm?: LLMProvider;
  log?: Logger;
};

export function createApp(overrides: AppOverrides = {}): App {
  const config = overrides.config ?? loadConfig();
  const llm = overrides.llm ?? createLlm(config);
  const log = overrides.log ?? createLogger(config.logLevel);
  return {
    config,
    pool:
      overrides.pool ??
      createPool(config.databaseUrl, { onError: (err) => log.warn(`database connection lost: ${err.message}`) }),
    embedder: overrides.embedder ?? createEmbedder(config),
    llm: llm instanceof BudgetedLLM ? llm : new BudgetedLLM(llm, config.maxLlmCalls),
    log,
  };
}

export async function closeApp(app: App): Promise<void> {
  await app.pool.end();
}
