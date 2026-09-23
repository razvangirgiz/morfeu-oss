import { createPool } from "../../src/db/client.js";
import { applyLanguage } from "../../src/db/language.js";
import { migrate } from "../../src/db/migrate.js";
import { adminUrl, reachable, recreateDatabase, startTestContainer, TEMPLATE_DB, urlFor } from "./database.js";

/** Migrates a template database once; each worker clones it. */
export default async function setup(): Promise<void> {
  if (!(await reachable(adminUrl()))) {
    if (process.env.CI) throw new Error(`test database not reachable at ${adminUrl()}`);
    startTestContainer();
  }
  await recreateDatabase(TEMPLATE_DB);
  const pool = createPool(urlFor(TEMPLATE_DB), { max: 1 });
  try {
    await migrate(pool);
    await applyLanguage(pool, "english");
  } finally {
    await pool.end();
  }
}
