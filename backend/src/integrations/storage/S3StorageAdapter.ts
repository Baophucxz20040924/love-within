import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import type { DownloadUrlOptions, StorageProvider } from './StorageProvider.js';

const UPLOAD_URL_TTL_SEC = 120;
const DOWNLOAD_URL_TTL_SEC = 300;
const HOUR_MS = 3_600_000;

/**
 * AWS S3 implementation (SDK v3).
 * - Bucket must be PRIVATE (Block Public Access on). All access is via presigned URLs.
 * - Credentials: static keys from env, or omit them to use the default provider chain (IAM role).
 * - Objects are kept indefinitely (no lifecycle expiry): water and story photos are part of the couple's history.
 */
export class S3StorageAdapter implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const cfg: S3ClientConfig = { region: env.s3.region };
    if (env.s3.accessKeyId && env.s3.secretAccessKey) {
      cfg.credentials = { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey };
    }
    this.client = new S3Client(cfg);
    this.bucket = env.s3.bucket;
  }

  async getUploadUrl(input: { key: string; mimeType: string; sizeBytes: number }) {
    // ContentType and ContentLength are part of the signature: the client must send
    // exactly these headers, so oversized or non-image uploads are rejected by S3 itself.
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.mimeType,
      ContentLength: input.sizeBytes,
    });
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: UPLOAD_URL_TTL_SEC });
    return { uploadUrl, expiresIn: UPLOAD_URL_TTL_SEC };
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions = {}) {
    if (!opts.cacheable) {
      const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
      const url = await getSignedUrl(this.client, cmd, { expiresIn: DOWNLOAD_URL_TTL_SEC });
      return { url, expiresIn: DOWNLOAD_URL_TTL_SEC };
    }
    // Sign against the start of the current hour with a 2 h lifetime: the URL is identical for
    // every request within the hour (browser cache hit) and always valid for ≥ 1 h from now.
    const signingDate = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseCacheControl: 'private, max-age=3600, immutable',
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: 7200, signingDate });
    const expiresIn = Math.floor((signingDate.getTime() + 7_200_000 - Date.now()) / 1000);
    return { url, expiresIn };
  }

  async headObject(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, mimeType: res.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === 'NotFound') return null;
      throw err;
    }
  }

  async getObject(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 object ${key} has no body`);
    const bytes = await res.Body.transformToByteArray();
    const body = Buffer.from(bytes);
    return { body, mimeType: res.ContentType ?? 'application/octet-stream', size: body.length };
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
