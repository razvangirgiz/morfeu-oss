import { homedir } from "node:os";
import { closeApp, createApp } from "../../app.js";
import { loadConfig, readDotEnv } from "../../config/config.js";
import { writeSettings } from "../../config/write.js";
import { CLIENTS, type ClientName, connectClient, defaultConnectEnv, detectClients } from "../../ops/connect.js";
import { prepareDatabase } from "../../ops/database.js";
import { diagnose, formatChecks } from "../../ops/doctor.js";
import { installSchedule } from "../../ops/schedule.js";
import { type SetupAnswers, settingsFor } from "../../ops/setup.js";
import { type Command, type CommandContext, listValue, stringValue } from "../command.js";
import { Prompt } from "../prompt.js";

/**
 * `morfeu setup`: asks a few questions (or takes them as flags), writes the
 * config file, prepares the database, connects MCP clients and installs the
 * daily run. Re-running it is safe and keeps what it can.
 */
export const setupCommand: Command = {
  name: "setup",
  summary: "Configure morfeu, prepare the database and connect your agents",
  usage:
    "setup [--yes] [--database docker|<url>] [--language english] [--llm openai|none|<base-url>] [--llm-model m] " +
    "[--embeddings openai|ollama|none] [--embedding-model m] [--connect claude-code,codex|none] [--hook] [--no-schedule]",
  options: {
    yes: { type: "boolean", short: "y" },
    database: { type: "string" },
    language: { type: "string" },
    user: { type: "string" },
    llm: { type: "string" },
    "llm-model": { type: "string" },
    embeddings: { type: "string" },
    "embedding-model": { type: "string" },
    "embedding-url": { type: "string" },
    connect: { type: "string", multiple: true },
    hook: { type: "boolean" },
    "no-schedule": { type: "boolean" },
  },
  async run(ctx) {
    const interactive = Boolean(process.stdin.isTTY) && !ctx.values.yes;
    const prompt = interactive ? new Prompt() : null;
    try {
      const existing = readDotEnv(ctx.config.configFile);
      const answers = await gatherAnswers(ctx, prompt, existing);
      writeSettings(ctx.config.configFile, settingsFor(answers, existing));
      ctx.out(`wrote ${ctx.config.configFile}`);

      const config = loadConfig({ ...process.env, MORFEU_CONFIG_FILE: ctx.config.configFile });
      const app = createApp({ config });
      try {
        const prepared = await prepareDatabase(app);
        ctx.out(`database ready${prepared.applied.length ? ` (applied ${prepared.applied.join(", ")})` : ""}`);

        const env = defaultConnectEnv(homedir());
        for (const client of await chooseClients(ctx, prompt, detectClients(env))) {
          const result = connectClient(client, env, {
            hook:
              client === "claude-code" &&
              Boolean(
                ctx.values.hook ??
                  (await prompt?.confirm("Load morfeu context automatically when a Claude Code session starts?", true)),
              ),
          });
          ctx.out(result.detail);
        }
        const schedule =
          !ctx.values["no-schedule"] &&
          (prompt ? await prompt.confirm("Run ingestion and consolidation daily at 04:30?", true) : true);
        if (schedule)
          ctx.out(installSchedule({ platform: process.platform, nodePath: env.nodePath, cliPath: env.cliPath }).detail);

        ctx.out(`\n${formatChecks(await diagnose(app, { cliPath: env.cliPath }))}`);
      } finally {
        await closeApp(app);
      }
      return 0;
    } finally {
      prompt?.close();
    }
  },
};

