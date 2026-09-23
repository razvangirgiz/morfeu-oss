import { ProviderUnavailableError } from "./errors.js";
import type { EmbeddingProvider } from "./types.js";

const BATCH = 8;

/** Embeddings from a local Ollama server (`ollama pull <model>` first). */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = "ollama";
  private readonly endpoint: string;

  constructor(
    readonly model: string,
    baseUrl: string,
  ) {
    const url = new URL(baseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("MORFEU_EMBEDDING_BASE_URL must be an http(s) URL without credentials");
    }
    this.endpoint = new URL("/api/embed", url).href;
  }

  /** Instruction-aware models (the Qwen3 embedding family) rank better when queries say what they look for. */
  async embedQuery(text: string): Promise<number[]> {
    const input = this.model.startsWith("qwen3-embedding")
      ? `Instruct: Retrieve memories that answer the question.\nQuery: ${text}`
      : text;
    const [vector] = await this.embed([input]);
    if (!vector) throw new Error("Ollama returned no vector");
    return vector;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += BATCH) {
      const input = texts.slice(offset, offset + BATCH);
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input, keep_alive: "10m" }),
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
        });
      } catch (err) {
        throw new ProviderUnavailableError(`Ollama is not reachable at ${this.endpoint}; is it running?`, {
          cause: err,
        });
      }
      if (!response.ok) {
        throw new ProviderUnavailableError(
          `Ollama embed failed (HTTP ${response.status}); run \`ollama pull ${this.model}\``,
        );
      }
      const data = (await response.json()) as { embeddings?: unknown };
      if (!isVectorList(data.embeddings, input.length)) {
        throw new Error("Ollama returned malformed embeddings");
      }
      vectors.push(...data.embeddings);
    }
    return vectors;
  }
}

function isVectorList(value: unknown, count: number): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)))
  );
}
