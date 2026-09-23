import { homedir } from "node:os";
import { createApp } from "../../app.js";
import { waitForDatabase } from "../../db/client.js";
import { serveStdio } from "../../mcp/server.js";
import { formatStats, getStats } from "../../memory/stats.js";
import { backupDatabase } from "../../ops/backup.js";
import { CLIENTS, type ClientName, connectClient, defaultConnectEnv, disconnectClient } from "../../ops/connect.js";
import { prepareDatabase } from "../../ops/database.js";
import { runDemo } from "../../ops/demo.js";
import { containerRunning, startDatabase, stopDatabase } from "../../ops/docker.js";
import { diagnose, formatChecks } from "../../ops/doctor.js";
import { sessionStartContext } from "../../ops/hook.js";
import { cronLine, installSchedule, removeSchedule, scheduleFiles } from "../../ops/schedule.js";
import { VERSION } from "../../version.js";
import { type Command, type CommandGroup, JSON_OPTION, print, requireArg, withApp } from "../command.js";
import { setupCommand } from "./setup.js";

const initCommand: Command = {
  name: "init",
  summary: "Start the managed database if needed, apply migrations and the search language",
  usage: "init",
  async run(ctx) {
    const r = await withApp(ctx, (app) => prepareDatabase(app));
    ctx.out(
      [
        r.started ? "started the morfeu-db container" : "",
        r.applied.length ? `applied ${r.applied.join(", ")}` : "schema up to date",
        r.languageChanged ? `keyword search now uses ${ctx.config.language}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return 0;
  },
};

const dbCommand: Command = {
  name: "db",
  summary: "Start or stop the managed Postgres container (data is kept)",
  usage: "db up|down",
  async run(ctx) {
    const action = requireArg(ctx, 0, "up|down");
    if (ctx.config.managedDb !== "docker")
      throw new Error("the database is not managed by morfeu (MORFEU_MANAGED_DB=off)");
    const r = action === "up" ? startDatabase(ctx.config) : action === "down" ? stopDatabase(ctx.config) : null;
    if (!r) throw new Error("use `morfeu db up` or `morfeu db down`");
    ctx.out(r.ok ? `database ${action}` : r.output);
    return r.ok ? 0 : 1;
  },
};

const doctorCommand: Command = {
  name: "doctor",
  summary: "Check that everything morfeu needs works; --probe also calls the providers",
  usage: "doctor [--probe] [--json]",
  options: { ...JSON_OPTION, probe: { type: "boolean" } },
  async run(ctx) {
    const checks = await withApp(ctx, (app) =>
      diagnose(app, { probe: Boolean(ctx.values.probe), cliPath: defaultConnectEnv(homedir()).cliPath }),
    );
    print(ctx, checks, () => formatChecks(checks));
    return checks.some((c) => c.status === "fail") ? 1 : 0;
  },
};

const statsCommand: Command = {
  name: "stats",
  summary: "Counts, vector coverage and the last runs",
  usage: "stats [--json]",
  options: JSON_OPTION,
  async run(ctx) {
    const stats = await withApp(ctx, (app) => getStats(app));
    print(ctx, stats, () => formatStats(stats));
    return 0;
  },
};

function clientArg(value: string): ClientName {
  if (!(CLIENTS as readonly string[]).includes(value))
    throw new Error(`unknown client ${value}; use ${CLIENTS.join(", ")}`);
  return value as ClientName;
}

const connectCommand: Command = {
  name: "connect",
  summary: `Register morfeu as an MCP server in a client (${CLIENTS.join(", ")})`,
  usage: "connect <client> [--hook] [--force]",
  options: { hook: { type: "boolean" }, force: { type: "boolean" } },
  async run(ctx) {
    const result = connectClient(clientArg(requireArg(ctx, 0, "client")), defaultConnectEnv(homedir()), {
      hook: Boolean(ctx.values.hook),
      force: Boolean(ctx.values.force),
    });
    ctx.out(result.detail);
    return result.status === "conflict" ? 1 : 0;
  },
};

const disconnectCommand: Command = {
  name: "disconnect",
  summary: "Remove morfeu from a client",
  usage: "disconnect <client>",
  async run(ctx) {
    const client = clientArg(requireArg(ctx, 0, "client"));
    const { removed } = disconnectClient(client, defaultConnectEnv(homedir()));
    ctx.out(removed ? `${client} no longer starts morfeu` : `${client} was not connected`);
    return 0;
  },
};

const scheduleCommand: Command = {
  name: "schedule",
  summary: "Install, remove or show the daily `morfeu run` (launchd on macOS, systemd on Linux)",
  usage: "schedule install|remove|show",
  async run(ctx) {
    const env = defaultConnectEnv(homedir());
    const s = { platform: process.platform, nodePath: env.nodePath, cliPath: env.cliPath };
    const action = requireArg(ctx, 0, "install|remove|show");
    if (action === "install") ctx.out(installSchedule(s).detail);
    else if (action === "remove") ctx.out(removeSchedule(s).detail);
    else if (action === "show") {
      const files = scheduleFiles(s);
      ctx.out(files.length ? files.map((f) => `# ${f.path}\n${f.content}`).join("\n") : cronLine(s));
    } else throw new Error("use install, remove or show");
    return 0;
  },
};

const backupCommand: Command = {
  name: "backup",
  summary: "Write a pg_dump of the database to the backup directory",
  usage: "backup",
  async run(ctx) {
    const r = await backupDatabase(ctx.config, ctx.now());
    ctx.out(
      `wrote ${r.path} (${Math.round(r.bytes / 1024)} KiB)${r.pruned ? `, removed ${r.pruned} old backups` : ""}`,
    );
    return 0;
  },
};

const hookCommand: Command = {
  name: "hook",
  summary: "Claude Code SessionStart hook (installed by `connect claude-code --hook`)",
  usage: "hook session-start",
  async run(ctx) {
    if (ctx.args[0] !== "session-start") throw new Error("use `morfeu hook session-start`");
    // A hook must never break a session: any failure prints nothing and exits 0.
    try {
      const stdin = await ctx.stdin();
      const text = await withApp(ctx, (app) => sessionStartContext(app, stdin, ctx.now(), process.cwd()));
      if (text) ctx.out(text);
    } catch {
      // intentionally silent
    }
    return 0;
  },
};

const mcpCommand: Command = {
  name: "mcp",
  summary: "Serve the MCP tools over stdio (what connected clients run)",
  usage: "mcp",
  async run(ctx) {
    const app = createApp({ config: ctx.config });
    await serveStdio(app);
    // The transport keeps the process alive; the pool closes with it.
    return new Promise<number>(() => {});
  },
};

const demoCommand: Command = {
  name: "demo",
  summary: "A two-minute tour on a throwaway database, no API key needed",
  usage: "demo",
  async run(ctx) {
    if (ctx.config.managedDb === "docker" && !containerRunning()) {
      const up = startDatabase(ctx.config);
      if (!up.ok) throw new Error(`the demo needs Postgres; could not start the morfeu-db container:\n${up.output}`);
    }
    await waitForDatabase(ctx.config.databaseUrl);
    await runDemo(ctx.config, ctx.out);
    return 0;
  },
};

const versionCommand: Command = {
  name: "version",
  summary: "Print the version",
  usage: "version",
  async run(ctx) {
    ctx.out(VERSION);
    return 0;
  },
};

export const adminCommands: CommandGroup = {
  title: "Setup and maintenance",
  commands: [
    setupCommand,
    demoCommand,
    initCommand,
    doctorCommand,
    statsCommand,
    connectCommand,
    disconnectCommand,
    scheduleCommand,
    backupCommand,
    dbCommand,
    mcpCommand,
    hookCommand,
    versionCommand,
  ],
};
