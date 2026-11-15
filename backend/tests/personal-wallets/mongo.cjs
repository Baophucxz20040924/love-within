'use strict';
// Opt-in integration: only fresh random-prefix collections in local lookwithin_dev.
// No dotenv, providers, API server, existing collection writes or existing index mutations.
if (process.argv.length !== 3 || process.argv[2] !== '--local-lookwithin-dev') throw Error('Explicit --local-lookwithin-dev opt-in required');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loader, quiet, mongoose } = require('./harness.cjs');
const namespace = require('./namespace.cjs').install(mongoose);
const mocks = { ...quiet };
delete mocks['services/bucketCompletion.service.ts'];
const load = loader(mocks);
const { Couple } = load('models/Couple.ts');
const { Wallet } = load('models/Wallet.ts');
const { LedgerEntry } = load('models/LedgerEntry.ts');
const { WalletOperation } = load('models/WalletOperation.ts');
const { MarketRedemption, MarketItem } = load('models/Market.ts');
const { BucketItem, BucketRewardDay } = load('models/BucketItem.ts');
const { Story } = load('models/Story.ts');
const { questRepository } = load('repositories/quest.repository.ts');
const { bucketRepository, bucketRewardDayRepository } = load('repositories/bucket.repository.ts');
const { storyRepository } = load('repositories/story.repository.ts');
const { finishBucketCompletion } = load('services/bucketCompletion.service.ts');
// Only the media/provider boundary is substituted; Story/Bucket persistence and gate CAS are real Mongo.
let storyFault = null, storyCreates = 0;
mocks['services/story.service.ts'] = { storyService: { create: async (_couple, _actor, content, opts) => {
  if (storyFault === 'unavailable') throw Error('fixture story unavailable');
  storyCreates++;
  const saved = await storyRepository.createReserved(opts.reservedId, content);
  if (storyFault === 'afterInsert') { storyFault = null; throw Error('fixture story inserted, acknowledgement lost'); }
  return saved;
} } };
const { walletRepository: repo } = load('repositories/wallet.repository.ts');
const { walletService } = load('services/wallet.service.ts');
mocks['services/wallet.service.ts'] = { walletService };
const market = load('services/market.service.ts').marketService;
const tag = randomUUID();
const fixtureIds = [];
const fixture = async (balance) => {
  const _id = new mongoose.Types.ObjectId(); fixtureIds.push(_id);
  const memberIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()].sort((a,b) => String(a).localeCompare(String(b)));
  const couple = await Couple.create({ _id, memberIds });
  if (balance !== undefined) await Wallet.collection.insertOne({ coupleId: _id, coinBalance: balance });
  return { couple, a: String(memberIds[0]), b: String(memberIds[1]) };
};
const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const original = { apply: repo.apply, appendLedger: repo.appendLedger, commit: repo.commit, clear: repo.clear, expUpdate: Couple.findOneAndUpdate };
async function bucketScenarios() {
  const makeItem = (couple, actor) => BucketItem.create({ coupleId: couple._id, title: tag, emoji: '.', category: 'other',
    createdBy: actor, updatedBy: actor, createdAt: new Date(Date.now() - 3 * 86400000) });
  const makeIntent = (item, actor) => ({ operationId: `bucket:${item._id}`, actorUserId: actor, ownerUserId: null,
    coin: 5, exp: 9, localDate: '2026-01-01' });
  const doneFields = (actor, completion) => ({ doneOn: '2026-01-01', doneBy: new mongoose.Types.ObjectId(actor),
    doneAt: new Date(), doneNote: '', completion });
  // Actual Mongo ABA: A computes eligibility, B completes (pending or paid), reopen, stale A attempts CAS.
  for (const paid of [false, true]) {
    const { couple, a, b } = await fixture(0);
    const item = await makeItem(couple, a);
    const staleIntent = makeIntent(item, a);
    const originalIntent = makeIntent(item, b);
    const done = doneFields(b, { version: 1, ready: true, story: null });
    assert.ok(await bucketRepository.markDone(couple._id, item._id, done, originalIntent));
    let stored = await BucketItem.findById(item._id).lean();
    assert.equal(stored.status, 'done'); assert.deepEqual(stored.rewardIntent, originalIntent);
    assert.equal(stored.rewardedAt.getTime(), done.doneAt.getTime(), 'completion and intent survive same write');
    if (paid) await walletService.recoverRewards(couple._id);
    assert.ok(await bucketRepository.reopen(couple._id, item._id, new Date(0), new mongoose.Types.ObjectId(a)));
    assert.equal(await bucketRepository.markDone(couple._id, item._id,
      doneFields(a, { version: 1, ready: true, story: null }), { ...staleIntent, localDate: '2026-01-02' }), null);
    stored = await BucketItem.findById(item._id).lean();
    assert.deepEqual(stored.rewardIntent, originalIntent); assert.equal(stored.rewardedAt.getTime(), done.doneAt.getTime());
    assert.ok(await bucketRepository.markDone(couple._id, item._id, doneFields(a, { version: 1, ready: true, story: null }), null));
    await walletService.recoverRewards(couple._id); await walletService.recoverRewards(couple._id);
    assert.equal((await walletService.getView(couple._id, a)).coinBalance, 3);
    assert.equal((await walletService.getView(couple._id, b)).coinBalance, 2);
    assert.equal((await Couple.findById(couple._id)).exp, 9);
    assert.deepEqual((await BucketItem.findById(item._id).lean()).rewardIntent, originalIntent);
    assert.equal(await LedgerEntry.countDocuments({ coupleId: couple._id }), 3);
    const day = await BucketRewardDay.findOne({ coupleId: couple._id, localDate: originalIntent.localDate }).lean();
    assert.equal(day.count, 1); assert.deepEqual(day.operationIds, [originalIntent.operationId]);
  }
  // Persisted pending story gate survives old date + source deletion; no payment before confirmed Story.
  for (const boundary of ['afterInsert', 'promotion', 'slot']) {
    const { couple, a, b } = await fixture(0);
    const item = await makeItem(couple, a), intent = makeIntent(item, a);
    const storyId = new mongoose.Types.ObjectId();
    const done = doneFields(a, { version: 1, ready: false, story: { id: String(storyId), actorUserId: a,
      body: 'frozen fixture', happenedOn: '2026-01-01', photos: [] } });
    await bucketRepository.markDone(couple._id, item._id, done, intent);
    assert.equal(await bucketRepository.reopen(couple._id, item._id, new Date(0), new mongoose.Types.ObjectId(a)), null);
    await BucketItem.updateOne({ _id: item._id }, { $set: { deletedAt: new Date() } });
    storyCreates = 0; storyFault = 'unavailable';
    assert.equal((await walletService.getView(couple._id, a)).coinBalance, 0, 'failed gate cannot block unrelated wallet read');
    assert.equal((await Couple.findById(couple._id)).exp, 0);
    assert.equal(await WalletOperation.countDocuments({ coupleId: couple._id }), 0);
    assert.equal(await BucketRewardDay.countDocuments({ coupleId: couple._id }), 0);
    assert.equal((await BucketItem.findById(item._id)).completion.ready, false);
    storyFault = boundary === 'afterInsert' ? 'afterInsert' : null;
    const originalUpdate = BucketItem.findOneAndUpdate, originalTake = bucketRewardDayRepository.take;
    try {
      if (boundary === 'promotion') BucketItem.findOneAndUpdate = (...args) => {
        const query = originalUpdate.apply(BucketItem, args), exec = query.exec.bind(query);
        query.exec = async () => { const result = await exec();
          if (args[1].$set?.['completion.ready'] === true) throw Error('fixture promotion acknowledgement lost');
          return result;
        }; return query;
      };
      if (boundary === 'slot') bucketRewardDayRepository.take = async (...args) => {
        await originalTake(...args); throw Error('fixture slot acknowledgement lost');
      };
      if (boundary === 'slot') await assert.rejects(walletService.recoverRewards(couple._id), /slot acknowledgement/);
      else await walletService.recoverRewards(couple._id); // Gate failures are deliberately deferred.
    } finally { BucketItem.findOneAndUpdate = originalUpdate; bucketRewardDayRepository.take = originalTake; storyFault = null; }
    assert.equal(await WalletOperation.countDocuments({ coupleId: couple._id }), 0);
    assert.equal(await Story.countDocuments({ coupleId: couple._id }), 1);
    // Successful Story may have been edited/deleted after lost ack. Its immutable fingerprint still confirms creation.
    await Story.updateOne({ _id: storyId }, { $set: { body: 'edited after creation', deletedAt: new Date() } });
    await walletService.recoverRewards(couple._id); await walletService.recoverRewards(couple._id);
    assert.equal(storyCreates, 1); assert.equal(await Story.countDocuments({ coupleId: couple._id }), 1);
    assert.ok((await Story.findById(storyId)).deletedAt, 'recovery never resurrects deleted Story');
    const stored = await BucketItem.findById(item._id);
    assert.equal(stored.completion.ready, true); assert.ok(stored.rewardCompletedAt);
    assert.equal(String(stored.storyId), String(storyId)); assert.deepEqual(stored.rewardIntent, intent);
    assert.equal((await walletService.getView(couple._id, a)).coinBalance, 3);
    assert.equal((await walletService.getView(couple._id, b)).coinBalance, 2);
    assert.equal((await Couple.findById(couple._id)).exp, 9);
    assert.equal(await LedgerEntry.countDocuments({ coupleId: couple._id }), 3);
    const day = await BucketRewardDay.findOne({ coupleId: couple._id, localDate: intent.localDate }).lean();
    assert.equal(day.count, 1); assert.deepEqual(day.operationIds, [intent.operationId]);
    // A stale loaded gate cannot promote a different completion token/doneAt.
    const staleItem = await BucketItem.findById(item._id);
    staleItem.completion = { ...done.completion, ready: false }; staleItem.doneAt = new Date(0);
    assert.equal(await finishBucketCompletion(couple, staleItem), false);
  }
  const { couple, a } = await fixture(0), legacy = await makeItem(couple, a);
  await BucketItem.updateOne({ _id: legacy._id }, { $set: { status: 'done', doneAt: new Date(), rewardedAt: new Date() } });
  await walletService.recoverRewards(couple._id);
  assert.equal((await walletService.getView(couple._id, a)).coinBalance, 0);
  assert.equal(await WalletOperation.countDocuments({ coupleId: couple._id }), 0, 'historical done flag cannot invent intent');
}
async function run() {
  namespace.verify();
  await mongoose.connect(namespace.URI, { serverSelectionTimeoutMS: 3000 });
  await namespace.prepare();
  // Verify prerequisites only on fresh process-scoped collections, never existing app collections.
  for (const [model, required] of [[Wallet, ['coupleId_1']], [LedgerEntry, ['operationKey_1']], [MarketRedemption, ['market_one_open', 'market_request_key']]]) {
    const indexes = await model.collection.indexes();
    for (const name of required) assert.ok(indexes.some(i => i.name === name && i.unique), `Prepare required unique index ${name} with writers stopped`);
  }
  for (const balance of [0, 8, 9]) {
    const { couple, a, b } = await fixture(balance);
    const [left, right] = await Promise.all([walletService.getView(couple._id, a), walletService.getView(couple._id, b)]);
    assert.equal(left.coinBalance, Math.ceil(balance / 2)); assert.equal(right.coinBalance, Math.floor(balance / 2));
    const stored = await Wallet.findOne({ coupleId: couple._id }).lean();
    assert.equal(stored.coinBalance, balance); assert.equal(stored.migration.originalBalance, balance);
    assert.equal(Object.values(stored.migration.allocations).reduce((a,b) => a+b, 0), balance);
  }
  const { couple, a, b } = await fixture(21);
  const input = { coupleId: couple._id, actorUserId: a, reason: 'quest', coin: 5, exp: 9 };
  for (const step of ['apply', 'appendLedger', 'commit', 'clear']) {
    const operationId = `${tag}:${step}`;
    let injected = false;
    repo[step] = async (...args) => { const result = await original[step](...args); if (!injected) { injected = true; throw Error(`fault:${step}`); } return result; };
    await assert.rejects(walletService.reward({ ...input, operationId }), /fault/);
    repo[step] = original[step];
    await Promise.all([walletService.reward({ ...input, operationId }), walletService.reward({ ...input, operationId })]);
    await walletService.getView(couple._id, a);
    assert.equal(await LedgerEntry.countDocuments({ coupleId: couple._id, operationKey: { $regex: `${step}:` } }), 3);
  }
  const beforeExpFault = (await Couple.findById(couple._id)).exp;
  let expFault = true;
  Couple.findOneAndUpdate = (...args) => {
    const q = original.expUpdate.apply(Couple, args);
    const exec = q.exec.bind(q);
    q.exec = async () => { const result = await exec(); if (expFault && args[1].$inc?.exp) { expFault = false; throw Error('fault:exp'); } return result; };
    return q;
  };
  await assert.rejects(walletService.reward({ ...input, operationId: `${tag}:exp` }), /fault:exp/);
  Couple.findOneAndUpdate = original.expUpdate;
  await walletService.reward({ ...input, operationId: `${tag}:exp` });
  assert.equal((await Couple.findById(couple._id)).exp, beforeExpFault + 9);
  // Real Mongo revision-fencing: delayed CAS resumes after another worker commits and clears the journal.
  const entered = pause(), release = pause(); let first = true;
  repo.apply = async (...args) => { if (first) { first = false; entered.resolve(); await release.promise; } return original.apply(...args); };
  const beforeRace = (await Couple.findById(couple._id)).exp;
  const stale = walletService.reward({ ...input, operationId: `${tag}:stale` }); await entered.promise;
  await walletService.reward({ ...input, operationId: `${tag}:stale` }); release.resolve(); await stale;
  repo.apply = original.apply;
  assert.equal((await Couple.findById(couple._id)).exp, beforeRace + 9);
  await assert.rejects(walletService.reward({ ...input, operationId: `${tag}:stale`, coin: 6 }), e => e.status === 409);
  // Terminal lookup must not even read a wallet snapshot, including after bounded receipt compaction.
  const get = repo.getOrCreate; repo.getOrCreate = () => { throw Error('snapshot should not be read'); };
  try { await walletService.reward({ ...input, operationId: `${tag}:stale` }); } finally { repo.getOrCreate = get; }
  // Personal insufficiency even when total would suffice.
  const own = await walletService.getView(couple._id, a);
  await assert.rejects(walletService.applyCoin({ coupleId: couple._id, operationId: `${tag}:insufficient`, actorUserId: a, ownerUserId: a, delta: -own.coinBalance - 1, reason: 'admin' }), e => e.status === 422);
  const item = await MarketItem.create({ coupleId: couple._id, createdBy: b, title: tag, priceCoin: 3 });
  const beforeBuyA = (await walletService.getView(couple._id, a)).coinBalance;
  const beforeBuyB = (await walletService.getView(couple._id, b)).coinBalance;
  const requests = await Promise.all([market.request(couple, a, String(item._id), `${tag}-request`), market.request(couple, a, String(item._id), `${tag}-request`)]);
  assert.equal(requests[0].redemption.id, requests[1].redemption.id);
  assert.equal((await walletService.getView(couple._id, a)).coinBalance, beforeBuyA - 3);
  const outcomes = await Promise.allSettled([market.cancel(couple, a, requests[0].redemption.id), market.decline(couple, b, requests[0].redemption.id, null)]);
  assert.ok(outcomes.some(o => o.status === 'fulfilled'));
  await market.history(couple, a);
  assert.equal((await walletService.getView(couple._id, a)).coinBalance, beforeBuyA);
  assert.equal((await walletService.getView(couple._id, b)).coinBalance, beforeBuyB);
  // A legacy requested debit was already excluded from the old available balance. Refund only its buyer.
  const legacy = await MarketRedemption.create({ coupleId: couple._id, itemId: item._id, itemTitle: tag, buyerUserId: a, sellerUserId: b, priceCoin: 7, status: 'requested' });
  await market.decline(couple, b, String(legacy._id), null);
  await market.decline(couple, b, String(legacy._id), null);
  assert.equal((await walletService.getView(couple._id, a)).coinBalance, beforeBuyA + 7);
  assert.equal((await walletService.getView(couple._id, b)).coinBalance, beforeBuyB);
  const historical = await MarketRedemption.create({ coupleId: couple._id, itemId: item._id, itemTitle: tag, buyerUserId: a, sellerUserId: b, priceCoin: 100, status: 'declined' });
  await market.decline(couple, b, String(historical._id), null);
  assert.equal((await walletService.getView(couple._id, a)).coinBalance, beforeBuyA + 7, 'ambiguous historical terminal is never refunded');
  const bad = await fixture(-1); await assert.rejects(walletService.getView(bad.couple._id, bad.a), e => e.code === 'WALLET_REVIEW_REQUIRED');
  await bucketScenarios();
  const momentDay = '2090-11-15';
  await questRepository.ensureProgress(couple._id, 'duo_moment', momentDay, 2);
  await questRepository.setProgress(couple._id, 'duo_moment', momentDay, 2, 2);
  assert.equal(await questRepository.setProgress(couple._id, 'duo_moment', momentDay, 1, 2), null);
  const ready = await questRepository.findOne(couple._id, 'duo_moment', momentDay);
  assert.equal(ready.status, 'completed'); assert.equal(ready.progress, 2);
  const intent = { operationId: `quest:${ready._id}`, actorUserId: a, ownerUserId: null, coin: 40, exp: 5 };
  const [beforeMomentA, beforeMomentB] = await Promise.all([walletService.getView(couple._id, a), walletService.getView(couple._id, b)]);
  const claimed = await questRepository.markRewarded(couple._id, 'duo_moment', momentDay, new mongoose.Types.ObjectId(a), intent);
  assert.ok(claimed);
  for (let i = 0; i < 2; i++) await walletService.reward({ ...claimed.rewardIntent, coupleId: couple._id, reason: 'quest', refId: claimed._id });
  assert.equal((await walletService.getView(couple._id, a)).coinBalance, beforeMomentA.coinBalance + 20);
  assert.equal((await walletService.getView(couple._id, b)).coinBalance, beforeMomentB.coinBalance + 20);
  assert.equal((await walletService.getView(couple._id, a)).exp, beforeMomentA.exp + 5);
  assert.equal(await questRepository.setProgress(couple._id, 'duo_moment', momentDay, 0, 2), null);
  console.log('PASS Mongo daily moment quest: stale refresh cannot demote, 40 Xu splits20/20 and5EXP once on replay');
  console.log('PASS standalone Mongo wallets: migration, concurrent operations, durable fault recovery, fencing, personal spend/refund and market race');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  Object.assign(repo, { apply: original.apply, appendLedger: original.appendLedger, commit: original.commit, clear: original.clear });
  Couple.findOneAndUpdate = original.expUpdate;
  try { if (mongoose.connection.readyState === 1) await namespace.cleanup(); }
  finally { await mongoose.disconnect(); }
});
