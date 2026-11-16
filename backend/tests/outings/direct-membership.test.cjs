'use strict';
// Real service, mutation, views, math, validation, schemas, capacity and notification adapter.
// Only persistence and external boundaries are replaced; no server, env, database or push provider.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
function installed(name) {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const base of [dir, path.join(dir, 'backend'), path.join(dir, 'frontend')]) {
      try { return require(require.resolve(name, { paths: [base] })); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    if (path.dirname(dir) === dir) throw Error(`Installed ${name} not found`);
  }
}
const ts = installed('typescript'), mongoose = installed('mongoose'), zod = installed('zod');
const src = path.resolve(__dirname, '../../src');
const id = (n) => n.toString(16).padStart(24, '0');
const A = id(1), B = id(2), C = id(3), D = id(4), P = id(5), X = id(6), EVENT = id(100);
const user = (value) => ({ _id: new mongoose.Types.ObjectId(value), displayName: `Person ${value}`, friendsNotifSeenAt: null });
const plain = (value) => JSON.parse(JSON.stringify(value));
const clone = (value) => value == null ? value : mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(value));
const expectCode = (code) => (error) => { assert.equal(error.code, code); return true; };

function harness() {
  const state = { stored: null, creates: 0, cas: 0, notifications: [], hints: [], pushes: [], rows: [],
    friendships: new Map(), blocks: [], blockChecks: [], mode: 'ok', event: { _id: user(EVENT)._id, creatorId: user(A)._id, inviteeIds: [user(B)._id, user(C)._id] } };
  const pair = (a, b) => [a.toString(), b.toString()].sort().join(':');
  const friends = (a, b) => state.friendships.get(pair(a, b)) ?? 'accepted';
  const friendshipRepository = {
    listBetween: async (a, ids) => ids.filter((b) => friends(a, b) !== 'missing').map((b) => ({ status: friends(a, b) })),
    areFriends: async (a, b) => friends(a, b) === 'accepted', countIncomingPending: async () => 0,
  };
  const friendBlockRepository = {
    isBlockedBetween: async (a, b) => state.blocks.some(([x, y]) => pair(a, b) === pair(x, y)),
    blockedIdsFor: async (a) => new Set(state.blocks.filter((p) => p.includes(a.toString())).flat().filter((b) => b !== a.toString())),
  };
  const profileService = { load: async (ids) => new Map(ids.map((value) => [value.toString(), { id: value.toString(), displayName: 'Member' }])) };
  const friendNotificationRepository = {
    add: async (to, type, actorId, entityId) => { state.rows.push({ _id: new mongoose.Types.ObjectId(), userId: to, type, entityId,
      actorIds: [actorId], recentActorIds: [actorId], readAt: null, updatedAt: new Date() }); },
    list: async (to) => state.rows.filter((r) => r.userId.equals(to)),
    listSince: async (to) => state.rows.filter((r) => r.userId.equals(to)),
  };
  const mocks = {
    'models/FriendSafety.ts': { FriendBlock: {} },
    'repositories/friendship.repository.ts': { friendshipRepository },
    'repositories/friendSafety.repository.ts': { friendBlockRepository },
    'repositories/friendNotification.repository.ts': { friendNotificationRepository },
    'repositories/user.repository.ts': { userRepository: {} },
    // Couple-only imports of the shared notification entry point stay inert in Friends tests.
    'repositories/coupleNotification.repository.ts': { coupleNotificationRepository: {} },
    'repositories/couple.repository.ts': { coupleRepository: {} },
    'services/coupleNotifications.service.ts': { invalidateCoupleNotifications: async () => {} },
    'models/FriendEvent.ts': { FriendEvent: {} }, 'models/FriendStory.ts': { FriendStory: {} }, 'models/FriendStoryComment.ts': { FriendStoryComment: {} },
    'services/friendEvent.service.ts': { friendEventService: { visibleEvent: async () => {
      if (!state.event) throw load('utils/errors.ts').Errors.notFound();
      return state.event;
    } } },
    'services/profile.service.ts': { profileService, profileOf: (profiles, value) => profiles.get(value.toString()) },
    'services/realtimeAudience.service.ts': { realtimeAudience: { outing: async (doc, domains) => { state.hints.push({ revision: doc.revision, participants: plain(doc.participants), domains }); }, own: async () => {} } },
    'services/realtime.service.ts': { realtimeService: {} },
    'services/friendSuggestion.service.ts': { invalidateSuggestionCache() {} },
    'services/push.service.ts': { pushService: { enqueue: (job) => state.pushes.push(job) } },
    'utils/logger.ts': { logger: { warn() {} } },
  };
  const actual = new Set(['models/FriendOuting.ts', 'models/FriendNotification.ts', 'repositories/friendOuting.repository.ts',
    'services/friendOuting.service.ts', 'services/friendOuting.mutations.ts', 'services/friendOuting.views.ts',
    'services/friendOuting.validation.ts', 'services/friendExpenseMath.ts', 'utils/errors.ts',
    'services/friendOutingNotifications.ts', 'services/notification.service.ts', 'services/friendNotifications.service.ts', 'config/notificationTypes.ts']);
  const cache = new Map();
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (cache.has(relative)) return cache.get(relative).exports;
    assert.ok(actual.has(relative), `Unexpected module boundary: ${relative}`);
    const filename = path.join(src, relative), module = { exports: {} };
    cache.set(relative, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const localRequire = (name) => {
      if (name === 'mongoose') return { ...mongoose, model: (name, schema) => mongoose.models[name] ?? mongoose.model(name, schema) };
      if (name === 'zod') return zod;
      if (name === 'node:crypto') return require(name);
      assert.ok(name.startsWith('.'), `Unexpected external dependency: ${name}`);
      return load(path.relative(src, path.resolve(path.dirname(filename), name)).replaceAll('\\', '/').replace(/\.js$/, '.ts'));
    };
    new Function('require', 'module', 'exports', `${code}\n//# sourceURL=${filename.replaceAll('\\', '/')}`)(localRequire, module, module.exports);
    return module.exports;
  }
  const repositoryModule = load('repositories/friendOuting.repository.ts');
  const repo = repositoryModule.friendOutingRepository;
  const actualRepo = { ...repo };
  // Exercise actual capacity/BSON helpers but replace database access with snapshot-isolated CAS.
  Object.assign(repo, {
    find: async (outingId) => state.stored?._id.toString() === outingId && !state.stored.deletedAt ? clone(state.stored) : null,
    findRaw: async (outingId) => state.stored?._id.toString() === outingId ? clone(state.stored) : null,
    findCreate: async (creatorId, op) => state.stored?.creatorId === creatorId && state.stored.createOperationId === op ? clone(state.stored) : null,
    create: async (doc) => {
      state.creates++;
      if (state.mode === 'duplicate-event') throw Object.assign(Error('duplicate'), { code: 11000 });
      if (state.mode === 'unknown') throw Error('write unavailable');
      state.stored = clone(doc);
      if (state.mode === 'ambiguous') throw Error('ack lost');
    },
    compareAndSwap: async (revision, doc) => {
      state.cas++;
      if (state.mode === 'fail' || state.stored.deletedAt || state.stored.revision !== revision) return false;
      if (state.mode === 'unknown') throw Error('write unavailable');
      state.stored = clone(doc);
      if (state.mode === 'ambiguous') throw Error('ack lost');
      if (state.mode === 'race-replay') return false;
      return true;
    },
    groupHasBlock: async (ids) => { state.blockChecks.push([...ids]); return state.blocks.some(([a, b]) => ids.includes(a) && ids.includes(b)); },
    list: async (who) => state.stored && !state.stored.deletedAt && state.stored.participants.some((p) => p.userId === who) ? [clone(state.stored)] : [],
    headers: async (who, ids) => state.stored && !state.stored.deletedAt && ids.includes(state.stored._id.toString()) && state.stored.participants.some((p) => p.userId === who) ? [clone(state.stored)] : [],
  });
  const serviceModule = load('services/friendOuting.service.ts'), service = serviceModule.friendOutingService;
  serviceModule.configureFriendOutingNotifications(async (event) => state.notifications.push(event));
  const { outingSchemas } = load('services/friendOuting.validation.ts');
  let sequence = 0;
  const createInput = (extra = {}) => outingSchemas.create.parse({ operationId: `create_${++sequence}`, expectedRevision: 0, title: 'Private trip title', outingDate: '2026-11-16', inviteeIds: [B], ...extra });
  const input = (extra = {}) => ({ operationId: `operation_${++sequence}`, expectedRevision: state.stored.revision, ...extra });
  const mutate = (kind, extra = {}, who = A, targetId) => service.mutate(user(who), state.stored._id.toString(), kind, input(extra), targetId);
  return { state, load, repo, actualRepo, service, createInput, input, mutate, pair, limits: load('models/FriendOuting.ts').OUTING_LIMITS };
}

