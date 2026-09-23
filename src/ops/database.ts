import type { App } from "../app.js";
import { waitForDatabase } from "../db/client.js";
import { applyLanguage } from "../db/language.js";
import { migrate } from "../db/migrate.js";
import { containerRunning, startDatabase } from "./docker.js";

export type PrepareResult = { started: boolean; applied: string[]; languageChanged: boolean };

/**
 * Makes the database ready for use: starts the managed container if needed,
 * applies migrations and points keyword search at the configured language.
 * Safe to run any number of times.
 */
export async function prepareDatabase(app: App): Promise<PrepareResult> {
  let started = false;
  if (app.config.managedDb === "docker" && !containerRunning()) {
    const up = startDatabase(app.config);
    if (!up.ok) throw new Error(`could not start the morfeu database container:\n${up.output}`);
    started = true;
  }
  await waitForDatabase(app.config.databaseUrl, started ? 120_000 : 15_000);
  const { applied } = await migrate(app.pool);
  const { changed } = await applyLanguage(app.pool, app.config.language);
  return { started, applied, languageChanged: changed };
}
