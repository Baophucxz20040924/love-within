import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { once, EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';

const require = createRequire(__filename);
require('dotenv').config = () => ({ parsed: {} });
process.env = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/never_connect', JWT_SECRET: randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: randomBytes(48).toString('hex'), JWT_ACCESS_TTL: '2s', STORAGE_PROVIDER: 'memory', AI_PROVIDER: 'mock', AI_CHAT_PROVIDER: 'mock', BANK_PROVIDER: 'mock', PUSH_PROVIDER: 'mock', SCHEDULER_ENABLED: 'false' };
const a = '111111111111111111111111', b = '222222222222222222222222';

async function main() {
  const { createApp } = await import('../../src/app.js');
  const { userRepository } = await import('../../src/repositories/user.repository.js');
  const { tokenService } = await import('../../src/services/token.service.js');
  const { credentialService } = await import('../../src/services/credential.service.js');
  const { Errors } = await import('../../src/utils/errors.js');
  credentialService.assertApp = async (id, version) => {
    if (id === b || version !== 0) throw Errors.unauthorized();
    return { _id: id, credentialVersion: 0, role: 'user', mustChangePassword: false } as never;
  };
  const { realtimeService, assertSingleRealtimeProcess } = await import('../../src/services/realtime.service.js');
  userRepository.findById = async (id) => id.toString() === b ? null : ({ friendsJoinedAt: id.toString() === a ? new Date() : null } as never);
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  function open(path: string, token?: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: token ? { Authorization: `Bearer ${token}` } : {} }, resolve);
      req.on('error', reject); req.end();
    });
  }
  function chunk(res: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stream timeout')), 3000);
      res.once('data', (data: Buffer) => { clearTimeout(timer); resolve(data.toString()); });
      res.once('error', reject);
    });
  }
  try {
    // Aborting during a slow membership lookup must never register an orphan stream.
    const originalFind = userRepository.findById;
    const originalSubscribe = realtimeService.subscribe;
    let release!: (user: any) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    userRepository.findById = () => { lookupStarted(); return new Promise((resolve) => { release = resolve; }); };
    let registered = false;
    realtimeService.subscribe = (...args) => { registered = true; return originalSubscribe(...args); };
    const aborted = request({ host: '127.0.0.1', port, path: '/api/realtime?space=couple', headers: { Authorization: `Bearer ${tokenService.signAccess(a, 0)}` } });
    aborted.on('error', () => {}); aborted.end();
    await started; aborted.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release({ friendsJoinedAt: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(registered, false);
    userRepository.findById = originalFind;
    realtimeService.subscribe = originalSubscribe;
    assert.equal((await open('/api/realtime?space=couple')).statusCode, 401);
    assert.equal((await open('/api/realtime?space=couple', 'bad')).statusCode, 401);
    assert.equal((await open('/api/realtime?space=other', tokenService.signAccess(a, 0))).statusCode, 400);
    assert.equal((await open('/api/realtime?space=couple', tokenService.signAccess(b, 0))).statusCode, 401);
    assert.equal((await open('/api/realtime?space=friends', tokenService.signAccess('333333333333333333333333', 0))).statusCode, 403);
    const now = Math.floor(Date.now() / 1000);
    const long = jwt.sign({ sub: a, type: 'access', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    assert.equal(tokenService.verifyAccess(long).expiresAtMs, (now + 2) * 1000);
    const short = jwt.sign({ sub: a, type: 'access', iat: now, exp: now + 1 }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    assert.equal(tokenService.verifyAccess(short).expiresAtMs, (now + 1) * 1000);
    const expired = jwt.sign({ sub: a, type: 'access', iat: now - 4, exp: now + 100 }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    assert.equal((await open('/api/realtime?space=couple', expired)).statusCode, 401);
    const stream = await open('/api/realtime?space=couple', long);
    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers['content-type']!, /text\/event-stream/);
    assert.match(await chunk(stream), /event: ready\ndata: {"version":1,"domains":\[\]}\n\n/);
    const next = chunk(stream);
    realtimeService.publish([a], 'friends', ['friends']);
    realtimeService.publish([b], 'couple', ['water']);
    realtimeService.publish([a], 'couple', ['water']);
    realtimeService.publish([a], 'couple', ['quests', 'water'], true);
    assert.equal(await next, 'event: access\ndata: {"version":1,"domains":["water","quests"]}\n\n');
    const revoke = chunk(stream);
    realtimeService.publish([a], 'couple', ['water']);
    realtimeService.publish([a], 'couple', [], true);
    realtimeService.publish([a], 'couple', ['quests']);
    assert.equal(await revoke, 'event: access\ndata: {"version":1,"domains":[]}\n\n');
    await once(stream, 'end'); // expires at maxAge, not the much later exp
    const streams: IncomingMessage[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await open('/api/realtime?space=couple', tokenService.signAccess(a, 0));
      assert.equal(s.statusCode, 200); await chunk(s); streams.push(s);
    }
    const limited = await open('/api/realtime?space=couple', tokenService.signAccess(a, 0));
    assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '10');
    streams[0].destroy();
    await new Promise((r) => setTimeout(r, 50));
    const replacement = await open('/api/realtime?space=couple', tokenService.signAccess(a, 0));
    assert.equal(replacement.statusCode, 200); await chunk(replacement);
    // Exercise heartbeat, backpressure, ready ordering, and cleanup without a 20 second sleep.
    const oldInterval = global.setInterval;
    let heartbeat: (() => void) | undefined;
    (global as any).setInterval = (fn: () => void) => { heartbeat = fn; return oldInterval(() => {}, 60_000); };
    class FakeResponse extends EventEmitter {
      writableLength = 0; writableEnded = false; destroyed = false; writes: string[] = []; backpressure = false;
      write(data: string) { this.writes.push(data); return !this.backpressure; }
      end() { this.writableEnded = true; }
    }
    const fake = new FakeResponse();
    assert.equal(realtimeService.subscribe('other', 0, 'couple', fake as unknown as Response, Date.now() + 10000), true);
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    await flush();
    assert.equal(fake.writes[0], 'event: ready\ndata: {"version":1,"domains":[]}\n\n');
    heartbeat!(); await flush(); assert.equal(fake.writes[1], ': heartbeat\n\n');
    fake.backpressure = true; heartbeat!(); await flush(); assert.equal(fake.writableEnded, true);
    const disconnected = new FakeResponse(); disconnected.destroyed = true;
    assert.equal(realtimeService.subscribe('other', 0, 'couple', disconnected as unknown as Response, Date.now() + 10000), false);
    const expiredResponse = new FakeResponse();
    assert.equal(realtimeService.subscribe('other', 0, 'couple', expiredResponse as unknown as Response, NaN), false);
    assert.equal(realtimeService.subscribe('other', 0, 'couple', expiredResponse as unknown as Response, Date.now() - 1), false);
    global.setInterval = oldInterval;
    assert.throws(() => assertSingleRealtimeProcess({ WEB_CONCURRENCY: '2' }));
    assert.doesNotThrow(() => assertSingleRealtimeProcess({ NODE_ENV: 'test', NODE_APP_INSTANCE: '1' }));
    const mockDev = { NODE_ENV: 'development', NODE_APP_INSTANCE: '1', STORAGE_PROVIDER: 'memory', AI_PROVIDER: 'mock', BANK_PROVIDER: 'mock', PUSH_PROVIDER: 'mock' };
    assert.doesNotThrow(() => assertSingleRealtimeProcess(mockDev));
    assert.throws(() => assertSingleRealtimeProcess({ ...mockDev, NODE_ENV: 'production' }));
    assert.throws(() => assertSingleRealtimeProcess({ ...mockDev, BANK_PROVIDER: 'thueapibank' }));
    assert.throws(() => assertSingleRealtimeProcess({ ...mockDev, WEB_CONCURRENCY: '2' }));
    realtimeService.drain();
    assert.equal(realtimeService.subscribe('other', 0, 'couple', new FakeResponse() as unknown as Response, Date.now() + 1000), false);
    for (const s of [...streams, replacement]) s.destroy();
    console.log('realtime transport tests passed');
  } finally { realtimeService.drain(); server.close(); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
