# Offline test inventory

The source of truth for the offline matrix is the explicit filename list in
`backend/tests/offline.cjs` and `frontend/tests/offline.cjs`. From either package,
`npm run test:offline` builds once and then runs each listed suite in a separate
Node process. The PR workflow uses Node 22 and the tracked package lock for each
package. It does not provision services, inject application secrets or deploy.
The frontend build includes TypeScript project checking; the backend build runs
`tsc`. Building and dependency installation are not themselves offline network
operations: the workflow's `npm ci` obtains locked packages as needed.

## Selected tests and isolation

- Backend wallet, market, rewards and settlement suites use
  `tests/personal-wallets/harness.cjs`: a fail-closed transpiling VM with fake
  repositories/services and synthetic records. Mongoose is used for types and
  model definitions, not a database connection.
- Backend Moment, Moment push, manual water proof, notification inbox and
  account-wide push suites transpile source in VMs with explicit mocked imports,
  persistence and provider operations. They do not start the server.
- `tests/observability/security.cjs` promotes isolated correlation, redaction,
  response, HTTP metrics, bounded operation metrics and blocked-request query
  assertions from the ignored local security helper. It loads only mocked or
  Node built-in imports. The helper's savings-write scenario is not copied;
  review it separately if needed.
- `tests/http-contract/routes.test.cjs` composes actual Express routers and
  auth/couple/credential/validation/error middleware over in-memory Node HTTP
  objects. Persistence/services are explicit fakes; no socket listens.
- `tests/moments/fairness.test.cjs` executes the actual schedule job over
  synthetic pages above its run cap with fail-closed imports and fake stores.
- `tests/observability/recovery.cjs` executes the actual wallet recovery and
  monitor source with fake persistence and a monotonic fake clock. It checks
  stage counts/outcomes, saturation, privacy and telemetry failure isolation.
- Backend `tests/credentials/unit.cjs` and `tests/privacy-lock/service.cjs`
  exercise compiled modules after the build. Synthetic credentials and explicit
  model/repository/logger mocks are installed before calls; model definitions
  do not connect to Mongo. No server or provider is started.
- Frontend app lock, auth/session, admin, discovery, notification, Moment,
  water, push and media suites exercise transpiled source with mocked browser,
  API and device interfaces. `tests/prefetch/routes.cjs` controls idle callbacks,
  gates, promise completion and cleanup around the actual scheduler/loader maps.
  `tests/realtime/realtime.cjs` and `tests/realtime/teardown.cjs` use strict VM
  imports, fake fetch/streams/browser state and in-memory query-core.
  No real browser or API is started.

These tests are not Mongo, real provider, native device or production performance
verification. Some inspect generated queries or mocked behavior rather than
executing actual persistence. Adding any entry requires reviewing its full
initialization and transitive imports for network, secrets, providers, listeners,
database access and cleanup side effects; a filename containing `mock` or
`test` is not evidence of isolation. Never replace these lists with globs.

## Code-extensibility wave additions (2026-11-19)

The optimization-wave inventory was **28 backend suite files and28 frontend suite files**. With the solo chat feature it is **30 backend and29 frontend suite files**, not a combined test-case count. Added source-loading suites:

- Backend `personal-wallets/pagination.cjs` and `comment-pages.cjs`: canonical scoped cursors, actual repository seeks, timestamp ties, visibility/live-story checks, wallet recovery order and legacy contracts. The strict wallet harness admits only the additional cursor utility and Buffer; it does not connect to Mongo.
- Backend `outings/direct-membership.test.cjs`: audited complete fixture; actual source/models with persistence/provider/realtime boundaries mocked.23 tests include request-local ACL parity and exact-roster block chunk/projection isolation alongside existing financial CAS/replay regressions.
- Backend `observability/bank-lifecycle.cjs`: real service/server source, fake timers/process/provider/persistence; startup/stop/restart/admission, bounded join and shared shutdown.
- Backend `moments/friend-reminder-fairness.cjs`: real job/repository source, fake stores;500-candidate continuation, failure checkpoints, single-flight, due-window structure, claims and recipient preservation.
- Existing `http-contract/routes.test.cjs` additionally composes new page routes for default/max/coercion/cursor-length validation, fresh auth/couple guards and legacy route compatibility. Cursor semantic validation is exercised in service fixtures.
- Frontend `tests/history/ledger.cjs`, `comments.cjs`: actual wrappers/TSX with strict fake hooks, navigation, rendering, success/error and invalidation assertions. Effects/focus are not browser proof.
- Frontend `tests/history/cancellation.cjs`: installed query-core observers plus actual transport/wrappers and fake fetch. Shared observers, last-consumer abort, parameter/next-page cancellation and ignored late results; existing transport regression covers shared refresh/body deadlines/session fences.

