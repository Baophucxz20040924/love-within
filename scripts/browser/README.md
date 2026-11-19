# Local verification harness

## Daily rewards, moment receipt and manual water proof (mock only)

With operator-owned Vite on port 5173 (no backend is required), run:

```powershell
node scripts/browser/daily-rewards-water.mjs --validate
node scripts/browser/daily-rewards-water.mjs
```

The script intercepts every API/provider request, uses synthetic DTOs in two 360x780 Vietnamese contexts, and blocks unexpected requests. It exercises reward/EXP copy, a confirmed moment receipt while refetch is held, uncertain-post exact-session reconciliation without reposting, optional manual proof and partner review, and ledger provenance. Read the printed result JSON and inspect screenshots. This is UI/fault-injection evidence, not real Mongo accounting, provider delivery, or physical iPhone verification. Existing external Playwright tooling is required; no app dependency is installed.

Source is persistent here. Dependencies, screenshots and result JSON live outside the app, normally `%TEMP%\lw_pw`. No frontend dependency is added. This harness never starts or stops application servers, reads `.env`, or saves credentials/storage state/traces/HAR.

## Post-auth notification onboarding (production-build mock only)

After inspecting port ownership, use an operator-owned production preview on **loopback port 5175**; keep the existing Vite on 5173 untouched. No backend is needed. Build first so the production-only push capability guards are exercised without changing them:

```powershell
npm --prefix frontend run build
node frontend/node_modules/vite/bin/vite.js preview frontend --host 127.0.0.1 --port 5175 --strictPort
# In another terminal, from the repository root:
node frontend/tests/push/onboarding-browser.mjs --validate
$env:LW_UI_URL = 'http://127.0.0.1:5175'
node frontend/tests/push/onboarding-browser.mjs --local-mock-runtime
```

The fixture never starts/stops servers or uses API/Mongo/provider credentials. It blocks unknown API and external requests, replaces Notification/PushManager/service-worker APIs before app execution, and drives real login/register forms with synthetic responses. It checks 360×780 mobile and 1280×800 desktop: default permission requires a tap, “Để sau” survives navigation/focus/re-login, denied permission offers settings help, granted without an owned subscription still requires explicit enable, existing owned opt-in is not enrolled again, and an iOS user-agent receives Home Screen installation guidance. Inspect the printed `result.json` **and** screenshots; inputs are masked. Browser fixture failures are retained in separate evidence directories.

This proves mocked UI integration only—not native permission, physical iPhone compatibility, real service-worker registration, HTTPS/VAPID delivery, production performance or Mongo concurrency. iOS user-agent emulation in Chromium is not Safari. Negative assertions are bounded observations. Isolated auth/readiness/StrictMode/cross-tab policy and async-fence regressions run with `npm --prefix frontend run test:push`; those use VM/fake hooks rather than a browser renderer. Stop only the preview process you own after verification; leave Vite running.

## Discovery and bounded prefetch (production-build mock only)

Use the same owned loopback production preview on port 5175 described above,
with no API/Mongo process needed. Run sequentially, not alongside other browser
or API regression lifecycles:

```powershell
$env:LW_UI_URL = 'http://127.0.0.1:5175'
node frontend/tests/discovery/browser.mjs --local-mock-runtime
```

This fixture keeps Home/Friends discovery and outing deletion-boundary checks,
then controls idle callbacks to inspect the two selected route entry chunks in
couple/desktop and Friends/mobile shells. Data Saver and 3G gate scheduling;
hidden/offline transitions are applied after startup verification and before the
queued callback. A direct nonselected guide route remains available with prefetch
disabled. Promise concurrency, cancellation/unmount and StrictMode replay are
covered by `frontend/tests/prefetch/routes.cjs`, not claimed as browser checks.
Inspect `result.json` and screenshots under the printed temporary evidence path.
All sessions/APIs are synthetic; unknown API/external requests fail closed.
Chunk-entry observations are not total dependency bytes or a production speedup.
Stop only the preview you own and leave Vite 5173 running.

## Ledger and couple-comment history (production-build mock only)

