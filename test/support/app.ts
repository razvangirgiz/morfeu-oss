import { afterAll, beforeEach } from "vitest";
import { type App, createApp } from "../../src/app.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { silentLogger } from "../../src/core/log.js";
import { createPool } from "../../src/db/client.js";
import { clearVectorCache } from "../../src/memory/vectors.js";
import { FakeEmbeddings, FakeLLM } from "../../src/providers/fake.js";
import { urlFor } from "./database.js";

export function workerDatabase(): string {
  return `morfeu_test_w${process.env.VITEST_POOL_ID ?? "0"}`;
}

export type TestApp = App & { fakeLlm: FakeLLM };

function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    MORFEU_DATABASE_URL: urlFor(workerDatabase()),
    MORFEU_LLM_PROVIDER: "fake",
    MORFEU_EMBEDDING_PROVIDER: "fake",
    MORFEU_USER_ID: "alex",
    MORFEU_LANGUAGE: "english",
    ...overrides,
  });
}

/**
 * An app on the worker's test database with fake providers. Tables are
 * emptied before every test; the pool closes after the file.
 */
export function useTestApp(overrides: NodeJS.ProcessEnv = {}): TestApp {
  const config = testConfig(overrides);
  const fakeLlm = new FakeLLM();
  const app = createApp({
    config,
    pool: createPool(config.databaseUrl, { max: 4 }),
    embedder: new FakeEmbeddings(),
    llm: fakeLlm,
    log: silentLogger,
  }) as TestApp;
  app.fakeLlm = fakeLlm;
  beforeEach(async () => {
    fakeLlm.reset();
    app.llm.calls = 0;
    await resetData(app);
  });
  afterAll(async () => {
    await app.pool.end();
  });
  return app;
}

const DATA_TABLES = [
  "dream_decisions",
  "runs",
  "memory_usage",
  "memory_embeddings",
  "query_embeddings",
  "memory_entities",
  "entities",
  "memory_sources",
  "memories",
  "events",
  "ingest_cursors",
];

/** TRUNCATE bypasses the append-only row triggers; only tests ever do this. */
async function resetData(app: App): Promise<void> {
  await app.pool.query(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  await app.pool.query("DELETE FROM settings WHERE key LIKE 'vector_dims:%'");
  clearVectorCache();
}

export const T0 = new Date("2026-03-01T09:00:00Z");

export function days(n: number, from = T0): Date {
  return new Date(from.getTime() + n * 86_400_000);
}
