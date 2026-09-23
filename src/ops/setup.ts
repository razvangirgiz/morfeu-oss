/** What the setup wizard (or its flags) decided. */
export type SetupAnswers = {
  database: { kind: "docker" } | { kind: "url"; url: string };
  language: string;
  userId?: string;
  llm:
    | { kind: "openai"; apiKey: string; model?: string }
    | { kind: "compatible"; baseUrl: string; model: string; apiKey?: string }
    | { kind: "none" };
  embeddings:
    | { kind: "openai"; apiKey?: string; model?: string }
    | { kind: "ollama"; baseUrl?: string; model?: string }
    | { kind: "none" };
};

/**
 * The config file entries for a set of answers. Every key morfeu owns is
 * written, empty when unused, so switching providers never leaves a stale
 * setting behind. The managed database keeps the default credentials: it
 * listens on 127.0.0.1 only, and a generated password would stop matching a
 * data volume that already exists.
 */
export function settingsFor(answers: SetupAnswers, existing: Record<string, string> = {}): Record<string, string> {
  const s: Record<string, string> = {
    MORFEU_LANGUAGE: answers.language,
    MORFEU_USER_ID: answers.userId ?? existing.MORFEU_USER_ID ?? "",
    MORFEU_LLM_PROVIDER: "",
    MORFEU_LLM_MODEL: "",
    MORFEU_LLM_BASE_URL: "",
    MORFEU_LLM_API_KEY: "",
    MORFEU_EMBEDDING_PROVIDER: "",
    MORFEU_EMBEDDING_MODEL: "",
    MORFEU_EMBEDDING_BASE_URL: "",
    MORFEU_EMBEDDING_API_KEY: "",
  };
  if (answers.database.kind === "docker") {
    s.MORFEU_MANAGED_DB = "docker";
    s.MORFEU_DATABASE_URL = "";
  } else {
    s.MORFEU_MANAGED_DB = "off";
    s.MORFEU_DATABASE_URL = answers.database.url;
  }
  const llm = answers.llm;
  if (llm.kind === "none") s.MORFEU_LLM_PROVIDER = "none";
  else {
    s.MORFEU_LLM_PROVIDER = "openai";
    s.MORFEU_LLM_MODEL = llm.model ?? "";
    s.MORFEU_LLM_API_KEY = llm.apiKey ?? "";
    if (llm.kind === "compatible") s.MORFEU_LLM_BASE_URL = llm.baseUrl;
  }
  const emb = answers.embeddings;
  s.MORFEU_EMBEDDING_PROVIDER = emb.kind;
  if (emb.kind === "openai") {
    s.MORFEU_EMBEDDING_MODEL = emb.model ?? "";
    // One OpenAI key serves both when the LLM already has it.
    s.MORFEU_EMBEDDING_API_KEY = emb.apiKey ?? (llm.kind === "openai" ? llm.apiKey : "");
  } else if (emb.kind === "ollama") {
    s.MORFEU_EMBEDDING_MODEL = emb.model ?? "";
    s.MORFEU_EMBEDDING_BASE_URL = emb.baseUrl ?? "";
  }
  return s;
}
