'use strict';

// Each entry has been reviewed for offline initialization and uses synthetic fixtures.
// Keep explicit filenames: adjacent Mongo and browser helpers are not safe here.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const suites = [
  'scam-game/state.cjs',
  'scam-game/ai-board.cjs',
  'personal-wallets/service.cjs',
  'personal-wallets/me-settled.cjs',
  'http-contract/thread-pages.cjs',
  'moments/couple-reminder-fairness.cjs',
  'personal-wallets/pagination.cjs',
  'personal-wallets/comment-pages.cjs',
  'outings/direct-membership.test.cjs',
  'observability/bank-lifecycle.cjs',
  'moments/friend-reminder-fairness.cjs',
  'personal-wallets/market.cjs',
  'personal-wallets/rewards.cjs',
  'personal-wallets/moment-rewards.cjs',
  'personal-wallets/bucket-completion.cjs',
  'personal-wallets/reward-policy.cjs',
  'personal-wallets/rewards-v2.cjs',
  'personal-wallets/daily-settlement.cjs',
  'personal-wallets/checkin-boundary.cjs',
  'moments/moments.test.cjs',
  'moments/push.test.cjs',
  'moments/fairness.test.cjs',
  'http-contract/routes.test.cjs',
  'water/manual-proof.test.cjs',
  'couple-notifications/inbox.test.cjs',
  'push/account-wide.test.cjs',
  'observability/security.cjs',
  'observability/recovery.cjs',
  'credentials/unit.cjs',
  'privacy-lock/service.cjs',
];
for (const suite of suites) {
  console.log(`\n--- ${suite} ---`);
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