function participant(who, status = 'accepted', consent = null) { return { userId: who, displayName: 'Member', status, consent }; }

test('create adds accepted members with full detail/list/access, null consent and initial revisions; new members can record expenses', async () => {
  const h = harness(), request = h.createInput({ inviteeIds: [B, C] });
  const created = await h.service.create(user(A), request);
  assert.equal(created.outcome.replayed, false);
  assert.equal(created.outing.phase, 'collecting');
  assert.equal(created.outing.revision, 1); assert.equal(created.outing.financeRevision, 1);
  assert.deepEqual(created.outing.participants.map((p) => [p.status, p.consent]), [['accepted', null], ['accepted', null], ['accepted', null]]);
  await new (h.load('models/FriendOuting.ts').FriendOuting)(h.state.stored).validate();
  const outingId = h.state.stored._id.toString();
  for (const who of [B, C]) {
    const view = await h.service.get(user(who), outingId);
    assert.equal(view.access, 'full'); assert.equal(view.myMembership, 'accepted'); assert.ok(view.expenses);
    const list = await h.service.list(user(who), { limit: 20 });
    assert.equal(list.items[0].memberCount, 3); assert.equal(list.items[0].access, 'full');
    assert.equal((await h.service.notificationVisibility(who, [outingId])).get(outingId).visible, true);
  }
  await assert.rejects(h.service.get(user(D), outingId), expectCode('NOT_FOUND'));
  assert.deepEqual(h.state.notifications.map((n) => [n.type, n.recipientIds]), [['outing_added', [B, C]]]);
  await h.mutate('expense_create', { title: 'Dinner', amount: 900, splitMode: 'equal', participantIds: [A, B, C] }, B);
  assert.equal(h.state.stored.expenses[0].payerId, B);
  assert.equal(h.state.stored.financeRevision, 2);
  assert.ok(h.state.stored.participants.every((p) => p.consent === null));
});

