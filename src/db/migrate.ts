import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../config/paths.js";
import { type Pool, withTx } from "./client.js";

export type Migration = { version: string; sql: string; checksum: string };

/**
 * Migrations are forward-only, numbered SQL files. Each runs in its own
 * transaction under a database-wide lock, and its checksum is recorded so an
 * edited migration is caught instead of silently diverging.
 */
export function loadMigrations(dir = join(packageRoot(), "migrations")): Migration[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return { version: file.replace(/\.sql$/, ""), sql, checksum: sha256(sql) };
    });
}

export type MigrateResult = { applied: string[]; current: string | null };

export async function migrate(pool: Pool, dir?: string): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);
  return withTx(pool, async (client) => {
    // Taken before reading the applied list, so concurrent starts queue up
    // instead of both trying to apply the same version.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('morfeu-migrate'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const rows = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of rows.rows) {
      const local = known.get(row.version);
      if (!local) {
        throw new Error(
          `the database has migration ${row.version}, which this version of morfeu does not know; upgrade morfeu`,
        );
      }
      if (local.checksum !== row.checksum) {
        throw new Error(`migration ${row.version} changed after it was applied; migrations are append-only`);
      }
    }
    const done = new Set(rows.rows.map((r) => r.version));
    const applied: string[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
      applied.push(m.version);
    }
    return { applied, current: migrations.at(-1)?.version ?? null };
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}
