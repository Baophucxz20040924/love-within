import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStates, stateNames, validateStates, contrastOnWhite, assertReachableGeometry } from './v12-outing-states.mjs';

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
    s => { s.invited.creatorId = owner.id; },
  ]) {
    const states = makeStates(owner, partner); corrupt(states);
    assert.throws(() => validateStates(states, owner, partner));
  }
});

test('fixture rejects duplicate and malformed identities', () => {
  assert.throws(() => makeStates(owner, owner));
  assert.throws(() => makeStates(owner, { ...partner, id: 'bad' }));
});

test('small invitation eyebrow contrast uses composited sRGB on white', () => {
  assert.equal(contrastOnWhite('rgb(0, 0, 0)'), 21);
  assert.equal(contrastOnWhite('rgb(255, 255, 255)'), 1);
  assert(contrastOnWhite('rgb(186, 210, 255)') < 4.5);
  assert(contrastOnWhite('rgb(45, 75, 120)') >= 4.5);
  assert.equal(contrastOnWhite('rgba(0, 0, 0, 0)'), 1);
  assert.equal(contrastOnWhite('rgba(0, 0, 0, 0.5)'), contrastOnWhite('rgb(127.5, 127.5, 127.5)'));
  assert.throws(() => contrastOnWhite('rgb(300, 0, 0)'));
  assert.throws(() => contrastOnWhite('unsupported'));
});

test('reachability rejects nav overlap, horizontal clipping, overlay and lost keyboard focus', () => {
  const box = { left: 16, right: 344, top: 400, bottom: 444, width: 328, height: 44, safeLeft: 0, safeRight: 360, safeTop: 80, safeBottom: 711, enabled: true, focused: true, hits: [true, true, true, true, true] };
  assert.doesNotThrow(() => assertReachableGeometry(box));
  for (const change of [{ bottom: 720 }, { right: 361 }, { left: -1 }, { top: 70 }, { focused: false }, { enabled: false }, { hits: [true, false, true, true, true] }, { hits: [] }, { width: 0 }]) {
    assert.throws(() => assertReachableGeometry({ ...box, ...change }));
  }
});