test('real invite mutation adds the whole batch once, clears all consent, reopens review, and preserves old expense allocations', async () => {
  const h = harness();
  await h.service.create(user(A), h.createInput());
  await h.mutate('expense_create', { title: 'Old expense', amount: 200, splitMode: 'equal', participantIds: [A, B] });
  await h.mutate('close_review');
  await h.mutate('approve', { financeRevision: h.state.stored.financeRevision });
  await h.mutate('object', { financeRevision: h.state.stored.financeRevision }, B);
  const before = clone(h.state.stored), request = h.input({ userIds: [C, D] });
  const result = await h.service.mutate(user(A), before._id.toString(), 'invite', request);
  assert.equal(result.outing.phase, 'collecting');
  assert.equal(result.outing.revision, before.revision + 1);
  assert.equal(result.outing.financeRevision, before.financeRevision + 1, 'one increment for a multi-member add');
  assert.equal(h.state.stored.editCount, before.editCount + 1);
  assert.equal(h.state.stored.ordinaryOperations, before.ordinaryOperations + 1);
  assert.equal(h.state.stored.receipts.length, before.receipts.length + 1);
  assert.equal(h.state.stored.receipts.at(-1).financeRevision, before.financeRevision + 1);
  assert.ok(h.state.stored.participants.every((p) => p.status === 'accepted' && p.consent === null));
  assert.deepEqual(plain(h.state.stored.expenses), plain(before.expenses), 'no retroactive rebalance');
  assert.equal(result.outing.balances.find((b) => b.userId === C).share, 0);
  assert.deepEqual(h.state.notifications.at(-1).recipientIds, [C, D]);
  assert.equal(h.state.notifications.at(-1).type, 'outing_added');
  await h.mutate('close_review');
  await assert.rejects(h.mutate('approve', { financeRevision: before.financeRevision }), expectCode('OUTING_FINANCE_REVISION'));
  for (const who of [A, B, C]) await h.mutate('approve', { financeRevision: h.state.stored.financeRevision }, who);
  assert.equal(h.state.stored.phase, 'review', 'membership is not consent: every new member must still approve');
  await h.mutate('approve', { financeRevision: h.state.stored.financeRevision }, D);
  assert.equal(h.state.stored.phase, 'settling');
});

test('new members are immediately valid equal/custom allocation targets and payers', async () => {
  const h = harness(); await h.service.create(user(A), h.createInput());
  await h.mutate('invite', { userIds: [C] });
  await h.mutate('expense_create', { title: 'Equal', amount: 300, splitMode: 'equal', participantIds: [A, B, C] });
  assert.equal(h.state.stored.expenses[0].allocations.find((a) => a.userId === C).amount, 100);
  await h.mutate('expense_create', { title: 'Custom', amount: 120, splitMode: 'custom', allocations: [{ userId: A, amount: 20 }, { userId: C, amount: 100 }] }, C);
  assert.equal(h.state.stored.expenses[1].payerId, C);
  assert.equal(h.state.stored.expenses[1].allocations.find((a) => a.userId === C).amount, 100);
  assert.ok(h.state.stored.participants.every((p) => p.consent === null));
});

test('legacy pending/declined rows are not reactivated; duplicates of every status are rejected and legacy acceptance remains explicit', async () => {
  const h = harness(); await h.service.create(user(A), h.createInput());
  h.state.stored.participants.push(participant(P, 'pending'), participant(X, 'declined'));
  const before = plain(h.state.stored), writes = h.state.cas;
  for (const existing of [A, B, P, X]) await assert.rejects(h.mutate('invite', { userIds: [existing, C] }), expectCode('BAD_REQUEST'));
  assert.deepEqual(plain(h.state.stored), before); assert.equal(h.state.cas, writes);
  await h.mutate('invite', { userIds: [C] });
  assert.equal(h.state.stored.participants.find((p) => p.userId === P).status, 'pending');
  assert.equal(h.state.stored.participants.find((p) => p.userId === X).status, 'declined');
  const outingId = h.state.stored._id.toString();
  assert.equal((await h.service.get(user(P), outingId)).access, 'invited');
  assert.equal((await h.service.get(user(X), outingId)).access, 'declined');
  await assert.rejects(h.mutate('expense_create', { title: 'Not a member', amount: 10, splitMode: 'equal', participantIds: [A, P] }), expectCode('BAD_REQUEST'));
  await assert.rejects(h.mutate('accept', {}, X), expectCode('OUTING_MEMBERSHIP'));
  const revision = h.state.stored.financeRevision;
  await h.mutate('accept', {}, P);
  assert.equal(h.state.stored.financeRevision, revision + 1);
  assert.equal(h.state.stored.participants.find((p) => p.userId === P).status, 'accepted');
});

