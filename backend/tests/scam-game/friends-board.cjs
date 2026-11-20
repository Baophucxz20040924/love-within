'use strict';
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { loader } = require('./harness.cjs');
const id = n => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const key = (a, b) => [String(a), String(b)].sort().join(':');

// Small, explicit evaluator for the operators this repository emits, not a Mongo emulator.
// Unknown stages/operators fail so the fixture cannot silently ignore a new ACL predicate.
const equal = (a, b) => a instanceof Types.ObjectId || b instanceof Types.ObjectId ? String(a) === String(b) : a === b;
function expr(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return row[value.slice(1)];
  if (!value || typeof value !== 'object' || value instanceof Types.ObjectId) return value;
  if (Array.isArray(value)) return value.map(v => expr(v, row));
  const [op, args] = Object.entries(value)[0];
  const a = () => expr(args, row);
  switch (op) {
    case '$toString': return String(a());
    case '$concat': return a().join('');
    case '$cond': return expr(args[0], row) ? expr(args[1], row) : expr(args[2], row);
    case '$eq': { const [x, y] = a(); return equal(x, y); }
    case '$gt': { const [x, y] = a(); return x > y; }
    case '$lt': { const [x, y] = a(); return x < y; }
    case '$and': return a().every(Boolean);
    case '$or': return a().some(Boolean);
    default: throw Error(`Unsupported expression ${op}`);
  }
}
function matches(row, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') return condition.some(f => matches(row, f));
    const value = row[field];
    if (condition && typeof condition === 'object' && !(condition instanceof Types.ObjectId)) {
      return Object.entries(condition).every(([op, expected]) => {
        if (op === '$gt') return value > expected;
        if (op === '$lt') return value < expected;
        if (op === '$ne') return !equal(value, expected);
        if (op === '$nin') return !expected.some(v => equal(v, value));
        if (op === '$exists') return (value !== undefined) === expected;
        if (op === '$elemMatch') return value.some(v => matches(v, expected));
        throw Error(`Unsupported predicate ${op}`);
      });
    }
    return equal(value, condition);
  });
}
async function tests() {
  const viewer = id(1), players = [], friendships = [], users = [];
  const add = (n, score, wins, relation = 'accepted', completed = 1) => {
    const _id = id(n);
    players.push({ _id, ruleVersion: 1, completed, bestScore: score, wins, match: { secrets: 'private' } });
    users.push({ _id, friendsJoinedAt: new Date(0) });
    if (relation) friendships.push({ pairKey: key(viewer, _id), status: relation, requesterId: n % 2 ? viewer : _id, recipientId: n % 2 ? _id : viewer });
  };
  add(1, 600, 3, null); add(2, 600, 3); add(3, 600, 2); add(4, 300, 0);
  add(5, 600, 99, null); add(6, 600, 99, 'pending'); add(7, 600, 99); add(8, 600, 99);
  add(9, 600, 99); users.find(u => equal(u._id, id(9))).friendsJoinedAt = null;
  add(10, 600, 99); users.splice(users.findIndex(u => equal(u._id, id(10))), 1);
  add(11, 600, 99, 'accepted', 0);
  const pipelines = [], logs = []; let failure;
  function aggregate(pipeline) {
    pipelines.push(pipeline);
    return { option: options => { assert.equal(options.maxTimeMS, 3000); return { exec: async () => {
      if (failure) throw failure;
      let rows = players.map(r => ({ ...r }));
      for (const stage of pipeline) {
        if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
        else if (stage.$project) rows = rows.map(row => Object.fromEntries(Object.keys(stage.$project).map(k => [k, row[k]])));
        else if (stage.$addFields) rows = rows.map(row => ({ ...row, ...Object.fromEntries(Object.entries(stage.$addFields).map(([k, v]) => [k, expr(v, row)])) }));
        else if (stage.$lookup) {
          const { from, localField, foreignField, as } = stage.$lookup;
          assert(!stage.$lookup.pipeline);
          const source = from === 'users' ? users : from === 'friendships' ? friendships : assert.fail('Unknown collection');
          rows = rows.map(row => ({ ...row, [as]: source.filter(r => equal(r[foreignField], row[localField])) }));
        } else if (stage.$sort) rows.sort((a, b) => { for (const [field, order] of Object.entries(stage.$sort)) { if (equal(a[field], b[field])) continue; return (a[field] > b[field] ? 1 : -1) * order; } return 0; });
        else if (stage.$limit) rows = rows.slice(0, stage.$limit);
        else if (stage.$group) rows = [{ ...Object.fromEntries(Object.entries(stage.$group).filter(([k]) => k !== '_id').map(([k, v]) => [k, rows.reduce((sum, row) => sum + expr(v.$sum, row), 0)])) }];
        else assert.fail(`Unsupported stage ${Object.keys(stage)}`);
      }
      return rows;
    } }; } };
  }
  const repo = loader({
    'models/ScamGamePlayer.ts': { SCAM_RULE_VERSION: 1, ScamGamePlayer: { aggregate } },
    'models/User.ts': { User: { collection: { name: 'users' } } },
    'models/Friendship.ts': { Friendship: { collection: { name: 'friendships' } } },
    'utils/logger.ts': { logger: { warn: (...args) => logs.push(args) } },
  })('repositories/scamGame.repository.ts').scamGameRepository;
  const blocked = [String(id(7)), String(id(8))];
  const page = await repo.leaderboard(viewer, blocked, 1);
  assert.equal(page.length, 2); assert.equal(String(page[0]._id), String(viewer)); assert.equal(page[0].rank, 1);
  assert.equal(pipelines.length, 2); assert.equal(Object.keys(pipelines[1].at(-1).$group).length, 2);
  assert.deepEqual(pipelines[0].slice(0, 8), pipelines[1].slice(0, 8));
  assert(!pipelines[1].some(p => p.$limit || p.$sort));
  const next = await repo.leaderboard(viewer, blocked, 3, { score: 600, wins: 3, id: String(viewer) });
  assert.deepEqual(Array.from(next, r => [String(r._id), r.rank]), [[String(id(2)), 1], [String(id(3)), 3], [String(id(4)), 4]]);
  assert.deepEqual(Object.keys(next[0]).sort(), ['_id', 'bestScore', 'rank', 'wins']);
  friendships.splice(friendships.findIndex(f => f.pairKey === key(viewer, id(2))), 1);
  const unfriended = await repo.leaderboard(viewer, blocked, 20);
  assert(!unfriended.some(r => equal(r._id, id(2)))); assert.equal(unfriended[1].rank, 2);
  // Beyond the unrelated friendIds helper's historical cap; no ID-list materialization here.
  for (let n = 20; n < 5022; n++) add(n, 0, 0);
  const distant = await repo.leaderboard(viewer, blocked, 20, { score: 0, wins: 0, id: String(id(5020)) });
  assert.equal(String(distant[0]._id), String(id(5021))); assert.equal(distant[0].rank, 4);
  const empty = await repo.leaderboard(id(99999), [], 20); assert.equal(empty.length, 0);
  for (const code of [50, 123]) {
    failure = { code, message: 'private Mongo details' };
    await assert.rejects(repo.leaderboard(viewer, [], 20), e => e.status === 503 && e.code === (code === 50 ? 'SCAM_BOARD_TIMEOUT' : 'SCAM_BOARD_UNAVAILABLE'));
  }
  assert(!JSON.stringify(logs).includes('private Mongo')); assert(!JSON.stringify(logs).includes(String(viewer)));
  console.log('PASS friend board: accepted/self/block scope, no friend cap, two-pass ties/seek, bounded counters, safe failures (synthetic evaluator, no Mongo)');
}
tests().catch(e => { console.error(e); process.exitCode = 1; });
