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
  /** Optional shorter timeout; never extends the configured provider timeout. */
  timeoutMs?: number;
  /** Disable adapter retry when the caller owns a shared attempt budget. */
  retry?: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
  totalTokens?: number;
  latencyMs: number;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'other';
  refused?: boolean;
}

export interface ChatProvider {
  readonly name: string;
  complete(req: ChatRequest): Promise<ChatResult>;
}

export type ChatFailureCode = 'timeout' | 'network' | 'rate_limit' | 'upstream' | 'configuration' | 'auth' | 'invalid_response' | 'empty_response' | 'rejected' | 'unknown';

export class ChatProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code: ChatFailureCode = 'unknown', readonly status?: number) {
    super(message);
    this.name = 'ChatProviderError';
  }
}
