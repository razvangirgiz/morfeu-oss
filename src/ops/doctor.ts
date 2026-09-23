import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { App } from "../app.js";
import { errorMessage, redactUrl } from "../db/client.js";
import { loadMigrations } from "../db/migrate.js";
import { connectedClients, defaultConnectEnv } from "./connect.js";
import { containerRunning, dockerAvailable } from "./docker.js";
import { scheduleInstalled } from "./schedule.js";

type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

/**
 * Checks that morfeu can work on this machine and says what to do when it
 * cannot. With `probe`, it also makes one small call to each provider. The
 * report never contains memory content, keys or passwords.
 */
export async function diagnose(app: App, options: { probe?: boolean; cliPath: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const { config } = app;

  const major = Number(process.versions.node.split(".")[0]);
  add(
    "node",
    major >= 22 ? "ok" : "fail",
    `Node ${process.versions.node}${major >= 22 ? "" : "; morfeu needs Node 22 or newer"}`,
  );
  add(
    "config",
    existsSync(config.configFile) ? "ok" : "warn",
    existsSync(config.configFile) ? config.configFile : `${config.configFile} does not exist yet; run \`morfeu setup\``,
  );

  if (config.managedDb === "docker") {
    if (!dockerAvailable())
      add("docker", "fail", "Docker is not running; start Docker, or set MORFEU_DATABASE_URL to your own Postgres");
    else
      add(
        "docker",
        containerRunning() ? "ok" : "warn",
        containerRunning() ? "morfeu-db is running" : "morfeu-db is stopped; `morfeu init` starts it",
      );
  }

  let dbOk = false;
  try {
    const applied = await app.pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    const latest = loadMigrations().at(-1)?.version;
    const current = applied.rows.at(-1)?.version;
    dbOk = current === latest;
    add(
      "database",
      dbOk ? "ok" : "fail",
      dbOk
        ? `${redactUrl(config.databaseUrl)} (schema ${current})`
        : `schema ${current ?? "missing"}, expected ${latest}; run \`morfeu init\``,
    );
  } catch (err) {
    add("database", "fail", `cannot use ${redactUrl(config.databaseUrl)}: ${errorMessage(err)}; run \`morfeu init\``);
  }

  if (dbOk) {
    const lang = await app.pool.query<{ value: string }>("SELECT value FROM settings WHERE key = 'fts_language'");
    const applied = lang.rows[0]?.value ?? "simple";
    add(
      "language",
      applied === config.language ? "ok" : "warn",
      applied === config.language
        ? config.language
        : `index uses ${applied}, config says ${config.language}; run \`morfeu init\``,
    );
    const missing = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memories m WHERE m.status IN ('active', 'candidate')
       AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = $1)`,
      [app.embedder.model],
    );
    const n = missing.rows[0]?.n ?? 0;
    if (config.embedding.provider !== "none")
      add(
        "vectors",
        n === 0 ? "ok" : "warn",
        n === 0
          ? `all memories indexed with ${app.embedder.model}`
          : `${n} memories without a vector; run \`morfeu reindex\``,
      );
  }

  add("llm", config.llm.provider === "none" ? "warn" : "ok", describeLlm(app));
  add("embeddings", config.embedding.provider === "none" ? "warn" : "ok", describeEmbeddings(app));
  if (options.probe) {
    try {
      await app.embedder.embed(["morfeu doctor"]);
      add("embeddings probe", "ok", "the embedder answered");
    } catch (err) {
      add("embeddings probe", "fail", errorMessage(err));
    }
    try {
      await app.llm.inner.complete({
        system: 'Answer with the JSON object {"ok": true}.',
        user: "ping",
        schemaName: "probe",
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      });
      add("llm probe", "ok", "the LLM answered with structured output");
    } catch (err) {
      add("llm probe", "fail", errorMessage(err));
    }
  }

  const env = defaultConnectEnv(homedir());
  env.cliPath = options.cliPath;
  const clients = Object.entries(connectedClients(env));
  const here = clients.filter(([, state]) => state === "this").map(([name]) => name);
  const elsewhere = clients.filter(([, state]) => state === "other").map(([name]) => name);
  add(
    "clients",
    here.length ? "ok" : "warn",
    [
      here.length ? `connected: ${here.join(", ")}` : "no MCP client starts this morfeu; run `morfeu connect <client>`",
      elsewhere.length
        ? `; ${elsewhere.join(", ")} start a different morfeu (\`morfeu connect <client> --force\` to switch)`
        : "",
    ].join(""),
  );
  const scheduled = scheduleInstalled({
    platform: process.platform,
    nodePath: process.execPath,
    cliPath: options.cliPath,
  });
  add(
    "schedule",
    scheduled ? "ok" : "warn",
    scheduled ? "daily run installed" : "no daily run; run `morfeu schedule install`, or run `morfeu run` yourself",
  );
  return checks;
}

function describeLlm(app: App): string {
  const { provider, model, baseUrl, apiKey } = app.config.llm;
  if (provider === "none") return "no LLM: explicit saves and search work, extraction and consolidation do not";
  if (provider === "fake") return "fake LLM (tests only)";
  const where = baseUrl ? ` at ${baseUrl}` : "";
  const key = apiKey || baseUrl ? "" : "; no API key set";
  return `${model}${where}${key}`;
}

function describeEmbeddings(app: App): string {
  const { provider, model, baseUrl } = app.config.embedding;
  if (provider === "none") return "no embeddings: search uses keywords and entities only";
  return `${provider} ${model}${baseUrl ? ` at ${baseUrl}` : ""}`;
}

export function formatChecks(checks: readonly Check[]): string {
  const mark: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  return checks.map((c) => `${mark[c.status]} ${c.name.padEnd(17)} ${c.detail}`).join("\n");
}
