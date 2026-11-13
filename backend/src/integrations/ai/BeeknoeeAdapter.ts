import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { WaterVisionError, type WaterVisionProvider, type WaterVisionResult } from './WaterVisionProvider.js';

/**
 * beeknoee water-vision adapter.
 *
 * beeknoee is an OpenAI-compatible proxy: POST {BEEKNOEE_BASE_URL}/v1/chat/completions with
 * `Authorization: Bearer sk-bee-...`. Images are sent in the standard OpenAI vision format
 * (content part `image_url` with a base64 data URI). The model MUST support vision — set it with
 * BEEKNOEE_MODEL (e.g. `openai/gpt-4o-mini`, `google/gemini-2.0-flash`). Text-only models such as
 * `deepseek/deepseek-v3.2` will fail or ignore the image.
 */

const PROMPT =
  'Bạn là trợ lý ước lượng lượng nước. Nhìn ảnh: nếu có ly/chai/cốc chứa nước hoặc đồ uống, ' +
  'hãy ước lượng thể tích chất lỏng còn trong vật chứa theo mililit. ' +
  'Chỉ trả về JSON đúng dạng: {"amount_ml": <số nguyên>, "recognized": <true|false>, "confidence": <0..1>} ' +
  'và không thêm bất kỳ chữ nào khác. Nếu không thấy đồ uống, trả về {"amount_ml": 0, "recognized": false, "confidence": 0}.';

const answerSchema = z.object({
  amount_ml: z.number().nonnegative(),
  recognized: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const chatResponseSchema = z.object({
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

const MAX_ML = 5000;

export class BeeknoeeAdapter implements WaterVisionProvider {
  async analyze(input: { imageBuffer: Buffer; mimeType: string }): Promise<WaterVisionResult> {
    if (!env.beeknoee.apiKey) {
      throw new WaterVisionError('BEEKNOEE_API_KEY chưa được cấu hình', false);
    }
    // Retry at most once, and only for transient network / 5xx / 429 failures.
    try {
      return await this.callOnce(input);
    } catch (err) {
      if (err instanceof WaterVisionError && err.retryable) {
        logger.warn('beeknoee transient failure, retrying once', { message: err.message });
        return this.callOnce(input);
      }
      throw err;
    }
  }

  private async callOnce(input: { imageBuffer: Buffer; mimeType: string }): Promise<WaterVisionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.beeknoee.timeoutMs);
    const url = `${env.beeknoee.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.beeknoee.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildRequest(input)),
        signal: controller.signal,
      });

      if (res.status >= 500 || res.status === 429) {
        throw new WaterVisionError(`beeknoee ${res.status}`, true);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new WaterVisionError(`beeknoee ${res.status}: ${text.slice(0, 300)}`, false);
      }

      const json: unknown = await res.json();
      return this.parse(json);
    } catch (err) {
      if (err instanceof WaterVisionError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new WaterVisionError(aborted ? 'beeknoee timeout' : `beeknoee network error: ${(err as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildRequest(input: { imageBuffer: Buffer; mimeType: string }) {
    const dataUri = `data:${input.mimeType};base64,${input.imageBuffer.toString('base64')}`;
    return {
      model: env.beeknoee.model,
      temperature: 0,
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUri, detail: 'low' } },
          ],
        },
      ],
    };
  }

  private parse(json: unknown): WaterVisionResult {
    const chat = chatResponseSchema.safeParse(json);
    if (!chat.success) {
      logger.warn('beeknoee response is not a chat completion', { issues: chat.error.issues.length });
      return { amountMl: 0, recognized: false, raw: compact(json) };
    }

    const content = chat.data.choices[0].message.content;
    const text = typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join('');
    const answer = extractJson(text);
    const parsed = answer ? answerSchema.safeParse(answer) : null;
    if (!parsed || !parsed.success) {
      logger.warn('beeknoee answer did not contain the expected JSON', { text: text.slice(0, 200) });
      return { amountMl: 0, recognized: false, raw: { text: text.slice(0, 500), usage: chat.data.usage } };
    }

    const amount = Math.round(parsed.data.amount_ml);
    const recognized = (parsed.data.recognized ?? amount > 0) && amount > 0 && amount <= MAX_ML;
    return {
      amountMl: recognized ? amount : 0,
      confidence: parsed.data.confidence,
      recognized,
      raw: { answer: parsed.data, model: env.beeknoee.model, usage: chat.data.usage },
    };
  }
}

/** Pull the first JSON object out of the model's reply (handles ```json fences and prose). */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function compact(json: unknown): Record<string, unknown> | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const s = JSON.stringify(json);
  return s.length <= 2000 ? (json as Record<string, unknown>) : { truncated: s.slice(0, 2000) };
}
