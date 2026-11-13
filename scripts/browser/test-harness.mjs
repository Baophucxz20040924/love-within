// Isolated helper checks: no Playwright/browser, API, fixture or process lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshot, fresh } from './harness.mjs';

function screenshotPage(values = []) {
  const inputs = values.map(value => ({ inputValue: async () => value }));
  const shots = [];
  return {
    shots,
    inputs,
    locator: () => ({ count: async () => inputs.length, nth: i => inputs[i] }),
    screenshot: async options => { shots.push(options); },
  };
}

test('screenshots remain full-page by default and support explicit viewport capture', async () => {
  const page = screenshotPage();
  await screenshot(page, 'default');
  await screenshot(page, 'viewport', { fullPage: false, animations: 'allow' });
  assert.equal(page.shots[0].fullPage, true);
  assert.equal(page.shots[0].animations, 'disabled');
  assert.equal(page.shots[1].fullPage, false);
  assert.equal(page.shots[1].animations, 'allow');
});

test('screenshots mask populated credential fields but not empty fields', async () => {
  const page = screenshotPage(['', 'synthetic-private-value']);
  await screenshot(page, 'credentials');
  assert.deepEqual(page.shots[0].mask, [page.inputs[1]]);
});

test('console resource metadata keeps only path and redacts credential-like content', async () => {
  const listeners = new Map();
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    on: (event, listener) => listeners.set(event, listener),
  };
  const browser = { newContext: async () => ({ newPage: async () => page }) };
  const errors = [];
  await fresh(browser, 'controlled', errors);
  listeners.get('console')({
    type: () => 'error',
    text: () => 'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    location: () => ({ url: 'http://localhost:4000/api/bucket?private=do-not-record' }),
  });
  listeners.get('console')({
    type: () => 'error',
    text: () => 'token=synthetic-private-value',
    location: () => ({ url: '' }),
  });
  assert.equal(errors[0].label, 'controlled');
  assert.equal(errors[0].path, '/api/bucket');
  assert(!JSON.stringify(errors).includes('do-not-record'));
  assert(!JSON.stringify(errors).includes('synthetic-private-value'));
  assert.equal(errors[1].path, undefined);
});
