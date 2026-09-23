import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageRoot } from "../config/paths.js";
import { extractTomlTable, parseTomlStdio, removeTomlTablesPrefixed, tomlString, upsertTomlTable } from "./toml.js";

export const CLIENTS = ["claude-code", "claude-desktop", "codex"] as const;
export type ClientName = (typeof CLIENTS)[number];

const NAME = "morfeu";

/** Everything connecting touches, injectable so tests never edit real config files. */
export type ConnectEnv = {
  home: string;
  platform: NodeJS.Platform;
  appData: string | undefined;
  /** Absolute node binary: GUI apps do not inherit the shell's PATH. */
  nodePath: string;
  cliPath: string;
  which(bin: string): string | null;
  run(command: string, args: string[]): { status: number };
};

export function defaultConnectEnv(home: string): ConnectEnv {
  return {
    home,
    platform: process.platform,
    appData: process.env.APPDATA,
    nodePath: process.execPath,
    cliPath: join(packageRoot(), "dist", "cli.js"),
    which(bin) {
      const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
      return r.status === 0 ? (r.stdout.split(/\r?\n/)[0]?.trim() ?? null) || null : null;
    },
    run(command, args) {
      return { status: spawnSync(command, args, { stdio: "ignore" }).status ?? 1 };
    },
  };
}

type ServerEntry = { command: string; args: string[] };

/** How every client starts morfeu: `node <package>/dist/cli.js mcp`. */
function serverEntry(env: ConnectEnv): ServerEntry {
  return { command: env.nodePath, args: [env.cliPath, "mcp"] };
}

export type ConnectResult = { client: ClientName; status: "connected" | "unchanged" | "conflict"; detail: string };

export function connectClient(
  client: ClientName,
  env: ConnectEnv,
  options: { force?: boolean; hook?: boolean } = {},
): ConnectResult {
  const desired = serverEntry(env);
  const current = readEntry(client, env);
  if (current && sameEntry(current, desired)) {
    if (client === "claude-code" && options.hook) installHook(env);
    return { client, status: "unchanged", detail: `${client} already starts morfeu` };
  }
  if (current && !options.force) {
    return {
      client,
      status: "conflict",
      detail: `${client} has a different "morfeu" server entry; pass --force to replace it`,
    };
  }
  writeEntry(client, env, desired, Boolean(current));
  if (client === "claude-code" && options.hook) installHook(env);
  const restart = client === "claude-code" ? "start a new session" : `restart ${client}`;
  return { client, status: "connected", detail: `${client} now starts morfeu; ${restart} to load it` };
}

export function disconnectClient(client: ClientName, env: ConnectEnv): { removed: boolean } {
  const had = readEntry(client, env) !== null;
  if (client === "claude-code") {
    const bin = env.which("claude");
    if (bin) env.run(bin, ["mcp", "remove", "-s", "user", NAME]);
    removeJsonEntry(join(env.home, ".claude.json"));
    removeHook(env);
  } else if (client === "claude-desktop") {
    removeJsonEntry(claudeDesktopConfig(env));
  } else {
    const bin = env.which("codex");
    if (bin) env.run(bin, ["mcp", "remove", NAME]);
    const path = codexConfig(env);
    if (existsSync(path))
      writeFileSync(path, removeTomlTablesPrefixed(readFileSync(path, "utf8"), `mcp_servers.${NAME}`));
  }
  return { removed: had };
}

/** Clients that look installed on this machine. */
export function detectClients(env: ConnectEnv): ClientName[] {
  return CLIENTS.filter((client) => {
    if (client === "claude-code") return env.which("claude") !== null || existsSync(join(env.home, ".claude"));
    if (client === "claude-desktop") return existsSync(dirname(claudeDesktopConfig(env)));
    return env.which("codex") !== null || existsSync(dirname(codexConfig(env)));
  });
}

/** For each client: starts this install ("this"), another morfeu ("other"), or nothing (false). */
export function connectedClients(env: ConnectEnv): Record<ClientName, "this" | "other" | false> {
  const desired = serverEntry(env);
  return Object.fromEntries(
    CLIENTS.map((c) => {
      const entry = readEntry(c, env);
      return [c, entry === null ? false : sameEntry(entry, desired) ? "this" : "other"];
    }),
  ) as Record<ClientName, "this" | "other" | false>;
}

