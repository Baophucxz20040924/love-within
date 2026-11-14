import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { run } from './measure.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(path.join(root, 'backend/package.json'));
const [phase = 'before', ...args] = process.argv.slice(2);
if (!/^(before|after)(-[a-z0-9-]+)?$/.test(phase)) throw new Error('Use before or after[-label]');
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--query-counts') { options.queryCounts = true; continue; }
  if (!['--source-root', '--fixture', '--baseline-dir'].includes(args[i]) || !args[i + 1]) throw new Error('Supported options: --source-root PATH --fixture PATH --baseline-dir PATH --query-counts');
  options[args[i]] = path.resolve(args[++i]);
}
// After defaults to the retained, measured baseline; never silently seed replacement data.
const baselineDir = options['--baseline-dir'] ?? path.join(here, 'results/before-2026-11-12T17-32-09-719Z');
if (phase.startsWith('after')) options['--fixture'] ??= path.join(baselineDir, 'fixture.json');
const sourceRoot = options['--source-root'] ?? root;
const sourceBackend = path.join(sourceRoot, 'backend');
const base = 'http://127.0.0.1:4010';
const mongoUri = 'mongodb://127.0.0.1:27017/lookwithin_v12_perf';
const out = path.join(here, 'results', `${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await fs.mkdir(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', () => reject(new Error('Port 4010 unavailable; no process was stopped')));
  probe.listen(4010, '::', () => probe.close(resolve));
});
// Copy only executable source/config, never .env, uploads, data, or dependencies from the backup.
// Both phases execute a frozen copy; hashes below describe THAT copy, not an earlier working tree.
const snapshot = await fs.mkdtemp(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'lw-v12-perf-'));
const backend = path.join(snapshot, 'backend');
let child;
let exited = false;
let stage = 'snapshot';
const maxDurationMs = 240000;
const deadline = Date.now() + maxDurationMs;
// Independent of pending fetch/driver work. Only the direct, non-watch child is owned.
const watchdog = setTimeout(() => {
  child?.kill('SIGKILL');
  console.error('Performance overall deadline exceeded; owned API kill requested; cleanup unverified');
  process.exit(124);
}, maxDurationMs + 10000);
async function stop() {
  if (child && !exited) child.kill();
  for (let i = 0; i < 100 && child && !exited; i++) await sleep(100);
  if (child && !exited) throw new Error('Owned API failed to stop');
}
process.once('SIGINT', async () => { await stop(); process.exit(130); });
process.once('SIGTERM', async () => { await stop(); process.exit(143); });
try {
  await fs.mkdir(backend);
  await fs.cp(path.join(sourceBackend, 'src'), path.join(backend, 'src'), { recursive: true, dereference: true });
  for (const file of ['package.json', 'tsconfig.json']) await fs.copyFile(path.join(sourceBackend, file), path.join(backend, file));
  await fs.symlink(path.join(root, 'backend/node_modules'), path.join(backend, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const sourceHashes = {};
  async function hashTree(dir) {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await hashTree(full);
      else sourceHashes[path.relative(backend, full).replaceAll('\\', '/')] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  }
  await hashTree(path.join(backend, 'src'));
  const sourceDigest = createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex');
  const jwtSecret = randomBytes(48).toString('base64url');
  const env = {};
  for (const name of ['PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','COMSPEC','PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    NODE_ENV: 'development', PORT: '4010', MONGODB_URI: mongoUri,
    STORAGE_PROVIDER: 'memory', AI_PROVIDER: 'mock', AI_CHAT_PROVIDER: 'mock',
    BANK_PROVIDER: 'mock', PUSH_PROVIDER: 'mock', NODE_APP_INSTANCE: '1',
    SCHEDULER_ENABLED: 'false', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '',
    JWT_SECRET: jwtSecret, JWT_REFRESH_SECRET: randomBytes(48).toString('base64url'),
    JWT_ACCESS_TTL: '1h', MEM_WARN_MB: '768',
  });
  const environment = {
    node: process.version, platform: process.platform, release: os.release(), arch: process.arch,
    cpus: os.cpus().length, cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))],
    cpuUsage: 'not measured; logical CPU count/model are not utilization or dedicated capacity',
    mongo: { version: null, status: 'not yet queried' }, maxDurationMs, eventLoopP99StopMs: 200,
    historicalMetadata: 'CPU model and Mongo version absent from old baseline; not retroactively inferred', totalMemoryMb: Math.round(os.totalmem()/1048576), freeMemoryMbAtStart: Math.round(os.freemem()/1048576),
    mode: 'development / tsx / non-watch', port: 4010, database: 'lookwithin_v12_perf', providers: 'memory + mocks', scheduler: false,
    nodeAppInstance: 1, dotenv: 'disabled via child-only preload', rssStopMb: 768, maxConcurrency: 4,
    queryInstrumentation: options.queryCounts ? 'mongoose-debug-als-v1' : 'none',
    instrumentationOverhead: options.queryCounts ? 'ALS per request, callback per Mongoose collection operation, one IPC count message per sampled response; not quantified; timings are instrumentation-only, not a speedup claim' : 'none',
    sourceRoot, sourceDigest, sourceHashes,
    dependencies: 'current backend/node_modules via temporary snapshot junction; no backup modifications',
    dependenciesLockSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'backend/package-lock.json'))).digest('hex'),
    command: [process.execPath, 'scripts/performance/run.mjs', phase, ...args],
    note: 'Shared workstation; API4000/browser activity may add noise. No historical environment-only run is a measured baseline.',
  };
  stage = 'startup';
  const preloads = ['--require', path.join(here, 'no-dotenv.cjs')];
  if (options.queryCounts) preloads.push('--require', path.join(here, 'query-counts.cjs'));
  child = spawn(process.execPath, [...preloads, '--import', 'tsx', 'src/server.ts'], {
    cwd: backend, env, stdio: options.queryCounts ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const queryMessages = new Map();
  const queryWaiters = new Map();
  child.on('message', message => {
    if (message?.type !== 'perf-query-count' || !Number.isInteger(message.sequence) || message.sequence < 1 || message.sequence > 512) return;
    const waiter = queryWaiters.get(message.sequence);
    if (waiter) { queryWaiters.delete(message.sequence); waiter(message); }
    else if (queryMessages.size < 512) queryMessages.set(message.sequence, message);
  });
  async function queryCountFor(sequence, route) {
    let message = queryMessages.get(sequence);
    queryMessages.delete(sequence);
    if (!message) message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { queryWaiters.delete(sequence); reject(Object.assign(new Error('QUERY_COUNT_TIMEOUT'), { harnessCode: 'QUERY_COUNT_TIMEOUT' })); }, 3000);
      queryWaiters.set(sequence, value => { clearTimeout(timer); resolve(value); });
    });
    if (!message.valid || message.method !== 'GET' || message.route !== route || !Number.isInteger(message.total) || message.total < 1 || message.total > 1000 ||
        !message.methods || Object.values(message.methods).some(n => !Number.isInteger(n) || n < 1) ||
        Object.values(message.methods).reduce((a,b) => a+b, 0) !== message.total) {
      throw Object.assign(new Error('QUERY_COUNT_INVALID'), { harnessCode: 'QUERY_COUNT_INVALID' });
    }
    return { total: message.total, methods: message.methods };
  }
  child.stdout.resume(); child.stderr.resume(); // Never persist raw app logs or credentials.
  child.on('exit', () => { exited = true; });
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; exited = true; });
  environment.apiPid = child.pid;
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 60000) {
    if (exited || spawnFailed) throw new Error('Owned API exited during startup');
    try {
      const r = await fetch(`${base}/api/metrics`, { signal: AbortSignal.timeout(2000) });
      const body = await r.json();
      if (r.ok && body.data?.pid === child.pid && body.data?.db?.state === 'connected') { ready = true; break; }
    } catch {}
    await sleep(500);
  }
  if (!ready) throw new Error('Owned API startup timed out');
  await fs.writeFile(path.join(out, 'environment.json'), JSON.stringify(environment, null, 2));
  console.log(JSON.stringify({ ready: true, phase, apiPid: child.pid, evidence: out, sourceDigest }));
  stage = 'measurement';
  await run({ phase, out, base, mongoUri, sourceDigest, backend, require, fixturePath: options['--fixture'],
    deadline, environment, baselineDir: phase.startsWith('after') ? baselineDir : null,
    queryCountFor: options.queryCounts ? queryCountFor : null,
    apiPid: child.pid, tokenFor: id => require('jsonwebtoken').sign({ sub: String(id), type: 'access' }, jwtSecret, { algorithm: 'HS256', expiresIn: '1h' }) });
  console.log(JSON.stringify({ completed: true, evidence: out }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ failed: true, stage, errorType: error?.name ?? 'Error', code: error?.harnessCode ?? null, apiPid: child?.pid }, null, 2));
  console.error(`Performance run failed at ${stage} (${error?.harnessCode ?? error?.name ?? 'Error'}); evidence: ${out}`);
  process.exitCode = 1;
} finally {
  await stop();
  clearTimeout(watchdog);
  // Unlink the junction explicitly before recursive removal; never traverse shared dependencies.
  await fs.unlink(path.join(backend, 'node_modules')).catch(() => {});
  await fs.rm(snapshot, { recursive: true, force: true });
  await fs.writeFile(path.join(out, 'cleanup.json'), JSON.stringify({ apiPid: child?.pid, stopped: !child || exited, snapshotRemoved: true }, null, 2));
}
