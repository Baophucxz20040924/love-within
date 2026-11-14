/** Text chat completion behind an interface (plan/PROJECT_SUMMARY.md). */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Ask the model for a single JSON object (OpenAI `response_format: json_object`). */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
  totalTokens?: number;
  latencyMs: number;
}

export interface ChatProvider {
  readonly name: string;
  complete(req: ChatRequest): Promise<ChatResult>;
}

export class ChatProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ChatProviderError';
    this.retryable = retryable;
  }
}
