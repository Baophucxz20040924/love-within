import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStates, stateNames, validateStates } from './v12-outing-states.mjs';

const owner = { id: '000000000000000000000001', displayName: 'An' };
const partner = { id: '000000000000000000000002', displayName: 'Bình' };

test('bounded state packs preserve source-shaped monetary invariants', () => {
  const states = makeStates(owner, partner);
  validateStates(states, owner, partner);
  assert.equal(stateNames.length, 9);
  assert.equal(states['tail-slots'].settlements.length, 451);
  assert.equal(states['tail-slots'].capacity.finalSettlementSlots, true);
  assert.equal(states['ordinary-closed'].capacity.editsFrozen, true);
  assert.equal(states['settling-pending-recipient'].balances.find(b => b.userId === owner.id).reservedIncoming, 40);
  assert.equal(states['settling-pending-recipient'].balances.find(b => b.userId === owner.id).received, 0);
  assert.equal(states.restricted.expenses[0].title, null);
  assert(!('participants' in states.invited));
  assert(!('balances' in states.declined));
});

test('validation rejects inconsistent amounts, reservation, quota and restricted text', () => {
  for (const corrupt of [
    s => { s['review-one-left'].expenses[0].allocations[0].amount++; },
    s => { s['settling-pending-recipient'].balances.find(b => b.userId === owner.id).balance -= 40; },
    s => { s['tail-slots'].capacity.settlements.used--; },
    s => { s.restricted.expenses[0].title = 'private'; },
  ]) {
    const states = makeStates(owner, partner); corrupt(states);
    assert.throws(() => validateStates(states, owner, partner));
  }
});

test('fixture rejects duplicate and malformed identities', () => {
  assert.throws(() => makeStates(owner, owner));
  assert.throws(() => makeStates(owner, { ...partner, id: 'bad' }));
});
