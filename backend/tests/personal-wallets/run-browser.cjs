'use strict';
// Owns only its scoped mock API child. Existing Vite5175 stays running.
if (process.argv.length !== 3 || process.argv[2] !== '--local-mock-runtime') throw Error('Explicit local mock opt-in required');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(4002, '127.0.0.1', () => probe.close(resolve));
  });
}
async function runSuite(suite) {
  await freePort();
  const api = spawn(process.execPath, [path.join(__dirname, 'mock-runtime.cjs'), '--local-mock-runtime'], {
    cwd: path.join(root, 'backend'), stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(`Owned scoped API PID ${api.pid}`);
  let ready = false, exited = false, buffer = '';
  const done = new Promise(resolve => api.once('exit', code => { exited = true; resolve(code); }));
  api.stdout.on('data', chunk => {
    buffer = (buffer + chunk.toString()).slice(-4096);
    if (buffer.includes('Isolated mock API 127.0.0.1:4002;')) ready = true;
  });
  // Suppress raw API logs: browser evidence carries only sanitized assertions.
  api.stderr.on('data', () => {});
  try {
    const deadline = Date.now() + 45000;
    while (!ready && !exited && Date.now() < deadline) await wait(100);
    if (!ready || exited) throw Error('Scoped mock API did not become ready');
    {
      const code = await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(root, `frontend/tests/${suite}/browser.mjs`), '--local-mock-runtime'], {
          cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.once('error', () => resolve(1));
        child.once('exit', resolve);
      });
      if (code !== 0) throw Error(`${suite} browser suite failed`);
    }
  } finally {
    if (!exited) api.stdin.end('stop\n');
    const timeout = Symbol('timeout');
    const result = await Promise.race([done, wait(15000).then(() => timeout)]);
    if (result === timeout) {
      // Kill only the child created above. Abrupt stop may leave its private prefix for manual cleanup.
      api.kill();
      throw Error('Owned API shutdown timed out; private fixture collections may remain');
    }
    console.log(`Owned API stopped with exit ${result}; Vite left running`);
    if (result !== 0) throw Error('Scoped API did not report a clean shutdown');
  }
}
async function main() {
  // Fresh owned API per suite avoids cross-suite rate-limit interference without weakening limits.
  for (const suite of ['personal-wallets', 'moments']) await runSuite(suite);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