function claudeDesktopConfig(env: ConnectEnv): string {
  if (env.platform === "darwin")
    return join(env.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (env.platform === "win32")
    return join(env.appData ?? join(env.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(env.home, ".config", "Claude", "claude_desktop_config.json");
}

function codexConfig(env: ConnectEnv): string {
  return join(env.home, ".codex", "config.toml");
}

function readEntry(client: ClientName, env: ConnectEnv): Partial<ServerEntry> | null {
  if (client === "claude-code") return readJsonEntry(join(env.home, ".claude.json"));
  if (client === "claude-desktop") return readJsonEntry(claudeDesktopConfig(env));
  const path = codexConfig(env);
  if (!existsSync(path)) return null;
  const table = extractTomlTable(readFileSync(path, "utf8"), `mcp_servers.${NAME}`);
  return table ? parseTomlStdio(table.body) : null;
}

/** Prefer the client's own CLI, which knows its config format; edit the file only as a fallback. */
function writeEntry(client: ClientName, env: ConnectEnv, entry: ServerEntry, replacing: boolean): void {
  if (client === "claude-code") {
    const bin = env.which("claude");
    if (bin) {
      if (replacing) env.run(bin, ["mcp", "remove", "-s", "user", NAME]);
      const added = env.run(bin, ["mcp", "add", "-s", "user", NAME, "--", entry.command, ...entry.args]);
      if (added.status === 0 && sameEntry(readEntry(client, env), entry)) return;
    }
    writeJsonEntry(join(env.home, ".claude.json"), entry);
  } else if (client === "claude-desktop") {
    writeJsonEntry(claudeDesktopConfig(env), entry);
  } else {
    const bin = env.which("codex");
    if (bin) {
      if (replacing) env.run(bin, ["mcp", "remove", NAME]);
      const added = env.run(bin, ["mcp", "add", NAME, "--", entry.command, ...entry.args]);
      if (added.status === 0 && sameEntry(readEntry(client, env), entry)) return;
    }
    const path = codexConfig(env);
    const body = `command = ${tomlString(entry.command)}\nargs = [${entry.args.map(tomlString).join(", ")}]`;
    mkdirSync(dirname(path), { recursive: true });
    const next = upsertTomlTable(existsSync(path) ? readFileSync(path, "utf8") : "", `mcp_servers.${NAME}`, body);
    writeFileSync(path, next.endsWith("\n") ? next : `${next}\n`);
  }
}

function sameEntry(a: Partial<ServerEntry> | null, b: ServerEntry): boolean {
  return Boolean(a) && a?.command === b.command && JSON.stringify(a?.args ?? []) === JSON.stringify(b.args);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Writes JSON after keeping one backup of the previous file next to it. */
function writeJson(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.morfeu.bak`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function readJsonEntry(path: string): Partial<ServerEntry> | null {
  const servers = readJson(path)?.mcpServers as Record<string, unknown> | undefined;
  const entry = servers?.[NAME];
  return entry && typeof entry === "object" ? (entry as Partial<ServerEntry>) : null;
}

function writeJsonEntry(path: string, entry: ServerEntry): void {
  const doc = readJson(path) ?? {};
  doc.mcpServers = { ...((doc.mcpServers as Record<string, unknown>) ?? {}), [NAME]: entry };
  writeJson(path, doc);
}

function removeJsonEntry(path: string): void {
  const doc = readJson(path);
  const servers = doc?.mcpServers as Record<string, unknown> | undefined;
  if (!doc || !servers || !(NAME in servers)) return;
  delete servers[NAME];
  writeJson(path, doc);
}

// Claude Code's SessionStart hook runs `morfeu hook session-start` and injects
// its output as context before the first prompt. Opt-in with --hook.
const HOOK_MARKER = "hook session-start";

function installHook(env: ConnectEnv): void {
  const path = join(env.home, ".claude", "settings.json");
  const settings = readJson(path) ?? {};
  const hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}) };
  const sessionStart = (Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []).filter((e) => !isOurHook(e));
  const command = [env.nodePath, env.cliPath, "hook", "session-start"].map(shellQuote).join(" ");
  sessionStart.push({ matcher: "startup|clear", hooks: [{ type: "command", command, timeout: 5 }] });
  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;
  writeJson(path, settings);
}

function removeHook(env: ConnectEnv): void {
  const path = join(env.home, ".claude", "settings.json");
  const settings = readJson(path);
  const hooks = settings?.hooks as Record<string, unknown> | undefined;
  if (!settings || !hooks || !Array.isArray(hooks.SessionStart)) return;
  const kept = hooks.SessionStart.filter((e) => !isOurHook(e));
  if (kept.length === hooks.SessionStart.length) return;
  hooks.SessionStart = kept;
  writeJson(path, settings);
}

export function hookInstalled(env: ConnectEnv): boolean {
  const hooks = readJson(join(env.home, ".claude", "settings.json"))?.hooks as Record<string, unknown> | undefined;
  return Array.isArray(hooks?.SessionStart) && hooks.SessionStart.some(isOurHook);
}

function isOurHook(entry: unknown): boolean {
  const list = (entry as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(list) && list.some((h) => String((h as { command?: unknown })?.command ?? "").includes(HOOK_MARKER))
  );
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
