'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// Run each suite in its own process: transport drains its singleton and replaces process.env.
const files = fs.readdirSync(__dirname).filter((name) => /(?:\.test\.(?:ts|cjs)|^finance\.cjs)$/.test(name)).sort();
for (const name of files) {
  const filename = path.join(__dirname, name);
  const args = name.endsWith('.ts')
    ? ['--import', pathToFileURL(path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs')).href, filename]
    : [filename];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 90000 });
  if (result.error || result.status !== 0) {
    console.error(`FAIL realtime suite: ${name}`);
    process.exit(result.status || 1);
  }
}
console.log(`PASS: ${files.length} realtime backend suites (isolated processes).`);
