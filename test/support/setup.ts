import { workerDatabase } from "./app.js";
import { recreateDatabase, TEMPLATE_DB } from "./database.js";

// Each test file starts from a fresh clone of the migrated template.
await recreateDatabase(workerDatabase(), TEMPLATE_DB);
