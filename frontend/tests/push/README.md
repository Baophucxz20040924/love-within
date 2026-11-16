# Account-device push regression checks

```sh
npm --prefix frontend run test:push
npm --prefix backend run test:push
```

These suites transpile actual modules with fake browser APIs, requests, storage and repositories. They never send a push or access a database. Coverage includes legacy opt-in upgrade, both-space ownership, account/intent fencing, serialized device mutations, expiry, generic presentation, settings and optional PIN entry.

## Browser fixtures

Read `scripts/browser/README.md` for external Playwright setup. Build the frontend and serve an owned **production preview** (push capability is disabled in a development build). Check listeners before starting a server; do not stop unowned listeners. No backend is needed: every API route is intercepted and unknown requests fail closed.

```sh
npm --prefix frontend run build
# In a separate terminal, from frontend/:
node node_modules/vite/bin/vite.js preview --host localhost --port 5175 --strictPort
# From the repository root:
LW_UI_URL=http://localhost:5175 node frontend/tests/push/browser.mjs --local-mock-runtime
```

The browser harness uses synthetic accounts and fake Notification, PushManager and service-worker APIs. It also verifies immediate masking and page retention on a short protected resume, and a PIN challenge at ten seconds using a test-only wall-clock offset. Unlock/status responses are fixtures, not backend verification. Evidence is written outside the repository to the printed temporary directory. Inspect `result.json` and viewport screenshots. Do not treat these checks as physical-device, installed-PWA, OS background timing, real OS notification or provider-delivery proof.

## Update behavior

The device record upgrades from space-scoped consent to account-scoped consent on the next signed-in sync, without requesting permission again. A missing record is not consent: a device already turned off by an old client must be explicitly enabled again. Old clients must load the updated application/service worker; already displayed OS notifications cannot be rewritten. Per-space category choices and shared quiet hours remain effective. No subscription migration, index removal or production provider action is required by these tests.
