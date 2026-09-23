import OpenAI from "openai";
import { ProviderUnavailableError } from "./errors.js";
import { withRetry } from "./retry.js";
import type { CompleteParams, EmbeddingProvider, LLMProvider } from "./types.js";

type ClientOptions = { apiKey: string; baseUrl: string; setting: string };

// morfeu owns the retry policy (withRetry); the SDK's own retries are off so
// one failure does not multiply two backoff loops.
function client(options: ClientOptions): OpenAI {
  if (!options.apiKey && !options.baseUrl) {
    throw new ProviderUnavailableError(`an API key is required: set ${options.setting} or OPENAI_API_KEY`);
  }
  return new OpenAI({
    apiKey: options.apiKey || "not-needed",
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    maxRetries: 0,
  });
}

/**
 * Any OpenAI-compatible chat completions endpoint with structured output:
 * OpenAI itself, or a local server (Ollama, LM Studio, vLLM) through base URL.
 */
export class OpenAICompatibleLLM implements LLMProvider {
  readonly name = "openai";
  private cached: OpenAI | undefined;

  constructor(
    readonly model: string,
    private readonly options: { apiKey: string; baseUrl: string },
  ) {}

  async complete(params: CompleteParams): Promise<unknown> {
    this.cached ??= client({ ...this.options, setting: "MORFEU_LLM_API_KEY" });
    const api = this.cached;
    const completion = await withRetry(() =>
      api.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: params.schemaName, strict: true, schema: params.jsonSchema },
        },
      }),
    );
    const text = completion.choices[0]?.message?.content;
    if (!text) throw new Error(`${this.model} returned an empty response`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${this.model} returned text that is not JSON; use a model that supports structured output`);
    }
  }
}

export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly name = "openai";
  private cached: OpenAI | undefined;

  constructor(
    readonly model: string,
    private readonly options: { apiKey: string; baseUrl: string },
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.cached ??= client({ ...this.options, setting: "MORFEU_EMBEDDING_API_KEY" });
    const api = this.cached;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await withRetry(() => api.embeddings.create({ model: this.model, input: batch }));
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      if (sorted.length !== batch.length)
        throw new Error(`${this.model} returned ${sorted.length} vectors for ${batch.length} texts`);
      for (const row of sorted) out.push(row.embedding);
    }
    return out;
  }
}
