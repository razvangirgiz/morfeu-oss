import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PlatformDirs = {
  /** Holds config.env. */
  config: string;
  /** Backups and other data worth keeping. */
  data: string;
  /** Logs of scheduled runs. */
  logs: string;
};

/**
 * Where morfeu keeps its files on this machine, following each platform's
 * convention: Application Support on macOS, the XDG base directories elsewhere.
 */
export function platformDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): PlatformDirs {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support", "morfeu");
    return { config: base, data: base, logs: join(home, "Library", "Logs", "morfeu") };
  }
  if (platform === "win32") {
    const base = join(env.APPDATA || join(home, "AppData", "Roaming"), "morfeu");
    return { config: base, data: base, logs: join(base, "logs") };
  }
  return {
    config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "morfeu"),
    data: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "morfeu"),
    logs: join(env.XDG_STATE_HOME || join(home, ".local", "state"), "morfeu"),
  };
}

/** The installed package directory (the one holding migrations/ and docker-compose.yml). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
