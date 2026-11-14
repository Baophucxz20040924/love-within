import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, validateFixture, storyPage, summarizeShifts } from './v12-populated.mjs';

const owner = { id: 'owner', displayName: 'Owner' };
const partner = { id: 'partner', displayName: 'Partner' };
const fixture = () => makeFixture(owner, partner, 'http://localhost:5173');

test('fixture validates 100 capped expenses, 50 members, zero balances and pagination', () => {
  const { ledger, stories } = fixture();
  validateFixture(ledger, stories);
  assert.deepEqual(storyPage(stories, null), storyPage(stories, null));
  assert.throws(() => storyPage(stories, 'unexpected'));
});

test('fixture validator rejects broken caps, sums, membership and balance', () => {
  for (const corrupt of [
    f => { f.ledger.expenses[0].amount++; },
    f => { f.ledger.expenses.pop(); },
    f => { f.ledger.participants.pop(); },
    f => { f.ledger.balances[0].balance++; },
    f => { f.stories.pop(); },
  ]) {
    const f = fixture(); corrupt(f);
    assert.throws(() => validateFixture(f.ledger, f.stories));
  }
});

test('layout shifts separate raw sum and maximum session window', () => {
  const result = summarizeShifts([{ time: 0, value: 0.1 }, { time: 500, value: 0.2 }, { time: 1500, value: 0.4 }]);
  assert.ok(Math.abs(result.rawSum - 0.7) < 1e-10);
  assert.ok(Math.abs(result.maxSessionWindow - 0.4) < 1e-10);
  assert.equal(summarizeShifts([]).maxSessionWindow, 0);
});