test('creator friendship, all prospective block pairs, current roster restrictions, creator-only and phases remain enforced', async () => {
  for (const status of ['pending', 'declined', 'missing']) {
    const h = harness(); h.state.friendships.set(h.pair(A, B), status);
    await assert.rejects(h.service.create(user(A), h.createInput()), expectCode('BAD_REQUEST'));
    assert.equal(h.state.creates, 0);
  }
  for (const blocked of [[A, B], [B, C]]) {
    const h = harness(); h.state.blocks = [blocked];
    await assert.rejects(h.service.create(user(A), h.createInput({ inviteeIds: [B, C] })), expectCode('OUTING_RESTRICTED'));
    assert.equal(h.state.creates, 0);
  }
  for (const blocked of [[A, C], [B, C], [C, D]]) {
    const h = harness(); await h.service.create(user(A), h.createInput()); h.state.blocks = [blocked];
    await assert.rejects(h.mutate('invite', { userIds: [C, D] }), expectCode('OUTING_RESTRICTED'));
    assert.equal(h.state.cas, 0);
    assert.ok(h.state.blockChecks.some((ids) => [A, B, C, D].every((who) => ids.includes(who))));
  }
  const h = harness(); await h.service.create(user(A), h.createInput());
  h.state.friendships.set(h.pair(A, C), 'missing');
  await assert.rejects(h.mutate('invite', { userIds: [C] }), expectCode('BAD_REQUEST'));
  h.state.friendships.clear();
  await assert.rejects(h.mutate('invite', { userIds: [C] }, B), expectCode('FORBIDDEN'));
  h.state.friendships.set(h.pair(A, B), 'missing');
  await assert.rejects(h.mutate('invite', { userIds: [C] }), expectCode('OUTING_RESTRICTED'));
  const restricted = await h.service.get(user(B), h.state.stored._id.toString());
  assert.equal(restricted.access, 'restricted'); assert.equal(restricted.title, 'Buổi chia tiền');
  h.state.friendships.clear();
  for (const phase of ['settling', 'completed']) {
    h.state.stored.phase = phase;
    await assert.rejects(h.mutate('invite', { userIds: [C] }), expectCode('OUTING_PHASE'));
  }
  assert.equal(h.state.cas, 0);
});

test('event creator/guest and unique-event protections are unchanged', async () => {
  const h = harness();
  h.state.event.creatorId = user(B)._id;
  await assert.rejects(h.service.create(user(A), h.createInput({ eventId: EVENT })), expectCode('FORBIDDEN'));
  h.state.event.creatorId = user(A)._id;
  await assert.rejects(h.service.create(user(A), h.createInput({ eventId: EVENT, inviteeIds: [D] })), expectCode('BAD_REQUEST'));
  assert.equal(h.state.creates, 0);
  h.state.mode = 'duplicate-event';
  await assert.rejects(h.service.create(user(A), h.createInput({ eventId: EVENT })), expectCode('OUTING_EVENT_EXISTS'));
  h.state.mode = 'ok';
  await h.service.create(user(A), h.createInput({ eventId: EVENT }));
  assert.equal(h.state.stored.eventId.toString(), EVENT);
  assert.equal(h.state.stored.participants[1].status, 'accepted');
});

test('participant, edit, operation and BSON capacity protections prevent any commit', async () => {
  for (const fill of [
    (h) => { h.state.stored.participants = Array.from({ length: h.limits.participants }, (_, i) => participant(i === 0 ? A : id(i + 200))); },
    (h) => { h.state.stored.editCount = h.limits.edits; },
    (h) => { h.state.stored.ordinaryOperations = h.limits.ordinaryOperations; },
    (h) => { h.state.stored.ordinaryWritesClosed = true; },
    (h) => { h.state.stored.title = 'x'.repeat(h.limits.ordinaryBytes); },
  ]) {
    const h = harness(); await h.service.create(user(A), h.createInput()); fill(h);
    const before = plain(h.state.stored);
    await assert.rejects(h.mutate('invite', { userIds: [C] }), expectCode('OUTING_CAPACITY'));
    assert.equal(h.state.cas, 0); assert.deepEqual(plain(h.state.stored), before);
  }
  const h = harness();
  const input = h.createInput(); input.inviteeIds = Array.from({ length: 50 }, (_, i) => id(i + 200));
  await assert.rejects(h.service.create(user(A), input), expectCode('OUTING_CAPACITY'));
  assert.equal(h.state.creates, 0);
});

