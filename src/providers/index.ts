import type { Config } from "../config/config.js";
import { ProviderUnavailableError } from "./errors.js";
import { FakeEmbeddings, FakeLLM } from "./fake.js";
import { OllamaEmbeddings } from "./ollama.js";
import { OpenAICompatibleEmbeddings, OpenAICompatibleLLM } from "./openai.js";
import type { EmbeddingProvider, LLMProvider } from "./types.js";

export function createEmbedder(config: Config): EmbeddingProvider {
  const { provider, model, baseUrl, apiKey } = config.embedding;
  switch (provider) {
    case "openai":
      return new OpenAICompatibleEmbeddings(model, { apiKey, baseUrl });
    case "ollama":
      return new OllamaEmbeddings(model, baseUrl);
    case "fake":
      return new FakeEmbeddings(model);
    case "none":
      return {
        name: "none",
        model,
        async embed(texts) {
          if (texts.length === 0) return [];
          throw new ProviderUnavailableError("no embedding provider configured (MORFEU_EMBEDDING_PROVIDER=none)");
        },
      };
  }
}

export function createLlm(config: Config): LLMProvider {
  const { provider, model, baseUrl, apiKey } = config.llm;
  switch (provider) {
    case "openai":
      return new OpenAICompatibleLLM(model, { apiKey, baseUrl });
    case "fake":
      return new FakeLLM();
    case "none":
      return {
        name: "none",
        model,
        async complete() {
          throw new ProviderUnavailableError(
            "no LLM configured (MORFEU_LLM_PROVIDER=none); extraction and consolidation need one",
          );
        },
      };
  }
}