Inspect ports4000/4001/5173/5175 first. With no API worker required, build and use only your own loopback production preview5175 as above; leave Vite5173 untouched. Existing external browser tooling is required, no dependency installation by this fixture:

```powershell
node scripts/browser/history-pages.mjs --validate
$env:LW_UI_URL = 'http://127.0.0.1:5175'
node scripts/browser/history-pages.mjs
```

The fail-closed fixture runs sequential mobile360×780 and desktop1280×800 contexts with synthetic auth/DTOs, blocks unknown API/external requests and websockets, and never starts servers or reads secrets. It checks ledger loading,20-row pages, older/newer/latest, provenance, empty/error retry; comment order, retained draft/error focus, successful send from history returning newest, deletion-to-empty-history and cached private rows hidden after an active20-second poll receives403. HTTP/console faults are explicitly budgeted. Read the printed `result.json` and screenshots; screenshots are viewport captures, not proof every row was visually reviewed. A deletion mock returning an empty page does not establish Mongo concurrent-delete behavior. Account switching and actual realtime transport are not exercised here; source/VM regressions cover additional fences.

Latest run:12/12 checks, `%TEMP%/lw_history_browser/1795054328949`; no unbudgeted errors/unknown requests, mobile ledger navigation and desktop comments images inspected. The earlier selector failure remains in a separate evidence directory. This is browser integration evidence only—not backend ACL, query cost, throughput, physical iPhone or Safari evidence. Stop only your owned preview afterwards; leave Vite running.

## Friends story/event comment pages (production-build mock only)

Inspect ports4000/4001/5173/5175 and ownership before starting anything. No API or Mongo worker is required. Build the current frontend and use your own loopback production preview5175 as above; do not replace or stop the existing Vite5173. Use the already-installed external Playwright/Chromium tooling:

```powershell
node scripts/browser/friend-comment-pages.mjs --validate
npm --prefix frontend run build
# Start an owned preview as shown above, then in another terminal:
$env:LW_UI_URL = 'http://127.0.0.1:5175'
node scripts/browser/friend-comment-pages.mjs
```

`--validate` checks synthetic IDs/relationships before importing the browser harness. Runtime runs sequential360×780 mobile and1280×800 desktop contexts for both story and event, with Vietnamese locale/timezone and reduced motion. Every API/external request and websocket is intercepted; unknown requests fail closed. The fixture never reads credentials, starts/stops servers or persists real block/comment mutations. Direct synthetic UI document navigation is fulfilled from the same local index, including `?comment=`; this is not deployment deep-link verification.

Six checks per device/resource cover root order/pages, lazy reply history, retained failed draft/error focus, add from history returning newest, delete-to-empty history, deep target focus/highlight and context-seed back navigation, reply success/newest, reply delete, a real20s context poll receiving403 and hiding cached rows, and actual report/block sheets immediately suppressing a cached root and its replies despite a deliberately stale mocked GET. The event consumer supports direct `?comment=` links; existing event inbox DTOs do not supply a comment ID and were not redesigned.

Latest result: **24/24 checks**, `%TEMP%/lw_friend_comments/1795059526539`; JSON reviewed, mobile-story deep-context and desktop-event failed-draft screenshots inspected. No unknown/external requests or unbudgeted errors; injected503/403 HTTP and console errors matched exact budgets. The first preview document404 failure is retained at `%TEMP%/lw_friend_comments/1795059257332`, not counted as PASS. Only the two named screenshots were visually inspected, not all16 captured images.

This proves synthetic UI/wrapper integration, not backend ACL, Mongo cost/concurrency, account switching, real realtime delivery, native push or physical iPhone/Safari behavior. Delete mocks model empty history, not concurrent database writes; block persistence is mocked. Run separately from API/browser regression lifecycles. Stop only the preview you own afterwards and leave Vite running.

## Solo AI chat game (fully intercepted)

Inspect ports4000/4001/5173/5175 and ownership, build frontend, use only an owned production preview5175 as above; leave Vite5173 untouched. No API/Mongo/provider is required:

```powershell
node scripts/browser/scam-game.mjs --validate
npm --prefix frontend run build
$env:LW_UI_URL = 'http://127.0.0.1:5175'
node scripts/browser/scam-game.mjs
```