- Backend `http-contract/thread-pages.cjs`: actual story/event comment repositories/services,521 roots and521 replies each, tied timestamps, scoped cursors, bounded deep context and live parent ACL. Route suite now exercises both Friends routers' root/reply/context validation/auth/membership and legacy dispatch.
- Backend `moments/couple-reminder-fairness.cjs`: actual job/query source with5001-event inner continuation,51-couple outer bound, query/read/partial failures, single-flight, current date/timezone/08:00 auto-stage rechecks and reminder slot parity.
- Backend `personal-wallets/me-settled.cjs`: actual repository/service/controller with strict fake imports; no-write settled validation, pending/legacy/invalid membership and missing-couple failures, awaited repair/error ordering, unpaired/missing-user handling and post-repair response EXP coherence. Existing wallet fault/replay/CAS/policy suites remain selected.
- Account-wide push now includes admission/drain active+waiting and timeout tests; lifecycle source fixture requires producer/HTTP joins then push drain before DB disconnect.
- Frontend `tests/history/friend-comments.cjs`: actual wrappers/TSX with strict fake hooks, single selected poll mode, root/reply/context navigation (including back to the notification seed), retained failed draft, success navigation, immediate local-block suppression and stale-error hiding. Browser effects are verified separately.

Separate fully intercepted production-preview UI fixtures are `scripts/browser/friend-comment-pages.mjs` and `scripts/browser/history-pages.mjs`; they are intentionally **not** in offline runners because they require an owned browser/runtime. See browser README and performance document for actual run evidence and limitations. No wildcard test discovery, live database cleanup, listener or provider was added to offline gates.

## Solo AI chat additions

- Backend `scam-game/state.cjs` and `ai-board.cjs` use their own fail-closed loader; only audited game source/errors plus crypto/Zod/Mongoose/Express packages are admitted. Env, provider factory, model persistence, profiles and safety queries are explicit fakes. They cover server props, score600, warning/loss/rescue, receipts/CAS, concurrent start, pending stop/new match, expired-lease takeover, late worker, AI failures/strict JSON/concurrency, exact-secret redaction, bounded context/storage, query shape and viewer-scoped cursors. Mongo window/rank execution is **not** tested.
- Existing in-memory `http-contract/routes.test.cjs` adds all six game routes, current auth/membership, request-owned player, consent, default/max bounds and synthetic OTP leading zeros. Its fake IncomingMessage explicitly marks parser completion and has a5s fail-fast timeout; no listening socket.
- Frontend `tests/scam-game.cjs` loads actual wrappers/TSX with explicit fake hooks/API/access stores: drawer click/drag/cancel, retained failed input, OTP text, duplicate submit, uncertain acknowledgement GET reconciliation, late session/access fence and cached-board hiding on failed revalidation. Browser layout/actual pointer interaction is separate.
- `scripts/browser/scam-game.mjs` is fully intercepted and outside offline runners. It never starts an API or reaches Mongo/AI. See `docs/scam-game.md` and browser README for limitations.

## Other tracked material, not selected

Inventory based on `git ls-files` at the reviewed revision, not ignore rules:

- Backend `tests/*/mongo.cjs` files require a Mongo runtime. In particular,
  wallet and other mock-runtime/browser harnesses use real listeners and/or
  Mongo and can initialize or clean fixtures. They are not part of this matrix.
- `backend/tests/realtime/run.cjs` dynamically discovers additional suites,
  including a transport test that imports the app and listens on a local port;
  `backend/tests/post-media/storage.test.cjs` also starts a local HTTP listener.
  Neither is in this matrix. Other backend suites remain outside this allowlist
  until separately audited; exclusion does not imply every one needs a live service.
- Frontend `tests/**/browser.mjs`, realtime dev-server and backend browser
  launchers are browser/runtime tooling, not isolated unit suites. Other
  tracked frontend scripts and suites are not implicitly covered.
- Tracked backend scripts include deployment bootstrap, measurements and
  smoke helpers. The existing ignored local
  `backend/scripts/test-security-observability.cjs` is not a tracked CI entry;
  it was reviewed read-only and only the isolated assertions above promoted.
  `git ls-files` does not enumerate ignored local helpers or generated evidence;
  neither is an input to this workflow. No cleanup of such artifacts is implied.

Run runtime/browser/DB/AI suites only under their own approved environment and
scope. A passing offline matrix is not evidence those suites were run.
