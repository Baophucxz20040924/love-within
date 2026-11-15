/**
 * Object storage abstraction for water and story photos. Implemented by S3StorageAdapter;
 * swap to R2/GCS by providing another implementation — nothing else changes.
 */
export interface DownloadUrlOptions {
  /**
   * Feed images: return a URL that stays identical for about an hour (signed against the start of
   * the current hour) and carries a Cache-Control header, so the browser reuses its cached copy
   * instead of re-downloading every photo each time the feed refetches.
   */
  cacheable?: boolean;
}

export interface StorageProvider {
  /**
   * Presigned PUT so the browser uploads directly to the bucket (bypassing the VPS).
   * `sizeBytes` is the exact file size the client declared (already validated ≤ cap);
   * it is bound into the signature so a larger body is rejected by the bucket.
   */
  getUploadUrl(input: { key: string; mimeType: string; sizeBytes: number }): Promise<{ uploadUrl: string; expiresIn: number }>;
  /** Presigned GET for viewing a private object (5 min by default, ≥ 1 h when cacheable). */
  getDownloadUrl(key: string, opts?: DownloadUrlOptions): Promise<{ url: string; expiresIn: number }>;
  /** Metadata only (no download). Returns null when the object does not exist. */
  headObject(key: string): Promise<{ size: number; mimeType: string } | null>;
  /** Read the object into memory to forward to the AI provider. */
  getObject(key: string): Promise<{ body: Buffer; mimeType: string; size: number }>;
  /** Read at most maxBytes (a positive safe integer), stopping the stream even if Range is ignored. */
  getObjectPrefix(key: string, maxBytes: number): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}
