const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadService } = require('./couple-test-loader.cjs');

const state = {
  events: [] ,
  writes: [] ,
  users: new Map (),
  invites: [] ,
};
(globalThis ).__pairingTest = state;
const stubs = {
  mongoose: `export const Types = { ObjectId: class {} };`,
  './realtimeAudience.service.js': `export const realtimeAudience = { own: async (id, space, domains, access) => globalThis.__pairingTest.events.push({id: String(id), space, domains, access}) };`,
  '../repositories/user.repository.js': `export const userRepository = {
 findById: async id => globalThis.__pairingTest.users.get(String(id)) || null,
 findByEmail: async email => [...globalThis.__pairingTest.users.values()].find(u => u.email === email) || null,
 setCoupleId: async (id, value) => { globalThis.__pairingTest.writes.push('user:' + id); globalThis.__pairingTest.users.get(String(id)).coupleId = value; },
  };`,
  '../repositories/couple.repository.js': `export const coupleRepository = {
 create: async input => ({ _id: 'couple-1', ...input }),
 findActiveById: async () => ({ _id: 'couple-1', memberIds: ['alice', 'bob'] }),
 archive: async () => { globalThis.__pairingTest.writes.push('archive'); },
  };`,
  '../repositories/pairingInvite.repository.js': `export const pairingInviteRepository = {
 findById: async id => globalThis.__pairingTest.invites.find(i => i._id === id),
 setStatus: async (id, status) => { globalThis.__pairingTest.invites.find(i => i._id === id).status = status; },
 findPendingSentBy: async id => globalThis.__pairingTest.invites.filter(i => i.status === 'pending' && i.fromUserId === id),
 findPendingReceivedBy: async email => globalThis.__pairingTest.invites.filter(i => i.status === 'pending' && i.toEmail === email),
 cancelPendingFor: async (ids, emails) => { globalThis.__pairingTest.writes.push('cancel'); for (const i of globalThis.__pairingTest.invites) if (i.status === 'pending' && (ids.includes(i.fromUserId) || emails.includes(i.toEmail))) i.status = 'cancelled'; },
  };`,
  '../utils/errors.js': `const err = msg => new Error(msg); export const Errors = { unauthorized: () => err('unauthorized'), conflict: err, badRequest: err, notFound: err };`,
  '../utils/logger.js': `export const logger = { info() {}, warn() {} };`,
};
const { pairingService } = loadService('pairing.service.ts', stubs);
function reset() {
  state.events.length = 0; state.writes.length = 0;
  state.users.clear();
  for (const id of ['alice', 'bob', 'carol', 'dave', 'unrelated']) state.users.set(id, { _id: id, email: `${id}@example.com`, timezone: 'UTC', coupleId: null });
  const make = (id , fromUserId , toEmail ) => ({ _id: id, fromUserId, toEmail, status: 'pending', expiresAt: new Date('2099-01-01') });
  state.invites = [make('accepted', 'alice', 'bob@example.com'), make('sent', 'alice', 'carol@example.com'), make('received', 'dave', 'bob@example.com'), make('other', 'carol', 'unrelated@example.com')];
}

test('accept signals both accounts and all affected invite participants, not unrelated users', async () => {
  reset();
  assert.deepEqual(await pairingService.accept('bob', 'accepted'), { coupleId: 'couple-1' });
  assert.equal(state.invites.find(i => i._id === 'accepted').status, 'accepted');
  assert.equal(state.invites.find(i => i._id === 'sent').status, 'cancelled');
  assert.equal(state.invites.find(i => i._id === 'received').status, 'cancelled');
  assert.equal(state.invites.find(i => i._id === 'other').status, 'pending');
  for (const id of ['alice', 'bob', 'carol', 'dave']) assert.ok(state.events.some(e => e.id === id && e.space === 'couple' && e.domains.includes('pairing')), id);
  assert.ok(!state.events.some(e => e.id === 'unrelated'));
  for (const id of ['alice', 'bob']) {
 assert.ok(state.events.some(e => e.id === id && e.space === 'couple' && e.domains.includes('account') && e.access));
 assert.ok(state.events.some(e => e.id === id && e.space === 'friends' && e.domains.includes('account')));
  }
});

test('unpair invalidates captured former members and then updates both accounts', async () => {
  reset();
  await pairingService.unpair('alice', 'couple-1' , true);
  assert.equal(state.writes[0], 'archive');
  for (const id of ['alice', 'bob']) {
 assert.ok(state.events.some(e => e.id === id && e.space === 'couple' && e.access && e.domains.length === 0));
 assert.ok(state.events.some(e => e.id === id && e.space === 'couple' && e.access && e.domains.includes('account')));
 assert.ok(state.events.some(e => e.id === id && e.space === 'friends' && e.domains.includes('account')));
  }
  assert.ok(!state.events.some(e => e.id === 'carol'));
});

test('refusing unpair before persistence emits nothing', async () => {
  reset();
  await assert.rejects(pairingService.unpair('alice', 'couple-1' , false));
  assert.equal(state.writes.length, 0); assert.equal(state.events.length, 0);
});
