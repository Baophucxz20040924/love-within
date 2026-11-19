'use strict';

// Keep this an explicit, audited list; browser helpers can start listeners.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const suites = [
  'tests/scam-game.cjs',
  'tests/app-lock/store.cjs',
  'tests/app-lock/tokens.cjs',
  'tests/app-lock/pin-entry.cjs',
  'scripts/test-auth-storage.cjs',
  'scripts/test-session-mutations.cjs',
  'tests/admin-session.cjs',
  'tests/discovery/navigation.cjs',
  'tests/prefetch/routes.cjs',
  'tests/history/ledger.cjs',
  'tests/history/comments.cjs',
  'tests/history/friend-comments.cjs',
  'tests/history/cancellation.cjs',
  'tests/realtime/realtime.cjs',
  'tests/realtime/teardown.cjs',
  'tests/notifications/notifications.cjs',
  'tests/moments.cjs',
  'tests/moments/transport.cjs',
  'tests/water/manual-proof.cjs',
  'tests/push/api.cjs',
  'tests/push/device.cjs',
  'tests/push/onboarding-policy.cjs',
  'tests/push/onboarding-ui.cjs',
  'tests/push/sw.cjs',
  'tests/push/ui.cjs',
  'tests/post-media/media.cjs',
  'tests/post-media/upload.cjs',
  'tests/post-media/player.cjs',
  'tests/post-media/composer.cjs',
];
for (const suite of suites) {
  console.log(`\n--- ${suite} ---`);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', suite)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
