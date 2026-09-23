import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";
import { loadConfig } from "../../src/config/config.js";

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (t) => out.push(t), err: (t) => err.push(t), config: loadConfig({}) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  it("prints help with every command group", async () => {
    const r = await run("help");
    expect(r.code).toBe(0);
    for (const word of ["Memory:", "Background work:", "Setup and maintenance:", "search", "setup", "doctor"]) {
      expect(r.out).toContain(word);
    }
  });

  it("prints a command's usage", async () => {
    const r = await run("help", "search");
    expect(r.out).toContain("Usage: morfeu search <query>");
    expect((await run("search", "--help")).out).toContain("Usage: morfeu search");
  });

  it("rejects unknown commands and unknown flags with exit code 2", async () => {
    expect((await run("serach")).code).toBe(2);
    const r = await run("search", "tea", "--scopes", "user:me");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Unknown option '--scopes'/);
  });

  it("reports command errors with exit code 1", async () => {
    const r = await run("save", "Alex likes tea");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--type is required/);
  });
});