test('request validation preserves inviteeIds/userIds names and rejects repeated IDs including mixed case', () => {
  const { outingSchemas } = harness().load('services/friendOuting.validation.ts');
  const upper = 'abcdefabcdefabcdefabcdef';
  assert.equal(outingSchemas.invite.safeParse({ operationId: 'duplicate_op', expectedRevision: 1, userIds: [B, B] }).success, false);
  assert.equal(outingSchemas.create.safeParse({ operationId: 'duplicate_op', expectedRevision: 0, title: 'Trip', outingDate: '2026-11-16', inviteeIds: [upper, upper.toUpperCase()] }).success, false);
  assert.deepEqual(outingSchemas.invite.parse({ operationId: 'compat_op', expectedRevision: 1, userIds: [C, B] }).userIds, [B, C]);
});

test('create/add replay retains revisions/consent and does not emit again; mismatched key/payload/actor cannot write', async () => {
  const h = harness(), request = h.createInput();
  const first = await h.service.create(user(A), request);
  assert.equal((await h.service.create(user(A), request)).outcome.replayed, true);
  assert.equal(h.state.creates, 1); assert.equal(h.state.notifications.length, 1);
  await assert.rejects(h.service.create(user(A), { ...request, inviteeIds: [C] }), expectCode('OUTING_OPERATION_CONFLICT'));
  const add = h.input({ userIds: [C] }), outingId = first.outing.id;
  const added = await h.service.mutate(user(A), outingId, 'invite', add);
  await h.mutate('close_review');
  await h.mutate('approve', { financeRevision: h.state.stored.financeRevision }, C);
  const before = plain(h.state.stored), writes = h.state.cas, messages = h.state.notifications.length;
  const replay = await h.service.mutate(user(A), outingId, 'invite', add);
  assert.equal(replay.outcome.replayed, true);
  assert.equal(replay.outcome.committedRevision, added.outcome.committedRevision);
  assert.deepEqual(plain(h.state.stored), before, 'replay must not reset later approvals');
  assert.equal(h.state.cas, writes); assert.equal(h.state.notifications.length, messages);
  await assert.rejects(h.service.mutate(user(A), outingId, 'invite', { ...add, userIds: [D] }), expectCode('OUTING_OPERATION_CONFLICT'));
  await assert.rejects(h.service.mutate(user(B), outingId, 'invite', add), expectCode('OUTING_OPERATION_CONFLICT'));
  await assert.rejects(h.service.mutate(user(A), outingId, 'close_review', add), expectCode('OUTING_OPERATION_CONFLICT'));
  await assert.rejects(h.service.mutate(user(A), outingId, 'invite', { ...add, operationId: 'stale_request', userIds: [D] }), expectCode('OUTING_REVISION_CONFLICT'));
  assert.equal(h.state.cas, writes);
});

test('CAS losers, ambiguous acknowledgements and receipt-based race replay do not duplicate member/finance changes or notifications', async () => {
  for (const mode of ['fail', 'unknown', 'ambiguous', 'race-replay']) {
    const h = harness(); await h.service.create(user(A), h.createInput());
    const before = clone(h.state.stored), add = h.input({ userIds: [C] }); h.state.mode = mode;
    if (mode === 'fail' || mode === 'unknown') {
      await assert.rejects(h.service.mutate(user(A), before._id.toString(), 'invite', add), expectCode(mode === 'fail' ? 'OUTING_REVISION_CONFLICT' : 'OUTING_OUTCOME_UNKNOWN'));
      assert.deepEqual(plain(h.state.stored), plain(before));
    } else {
      const result = await h.service.mutate(user(A), before._id.toString(), 'invite', add);
      assert.equal(result.outcome.replayed, true);
      assert.equal(h.state.stored.financeRevision, before.financeRevision + 1);
      assert.equal(h.state.stored.participants.filter((p) => p.userId === C).length, 1);
      h.state.mode = 'ok';
      assert.equal((await h.service.mutate(user(A), before._id.toString(), 'invite', add)).outcome.replayed, true);
    }
    assert.equal(h.state.cas, 1); assert.equal(h.state.notifications.length, 1, 'only original create notification');
  }
  const h = harness(), create = h.createInput(); h.state.mode = 'ambiguous';
  const result = await h.service.create(user(A), create);
  assert.equal(result.outcome.replayed, true); assert.equal(h.state.stored.participants[1].status, 'accepted');
  assert.equal(h.state.notifications.length, 0);
  await h.service.create(user(A), create); assert.equal(h.state.creates, 1);
});