The fixture blocks unknown API/external requests and websockets; all game/auth responses are synthetic. Its intercepted SSE request is held open (no upstream connection) to avoid artificial EOF/reconnect access transitions during form tests. Terminal composer observation is atomic so removal on loss is not mistaken for an input timeout. Sequential360×780 and1280×800 checks cover Bảng tin → prominent Chơi ngay card → game, Tôi → game, direct/reload entry without auto-start, Friends palette after auth bootstrap, explicit consent/name, provider error draft retention, committed-write/lost-ack GET reconciliation, click-only accordion plus Enter/Space, drag/scroll/selection not toggling the panel, no nested panel scrolling, composer preceding confirmation, terminal-only leaderboard with zero active board requests, wrong form value retention, password reveal/OTP leading zero, three stages600 points, wins/BXH, trust-only meter, continuation at trust0 then AI hang-up retaining100 partial points without a new prop or extra win, read-only loss, reload of pending state, Dừng scam and replay with another character. Gesture checks use a mouse pointer at both viewport sizes, not physical touch; native clipboard and mobile keyboard behavior are not verified. `--validate` exits before browser/harness import. Read result JSON and screenshots; automated no-overflow does not prove layout quality. No real provider persona intelligence, Mongo persistence/rank concurrency, native keyboard, Safari/device or production performance claim. Stop only the owned preview afterwards. Local mechanics and provider choices are documented in `backend/docs/scam-game.md`.

Current fixture also asserts immediate outgoing bubbles before a held AI response, empty sent composer/new draft support, inline failed-message recovery, receipt-based deduplication, pending-bubble reconstruction after reload, all three unfinished inputs editable during pending, natural value replies, and shorter password labels. Completion waits for canonical state rather than an empty composer. This does not test actual provider output.

Latest personality/focused-play UI result: **14/14 groups**, `%TEMP%/lw_scam_browser/1795095339409`. JSON reviewed: six injected503/422 faults, exactly12 budgeted HTTP/console errors, blocked list empty. Seven of24 screenshots inspected: chat header, expanded confirmation and terminal leaderboard at both sizes, plus mobile stopped result. Click/keyboard toggles preserve drafts; drag, scroll, text selection and inserted text do not toggle; no panel-local scroll or active leaderboard requests. Backend32/frontend29 offline suite files and both builds passed. Synthetic UI only, not real-model pacing or native touch/clipboard evidence. Owned5175 preview stopped; existing4000/5173 listeners untouched.

Historical optimistic-send/context-contract UI result: **14/14 groups**, `%TEMP%/lw_scam_browser/1795086562399`. JSON reviewed: six injected503/422 faults, exactly12 budgeted HTTP/console errors, blocked list empty. Optimistic-pending, send-error and drawer-error screenshots inspected at both sizes (six of22 inventory captures). Pending user bubble appears before AI completes, newer draft remains independent, failures have nearby recovery controls, and natural account reply appears without a server prop bubble. Lower drawer/composer controls remain scroll-reachable, not all simultaneously visible above fixed navigation. Backend30+frontend29 offline suites/builds passed, with targeted recovery/context checks rerun; no API/provider/Mongo runtime. Owned5175 preview stopped, existing listeners left alone.

Historical trust-only / AI hang-up result: **14/14 checks**, `%TEMP%/lw_scam_browser/1795082365530`. Result JSON reviewed: six injected503/422 faults, exactly12 budgeted HTTP/console errors, no unknown/external requests. One full-width blue trust meter replaces suspicion/warnings; trust0 continuation, AI hang-up after100 confirmed points with best600/wins1 unchanged, no new password and terminal read-only controls are asserted. Character header/trust, loss card and reachable composer/stop screenshots at both viewports were visually inspected (six of18 inventory images, not all captures). Backend30 and frontend29 audited offline suite files plus builds passed; no actual provider/API/Mongo call or win-rate claim. The owned preview was stopped and existing listeners left untouched.

