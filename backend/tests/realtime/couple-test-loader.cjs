'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sourceRoot = path.resolve(__dirname, '../../src');
function compile(source, filename, mocks) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  function localRequire(specifier) {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    return require(specifier);
  }
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename })(localRequire, mod, mod.exports, filename, path.dirname(filename));
  return mod.exports;
}
function loadService(name, stubs) {
  const mocks = {};
  for (const [specifier, source] of Object.entries(stubs)) mocks[specifier] = compile(source, `mock:${specifier}`, {});
  const filename = path.join(sourceRoot, 'services', name);
  return compile(fs.readFileSync(filename, 'utf8'), filename, mocks);
}
module.exports = { loadService };
