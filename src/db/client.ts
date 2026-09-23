import pg from "pg";

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Db = Pick<pg.Pool, "query">;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string, options: { max?: number } = {}): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: options.max ?? 8, connectionTimeoutMillis: 10_000 });
}

/** Runs `fn` in one transaction on one checked-out connection; rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serializes whole runs (extract, dream) across processes. A second run with
 * the same key fails fast instead of racing writes or double-spending LLM calls.
 */
export async function withRunLock<T>(pool: pg.Pool, key: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [key]);
    if (!res.rows[0]?.ok) throw new Error(`another ${key} run is in progress; retry after it finishes`);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export async function waitForDatabase(databaseUrl: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const pool = createPool(databaseUrl, { max: 1 });
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  throw new Error(`Postgres is not reachable at ${redactUrl(databaseUrl)}: ${errorMessage(last)}`);
}

/** The connection string without its password, for messages and logs. */
export function redactUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(invalid database URL)";
  }
}

/** A double-quoted SQL identifier, for the few statements that cannot take parameters. */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`invalid SQL identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** A single-quoted SQL string literal, for DDL that cannot take parameters. */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

/** pg returns timestamptz as Date; rows that crossed JSON carry ISO strings. */
export function toDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp ${value}`);
  return new Date(ms);
}

export function toDateOrNull(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collects query parameters while SQL is assembled; `add` returns the placeholder. */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
