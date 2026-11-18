'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '../../src');
/** Fail-closed source loader: no env, providers, sockets or runtime entrypoints in this test graph. */
function loader(overrides = {}) {
  const cache = new Map();
  return function load(relative) {
    const filename = path.resolve(root, relative).replace(/\.js$/, '.ts');
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const requireSafe = (name) => {
      const key = name.startsWith('.') ? path.relative(root, path.resolve(path.dirname(filename), name)).replaceAll('\\', '/').replace(/\.js$/, '.ts') : name;
      if (Object.hasOwn(overrides, key)) return overrides[key];
      if (name === 'mongoose') return mongoose;
      if (name === 'node:crypto') return require(name);
      assert.ok(/^(models\/|repositories\/(wallet|market|checkin|quest|bucket|story)\.repository\.ts$|services\/bucketCompletion\.service\.ts$|config\/economy\.ts$|utils\/(errors|date)\.ts$)/.test(key), `Unmocked unsafe import ${key}`);
      return load(key);
    };
    vm.runInNewContext(code, { module: mod, exports: mod.exports, require: requireSafe, Date, console, setTimeout, clearTimeout }, { filename });
    return mod.exports;
  };
}
const noop = async () => {};
// Legacy suites intentionally stay on v1; v2 policy/settlement has its own fail-closed fixtures.
const legacyPolicy = couple => ({ version: 2, effectiveDate: '9999-12-31', timezone: couple.timezone ?? 'UTC', activatedAt: new Date(0) });
const quiet = {
  'services/rewardPolicy.service.ts': { rewardPolicyService: {
    ensure: async couple => legacyPolicy(couple),
    forDay: async couple => ({ ...legacyPolicy(couple), version: 1 }),
  } },
  'services/dailyReward.service.ts': { dailyRewardService: {
    recoverCouple: noop, settleCheckins: async () => true,
    getCheckinRewardView: async (_couple, localDate) => ({ policyVersion: 1, effectiveDate: '9999-12-31', localDate,
      status: 'legacy', baseCoin: 0, bonusCoin: 0, coinAwarded: 0, commonStreak: null }),
  } },
  'services/bucketCompletion.service.ts': { finishBucketCompletion: async () => true },
  'services/realtimeAudience.service.ts': { realtimeAudience: { couple: noop, own: noop } },
  'services/notification.service.ts': { notificationService: { toPartner: noop, emit: noop } },
  'utils/logger.ts': { logger: { info() {}, warn() {}, error() {} } },
  'repositories/user.repository.ts': { userRepository: { findDisplayNames: async ids => new Map(ids.map(id => [String(id), 'Fixture'])) } },
};
module.exports = { loader, quiet, mongoose };
