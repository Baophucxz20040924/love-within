'use strict';
// Dependency-free service-worker regression tests: node --test frontend/tests/push/sw.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const filename = path.resolve(__dirname, '../../public/sw.js');
const source = fs.readFileSync(filename, 'utf8');
const now = Date.parse('2026-11-16T12:00:00Z');
function fixture(windows = []) {
  const listeners = {}, notifications = [], calls = [], opened = [], deleted = [];
  class Clock extends Date { static now() { return now; } }
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
    navigator: {
      setAppBadge() { throw Error('Payload badge must not be used'); },
      clearAppBadge() { throw Error('Payload badge must not be used'); },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async url => opened.push(url),
      claim: async () => calls.push('claim'),
    },
  };
  vm.runInNewContext(source, {
    self, URL, Date: Clock,
    caches: { keys: async () => ['look-within-shell-v6', 'look-within-shell-v7'], delete: async key => deleted.push(key) },
  }, { filename });
  async function dispatch(type, event) {
    let work;
    listeners[type]({ ...event, waitUntil: promise => { work = promise; } });
    await work;
  }
  return {
    notifications, calls, opened, deleted,
    push: value => dispatch('push', { data: { json: () => value } }),
    badJSON: () => dispatch('push', { data: { json() { throw Error('invalid JSON'); } } }),
    empty: () => dispatch('push', {}),
    click: data => dispatch('notificationclick', { notification: { data, close: () => calls.push('close') } }),
    activate: () => dispatch('activate', {}),
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
const generic = {
  title: 'Love Within',
  options: {
    body: 'Bạn có một thông báo mới', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
    lang: 'vi', data: { url: '/' },
  },
};

test('all payload presentation fields are ignored, including legacy private data and numeric badge', async () => {
  const h = fixture();
  for (const badge of [42, 0, -1, 'https://evil.example/badge']) {
    await h.push({ title: 'Private actor', body: 'Secret content', tag: 'friends:secret-post',
      url: '/friends/posts/secret?space=friends#private', image: 'https://evil.example/image',
      icon: 'https://evil.example/icon', badge, data: { url: '/letters/secret' }, actions: [{ action: 'private' }] });
  }
  assert.equal(h.notifications.length, 4);
  for (const notification of h.notifications) assert.deepEqual(plain(notification), generic);
});

test('missing, malformed and primitive payloads produce exactly the same public notification', async () => {
  const h = fixture();
  await h.empty();
  await h.badJSON();
  for (const payload of [null, [], ['secret'], 'secret', 42, true, {}]) await h.push(payload);
  assert.equal(h.notifications.length, 9);
  for (const notification of h.notifications) assert.deepEqual(plain(notification), generic);
});

test('explicit invalid, past and exact-boundary expiry suppress display; future expiry stays generic', async () => {
  const h = fixture();
  for (const expiresAt of [null, false, 0, now + 1000, {}, [], '', 'not-a-date',
    '2026-11-16T11:59:59.999Z', '2026-11-16T12:00:00Z']) await h.push({ expiresAt, title: 'secret' });
  assert.equal(h.notifications.length, 0);
  await h.push({ expiresAt: '2026-11-16T12:00:00.001Z', title: 'secret', url: '/moments?session=private' });
  assert.deepEqual(plain(h.notifications), [generic]);
});

test('cold clicks always open root and ignore old payload routes, external URLs and action data', async () => {
  const h = fixture([{ url: 'https://evil.example/app', focus() { throw Error('Wrong origin'); } }]);
  for (const data of [undefined, null, {}, { url: '/friends/notifications' }, { url: '/letters/private' },
    { url: '//evil.example' }, { url: 'https://evil.example' }, { url: '/?space=friends', account: 'old' }]) await h.click(data);
  assert.equal(h.opened.length, 8);
  assert.ok(h.opened.every(url => url === '/'));
  assert.equal(h.calls.filter(call => call === 'close').length, 8);
});

test('warm clicks send only typed neutral message before focus, even when focus fails', async () => {
  for (const rejectFocus of [false, true]) {
    const calls = [];
    const h = fixture([{ url: 'https://app.example/friends/posts/private',
      postMessage: message => calls.push(plain(message)),
      focus: async () => { calls.push('focus'); if (rejectFocus) throw Error('not allowed'); },
      navigate() { throw Error('Worker must not bypass app guards'); },
    }]);
    await h.click({ url: '/letters/private', space: 'couple', userId: 'old-account' });
    assert.deepEqual(calls, [{ type: 'lw:notification-open' }, 'focus']);
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.calls, ['close']);
  }
});

test('activation drops the previous shell cache version', async () => {
  const h = fixture();
  await h.activate();
  assert.deepEqual(h.deleted, ['look-within-shell-v6']);
  assert.deepEqual(h.calls, ['claim']);
});
