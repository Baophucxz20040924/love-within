# Moments verification boundaries

## Standalone mocked tests

From repository root (installed dependencies required, no new dependencies):

```sh
node backend/tests/moments/moments.test.cjs
node backend/tests/moments/push.test.cjs
node frontend/tests/moments.cjs
```

These execute real TypeScript functions/callbacks in VM harnesses with explicit repository, storage, notification, clock and React mocks. They do not read environment files, connect Mongo, start HTTP servers, open browsers, or contact providers. Coverage includes one daily random prompt/timezones/DST, separate30-minute reward and local-midnight capture deadlines, late streak completion without reward, session privacy and legacy reads, cutoff rechecks, query shape, Story CAS behavior, queued/per-device push expiry, service-worker late receipts, parent timers and stale capture responses. Mocked Mongo query-shape checks alone are not proof Mongo evaluates the query correctly.

## Standalone local Mongo

Operator opt-in only, after the backend build:

```sh
npm --prefix backend run build
node backend/tests/moments/mongo.cjs --local-lookwithin-dev
```

The script targets only `mongodb://127.0.0.1:27017/lookwithin_dev`, rejects a missing/different flag, imports only the moment model/repository after installing the personal-wallet namespace guard, and does not read dotenv or start an app/provider. It creates required indexes only in fresh random-prefix collections, never existing app collections. It checks concurrent schedule upserts, duplicate-post claims, notification/Story CAS, DB-stamped `postedAt`/`lateMin`, literal metadata, separate reward/capture cutoffs, late streak and legacy/v2 preservation. Cleanup drops only exact collections created by this process. An abrupt stop can leave its private collections. This is repository integration, not HTTP/auth/storage integration.

## Operator-owned local browser runtime

Source-only suite; neither starts nor stops servers:

```sh
node frontend/tests/moments/browser.mjs --local-mock-runtime
```

Prerequisites:
- Operator has reviewed the project runtime instructions and separately started mock API `127.0.0.1:4002` and UI `127.0.0.1:5175`, with the UI proxy pointing at that API.
- All API providers are mock; no production credentials or external-provider runtime.
- External `playwright-core` is available under `LW_PW_HOME` (default OS temp `lw_pw`), with a version supporting `page.clock`.
- Chromium executable is set by `CHROME` or available at the existing Windows Playwright path used by the other suites. `LW_HEADED=1` is optional.

The suite uses `page.clock.setFixedTime` to control Date while leaving real auth/realtime timers running. Foreground cases perform a hidden→visible transition and wait for both the PIN shield and REST access-verification boundary to clear; a temporarily concealed sheet is not counted as successful submission.

The suite creates synthetic accounts and a pair through the real local API and logs in through the UI. Those synthetic accounts remain in the local database; it does not issue broad cleanup or delete arbitrary data. It then intercepts moment endpoints and storage PUTs with deterministic **UI fixtures**, drives fake browser time, and uses an in-memory PNG through the native capture file input (`setInputFiles`). Tests cover Home idle/reward-expiry states, retained preview and delayed upload across reward expiry, midnight capture-sheet expiry, delayed PUT and POST, original-session request payloads, rejection of a stale response in a later-day view, historical multi-session calendar, privacy display, exact session deep links and legacy/v2 read-only UI. Two additional no-PIN visibility regressions dispatch hidden/visible transitions through the real bootstrap/lock listeners: a native-picker round trip must accept its returned file after revalidation, and backgrounding during a delayed PUT must finish or expose an enabled retry rather than leave the sheet permanently busy. These are simulated visibility transitions, not physical-device camera proof; the unchanged pre-fix component is expected to fail them.

Screenshots go to `LW_PW_HOME/shots/moments-<timestamp>`. Inputs are masked. No HAR, trace, storage-state dump, credentials or tokens are written. Service workers are blocked to prevent stale app-shell interference; service-worker expiry is tested separately in the standalone mocked suite.

**Important limits:** intercepted moment data is not backend scheduling/cutoff/auth/CAS evidence. The browser fixture's shortened windows are intentional test inputs, not actual thirty-minute reward windows. No native camera hardware, physical phone, installed PWA, real Web Push or OS notification-removal behavior is verified. The script requires an operator-owned local runtime and must not run concurrently with other local regression suites. Authoring/syntax-checking the source is not a claim that the browser tests passed.
