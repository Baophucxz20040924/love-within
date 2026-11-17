'use strict';
// Synthetic subprocesses only: no Mongo, Docker, SSH, dotenv or providers.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const cli = path.join(backend, 'dist/commands/bootstrap-admin.js');
const secret = 'synthetic secret $ ` quotes \' "';
const harness = String.raw`
const Module = require('node:module');
const original = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'mongoose') return { connect: async () => { console.log('CONNECT'); }, disconnect: async () => { console.log('DISCONNECT'); } };
  if (request.endsWith('/models/User.js')) return { User: { createIndexes: async () => { console.log('INDEX'); } } };
  if (request.endsWith('/services/adminBootstrap.service.js')) return { bootstrapAdmin: async password => {
    if (password !== process.env.EXPECTED) throw new Error('wrong input');
    if (process.env.MODE === 'fail') throw new Error('synthetic secret should never be logged ' + password);
    return process.env.MODE === 'exists' ? 'exists' : 'created';
  } };
  return original.apply(this, arguments);
};
process.argv = ['node', 'bootstrap-admin', ...JSON.parse(process.env.ARGS)];
require(process.env.CLI);
`;
function runCli({ args = ['--password-stdin'], input = secret, mode = 'created', uri = 'synthetic-uri' } = {}) {
  return spawnSync(process.execPath, ['-e', harness], {
    input, encoding: 'utf8', env: { PATH: process.env.PATH, CLI: cli, ARGS: JSON.stringify(args), EXPECTED: secret, MONGODB_URI: uri, MODE: mode },
  });
}
for (const mode of ['created', 'exists']) {
  const result = runCli({ mode });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, mode === 'created' ? /Admin created/ : /Admin already exists/);
  assert.match(result.stdout, /CONNECT[\s\S]*INDEX[\s\S]*DISCONNECT/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
}
for (const options of [{ mode: 'fail' }, { args: ['--password-stdin', secret] }, { uri: '' }, { input: secret + '\nextra' }]) {
  const result = runCli(options);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Admin bootstrap failed/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
  if (options.mode === 'fail') assert.match(result.stdout, /DISCONNECT/);
  else assert.doesNotMatch(result.stdout, /CONNECT/);
}

const workflow = fs.readFileSync(path.join(backend, '../.github/workflows/deploy-backend-dev.yml'), 'utf8').replace(/\r\n/g, '\n');
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const end = workflow.indexOf('\n      - ', start + 1);
  const block = workflow.slice(start, end === -1 ? undefined : end);
  const run = block.split('        run: |\n')[1];
  assert.ok(run, name);
  return run.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}
const validate = step('Validate admin bootstrap secret');
const pull = step('Pull exact API image on the VPS');
const bootstrap = step('Bootstrap admin on the VPS');
const restart = step('Persist image and restart on the VPS');
assert.ok(workflow.indexOf('name: Validate admin bootstrap secret') < workflow.indexOf('name: Build and push image'));
assert.ok(workflow.indexOf('name: Pull exact API image') < workflow.indexOf('name: Bootstrap admin'));
assert.ok(workflow.indexOf('name: Bootstrap admin') < workflow.indexOf('name: Persist image'));
assert.match(pull, /IMAGE=.*docker compose pull api/);
assert.doesNotMatch(pull, /sed -i|>> \.env/);
assert.match(bootstrap, /docker compose run --rm -T --no-deps api node dist\/commands\/bootstrap-admin\.js --password-stdin/);
assert.match(bootstrap, /IMAGE=/);
assert.doesNotMatch(bootstrap, /<<|ADMIN_BOOTSTRAP_PASSWORD=.*docker compose/);
assert.match(restart, /sed -i/);
assert.match(restart, /docker compose up -d/);

// Run the actual workflow snippets with a fake SSH binary. It records stdin/args only;
// it never connects, invokes Docker, or evaluates the remote command.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-transport-'));
try {
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  const log = path.join(temp, 'log');
  const ssh = path.join(bin, 'ssh');
  fs.writeFileSync(ssh, '#!/bin/sh\nprintf "CALL\\n" >> "$MOCK_LOG"\nprintf "%s\\n" "$@" >> "$MOCK_LOG"\nprintf "STDIN=" >> "$MOCK_LOG"\nwhile IFS= read -r line || [ -n "$line" ]; do printf "%s" "$line" >> "$MOCK_LOG"; done\nprintf "\\nEND\\n" >> "$MOCK_LOG"\nexit "${MOCK_STATUS:-0}"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, MOCK_LOG: log, VPS_PORT: '22', VPS_USER: 'synthetic-user', VPS_HOST: 'example.invalid', VPS_PATH: '/opt/synthetic', IMAGE: 'ghcr.io/example/backend:123', GHCR_USER: 'synthetic', GHCR_TOKEN: 'synthetic-token', ADMIN_BOOTSTRAP_PASSWORD: secret };
  function run(script, overrides = {}) { return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...env, ...overrides } }); }
  assert.equal(run(validate, { ADMIN_BOOTSTRAP_PASSWORD: '' }).status, 1);
  assert.equal(fs.existsSync(log), false);
  assert.equal(run(bootstrap, { ADMIN_BOOTSTRAP_PASSWORD: '' }).status, 1);
  assert.equal(fs.existsSync(log), false);
  assert.equal(run(pull).status, 0);
  assert.equal(run(bootstrap).status, 0);
  const calls = fs.readFileSync(log, 'utf8');
  assert.ok(calls.includes(`STDIN=${secret}\nEND`));
  assert.equal(calls.split(secret).length - 1, 1, 'password must occur only in stdin');
  assert.match(calls, /-T\n/);
  const failed = run(bootstrap, { MOCK_STATUS: '7' });
  assert.equal(failed.status, 7);
  assert.ok(!(failed.stdout + failed.stderr).includes(secret));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('PASS compiled bootstrap CLI and dev deployment transport');
