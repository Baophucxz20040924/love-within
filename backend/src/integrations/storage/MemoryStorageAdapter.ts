import { Router, raw, type RequestHandler } from 'express';
import type { StorageProvider } from './StorageProvider.js';

/** A single byte range. Reject malformed/multipart ranges rather than returning partial garbage. */
function byteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return null;
    return { start: suffix >= length ? 0 : Number(length - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) return null;
  return { start: Number(start), end: end >= length ? size - 1 : Number(end) };
}

/**
 * DEV-ONLY in-process storage (STORAGE_PROVIDER=memory). Mimics the presigned-URL flow:
 * the "upload URL" points at a local endpoint that stores bytes in a Map.
 * Never use in production — data is lost on restart and lives in VPS RAM.
 */
export class MemoryStorageAdapter implements StorageProvider {
  private readonly objects = new Map<string, { body: Buffer; mimeType: string }>();
  private readonly publicBase: string;

  constructor(publicBase: string) {
    this.publicBase = publicBase.replace(/\/$/, '');
  }

  private url(key: string): string {
    return `${this.publicBase}/api/dev-storage/${encodeURIComponent(key)}`;
  }

  async getUploadUrl(input: { key: string; mimeType: string; sizeBytes: number }) {
    return { uploadUrl: this.url(input.key), expiresIn: 120 };
  }

  async getDownloadUrl(key: string) {
    return { url: this.url(key), expiresIn: 300 };
  }

  async headObject(key: string) {
    const obj = this.objects.get(key);
    return obj ? { size: obj.body.length, mimeType: obj.mimeType } : null;
  }

  async getObject(key: string) {
    const obj = this.objects.get(key);
    if (!obj) throw Object.assign(new Error(`Object not found: ${key}`), { name: 'NoSuchKey' });
    return { body: obj.body, mimeType: obj.mimeType, size: obj.body.length };
  }

  async getObjectPrefix(key: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    const obj = this.objects.get(key);
    if (!obj) throw Object.assign(new Error(`Object not found: ${key}`), { name: 'NoSuchKey' });
    return Buffer.from(obj.body.subarray(0, maxBytes));
  }

  async deleteObject(key: string) {
    this.objects.delete(key);
  }

  /** Express router implementing PUT/GET/HEAD for the fake presigned URLs. */
  router(maxBytes: number, videoMaxBytes: number = maxBytes): Router {
    const r = Router();
    const photoBody = raw({ type: () => true, limit: maxBytes });
    const videoBody = raw({ type: () => true, limit: videoMaxBytes });
    r.put('/:key', (req, res, next) => {
      // Express already decodes the route parameter. Only the dedicated post-video
      // branch gets the higher raw-body cap, never photos/avatars/moments/events.
      const isVideoKey = /^(?:friends|couples)\/[^/]+\/story-videos\/.+/.test(req.params.key);
      return (isVideoKey ? videoBody : photoBody)(req, res, next);
    }, (req, res) => {
      this.objects.set(req.params.key, {
        body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        mimeType: req.headers['content-type'] ?? 'application/octet-stream',
      });
      res.status(200).end();
    });
    const read: RequestHandler = (req, res) => {
      const obj = this.objects.get(req.params.key);
      if (!obj) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', obj.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      let body = obj.body;
      if (req.headers.range !== undefined) {
        const range = byteRange(req.headers.range, body.length);
        if (!range) {
          res.setHeader('Content-Range', `bytes */${body.length}`);
          res.setHeader('Content-Length', '0');
          res.status(416).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${body.length}`);
        body = body.subarray(range.start, range.end + 1);
      }
      res.setHeader('Content-Length', String(body.length));
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    r.route('/:key').get(read).head(read);
    return r;
  }
}
