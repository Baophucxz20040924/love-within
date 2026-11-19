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
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).nullable().optional(),
          refusal: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ total_tokens: z.number().optional() }).partial().optional(),
});

export class BeeknoeeChatAdapter implements ChatProvider {
  readonly name = 'beeknoee';

  async complete(req: ChatRequest): Promise<ChatResult> {
    if (!env.beeknoee.apiKey) throw new ChatProviderError('Chat provider is not configured', false, 'configuration');
    // Retry once on 5xx / 429 / network errors. Timeouts are not retried: the user is already waiting.
    try {
      return await this.callOnce(req);
    } catch (err) {
      if (req.retry !== false && err instanceof ChatProviderError && err.retryable) {
        logger.warn('beeknoee chat transient failure, retrying once', { code: err.code, status: err.status });
        return this.callOnce(req);
      }
      throw err;
    }
  }

  private async callOnce(req: ChatRequest): Promise<ChatResult> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs !== undefined && Number.isFinite(req.timeoutMs)
      ? Math.max(1, Math.min(env.beeknoee.chatTimeoutMs, req.timeoutMs)) : env.beeknoee.chatTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        const code = res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'upstream'
          : res.status === 401 || res.status === 403 ? 'auth' : 'rejected';
        throw new ChatProviderError('Chat provider HTTP failure', res.status >= 500 || res.status === 429, code, res.status);
      }

      let payload: unknown;
      try { payload = await res.json(); }
      catch {
        if (controller.signal.aborted) throw new ChatProviderError('Chat provider timeout', false, 'timeout');
        throw new ChatProviderError('Chat provider invalid JSON envelope', true, 'invalid_response');
      }
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) throw new ChatProviderError('Chat provider invalid completion', true, 'invalid_response');
      const choice = parsed.data.choices[0];
      const content = choice.message.content;
      const text = (typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join('')).trim();
      const reason = choice.finish_reason;
      const finishReason: ChatResult['finishReason'] = reason == null ? undefined
        : reason === 'stop' || reason === 'length' || reason === 'content_filter' || reason === 'tool_calls' ? reason : 'other';
      const refused = Boolean(choice.message.refusal?.trim());
      if (!text && !refused && finishReason !== 'content_filter' && finishReason !== 'length')
        throw new ChatProviderError('Chat provider empty reply', true, 'empty_response');
      return {
        text,
        model: parsed.data.model ?? env.beeknoee.chatModel,
        totalTokens: parsed.data.usage?.total_tokens,
        latencyMs: Date.now() - started,
        finishReason,
        refused,
      };
    } catch (err) {
      if (err instanceof ChatProviderError) throw err;
      if (controller.signal.aborted || err instanceof Error && err.name === 'AbortError')
        throw new ChatProviderError('Chat provider timeout', false, 'timeout');
      throw new ChatProviderError('Chat provider network failure', true, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}