Historical UI-refresh result (before AI hang-up contract): **14/14 checks**, `%TEMP%/lw_scam_browser/1795080777494`; result JSON reviewed, six injected503/422 faults produced exactly12 budgeted HTTP/console errors, no unknown/external requests. The18 viewport captures are an inventory, not18 fully reviewed states. Visual review spans the same-source passing runs: feed/lobby/drawer/BXH/composer on both viewports at `1795080324632`, mobile/desktop character headers plus mobile consent at `1795080617052`, and final desktop consent at `1795080777494`. CTA/composer/stop are asserted scroll-reachable above navigation; textarea width, long wrapping/selectable bubbles and password-toggle draft retention are checked. They are not promised onscreen without scrolling or with a native keyboard open. Earlier failures remain separate (synthetic SSE EOF interrupted actions; a split count/input read raced terminal removal); the fixture now holds SSE and observes terminal input atomically. Latest frontend build and all29 offline suite files passed, including65 lock-store cases and the game VM suite. Backend30-suite evidence predates this frontend-only refresh; no backend runtime/provider probe ran here. Suite-file counts are not individual test counts. The owned preview was stopped; existing Vite was left untouched.

## Install external tooling

PowerShell, from the repository root:

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\lw_pw" | Out-Null
Copy-Item .\scripts\browser\tooling-package.json "$env:TEMP\lw_pw\package.json"
npm install --prefix "$env:TEMP\lw_pw" --ignore-scripts --no-audit --no-fund
$env:CHROME = "$env:LOCALAPPDATA\ms-playwright\chromium-1243\chrome-win64\chrome.exe"
```

The package pins `playwright-core` 1.65.0. It uses the already installed browser; no browser download or frontend installation is required. `LW_PW_HOME` overrides the external tooling directory.

## CP7 browser flow

The operator must first start Vite at localhost:5173 and a fresh local backend at localhost:4000, with local MongoDB `lookwithin_dev`, `NODE_ENV=development`, `STORAGE_PROVIDER=memory`, `AI_PROVIDER=mock`, `AI_CHAT_PROVIDER=mock`, `BANK_PROVIDER=mock`, `PUSH_PROVIDER=mock`, `NODE_APP_INSTANCE=1`, and `SCHEDULER_ENABLED=false`. Set these only in the launched process environment. Registration throttles are reset by the operator restarting the API before a run. Do not point this at a real bank provider or production database.

```powershell
node .\scripts\browser\cp7-savings.mjs
```

Optional process variables: `LW_UI_URL`, `LW_API_URL` (local hosts only), `LW_HEADED=1`, `LW_EVIDENCE_DIR` (default `%TEMP%\lw_pw\shots\cp7-<run-id>`).

The script uses two separate contexts, 360x780, vi-VN, Asia/Ho_Chi_Minh. The partner uses reduced motion. API calls only seed/register/pair accounts and link/clean up the owner's mock bank. Login and all savings mutations run through visible UI.

Coverage: no-bank entry and manual contributions; create proposal/partner consent; pin/Home; both partners' ledger and owner-only deletion; withdrawal reason; target rejection/approval and due date; reached milestone/reduced motion/reload dedup; real Bucket list and Story composers; private bank note; explicit bank-sharing warning; attachment with note privacy; close approval and read-only history. No pause/resume/delete-goal flow exists in the CP7 UI contract.

Screenshots are taken at checkpoints and on failure. `result.json` contains step results and sanitized console, page, HTTP and request failures. No HTTP error is silently accepted. Review screenshots manually after running; the script checks horizontal overflow but cannot establish visual quality. Only synthetic account/transaction data should be used. Screenshots mask email/password inputs, not arbitrary user content. Mock bank data is disconnected/purged in cleanup; test accounts/goals are retained in the local dev DB. If the process is forcibly terminated, cleanup may need to be completed by the operator.

The harness fails fast at the first flow failure and returns exit code 1. Labels follow the current frontend source; if source changes, update selectors rather than bypassing the UI with API assertions. Browser/OS version compatibility and real phone behavior remain operator checks. It is not a restoration of the 13 historical browser suites lost with the temporary directory.

## V12 browser and isolated verification

Run browser flows only after the operator has checked/started owned local mock services. Do not run alongside API smoke lifecycles or performance measurements.

```powershell
node scripts/browser/v12-boat.mjs
node scripts/browser/v12-outings.mjs
$env:LW_BASELINE_FIXTURE = '<private synthetic fixture from v12-baseline>'
node scripts/browser/v12-session.mjs
node scripts/browser/v12-interactions.mjs
node scripts/browser/v12-matrix.mjs
node scripts/browser/v12-populated.mjs
node scripts/browser/v12-savings-list.mjs
```

Outings drives three independent UI logins, invitations, integer/zero-share editing, consent, partial confirmation and restricted history. Its injected 409 checks draft UX, not real CAS concurrency. Session/interactions classify only explicitly injected faults. Matrix is a default-state capture inventory, **not** complete 42-route visual/state acceptance; missing populated fixtures are recorded, not passed. Inspect `result.json` and open screenshots. No credentials, traces, HAR or storage state are evidence artifacts.

Isolated regressions (no browser, API, or process actions):

```powershell
node --test scripts/browser/test-harness.mjs scripts/browser/test-populated.mjs
node frontend/scripts/test-session-mutations.cjs
node frontend/scripts/test-finance-bootstrap.cjs
node --test scripts/browser/test-outing-states.mjs
node scripts/browser/v12-savings-list.mjs --validate
node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/test-savings-list.ts
```

Helper/fixture tests check default full-page versus explicit viewport capture, populated credential masks, sanitized console resource paths, 50-member/100-expense arithmetic, and layout-shift session-window summarization. Component tests load actual TSX with mocked hooks/query/API; they are not browser proof. Savings pipeline mocks do not connect to MongoDB. The helper carries paths only, never resource query strings. `--validate` exits before browser/harness import.

Session harness hardening adds exact original/refresh request counts, `form.requestSubmit()` duplicate exclusion, and expected resource errors scoped by label/path/status/count. Correction to an earlier static review: the old handler **already returned the original bucket401 for all three faults**; reordering did not fix a missing refresh trigger. Extended session runtime has passed 10 cases; HeavyOutings completed 319/319. Latest exact-source evidence and remaining visual limits are recorded in `plan/ENGINEERING_WORKFLOW.md` (evidence and route/state sections), not inferred from these historical counts.

Runtime-verified extensions (see the consolidated engineering workflow for source/evidence attribution): session adds delayed successful read/mutation responses across logout/login in the original document (no reload hiding cache leaks), plus same-tab pending-login duplicate exclusion. CP7 adds an observed successful local entry write whose acknowledgement is replaced with 503, a synthetic busy409 retry, then real same-operationId replay; this is not a process crash/journal guarantee or reload-persistent retry. Expected errors are scoped to declared cases. `v12-populated.mjs` injects GET-only DTOs for 12 long image posts and a 50-member/10-billion-VND ledger at three viewports; it uses local icon imagery and tests rendering only, not actual 50-account API/ACL/cap acceptance. Open the resulting images manually. Do not run any of these while HeavyOutings is alive; verify its OS ownership and actual result first.

Approved isolated test harnesses are distinct from browser `lookwithin_dev`: security owns a disposable loopback mongod and generated credentials, recovery uses a fresh exclusive synthetic DB on local Mongo, and performance reuses the tagged `lookwithin_v12_perf` baseline fixture. They disable dotenv and must never target production. Do not modify database guards to force a run.

```powershell
powershell -NoProfile -File backend/scripts/run-security.ps1 -LogDirectory '<local evidence directory>'
node backend/scripts/run-savings-recovery.mjs --exclusive-synthetic-db
node scripts/performance/run.mjs after-v12-quiet
```

Recovery stops both owned fixture workers before invoking the actual offline CLI. It models a constructed interruption, not a real process crash or distributed worker detector. Performance requires free 4010 and no competing regression/browser workload; report regressions and actual measurement limits. Separate heavy outing profile remains a multi-hour paced test, not included in the ordinary run.

## State-family verification added during closure

Use the same guarded private synthetic baseline and owned mock runtime as above. Run **sequentially**, never alongside smokes or performance. An alternate `LW_API_URL` does not change the frontend's relative `/api` proxy: configure the owned Vite proxy to that same API.

```powershell
node scripts/browser/v12-content-states.mjs
node scripts/browser/v12-friends-states.mjs
node scripts/browser/v12-daily-states.mjs
node scripts/browser/v12-home-states.mjs
node scripts/browser/v12-reflection-states.mjs
node scripts/browser/v12-finance-states.mjs
node scripts/browser/v12-public-states.mjs
node scripts/browser/v12-guards.mjs
node scripts/browser/v12-family-states.mjs
node scripts/browser/v12-accessibility.mjs
```

These state packs use deterministic DTOs, held requests and exact error budgets. Display/failure tests do not prove successful server mutation or ACL. Read `result.json`, open named screenshots, and record full-size versus scaled review. A passing assertion can still capture the wrong scroll position; preserve failed/pre-fix artifacts. Public states need no baseline because authentication requests are intercepted, not sent upstream.

Pure checks:

```powershell
node --test scripts/browser/test-content-states.mjs scripts/browser/test-friends-states.mjs scripts/browser/test-reflection-states.mjs scripts/browser/test-v12-daily-states.mjs scripts/browser/test-finance-states.mjs
node frontend/scripts/test-auth-storage.cjs
node frontend/scripts/test-savings-progress.cjs
node scripts/browser/v12-public-states.mjs --validate
node scripts/browser/v12-guards.mjs --validate
node scripts/performance/outing-http.mjs --check
```

Outing HTTP measurement is separate: `node scripts/performance/outing-http.mjs --exclusive-local-fixture --runtime-lock-held`. It owns port4011 and a random fresh loopback synthetic DB, uses controlled `createApp` startup without `syncIndexes`, retains data, and reports **after-only** HTTP and Mongoose-operation observations. It must not run beside browser/smoke workloads; operation counts are not wire-command counts or a speedup claim.

## Persistent backend smoke matrix

```powershell
.\backend\scripts\run-smokes.ps1
.\backend\scripts\run-smokes.ps1 -Only smoke-market-approval,smoke-savings
.\backend\scripts\run-smokes.ps1 -Only finance -SuiteTimeoutSec 600
```

Unlike the browser harness, this runner explicitly manages backend processes. The operator must release port 4000 (and 4001 for savings) first. It refuses preexisting listeners; the retired legacy helper is not needed, and arbitrary port owners must never be killed. It restarts its own backend for every suite, validates PID creation time before stopping only its own processes, and leaves Vite untouched. Savings uses a second owned API worker on 4001 by default and passes `SAVINGS_SECOND_API_BASE` to the smoke script.

The standard matrix requires all 21 legacy suites plus outings and the isolated security wrapper. Missing selected suites fail, including savings; no silent skip. Savings and outings use two owned workers. Security owns a separate guarded disposable loopback Mongo/API lifecycle, generated synthetic credentials and no-dotenv preload; it does not reuse a production or shared fixture. `-Only` accepts names with/without `smoke-` and `.ps1`, comma-separated or a PowerShell array. Each suite has a bounded timeout (default 300 seconds). The runner forces safe mock/storage/local-DB settings; scheduler alone uses `PUSH_PROVIDER=webpush` with empty VAPID values so its production probe is compatible. Provider settings are injected into child environment blocks without changing `.env` or displaying secret values.

A zero exit code is insufficient: the runner requires PASS assertions, no FAIL lines, an explicit consistent terminal summary, no stderr, and no timeout. It detects the market suite's zero-exit failures. Historical expected counts are informational, since new features may add regression assertions. Sanitized assertion logs and `summary.json` go to `%TEMP%\lw_smokes_<timestamp>` or `-LogDirectory`. Primary raw server logs retain legacy `%TEMP%\lw_server.log` / `.err.log` paths needed by existing smoke privacy assertions; second-worker logs use `_4001`. Raw logs and child errors are not copied to evidence or printed. Inspect local raw logs privately when startup fails.

Avoid running date-sensitive suites across midnight Asia/Ho_Chi_Minh. The runner modifies local dev data and may run scheduler jobs against previously seeded local records. Do not run concurrently with another smoke/browser session.