async function gatherAnswers(
  ctx: CommandContext,
  prompt: Prompt | null,
  existing: Record<string, string>,
): Promise<SetupAnswers> {
  const flag = (key: string) => stringValue(ctx.values, key);

  let database = flag("database");
  if (!database && prompt) {
    database = await prompt.choose(
      "Where should morfeu keep its database?",
      [
        { value: "docker", label: "In a Docker container morfeu manages (needs Docker)" },
        { value: "url", label: "In my own Postgres with pgvector (connection URL)" },
      ],
      existing.MORFEU_MANAGED_DB === "off" ? "url" : "docker",
    );
    if (database === "url") database = await prompt.text("Postgres URL", existing.MORFEU_DATABASE_URL ?? "");
  }
  database ??= existing.MORFEU_MANAGED_DB === "off" ? existing.MORFEU_DATABASE_URL : "docker";
  if (!database) throw new Error("--database is required: docker, or a postgres:// URL");

  const language =
    flag("language") ??
    (prompt
      ? await prompt.text(
          "Main language of your conversations (for keyword search)",
          existing.MORFEU_LANGUAGE ?? "english",
        )
      : (existing.MORFEU_LANGUAGE ?? "english"));

  let llmChoice = flag("llm");
  if (!llmChoice && prompt) {
    llmChoice = await prompt.choose(
      "Which model should turn conversations into memories?",
      [
        { value: "openai", label: "OpenAI (API key)" },
        { value: "compatible", label: "A local or other OpenAI-compatible server (Ollama, LM Studio, OpenRouter...)" },
        { value: "none", label: "None: only memories you or your agents save explicitly" },
      ],
      "openai",
    );
    if (llmChoice === "compatible") llmChoice = await prompt.text("Base URL", "http://127.0.0.1:11434/v1");
  }
  llmChoice ??= existing.MORFEU_LLM_PROVIDER === "none" ? "none" : existing.MORFEU_LLM_BASE_URL || "openai";
  let llm: SetupAnswers["llm"];
  if (llmChoice === "none") llm = { kind: "none" };
  else if (llmChoice === "openai") {
    const apiKey =
      process.env.OPENAI_API_KEY ??
      existing.MORFEU_LLM_API_KEY ??
      (prompt ? await prompt.secret("OpenAI API key") : "");
    llm = { kind: "openai", apiKey, model: flag("llm-model") };
  } else {
    const model =
      flag("llm-model") ??
      (prompt
        ? await prompt.text("Model name (must support structured JSON output)", existing.MORFEU_LLM_MODEL ?? "qwen3:8b")
        : existing.MORFEU_LLM_MODEL);
    if (!model) throw new Error("--llm-model is required with an OpenAI-compatible base URL");
    const apiKey =
      existing.MORFEU_LLM_API_KEY || (prompt ? await prompt.secret("API key (leave empty for a local server)") : "");
    llm = { kind: "compatible", baseUrl: llmChoice, model, apiKey };
  }

  let emb = flag("embeddings");
  if (!emb && prompt) {
    emb = await prompt.choose(
      "Which embeddings should power semantic search?",
      [
        { value: "ollama", label: "Ollama on this machine (free, private; `ollama pull qwen3-embedding:0.6b`)" },
        { value: "openai", label: "OpenAI" },
        { value: "none", label: "None: keyword and entity search only" },
      ],
      llm.kind === "openai" ? "openai" : "ollama",
    );
  }
  emb ??= existing.MORFEU_EMBEDDING_PROVIDER || (llm.kind === "openai" ? "openai" : "none");
  const embeddings: SetupAnswers["embeddings"] =
    emb === "ollama"
      ? { kind: "ollama", model: flag("embedding-model"), baseUrl: flag("embedding-url") }
      : emb === "openai"
        ? { kind: "openai", model: flag("embedding-model") }
        : emb === "none"
          ? { kind: "none" }
          : (() => {
              throw new Error("--embeddings must be openai, ollama or none");
            })();

  return {
    database: database === "docker" ? { kind: "docker" } : { kind: "url", url: database },
    language,
    userId: flag("user"),
    llm,
    embeddings,
  };
}

async function chooseClients(
  ctx: CommandContext,
  prompt: Prompt | null,
  detected: ClientName[],
): Promise<ClientName[]> {
  const flagged = listValue(ctx.values, "connect");
  if (flagged) {
    if (flagged.includes("none")) return [];
    for (const c of flagged)
      if (!(CLIENTS as readonly string[]).includes(c))
        throw new Error(`unknown client ${c}; use ${CLIENTS.join(", ")}`);
    return flagged as ClientName[];
  }
  if (!prompt) return detected;
  const chosen: ClientName[] = [];
  for (const client of detected) if (await prompt.confirm(`Connect ${client}?`, true)) chosen.push(client);
  return chosen;
}
