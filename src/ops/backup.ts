import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Config } from "../config/config.js";
import { CONTAINER } from "./docker.js";

const KEEP_BACKUPS = 14;
const PREFIX = "morfeu-";
const SUFFIX = ".dump";

/**
 * Writes a pg_dump (custom format, restorable with pg_restore) of the whole
 * database to the backup directory, readable only by the user, then keeps the
 * newest KEEP_BACKUPS files. The managed container dumps from inside Docker;
 * a user-provided Postgres needs pg_dump on the PATH.
 */
export async function backupDatabase(
  config: Config,
  now: Date,
): Promise<{ path: string; bytes: number; pruned: number }> {
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const path = join(config.backupDir, `${PREFIX}${now.toISOString().replace(/[:.]/g, "-")}${SUFFIX}`);
  const url = new URL(config.databaseUrl);
  const [command, args] =
    config.managedDb === "docker"
      ? [
          "docker",
          ["exec", CONTAINER, "pg_dump", "-U", decodeURIComponent(url.username), "-d", url.pathname.slice(1), "-Fc"],
        ]
      : ["pg_dump", ["--dbname", config.databaseUrl, "-Fc"]];
  const out = createWriteStream(path, { mode: 0o600 });
  try {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.pipe(out);
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on("error", (err) => reject(new Error(`${command} is not available: ${err.message}`)));
      child.on("close", resolve);
    });
    // Both must finish: the dump process, and every byte reaching the disk.
    const [code] = await Promise.all([exit, finished(out)]);
    if (code !== 0) throw new Error(`backup failed (${command} exited with ${code}): ${stderr.trim()}`);
  } catch (err) {
    out.destroy();
    rmSync(path, { force: true });
    throw err;
  }
  chmodSync(path, 0o600);
  return { path, bytes: statSync(path).size, pruned: pruneBackups(config.backupDir) };
}

/** Deletes the oldest morfeu dumps beyond KEEP_BACKUPS. Other files in the directory are left alone. */
export function pruneBackups(dir: string, keep = KEEP_BACKUPS): number {
  const dumps = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort()
    .reverse();
  for (const old of dumps.slice(keep)) rmSync(join(dir, old));
  return Math.max(0, dumps.length - keep);
}
