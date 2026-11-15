# Optional app PIN verification

The previous mandatory secret-gesture resume cover has been removed. One account can optionally configure a six-digit PIN for each space. Only the current space's enabled flag causes a resume challenge; when both are enabled, either PIN selects its own Home. PINs must differ and are verified by the backend. No PIN or verifier is persisted in browser storage.

Settings: `/profile/app-lock` and `/friends/me/app-lock`. Configuration requires the account password. Explicit recovery logs out locally and returns to the full email/password form; server PINs remain configured. Full password login permits the selected space for that entry. Cold/resume status failures stay covered until retry or logout. PIN unlock always goes Home, not the original deep link; actual locks discard mounted drafts. No-PIN resume retains mounted content.

## Isolated checks

```sh
npm --prefix frontend run test:app-lock
npm --prefix frontend run test:realtime
npm --prefix backend run test:privacy-lock
```

The unlock screen uses six masked dots and a touch keypad. Six digits submit automatically through one guarded handler; invalid PIN feedback lasts 600ms, while network/rate-limit failures remain separate and never auto-resubmit. Configuration still uses explicit save/password confirmation.

`pin-entry.cjs` exercises the actual component with mocked hooks/timers: leading zero, keypad/delete, partial input, duplicate/Enter guards, invalid feedback, countdown, cleanup and stale epoch/session continuations.

`store.cjs` exercises actual controller/mask source with deterministic DOM and API mocks: configuration matrix, epochs/generations/revisions, invalid responses, independent masks, late portals and media. `tokens.cjs` checks atomic publication of session identity and credential pair, rotation and logout. Auth regression covers stale join completions. These are not device tests.

## Mongo integration

Read `scripts/browser/README.md` and observe runtime ownership rules first. Build backend, then run separately from browser verification:

```sh
npm --prefix backend run build
node backend/tests/privacy-lock/mongo.cjs --local-lookwithin-dev
```

The integration test only connects to `mongodb://127.0.0.1:27017/lookwithin_dev`, uses randomly identified synthetic rows and deletes only its own fixture. It checks real aggregation/defaults, durable lockout, concurrent callers and config CAS. It does not test separate OS workers/restarts or deploy indexes.

## Browser

Read `scripts/browser/README.md`. Inspect ports 4000/4001/5173 plus 4002/5175; never kill an unowned listener. Use the owned mock-runtime preload `backend/tests/realtime/mock-runtime.cjs` for API4002 and the dedicated Vite proxy `frontend/tests/realtime/dev-server.mjs` on 5175. Do not read `.env`, run real providers, or run API regressions concurrently. Stop the owned API afterwards; leave Vite.

```sh
node frontend/tests/app-lock/browser.mjs --local-mock-runtime
```

External Playwright tooling only; no frontend dependency. Synthetic accounts and pairing are API setup; login, configure/change/disable and unlock run through UI. The suite simulates visibility events and captures credential-masked screenshots and sanitized result JSON under the external tooling directory. No storage state, traces or HAR. Synthetic accounts remain in the local dev DB. Review images manually; a passing assertion is not visual review.

## Scope

This is server-verified UI reentry protection, not encrypted local storage or a replacement for JWT/ACL. Someone with retained tokens/devtools can still access authorized APIs. Requires a network connection. Push preferences are unchanged: OS notification previews and app-switcher snapshots are outside this guarantee. Browser simulation does not verify a physical phone, installed HTTPS PWA, native picker, OS background timing or snapshots.
