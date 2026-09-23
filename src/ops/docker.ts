import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Config } from "../config/config.js";
import { packageRoot } from "../config/paths.js";

export const CONTAINER = "morfeu-db";

/** The compose file's variables, derived from the database URL so container and client always agree. */
function composeEnv(config: Config): NodeJS.ProcessEnv {
  const url = new URL(config.databaseUrl);
  return {
    ...process.env,
    MORFEU_PG_PORT: url.port || "5432",
    MORFEU_PG_USER: decodeURIComponent(url.username),
    MORFEU_PG_PASSWORD: decodeURIComponent(url.password),
    MORFEU_PG_DATABASE: url.pathname.slice(1),
  };
}

export type CommandResult = { ok: boolean; output: string };

function compose(config: Config, args: string[]): CommandResult {
  const r = spawnSync("docker", ["compose", "-f", join(packageRoot(), "docker-compose.yml"), ...args], {
    env: composeEnv(config),
    encoding: "utf8",
  });
  if (r.error) return { ok: false, output: `docker is not available: ${r.error.message}` };
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Starts the managed Postgres container and waits until it is healthy. */
export function startDatabase(config: Config): CommandResult {
  return compose(config, ["up", "-d", "--wait"]);
}

/** Stops the container. The data volume is kept. */
export function stopDatabase(config: Config): CommandResult {
  return compose(config, ["stop"]);
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export function containerRunning(): boolean {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}
