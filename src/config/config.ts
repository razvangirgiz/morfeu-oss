import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { platformDirs } from "./paths.js";

const LLM_PROVIDERS = ["openai", "none", "fake"] as const;
const EMBEDDING_PROVIDERS = ["openai", "ollama", "none", "fake"] as const;
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

type LlmProviderName = (typeof LLM_PROVIDERS)[number];
type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export type Config = {
  /** The file settings were read from, whether or not it exists yet. */
  configFile: string;
  /** Postgres connection string. */
  databaseUrl: string;
  /** "docker": morfeu starts and stops its own pgvector container. "off": bring your own Postgres. */
  managedDb: "docker" | "off";
  /** What `user:me` resolves to. */
  userId: string;
  /** Postgres text search language for keyword retrieval, e.g. english, romanian, simple. */
  language: string;
  llm: { provider: LlmProviderName; model: string; baseUrl: string; apiKey: string };
  embedding: { provider: EmbeddingProviderName; model: string; baseUrl: string; apiKey: string };
  /** Upper bound on LLM calls in one extract or dream run. */
  maxLlmCalls: number;
  /** Cosine similarity below this carries no relevance signal for the configured embedding model. */
  semanticFloor: number;
  claudeProjectsDir: string;
  /** Claude Code project directories whose name contains any of these are never ingested. */
  ingestExclude: string[];
  /** Subjects the extractor must never turn into memories. */
  neverExtract: string[];
  /** Archive old, unimportant, never-retrieved memories during the dream. */
  decay: boolean;
  backupDir: string;
  logLevel: LogLevel;
};

type Env = Record<string, string | undefined>;

export const DEFAULT_DATABASE_URL = "postgres://morfeu:morfeu@127.0.0.1:5433/morfeu";
const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProviderName, string> = {
  openai: "text-embedding-3-small",
  ollama: "qwen3-embedding:0.6b",
  none: "none",
  fake: "fake-embedding",
};

/**
 * Settings come from the environment, over a dotenv-style config file.
 *
 * The file is read only for the real process environment (or when
 * MORFEU_CONFIG_FILE names one). An explicit env object, as tests pass, is
 * taken as complete, so a user's config can never leak into a test run.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configFile = configFilePath(env);
  const fromFile = env === process.env || env.MORFEU_CONFIG_FILE ? readDotEnv(configFile) : {};
  const e: Env = { ...fromFile };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) e[key] = value;

  const explicitUrl = str(e, "MORFEU_DATABASE_URL", "");
  const llmProvider = oneOf(e, "MORFEU_LLM_PROVIDER", "openai", LLM_PROVIDERS);
  const embeddingProvider = oneOf(e, "MORFEU_EMBEDDING_PROVIDER", "openai", EMBEDDING_PROVIDERS);
  const openaiKey = str(e, "OPENAI_API_KEY", "");
  // OPENAI_API_KEY is only a fallback for OpenAI itself, never sent to another server.
  const llmBaseUrl = str(e, "MORFEU_LLM_BASE_URL", "");
  const embeddingBaseUrl = str(
    e,
    "MORFEU_EMBEDDING_BASE_URL",
    embeddingProvider === "ollama" ? "http://127.0.0.1:11434" : "",
  );
  const dirs = platformDirs(env);

  return {
    configFile,
    databaseUrl: explicitUrl || DEFAULT_DATABASE_URL,
    managedDb: oneOf(e, "MORFEU_MANAGED_DB", explicitUrl ? "off" : "docker", ["docker", "off"] as const),
    userId: str(e, "MORFEU_USER_ID", "me").trim(),
    language: language(str(e, "MORFEU_LANGUAGE", "english")),
    llm: {
      provider: llmProvider,
      model: str(e, "MORFEU_LLM_MODEL", "gpt-5-mini"),
      baseUrl: llmBaseUrl,
      apiKey: str(e, "MORFEU_LLM_API_KEY", llmBaseUrl ? "" : openaiKey),
    },
    embedding: {
      provider: embeddingProvider,
      model: str(e, "MORFEU_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODELS[embeddingProvider]),
      baseUrl: embeddingBaseUrl,
      apiKey: str(e, "MORFEU_EMBEDDING_API_KEY", embeddingBaseUrl ? "" : openaiKey),
    },
    maxLlmCalls: int(e, "MORFEU_MAX_LLM_CALLS", 100),
    semanticFloor: num(e, "MORFEU_SEMANTIC_FLOOR", embeddingProvider === "fake" ? 0 : 0.3),
    claudeProjectsDir: str(e, "MORFEU_CLAUDE_PROJECTS_DIR", join(homedir(), ".claude", "projects")),
    ingestExclude: list(e, "MORFEU_INGEST_EXCLUDE", ","),
    neverExtract: list(e, "MORFEU_NEVER_EXTRACT", ";"),
    decay: onOff(e, "MORFEU_DECAY", false),
    backupDir: str(e, "MORFEU_BACKUP_DIR", join(dirs.data, "backups")),
    logLevel: oneOf(e, "MORFEU_LOG_LEVEL", "info", LOG_LEVELS),
  };
}

function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MORFEU_CONFIG_FILE;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("MORFEU_CONFIG_FILE must be an absolute path");
    return explicit;
  }
  return join(platformDirs(env).config, "config.env");
}

export function readDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

/** Postgres snowball dictionaries are named `<language>_stem`; `simple` has no stemming. */
function language(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z]+$/.test(value)) throw new Error(`MORFEU_LANGUAGE must be a Postgres text search language, got ${raw}`);
  return value;
}

function str(e: Env, key: string, fallback: string): string {
  const raw = e[key];
  return raw === undefined || raw === "" ? fallback : raw;
}

function num(e: Env, key: string, fallback: number): number {
  const raw = e[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${raw}`);
  return n;
}

function int(e: Env, key: string, fallback: number): number {
  const n = num(e, key, fallback);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got ${n}`);
  return n;
}

function onOff(e: Env, key: string, fallback: boolean): boolean {
  const raw = str(e, key, fallback ? "on" : "off").toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  throw new Error(`${key} must be on or off, got ${raw}`);
}

function list(e: Env, key: string, separator: string): string[] {
  return str(e, key, "")
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(e: Env, key: string, fallback: T, allowed: readonly T[]): T {
  const value = str(e, key, fallback);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join(", ")}, got ${value}`);
  }
  return value as T;
}
