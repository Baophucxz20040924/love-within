'use strict';
// Repository-only synthetic model test: no dotenv, Mongo, server, or push provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { PushSubscription } = require('../../dist/models/PushSubscription.js');
const { pushSubscriptionRepository: repo } = require('../../dist/repositories/pushSubscription.repository.js');
const original = PushSubscription.findOneAndUpdate;
const a = new Types.ObjectId(), b = new Types.ObjectId();
const endpoint = 'https://fcm.googleapis.com/synthetic-only';
const input = (userId, credentialVersion) => ({ userId, credentialVersion, endpoint, keys: { p256dh: 'synthetic', auth: 'synthetic' }, userAgent: 'Synthetic' });

test('delayed pre-reset device write cannot downgrade a newly registered credential generation', async () => {
  let row = null;
  let operations = 0;
  PushSubscription.findOneAndUpdate = (filter, update, options) => ({ exec: async () => {
    operations++;
    // Verify the actual repository query carries all three guarded cases (rather than making a read/check/write decision).
    assert.equal(filter.endpoint, endpoint);
    assert.equal(filter.$or[0].userId.$ne.toString(), update.$set.userId.toString());
    assert.equal(filter.$or[1].credentialVersion.$lte, update.$set.credentialVersion);
    assert.equal(filter.$or[2].credentialVersion.$exists, false);
    const allowed = row && (row.userId.toString() !== update.$set.userId.toString() ||
      row.credentialVersion === undefined || row.credentialVersion <= update.$set.credentialVersion);
    if (allowed) { row = { ...row, ...update.$set }; return { ...row }; }
    if (!options.upsert) return null;
    if (row) throw Object.assign(new Error('synthetic duplicate endpoint'), { code: 11000 });
    row = { _id: new Types.ObjectId(), ...update.$set }; return { ...row };
  } });
  try {
    await repo.upsert(input(a, 0));
    // Recovery rotates credentials twice. The new login finishes its registration first.
    await repo.upsert(input(a, 2));
    const preserved = row.keys;
    await assert.rejects(() => repo.upsert({ ...input(a, 0), keys: { p256dh: 'stale', auth: 'stale' } }), e => e.status === 409);
    assert.equal(row.credentialVersion, 2);
    assert.equal(row.keys, preserved);
    assert.equal(operations, 4); // stale insert conflict followed by guarded, non-upserting retry
    await repo.upsert(input(a, 2)); // normal idempotent registration
    await repo.upsert(input(b, 0)); // endpoint transfer to another account remains valid
    assert.equal(row.userId.toString(), b.toString()); assert.equal(row.credentialVersion, 0);
    delete row.credentialVersion;
    await repo.upsert(input(b, 0)); // legacy zero can be upgraded to an explicit zero
    assert.equal(row.credentialVersion, 0);
    delete row.credentialVersion;
    await repo.upsert(input(b, 3));
    assert.equal(row.credentialVersion, 3);
    await assert.rejects(() => repo.upsert(input(b, -1)), e => e.status === 401);
  } finally { PushSubscription.findOneAndUpdate = original; }
});

test('a concurrent first registration retries only a version-guarded update', async () => {
  let attempts = 0;
  PushSubscription.findOneAndUpdate = (filter, update, options) => ({ exec: async () => {
    attempts++;
    assert.ok(filter.$or);
    if (attempts === 1) { assert.equal(options.upsert, true); throw Object.assign(new Error('first insert raced'), { code: 11000 }); }
    assert.notEqual(options.upsert, true);
    return { _id: new Types.ObjectId(), ...update.$set };
  } });
  try { assert.equal((await repo.upsert(input(a, 0))).credentialVersion, 0); assert.equal(attempts, 2); }
  finally { PushSubscription.findOneAndUpdate = original; }
});
