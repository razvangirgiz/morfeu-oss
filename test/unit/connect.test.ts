import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ConnectEnv,
  connectClient,
  connectedClients,
  disconnectClient,
  hookInstalled,
} from "../../src/ops/connect.js";

function env(overrides: Partial<ConnectEnv> = {}): ConnectEnv {
  const home = mkdtempSync(join(tmpdir(), "morfeu-home-"));
  return {
    home,
    platform: "linux",
    appData: undefined,
    nodePath: "/usr/bin/node",
    cliPath: "/opt/morfeu/dist/cli.js",
    which: () => null,
    run: () => ({ status: 1 }),
    ...overrides,
  };
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("connect", () => {
  it("writes Claude Code's config without its CLI, keeping other servers", () => {
    const e = env();
    writeFileSync(
      join(e.home, ".claude.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }),
    );
    expect(connectClient("claude-code", e).status).toBe("connected");
    const doc = read(join(e.home, ".claude.json"));
    expect(doc.mcpServers.morfeu).toEqual({ command: "/usr/bin/node", args: ["/opt/morfeu/dist/cli.js", "mcp"] });
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.theme).toBe("dark");
    expect(connectClient("claude-code", e).status).toBe("unchanged");
  });

  it("refuses to overwrite a different entry without force", () => {
    const e = env();
    writeFileSync(join(e.home, ".claude.json"), JSON.stringify({ mcpServers: { morfeu: { command: "old" } } }));
    expect(connectClient("claude-code", e).status).toBe("conflict");
    expect(connectClient("claude-code", e, { force: true }).status).toBe("connected");
  });

  it("installs and removes the SessionStart hook next to the user's own hooks", () => {
    const e = env();
    mkdirSync(join(e.home, ".claude"));
    const mine = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    writeFileSync(join(e.home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [mine] } }));
    connectClient("claude-code", e, { hook: true });
    expect(hookInstalled(e)).toBe(true);
    const hooks = read(join(e.home, ".claude", "settings.json")).hooks.SessionStart;
    expect(hooks).toHaveLength(2);
    expect(hooks[1].hooks[0].command).toBe("/usr/bin/node /opt/morfeu/dist/cli.js hook session-start");
    disconnectClient("claude-code", e);
    expect(read(join(e.home, ".claude", "settings.json")).hooks.SessionStart).toEqual([mine]);
  });

  it("writes Claude Desktop's config at the platform's path", () => {
    const e = env({ platform: "darwin" });
    connectClient("claude-desktop", e);
    const path = join(e.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    expect(read(path).mcpServers.morfeu.args).toEqual(["/opt/morfeu/dist/cli.js", "mcp"]);
  });

  it("adds and removes one table in Codex's TOML, leaving the rest", () => {
    const e = env();
    mkdirSync(join(e.home, ".codex"));
    const path = join(e.home, ".codex", "config.toml");
    writeFileSync(path, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
    connectClient("codex", e);
    expect(readFileSync(path, "utf8")).toContain(
      '[mcp_servers.morfeu]\ncommand = "/usr/bin/node"\nargs = ["/opt/morfeu/dist/cli.js", "mcp"]',
    );
    expect(connectedClients(e).codex).toBe("this");
    disconnectClient("codex", e);
    expect(readFileSync(path, "utf8")).toBe('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  });

  it("prefers the client's own CLI when it is installed", () => {
    const calls: string[][] = [];
    const e = env({
      which: (bin) => (bin === "claude" ? "/bin/claude" : null),
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 1 };
      },
    });
    connectClient("claude-code", e);
    expect(calls[0]).toEqual([
      "/bin/claude",
      "mcp",
      "add",
      "-s",
      "user",
      "morfeu",
      "--",
      "/usr/bin/node",
      "/opt/morfeu/dist/cli.js",
      "mcp",
    ]);
    // The CLI failed here, so the file was written directly.
    expect(connectedClients(e)["claude-code"]).toBe("this");
  });
});
