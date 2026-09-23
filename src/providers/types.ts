export type EmbeddingProvider = {
  readonly name: string;
  readonly model: string;
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** A vector for a search query, when the model wants queries phrased differently from documents. */
  embedQuery?(text: string): Promise<number[]>;
};

export type CompleteParams = {
  system: string;
  user: string;
  /** Name of the JSON schema, sent to providers that label structured output. */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
};

export type LLMProvider = {
  readonly name: string;
  readonly model: string;
  /** One structured completion; resolves to the parsed JSON object. */
  complete(params: CompleteParams): Promise<unknown>;
};
