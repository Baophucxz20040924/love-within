import { Router, raw } from 'express';
import type { StorageProvider } from './StorageProvider.js';

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

  async deleteObject(key: string) {
    this.objects.delete(key);
  }

  /** Express router implementing PUT/GET for the fake presigned URLs. */
  router(maxBytes: number): Router {
    const r = Router();
    r.put('/:key', raw({ type: () => true, limit: maxBytes }), (req, res) => {
      const key = decodeURIComponent(req.params.key);
      this.objects.set(key, {
        body: req.body as Buffer,
        mimeType: req.headers['content-type'] ?? 'application/octet-stream',
      });
      res.status(200).end();
    });
    r.get('/:key', (req, res) => {
      const obj = this.objects.get(decodeURIComponent(req.params.key));
      if (!obj) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', obj.mimeType);
      res.send(obj.body);
    });
    return r;
  }
}
