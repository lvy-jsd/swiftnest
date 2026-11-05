/** The model request and stream surface shared by built-in modules. */
export interface LlmChunk {
  type: string;
  text?: string;
  reason?: { kind: string; failure?: { message: string } };
}

/** One model call as DSH takes it; other request fields pass through untouched. */
export interface LlmRequest {
  provider: string;
  model: string;
  messages: readonly { role: string; content: readonly unknown[] }[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Llm {
  stream(options: LlmRequest): AsyncIterable<LlmChunk>;
}
