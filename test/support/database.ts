import { spawnSync } from "node:child_process";
import pg from "pg";

const TEST_URL = process.env.MORFEU_TEST_DATABASE_URL ?? "postgres://morfeu:morfeu@127.0.0.1:5434/morfeu_test";
export const TEMPLATE_DB = "morfeu_test_template";

/** Tests create and drop databases: refuse anything not obviously a test database. */
function assertTestDatabase(name: string): void {
  if (!/^morfeu_test[a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to touch database "${name}": test databases must be named morfeu_test*`);
  }
}

export function urlFor(database: string): string {
  assertTestDatabase(database);
  const url = new URL(TEST_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

export function adminUrl(): string {
  const url = new URL(TEST_URL);
  assertTestDatabase(url.pathname.slice(1));
  return url.toString();
}

export async function reachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function startTestContainer(): void {
  const r = spawnSync("docker", ["compose", "-f", "docker-compose.test.yml", "up", "-d", "--wait"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `the integration tests need Postgres with pgvector at ${TEST_URL}. ` +
        `Start one with \`pnpm db:test:up\` (Docker), or set MORFEU_TEST_DATABASE_URL.\n${r.stderr}`,
    );
  }
}

export async function recreateDatabase(name: string, template?: string): Promise<void> {
  assertTestDatabase(name);
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
  } finally {
    await admin.end();
  }
}
