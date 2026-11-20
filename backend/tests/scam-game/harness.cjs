'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../src');
const allowed = new Set(['services/scamGame/scenarios.ts', 'services/scamGame/rules.ts', 'services/scamGame/emotions.ts', 'services/scamGame/characters.ts', 'services/scamGame/ai.ts', 'services/scamGame.service.ts', 'repositories/scamGame.repository.ts', 'routes/scamGame.routes.ts', 'utils/errors.ts', 'integrations/ai/ChatProvider.ts', 'integrations/ai/BeeknoeeChatAdapter.ts']);
function loader(overrides = {}, globals = {}) {
  const cache = new Map();
  return function load(relative) {
    assert(allowed.has(relative), `Unsafe source ${relative}`);
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.resolve(root, relative), mod = { exports: {} }; cache.set(relative, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const safeRequire = name => {
      const key = name.startsWith('.') ? path.relative(root, path.resolve(path.dirname(filename), name)).replaceAll('\\', '/').replace(/\.js$/, '.ts') : name;
      if (Object.hasOwn(overrides, key)) return overrides[key];
      if (['node:crypto', 'zod', 'mongoose', 'express'].includes(name)) return require(name);
      assert(allowed.has(key), `Unmocked unsafe import ${key}`); return load(key);
    };
    vm.runInNewContext(code, { module: mod, exports: mod.exports, require: safeRequire, Date, Buffer, structuredClone, console, setTimeout, clearTimeout, ...globals }, { filename });
    return mod.exports;
  };
}
module.exports = { loader };