test('direct mutation transition works in collecting and review and leaves legacy membership statuses unchanged', async () => {
  const h = harness(); await h.service.create(user(A), h.createInput());
  const { applyOutingMutation } = h.load('services/friendOuting.mutations.ts');
  for (const phase of ['collecting', 'review']) {
    const doc = clone(h.state.stored); doc.phase = phase;
    doc.participants[0].consent = { status: 'approved', financeRevision: doc.financeRevision };
    doc.participants[1].consent = { status: 'objected', financeRevision: doc.financeRevision };
    doc.participants.push(participant(P, 'pending'), participant(X, 'declined'));
    const before = clone(doc);
    const result = applyOutingMutation(doc, A, 'invite', h.input({ userIds: [C, D] }), false, undefined, [participant(C), participant(D)]);
    assert.equal(result.bucket, 'ordinary'); assert.equal(doc.financeRevision, before.financeRevision + 1);
    assert.equal(doc.revision, before.revision, 'outer service owns ledger revision'); assert.equal(doc.phase, 'collecting');
    assert.ok(doc.participants.every((p) => p.consent === null));
    assert.equal(doc.participants.find((p) => p.userId === P).status, 'pending');
    assert.equal(doc.participants.find((p) => p.userId === X).status, 'declined');
  }
});

test('outing_added passes real adapter/model/rules/list/badge with generic private push; historical outing_invite stays supported', async () => {
  const h = harness(); h.load('services/friendOutingNotifications.ts').registerFriendOutingNotifications();
  await h.service.create(user(A), h.createInput());
  await h.mutate('invite', { userIds: [C] });
  assert.deepEqual(h.state.rows.map((r) => [r.type, r.userId.toString()]), [['outing_added', B], ['outing_added', C]]);
  const model = h.load('models/FriendNotification.ts');
  const rules = h.load('config/notificationTypes.ts').FRIENDS_PUSH_RULES;
  for (const type of ['outing_added', 'outing_invite']) {
    assert.ok(model.FRIEND_NOTIFICATION_TYPES.includes(type)); assert.ok(model.OUTING_NOTIFICATION_TYPES.has(type));
    assert.equal(rules[type].group, 'events');
    await new model.FriendNotification({ userId: user(B)._id, type, actorIds: [user(A)._id], recentActorIds: [user(A)._id], createdAt: new Date(), updatedAt: new Date() }).validate();
    await h.load('services/notification.service.ts').notificationService.emit({ space: 'friends', to: user(B)._id, actorId: user(A)._id,
      type, entityId: h.state.stored._id, push: { body: 'Private names and money 999999', url: '/private', tag: 'private' } });
    const job = h.state.pushes.at(-1);
    assert.equal(job.type, type); assert.equal(job.group, 'events'); assert.equal(job.actorId, null);
    assert.equal(job.content.body, 'Bạn có cập nhật mới về buổi đi chơi');
    assert.equal(job.content.url, `/friends/outings/${h.state.stored._id}`);
    assert.equal(job.content.tag, `outing:${h.state.stored._id}`);
  }
  const feed = h.load('services/friendNotifications.service.ts').friendNotificationsService;
  const list = await feed.list(user(B));
  assert.deepEqual(list.items.map((n) => n.type), ['outing_added', 'outing_added', 'outing_invite']);
  assert.ok(list.items.every((n) => n.entity.kind === 'outing' && !n.entity.restricted));
  assert.equal((await feed.unread(user(B))).notifications, 3);
  h.state.friendships.set(h.pair(A, B), 'missing');
  const restricted = await feed.list(user(B));
  assert.equal(restricted.items.length, 3, 'historical financial membership keeps access after unfriend');
  assert.ok(restricted.items.every((n) => n.entity.restricted && n.actors.length === 0));
  h.state.blocks = [[A, B]];
  assert.equal((await feed.list(user(B))).items.length, 0, 'blocked actor rows are not exposed');
});

test('adapter still skips blocked, invisible and duplicate recipients; replay does not store/push another added row', async () => {
  const h = harness(); let deliver;
  h.load('services/friendOuting.service.ts').configureFriendOutingNotifications = (handler) => { deliver = handler; };
  h.load('services/friendOutingNotifications.ts').registerFriendOutingNotifications();
  const request = h.createInput({ inviteeIds: [B, C] }); await h.service.create(user(A), request);
  const event = { type: 'outing_added', outingId: h.state.stored._id.toString(), actorId: A, recipientIds: [A, B, B, C, D], operationId: request.operationId };
  h.state.blocks = [[A, C]];
  await deliver(event);
  assert.deepEqual(h.state.rows.map((r) => r.userId.toString()), [B]);
  assert.equal(h.state.pushes.length, 1);
  // Install the actual adapter on the service hook for a commit/replay pair.
  const fresh = harness(); fresh.load('services/friendOutingNotifications.ts').registerFriendOutingNotifications();
  await fresh.service.create(user(A), fresh.createInput());
  const add = fresh.input({ userIds: [C] }), outingId = fresh.state.stored._id.toString();
  await fresh.service.mutate(user(A), outingId, 'invite', add);
  await fresh.service.mutate(user(A), outingId, 'invite', add);
  assert.equal(fresh.state.rows.length, 2); assert.equal(fresh.state.pushes.length, 2);
});

