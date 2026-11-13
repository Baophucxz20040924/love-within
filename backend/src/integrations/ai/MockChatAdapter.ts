import { ChatProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './ChatProvider.js';

/**
 * DEV ONLY. Deterministic finance-assistant replies so smoke tests and the UI work without beeknoee.
 *   - JSON mode → valid insights JSON; notes listed as `n1: "..."` are labelled by keyword.
 *   - text mode → echoes how many transactions / notes it read, so tests can check the context.
 *   - a user message containing "#mock-fail" → non-retryable provider error (tests the 503 path).
 */
const KEYWORDS: Array<[RegExp, string]> = [
  [/cơm|ăn|bún|phở|cafe|cà phê|trà|bánh|nhậu|lẩu|food/i, 'food'],
  [/grab|xăng|taxi|xe|gửi xe|be |transport/i, 'transport'],
  [/điện|nước|internet|wifi|hóa đơn|tiền nhà|bill/i, 'bills'],
  [/quà|sinh nhật|gift/i, 'gift'],
  [/phim|game|karaoke|fun/i, 'fun'],
  [/shopee|lazada|quần|áo|giày|mua/i, 'shopping'],
  [/thuốc|khám|bệnh viện|health/i, 'health'],
];

export class MockChatAdapter implements ChatProvider {
  readonly name = 'mock';

  async complete(req: ChatRequest): Promise<ChatResult> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (last.includes('#mock-fail')) throw new ChatProviderError('mock failure', false);
    const all = req.messages.map((m) => m.content).join('\n');
    const text = req.json ? this.insights(all) : this.reply(all, last);
    return { text, model: 'mock', totalTokens: Math.ceil(all.length / 4), latencyMs: 0 };
  }

  private insights(prompt: string): string {
    const labels: Record<string, string> = {};
    for (const m of prompt.matchAll(/^(n\d+): "(.*)"/gm)) {
      labels[m[1]] = KEYWORDS.find(([re]) => re.test(m[2]))?.[1] ?? 'other';
    }
    return JSON.stringify({
      labels,
      headline: '[mock] Chi tiêu của bạn đang ổn định',
      observations: ['[mock] Nhận xét 1', '[mock] Nhận xét 2'],
      suggestions: [
        { title: '[mock] Đặt ngân sách ăn uống', detail: 'Giới hạn 150.000đ mỗi ngày.', estimatedSavingVnd: 300000 },
        { title: '[mock] Ghi chú thêm giao dịch', detail: 'Để trợ lý hiểu bạn hơn.', estimatedSavingVnd: null },
      ],
      noteTip: null,
    });
  }

  private reply(prompt: string, question: string): string {
    const m = prompt.match(/(\d+) giao dịch, (\d+) có ghi chú/);
    const read = m ? `${m[1]} giao dịch, ${m[2]} có ghi chú` : 'không có dữ liệu';
    return `[mock] Mình đã đọc ${read}. Bạn hỏi: "${question.slice(0, 80)}"`;
  }
}
