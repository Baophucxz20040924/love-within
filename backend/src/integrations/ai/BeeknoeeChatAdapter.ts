import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ChatProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './ChatProvider.js';

/**
 * beeknoee text chat (OpenAI-compatible POST {BEEKNOEE_BASE_URL}/v1/chat/completions, Bearer sk-bee-...).
 * Model: BEEKNOEE_CHAT_MODEL. Checked live on 07/11/2026 with scripts/probe-beeknoee.ts:
 * openai/gpt-5.4-mini, openai/gpt-5.4-nano and google/gemini-3.5-flash-lite answer in ~1–2 s and accept
 * `response_format: { type: 'json_object' }`. Embedding models (e.g. qwen/qwen3-embedding-8b) are rejected with 400.
 *
 * Never logs prompts or replies: they contain the user's transactions and notes.
 */

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).nullable(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ total_tokens: z.number().optional() }).partial().optional(),
});

export class BeeknoeeChatAdapter implements ChatProvider {
  readonly name = 'beeknoee';

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!env.beeknoee.apiKey) throw new ChatProviderError('BEEKNOEE_API_KEY chưa được cấu hình', false);
    // Retry once on 5xx / 429 / network errors. Timeouts are not retried: the user is already waiting.
    try {
      return await this.callOnce(req);
    } catch (err) {
      if (err instanceof ChatProviderError && err.retryable) {
        logger.warn('beeknoee chat transient failure, retrying once', { message: err.message });
        return this.callOnce(req);
      }
      throw err;
    }
  }

  private async callOnce(req: ChatRequest): Promise<ChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.beeknoee.chatTimeoutMs);
    const url = `${env.beeknoee.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const started = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: env.beeknoee.chatModel,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        messages: req.messages,
      };
      if (req.json) body.response_format = { type: 'json_object' };

      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.beeknoee.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status >= 500 || res.status === 429) throw new ChatProviderError(`beeknoee ${res.status}`, true);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ChatProviderError(`beeknoee ${res.status}: ${providerMessage(text)}`, false);
      }

      const parsed = responseSchema.safeParse(await res.json());
      if (!parsed.success) throw new ChatProviderError('beeknoee response is not a chat completion', true);
      const content = parsed.data.choices[0].message.content;
      const text = (typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join('')).trim();
      if (!text) throw new ChatProviderError('beeknoee empty reply', true);
      return {
        text,
        model: parsed.data.model ?? env.beeknoee.chatModel,
        totalTokens: parsed.data.usage?.total_tokens,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof ChatProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw new ChatProviderError('beeknoee timeout', false);
      throw new ChatProviderError(`beeknoee network error: ${(err as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keep only the provider's error message (never the request), capped. */
function providerMessage(text: string): string {
  try {
    const msg = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof msg === 'string') return msg.split('\n')[0].slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}