test('delete uses a dedicated receipt, creator-only replay, hides detail and notifications and preserves event source', async () => {
  const h = harness(); h.load('services/friendOutingNotifications.ts').registerFriendOutingNotifications();
  const create = h.createInput({ eventId: EVENT }); await h.service.create(user(A), create);
  const outingId = h.state.stored._id.toString(), request = h.input(), before = clone(h.state.stored);
  await assert.rejects(h.service.delete(user(B), outingId, request), expectCode('FORBIDDEN'));
  await assert.rejects(h.service.delete(user(D), outingId, request), expectCode('NOT_FOUND'));
  const pushes = h.state.pushes.length;
  const result = await h.service.delete(user(A), outingId, request);
  assert.deepEqual(result, { deletedId: outingId, outcome: { operationId: request.operationId, kind: 'delete', resultId: outingId, committedRevision: 2, replayed: false } });
  assert.equal(h.state.stored.eventId, null); assert.equal(h.state.stored.originalEventId.toString(), EVENT);
  assert.deepEqual(plain(h.state.stored.receipts), plain(before.receipts));
  assert.ok(h.state.stored.deletedAt); await new (h.load('models/FriendOuting.ts').FriendOuting)(h.state.stored).validate();
  assert.deepEqual(h.state.hints.at(-1).domains, ['friend-outings', 'friend-notifications']);
  assert.deepEqual(h.state.hints.at(-1).participants, before.participants); assert.equal(h.state.pushes.length, pushes);
  assert.equal((await h.service.delete(user(A), outingId, request)).outcome.replayed, true);
  await assert.rejects(h.service.delete(user(A), outingId, { ...request, expectedRevision: 2 }), expectCode('OUTING_OPERATION_CONFLICT'));
  await assert.rejects(h.service.delete(user(A), outingId, { ...request, operationId: 'another_operation' }), expectCode('OUTING_OPERATION_CONFLICT'));
  await assert.rejects(h.service.delete(user(B), outingId, request), expectCode('NOT_FOUND'));
  await assert.rejects(h.service.get(user(A), outingId), expectCode('NOT_FOUND'));
  await assert.rejects(h.service.mutate(user(A), outingId, 'close_review', request), expectCode('NOT_FOUND'));
  assert.equal((await h.service.list(user(B), { limit: 20 })).items.length, 0);
  assert.equal((await h.service.notificationVisibility(B, [outingId])).size, 0);
  const feed = h.load('services/friendNotifications.service.ts').friendNotificationsService;
  assert.equal((await feed.list(user(B))).items.length, 0); assert.equal((await feed.unread(user(B))).notifications, 0);
  await assert.rejects(h.service.create(user(A), create), expectCode('OUTING_DELETED'));
});

test('delete rejects all monetary history and inconsistent total, but permits every phase and restricted empty outings', async () => {
  for (const setup of [
    (d) => { d.expenses.push({ status: 'active' }); }, (d) => { d.expenses.push({ status: 'void' }); },
    ...['pending', 'confirmed', 'rejected', 'cancelled'].map((status) => (d) => { d.settlements.push({ status }); }),
    (d) => { d.totalExpenses = 1; },
  ]) {
    const h = harness(); await h.service.create(user(A), h.createInput()); setup(h.state.stored);
    await assert.rejects(h.service.delete(user(A), h.state.stored._id.toString(), h.input()), expectCode('OUTING_NOT_EMPTY'));
    assert.equal(h.state.cas, 0);
  }
  for (const phase of ['collecting', 'review', 'settling', 'completed']) {
    const h = harness(); await h.service.create(user(A), h.createInput()); h.state.stored.phase = phase;
    h.state.friendships.set(h.pair(A, B), 'missing');
    await h.service.delete(user(A), h.state.stored._id.toString(), h.input()); assert.ok(h.state.stored.deletedAt);
  }
});

test('delete key collision, quota reserve, absolute size, ambiguous write and CAS race paths', async () => {
  for (const mode of ['ambiguous', 'race-replay', 'unknown', 'fail']) {
    const h = harness(); await h.service.create(user(A), h.createInput()); const request = h.input(), outingId = h.state.stored._id.toString();
    h.state.mode = mode;
    if (mode === 'unknown' || mode === 'fail') await assert.rejects(h.service.delete(user(A), outingId, request), expectCode(mode === 'unknown' ? 'OUTING_OUTCOME_UNKNOWN' : 'OUTING_REVISION_CONFLICT'));
    else assert.equal((await h.service.delete(user(A), outingId, request)).outcome.replayed, true);
  }
  const h = harness(); const create = h.createInput(); await h.service.create(user(A), create);
  const outingId = h.state.stored._id.toString();
  await assert.rejects(h.service.delete(user(A), outingId, { operationId: create.operationId, expectedRevision: 1 }), expectCode('OUTING_OPERATION_CONFLICT'));
  h.state.stored.ordinaryOperations = h.limits.ordinaryOperations; h.state.stored.reservedOperations = h.limits.reservedOperations;
  await h.service.delete(user(A), outingId, h.input()); assert.ok(h.state.stored.deleteReceipt);
  const full = harness(); await full.service.create(user(A), full.createInput()); full.state.stored.title = 'x'.repeat(full.limits.maximumBytes);
  await assert.rejects(full.service.delete(user(A), full.state.stored._id.toString(), full.input()), expectCode('OUTING_CAPACITY'));
});

