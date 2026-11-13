import type { WaterVisionProvider, WaterVisionResult } from './WaterVisionProvider.js';

/**
 * DEV-ONLY provider (AI_PROVIDER=mock). Returns a deterministic volume derived from the
 * image size so the end-to-end flow can be exercised without beeknoee credentials.
 * Images under 16 bytes are treated as "not recognized" to test the error path.
 */
export class MockVisionAdapter implements WaterVisionProvider {
  async analyze(input: { imageBuffer: Buffer }): Promise<WaterVisionResult> {
    const size = input.imageBuffer.length;
    if (size < 16) return { amountMl: 0, recognized: false, raw: { mock: true, size } };
    const amountMl = 100 + (size % 400); // 100..499 ml
    return { amountMl, confidence: 0.9, recognized: true, raw: { mock: true, size } };
  }
}
