export interface WaterVisionResult {
  amountMl: number;
  confidence?: number;
  /** false when the model could not identify a drink / water container. */
  recognized: boolean;
  /** Compact raw payload for debugging. Keep small; may be persisted on the log. */
  raw?: Record<string, unknown>;
}

export interface WaterVisionProvider {
  analyze(input: { imageBuffer: Buffer; mimeType: string }): Promise<WaterVisionResult>;
}

/** Thrown for transport/timeout/5xx failures so the service can show a friendly retry message. */
export class WaterVisionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'WaterVisionError';
    this.retryable = retryable;
  }
}