test('create ambiguous readback never returns a concurrent tombstone and delete cannot reuse mutation keys', async () => {
  const h = harness(), request = h.createInput();
  const create = h.repo.create;
  h.repo.create = async (doc) => { await create(doc); h.state.stored.deletedAt = new Date(); throw Error('ack lost'); };
  await assert.rejects(h.service.create(user(A), request), expectCode('OUTING_DELETED'));
  const other = harness(); await other.service.create(user(A), other.createInput());
  const invite = other.input({ userIds: [C] }), outingId = other.state.stored._id.toString();
  await other.service.mutate(user(A), outingId, 'invite', invite);
  const before = plain(other.state.stored.receipts);
  await assert.rejects(other.service.delete(user(A), outingId, { operationId: invite.operationId, expectedRevision: other.state.stored.revision }), expectCode('OUTING_OPERATION_CONFLICT'));
  await other.service.delete(user(A), outingId, other.input());
  assert.deepEqual(plain(other.state.stored.receipts), before);
});

test('released event permits a fresh create while old create cannot resurrect the tombstone', async () => {
  const h = harness(), rows = [];
  h.repo.findCreate = async (creator, op) => clone(rows.find((d) => d.creatorId === creator && d.createOperationId === op));
  h.repo.findRaw = async (outingId) => clone(rows.find((d) => d._id.toString() === outingId));
  h.repo.create = async (doc) => {
    if (doc.eventId && rows.some((r) => r.eventId?.equals(doc.eventId))) throw Object.assign(Error('duplicate event'), { code: 11000 });
    rows.push(clone(doc));
  };
  h.repo.compareAndSwap = async (revision, doc) => {
    const index = rows.findIndex((r) => r._id.equals(doc._id) && r.revision === revision && !r.deletedAt);
    if (index < 0) return false; rows[index] = clone(doc); return true;
  };
  const first = h.createInput({ eventId: EVENT }); const created = await h.service.create(user(A), first);
  const second = h.createInput({ eventId: EVENT });
  await assert.rejects(h.service.create(user(A), second), expectCode('OUTING_EVENT_EXISTS'));
  await h.service.delete(user(A), created.outing.id, { operationId: 'delete_event', expectedRevision: 1 });
  const fresh = await h.service.create(user(A), second);
  assert.notEqual(fresh.outing.id, created.outing.id); assert.equal(rows.length, 2);
  await assert.rejects(h.service.create(user(A), first), expectCode('OUTING_DELETED'));
});

test('real repository applies active filters and preserves event unique-index behavior', async () => {
  const h = harness(), Model = h.load('models/FriendOuting.ts').FriendOuting, seen = [];
  const original = { findOne: Model.findOne, find: Model.find, replaceOne: Model.replaceOne };
  const chain = () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, exec: async () => [] });
  Model.findOne = (query) => { seen.push(query); return chain(); };
  Model.find = (query) => { seen.push(query); return chain(); };
  Model.replaceOne = (query) => { seen.push(query); return { exec: async () => ({ matchedCount: 1 }) }; };
  try {
    await h.actualRepo.find(id(99)); await h.actualRepo.list(A, 10); await h.actualRepo.headers(A, [id(99)]);
    await h.actualRepo.affectedByRelationship(A, B); await h.actualRepo.compareAndSwap(7, { _id: user(id(99))._id });
    assert.equal(seen.length, 5); for (const query of seen) assert.equal(query.deletedAt, null);
    assert.equal(seen[4].revision, 7);
    const indexes = Model.schema.indexes();
    assert.ok(indexes.some(([fields, options]) => fields.eventId === 1 && options.unique && options.partialFilterExpression.eventId.$type === 'objectId'));
  } finally { Object.assign(Model, original); }
});

test('expense and delete resolve against the same revision in both race orders', async () => {
  for (const winner of ['delete', 'expense']) {
    const h = harness(); await h.service.create(user(A), h.createInput());
    const outingId = h.state.stored._id.toString(), del = h.input(), expense = h.input({ title: 'Meal', amount: 10, splitMode: 'equal', participantIds: [A, B] });
    const original = h.repo.compareAndSwap; let release, entered;
    const blocked = new Promise((resolve) => { release = resolve; }), ready = new Promise((resolve) => { entered = resolve; });
    let first = true;
    h.repo.compareAndSwap = async (...args) => { if (first) { first = false; entered(); await blocked; } return original(...args); };
    const slow = winner === 'delete' ? h.service.mutate(user(A), outingId, 'expense_create', expense) : h.service.delete(user(A), outingId, del);
    await ready;
    if (winner === 'delete') await h.service.delete(user(A), outingId, del);
    else await h.service.mutate(user(A), outingId, 'expense_create', expense);
    release(); await assert.rejects(slow, expectCode(winner === 'delete' ? 'NOT_FOUND' : 'OUTING_REVISION_CONFLICT'));
    assert.equal(!!h.state.stored.deletedAt, winner === 'delete');
    assert.equal(h.state.stored.expenses.length, winner === 'expense' ? 1 : 0);
  }
});
