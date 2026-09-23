import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createMcpServer, TOOLS } from "../../src/mcp/server.js";
import { days, useTestApp } from "../support/app.js";

const app = useTestApp();
let clock = days(0);
let client: Client;

beforeEach(async () => {
  clock = days(0);
  const server = createMcpServer(app, () => clock);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
}

describe("MCP server", () => {
  it("lists every tool with a schema and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toBeDefined();
    }
    expect(client.getInstructions()).toContain("morfeu_context");
  });

  it("saves, finds, corrects and forgets through the tools", async () => {
    const saved = (
      await call("morfeu_save", { content: "Alex prefers dark mode", type: "preference", scope: "user:me" })
    ).json();
    expect(saved.deduplicated).toBe(false);
    clock = days(1);
    const found = (await call("morfeu_search", { query: "dark mode", scopes: ["user:me"] })).json();
    expect(found.hits[0]).toMatchObject({ id: saved.id, scope: "user:alex", type: "preference" });
    const corrected = (
      await call("morfeu_correct", { memory_id: saved.id, content: "Alex prefers light mode" })
    ).json();
    expect(corrected.retracted_id).toBe(saved.id);
    const context = await call("morfeu_context", { task: "set up the editor theme", scopes: ["user:me"] });
    expect(context.text).toContain("Alex prefers light mode");
    expect(context.text).not.toContain("dark mode");
    await call("morfeu_forget", { memory_id: corrected.id, reason: "user asked" });
    expect((await call("morfeu_search", { query: "light mode" })).json().hits).toEqual([]);
  });

  it("returns clear errors for bad arguments instead of failing the connection", async () => {
    const missing = await call("morfeu_save", { content: "x", type: "preference" });
    expect(missing).toMatchObject({ isError: true, text: "scope is required and must be a non-empty string" });
    const badType = await call("morfeu_save", { content: "x", type: "mood", scope: "user:me" });
    expect(badType.text).toMatch(/type must be one of/);
    const badScope = await call("morfeu_search", { query: "x", scopes: ["team:core"] });
    expect(badScope.text).toMatch(/invalid scope type/);
    const unknown = await call("morfeu_nope", {});
    expect(unknown).toMatchObject({ isError: true, text: "unknown tool morfeu_nope" });
  });

  it("pins, logs events and reports stats", async () => {
    const saved = (
      await call("morfeu_save", { content: "Alex's timezone is Europe/Lisbon", type: "fact", scope: "user:me" })
    ).json();
    const pinned = (await call("morfeu_pin", { action: "pin", memory_id: saved.id })).json();
    expect(pinned.pinned.map((m: { id: string }) => m.id)).toEqual([saved.id]);
    const logged = (
      await call("morfeu_log_event", { content_text: "Standup moved to 10:00", project: "Acme-API" })
    ).json();
    expect(logged.event_id).toMatch(/^[0-9a-f-]{36}$/);
    const stats = (await call("morfeu_stats", {})).json();
    expect(stats.events.unprocessed).toBe(1);
    expect(stats.pinned).toBe(1);
  });

  it("answers about the past with as_of and lists changes", async () => {
    const old = (await call("morfeu_save", { content: "Alex uses Vim", type: "preference", scope: "user:me" })).json();
    clock = days(10);
    await call("morfeu_save", { content: "Alex uses Helix", type: "preference", scope: "user:me", supersedes: old.id });
    clock = days(11);
    const past = (await call("morfeu_search", { query: "editor alex uses", as_of: days(5).toISOString() })).json();
    expect(past.hits.map((h: { content: string }) => h.content)).toContain("Alex uses Vim");
    expect(past.hits.map((h: { content: string }) => h.content)).not.toContain("Alex uses Helix");
    const changes = (await call("morfeu_changes", { since: days(5).toISOString() })).json();
    expect(changes.summary).toMatchObject({ changed: 1, new: 1 });
  });
});
