import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL, loadConfig, readDotEnv } from "../../src/config/config.js";
import { platformDirs } from "../../src/config/paths.js";
import { writeSettings } from "../../src/config/write.js";
import { settingsFor } from "../../src/ops/setup.js";

describe("loadConfig", () => {
  it("has working defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      databaseUrl: DEFAULT_DATABASE_URL,
      managedDb: "docker",
      userId: "me",
      language: "english",
      llm: { provider: "openai", model: "gpt-5-mini" },
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      maxLlmCalls: 100,
      decay: false,
    });
  });

  it("stops managing the database when a URL is given", () => {
    expect(loadConfig({ MORFEU_DATABASE_URL: "postgres://x@db/y" }).managedDb).toBe("off");
  });

  it("picks provider-specific defaults and shares the OpenAI key", () => {
    const c = loadConfig({ MORFEU_EMBEDDING_PROVIDER: "ollama", OPENAI_API_KEY: "k" });
    expect(c.embedding).toMatchObject({ model: "qwen3-embedding:0.6b", baseUrl: "http://127.0.0.1:11434" });
    expect(c.llm.apiKey).toBe("k");
  });

  it("rejects invalid values with the setting's name", () => {
    expect(() => loadConfig({ MORFEU_LLM_PROVIDER: "claude" })).toThrow(/MORFEU_LLM_PROVIDER must be one of/);
    expect(() => loadConfig({ MORFEU_MAX_LLM_CALLS: "-1" })).toThrow(/MORFEU_MAX_LLM_CALLS/);
    expect(() => loadConfig({ MORFEU_DECAY: "maybe" })).toThrow(/on or off/);
    expect(() => loadConfig({ MORFEU_LANGUAGE: "en-GB" })).toThrow(/text search language/);
  });

  it("reads the config file named by MORFEU_CONFIG_FILE, with the environment winning", () => {
    const dir = mkdtempSync(join(tmpdir(), "morfeu-config-"));
    const file = join(dir, "config.env");
    writeFileSync(file, '# comment\nMORFEU_LANGUAGE=romanian\nMORFEU_USER_ID="alex"\n');
    const c = loadConfig({ MORFEU_CONFIG_FILE: file, MORFEU_USER_ID: "sam" });
    expect(c.language).toBe("romanian");
    expect(c.userId).toBe("sam");
  });

  it("never reads a config file for an explicit environment without MORFEU_CONFIG_FILE", () => {
    expect(loadConfig({ HOME: "/nonexistent" }).language).toBe("english");
  });
});

describe("platformDirs", () => {
  it("follows each platform's convention", () => {
    expect(platformDirs({}, "darwin", "/Users/a").config).toBe("/Users/a/Library/Application Support/morfeu");
    expect(platformDirs({}, "linux", "/home/a")).toEqual({
      config: "/home/a/.config/morfeu",
      data: "/home/a/.local/share/morfeu",
      logs: "/home/a/.local/state/morfeu",
    });
    expect(platformDirs({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/a").config).toBe("/x/morfeu");
  });
});

describe("writeSettings", () => {
  it("updates keys in place, appends new ones, drops emptied ones, and keeps the file private", () => {
    const dir = mkdtempSync(join(tmpdir(), "morfeu-write-"));
    const file = join(dir, "sub", "config.env");
    writeSettings(file, { MORFEU_LANGUAGE: "english", MORFEU_LLM_API_KEY: "sk-a" });
    writeFileSync(file, `${readFileSync(file, "utf8")}# mine\nOTHER=1\n`);
    writeSettings(file, { MORFEU_LANGUAGE: "german", MORFEU_LLM_API_KEY: "", MORFEU_USER_ID: "alex smith" });
    expect(readDotEnv(file)).toEqual({ MORFEU_LANGUAGE: "german", OTHER: "1", MORFEU_USER_ID: "alex smith" });
    expect(readFileSync(file, "utf8")).toContain("# mine");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("settingsFor", () => {
  it("maps setup answers to settings and reuses one OpenAI key", () => {
    const s = settingsFor({
      database: { kind: "url", url: "postgres://u:p@h/db" },
      language: "english",
      llm: { kind: "openai", apiKey: "sk-x" },
      embeddings: { kind: "openai" },
    });
    expect(s).toMatchObject({
      MORFEU_MANAGED_DB: "off",
      MORFEU_DATABASE_URL: "postgres://u:p@h/db",
      MORFEU_LLM_PROVIDER: "openai",
      MORFEU_LLM_API_KEY: "sk-x",
      MORFEU_EMBEDDING_API_KEY: "sk-x",
      MORFEU_LLM_BASE_URL: "",
    });
  });

  it("leaves the managed database on its default local URL", () => {
    const s = settingsFor({
      database: { kind: "docker" },
      language: "english",
      llm: { kind: "none" },
      embeddings: { kind: "none" },
    });
    expect(s).toMatchObject({ MORFEU_MANAGED_DB: "docker", MORFEU_DATABASE_URL: "" });
    expect(loadConfig({ MORFEU_MANAGED_DB: "docker", MORFEU_DATABASE_URL: "" }).databaseUrl).toBe(DEFAULT_DATABASE_URL);
  });

  it("configures a local OpenAI-compatible model and Ollama embeddings", () => {
    const s = settingsFor({
      database: { kind: "docker" },
      language: "romanian",
      llm: { kind: "compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" },
      embeddings: { kind: "ollama" },
    });
    expect(s).toMatchObject({
      MORFEU_LANGUAGE: "romanian",
      MORFEU_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      MORFEU_LLM_MODEL: "qwen3:8b",
      MORFEU_EMBEDDING_PROVIDER: "ollama",
    });
  });
});
