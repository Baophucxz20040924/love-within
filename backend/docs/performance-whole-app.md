# Whole-app performance solution and delivery roadmap

## Status and scope

This is a **static-code-evidenced roadmap**, not a report of measured production bottlenecks, latency, capacity or speedup. Priorities order investigation and delivery dependencies. They do not establish that a particular query, component or configured pool is slow in production.

The [daily activities evidence](performance-daily-activities.md) is a separate offline Moment simulation. Its artificial delays and VM boundary counts are not real Mongo operations, HTTP latency or whole-app results. Save acknowledgement, usable UI, media rendering, reward settlement and inbox delivery are different milestones; measure each separately.

The first release added this roadmap and proactive post-auth push onboarding. The follow-up optimization wave implements bounded selective route prefetch, matched-route wallet/quest authentication, parsed-request replacement, bounded recovery observations, Moment traversal continuation and explicit offline gates. See the implementation status below and [API/scaling assessment](api-scale-review.md).

The user clarified on 2026-11-18 that **scale means code extensibility on unchanged infrastructure**. The second wave implements additive histories, selected GET cancellation, request-local outing ACL batching, bank lifecycle and Friends reminder continuation. No additional server/replica/Redis/queue service, pool/deploy change or index rollout is required or included. The third wave adds Friends threaded histories, couple-reminder continuation, push drain and an internal `/me` repair/read seam. Read-only default `/me`, durable delivery/retry and broader freshness changes remain separate phases. No production telemetry, real database/explain/load test or provider call was performed.

### Follow-up implementation status

| Area | Implemented scope | Verification boundary |
| --- | --- | --- |
| Frontend startup | Up to two selected top-level route loaders per shell lifetime; serial idle work, visibility/connectivity/constrained-network gates, queued-work cancellation | Deterministic loader/concurrency and mocked browser checks; not production navigation latency or unique chunk/byte savings |
| API work amplification | Wallet/quest guards only on matched routes, fresh credential checks retained; parsed query/params replace original values | Composed Express offline contract fixtures; representative downstream credential reads change from three to one, not a claim about every endpoint |
| Recovery visibility | Fixed-label numeric whole/stage observations; no extra reads or change in repair semantics | Mock backlog/failure fixtures; saturation is not backlog size and completion is not a new payout count |
| Background fairness | Process-local Moment scan checkpoint after successful pages, bounded continuation and wrap | Synthetic population above 20,000; not durable progress across process restarts or poison records |
| Hygiene | Strict discovery harness repair, explicit audited offline entrypoints and no-secret PR workflow | Local build/offline results recorded separately; workflow execution on GitHub requires a later authorized push |

### Local verification — 2026-11-18

- `npm --prefix backend run test:offline`: PASS after integration; backend TypeScript build and all 20 explicitly listed suite files completed with exit code 0.
- `npm --prefix frontend run test:offline`: PASS after integration; production build/typechecking and all 24 explicitly listed suite files completed with exit code 0. These are suite-file counts, not a combined count of test cases.
- Express composition fixtures prove the representative downstream credential-read reduction from 3 to 1, immediate rejection after credential-version change, and parsed-value replacement/atomicity. Prefetch fixtures prove a two-loader budget, serial execution, gates, rejection handling and cancellation/StrictMode behavior.
- Moment fairness fixtures include 20,001 synthetic couples across bounded runs, wrap, insertion/deletion, page failure retry and local-date/timezone boundaries. Recovery fixtures include empty/populated/saturated/deferred/error work and telemetry failure isolation. These do not exercise real Mongo concurrency.
- The final intercepted production-build discovery browser run passed 16 checks, including desktop couple/mobile Friends prefetch, Data Saver/3G gates and hidden/offline transitions before the queued callback. Exactly the two selected route entry chunks were requested in each visible-shell fixture; no selected entries were requested in the four gated fixtures. Direct navigation to a nonselected guide route remained usable with Data Saver enabled. This is not a full transitive-chunk/byte measurement or a production speedup.
- The post-auth push onboarding production-build browser regression passed all 6 synthetic scenarios after the optimization build: explicit-tap enable, Later/relogin, denied help, granted without subscription, existing opt-in, and iOS-install guidance. Evidence: `%TEMP%/lw_push_onboarding_browser/1794989956691-950ead75`; result and default/denied screenshots inspected. This is mocked browser API behavior, not native permission or push delivery.
- Node 24.18.0 was used locally. The new Node 22 GitHub PR workflow has not been executed remotely; no new optimization commit, push or deployment was performed.

The first hidden-browser attempt timed out at session verification because it forced hidden state before startup. The retained failed evidence was not counted as a product regression or PASS; the corrected fixture transitions after startup and passes. Browser cancellation/unmount/StrictMode and forced import rejection remain deterministic unit coverage, not browser claims. Final browser evidence: `%TEMP%/lw_discovery_browser/1794989757021-9dc41498` (`result.json` plus screenshots); desktop couple, mobile Friends and direct-route screenshots were inspected. The optional isolated-worktree reviewer stopped after a root git-access boundary refusal; no completed independent-review claim is made. No real Mongo, load test, provider delivery, native permission prompt or physical device was exercised.

## Second wave — code-only delivery, 2026-11-19

| Area | Delivered behavior | Evidence / remaining limit |
| --- | --- | --- |
| Ledger | Additive scoped canonical keyset pages; Profile20 rows and older/newer/latest; legacy array50 retained |105 tied-date synthetic rows, visibility/type/owner cursor and recovery-order tests. No accounting/query-plan changes. |
| Couple comments | Additive keyset pages, live story check, one active page20; chronological rendering; add returns newest; active-only invalidation |521 tied-date comments across27 pages, legacy500, draft/navigation/error tests. Friends threaded pagination deferred. |
| Cancellation | Selected GET wrappers/query functions consume existing signal | Installed query-core observer tests: shared read survives first unsubscribe, last consumer abort, late result not cached, parameter/next-page cancellation. Existing transport shared-refresh/deadline/session tests retained. |
| Outing ACL | Batched exact pairs and exact-roster block queries within one list request |23 direct-membership tests, including sequential parity, block chunk projection, cross-roster isolation and empty-visible-page continuation. Detail/write/replay checks remain live; no permission TTL cache. |
| Bank | Tracked timers, generation/admission, cancellable jitter wait, bounded join and single server shutdown | Fake timers/deferred list/sync/restart/timeout tests. Provider operation may outlive10s join; true overlap guard remains held. |
| Friends reminders |500-candidate continuation with tied startAt/_id, completed-record checkpoints and single-flight |501st candidate reached after500 already-sent, read/partial failure and live-window/recipient/reschedule fixtures. Process-local progress and claim-before-delivery limitations remain. |

New history contracts are live keyset pages, not stable numbered snapshots. Row limits bound payload/rendering, not Mongo documents examined; no index rollout occurred. No latency, capacity or speedup percentage is inferred.

Browser: `scripts/browser/history-pages.mjs` passed12 checks at360×780 and1280×800 against a production preview with every API/external request intercepted. Coverage includes ledger loading/20 rows/navigation/empty/error retry/provenance; comment order, draft and error focus, history-to-newest success, delete-to-empty history and stale-row hiding after a real active-page poll receives403. HTTP/console errors were deliberately injected and budgeted; there were no unbudgeted errors or unknown requests. Evidence: `%TEMP%/lw_history_browser/1795054328949`; result and mobile ledger navigation/desktop comments screenshots inspected. Earlier failed evidence `%TEMP%/lw_history_browser/1795053804087` is retained: an overly broad success selector matched textarea text before submission settled, fixed by waiting on a comment body. This was a fixture failure, not silently counted as PASS.

Final combined local gate: `npm --prefix backend run test:offline && npm --prefix frontend run test:offline && git diff --check` PASS, including backend build/25 explicit suite files and frontend typecheck/production build/27 explicit suite files. After adding empty-visible-page continuation coverage, both the focused outing rerun and the final backend25-file gate passed, including all23 outing tests. The initial combined attempt failed frontend TypeScript inference around function-valued placeholderData; explicit `useQuery<Story>` / `useQuery<FriendStory>` fixed it and the full rerun passed. Local Node24.18.0 only; the Node22 PR workflow remains unexecuted remotely. No commit/push/deploy or infrastructure/data mutation occurred. Owned preview5175 stopped; existing Vite5173 remains running.

Browser mocks do not prove server ACL, actual account-switch/realtime delivery, Mongo concurrency or physical-device behavior. The deletion fixture models a page becoming empty, not a concurrent database deletion. Source/VM gates cover additional cache and transport fences. No completed independent-review claim is made; isolated reviewer launches stopped without reviewing the root checkout.

## Third wave — end-to-end code-only follow-up, 2026-11-19

| Area | Delivered behavior | Evidence / limit |
| --- | --- | --- |
| Friends discussion | Additive root/reply pages and bounded notification context for story and event; lazy replies, one root/context poller, chronological page display and existing mutation/count behavior |521 roots +521 replies per resource, ties/scoped cursors/live root ACL, actual route validation/auth tests; legacy arrays retained. Context does not scan prior pages. |
| Reply UI boundaries | Context-seed back navigation, event `?comment=` consumer, retained failed draft, add from history/newest replies, delete-to-empty, immediate local-block suppression | Mocked production browser24 checks at360×780 and1280×800 for both resources; no real DB ACL or realtime transport. |
| Couple reminders |50-couple/500-event candidate budgets, outer/inner continuation, fresh couple/timezone and current invocation window, single-flight |5001 events/51 couples, partial/query failures and query structure; auto stage rechecks on08:00/day/timezone changes. A full sweep may still exceed a due window; restart loses position. |
| Push shutdown | Stop producers/HTTP first, close push admission and bounded10s join of admitted active+waiting jobs, then disconnect |16 account-wide push tests plus existing6 Moment push and lifecycle tests. Timeout is not provider completion; no outbox/retry. |
| `/me` | Separate awaited repair from repository read-only settled validation; build couple/wallet/top-level EXP from post-repair values | Actual source seam/controller tests plus financial journal/replay/CAS regressions. Default GET still repairs; no transaction snapshot, no latency claim. Existing frontend auth epochs/single-flight and domain batching unchanged. |

The settled read replaces the redundant final get/create/migrate lookup with read/validate; it does not remove the compatibility recovery scans or cache permissions/balances across requests. Pending races fail closed with the existing review error. No new auth TTL cache or speculative narrowing of quest invalidation was introduced.

Browser evidence: `%TEMP%/lw_friend_comments/1795059526539`, result JSON reviewed and mobile-story deep context plus desktop-event failed-draft screenshots inspected.24 checks passed; unknown/external requests and unbudgeted errors were zero. API503/403 faults were deliberate, exact HTTP/console budgets matched. Local block is an intercepted mutation with deliberately stale GET data, not a real backend block. The first run's query-string document navigation hit preview404; its evidence is retained at `%TEMP%/lw_friend_comments/1795059257332`. The fixture now serves only the synthetic UI document from the same local index; API requests remain fail-closed. Earlier20-check run is not the final acceptance count. No completed independent-review claim is made.

Final third-wave local verification: fixture `--validate`, backend TypeScript build/**28 explicit suite files**, frontend TypeScript/production build/**28 explicit suite files**, and `git diff --check` all PASS. The aggregate gate was rerun after the final local-block, reminder-query and `/me` missing/unpaired/error-order regressions; exit code0. Counts are suite files, not test cases. The first integration gate failed because the Friends reminder query fixture did not mock the new comment-page import; an exact fail-closed mock was added (it asserts if invoked), and subsequent full gates passed. No generic import bypass was introduced.

Local Node24.18.0 only; Node22 GitHub workflow remains unrun remotely. No API/Mongo/provider run, dependency install, real data/index/backfill mutation, commit, push or deployment. Final port inspection found only the retained Vite5173 PID34188; owned preview5175 was stopped, with no listener on4000/4001/5175. Existing and accidentally created isolated reviewer worktrees were not cleaned; no completed independent review is claimed.

## P0 — Baselines and budgets

### Existing work to retain

- Separate personal/admin bundles and lazy routes: `frontend/src/app/App.tsx`, `frontend/src/app/lazyPages.ts`, `frontend/src/features/friends/lazyPages.ts`.
- Shared React Query keys/cache; parallel Home pulse sections with partial-failure isolation; 150ms realtime domain batching.
- Cursor feeds and header projections, bounded comment/unread scans, lazy images/async decode, aspect ratios, upload compression and self-hosted Vietnamese fonts.
- Numeric process-local request, section and scheduler observations: `backend/src/middleware/requestMetrics.ts:24`, `backend/src/utils/monitor.ts:15`, `backend/src/services/pulse.service.ts:48`, `backend/src/services/scheduler.service.ts:177`.

Request histograms are bucket estimates with process resets, not exact percentiles or cross-replica aggregation. Declared Content-Length is not compressed wire bytes; absent length is unknown, not zero. Mongoose operation counts are not Mongo wire-command counts. Concurrent section spans cannot be added to infer endpoint latency. Long-lived SSE must be interpreted separately.

### Journey coverage

| Journey | Required observations |
| --- | --- |
| Signed-out cold/warm startup; login/register/recovery; PIN unlock | JS/CSS bytes, parse/execute long tasks, verification/request counts, time to usable UI, mask duration, error/retry path |
| Paired/unpaired Home; quests/check-in/water/Moments | Active query keys, requests per five foreground minutes, pulse sections, save acknowledgement vs view vs settlement, upload bytes |
| Friends feed, profiles, comments, events | Large friend/hidden-author sets, deep scrolling DOM/heap/GC, comment history, authorization/block/delete and signing count |
| Finance, savings, outings | Mount sync vs provider time, loaded pages, query plans, history size, financial mutation conflicts/recovery |
| Inbox, push and SSE reconnect | Data age, unread accuracy/saturation, connection/reconnect rates, fallback polls, queue depth/drops/oldest due |
| Admin | Separate cold/warm bundle, manual list/search request count, response bytes/API latency and interaction responsiveness |

Capture fixed build/fixture revisions, device/browser, network, cache state, sample size and uncertainty. Include hidden/visible, offline/reconnect and slow/failing dependency cases. Compare before/after with the same setup and publish regressions as well as improvements.

**Reference targets, not current measurements:** field p75 LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1, segmented mobile/desktop. Lab long tasks/TBT diagnose interaction problems but do not establish field INP. Choose per-route API p50/p95/p99, request-rate, memory, freshness and backlog budgets after baseline/product freshness requirements; record baseline and selected budget explicitly. Do not promise a percentage speedup without measurements.

### Measurement privacy and operations

Use bounded, low-cardinality route/operation/outcome labels and numeric aggregates with reviewed retention/access. Never log tokens, push endpoints, signed URLs, media keys, captions, raw bodies/filters, search terms, personal balances or user/couple IDs (including hashed IDs). Telemetry failure must not fail a user operation. Review access policy before reading metric snapshots; do not publish raw traces/HAR or secret configuration.

Reuse existing scripts only within their stated scope. Database/explain/load work needs separate authorization and representative isolated synthetic fixtures; do not reuse shared/production records or weaken guards. Browser, API-smoke and performance lifecycles run sequentially, never competing. Do not run offline recovery while any API worker is alive.

## P1 — Startup, authentication and route loading

**Baseline evidence (`0e59338`):** `frontend/src/components/AppLayout.tsx` and Friends layout scheduled all-page idle prefetch, invoking 22 and 14 loader entries respectively. The follow-up replaces that burst with a small allowlist and shared cancellable scheduler; normal lazy imports remain. Auth bootstrap/startSession and `frontend/src/features/realtime/RealtimeSync.tsx` still verify identity/scope at different lifecycle points. Personal/admin splitting already exists.

**Hypothesis to measure:** broad prefetch may compete with useful route/media work; repeated verification may overlap. Count transferred/used/prefetched bytes, cached requests, startup long tasks, navigation-to-ready and verification calls by lifecycle. Static imports or multiple call sites alone do not prove duplication.

**Solution:** selective next-route prefetch in small idle batches, respecting Data Saver/connection capability and preserving on-demand imports. Coalesce only truly equivalent in-flight auth checks with the same generation, user, scope and revocation semantics. Never bypass PIN, credential checks or cache clearing on access loss. Do not merge intentionally independent post-resume verification just to reduce request count.

**Acceptance/rollback:** meet baseline-derived startup/navigation budgets with logout, same-account re-login, account switch, PIN and revoked-session tests unchanged. Medium risk for prefetch, high for auth. Roll back scheduling/coalescing independently to original lazy imports/verification.

## P1 — Home, polling, invalidation and SSE

**Evidence:** Home pulse polls at 30s (`frontend/src/pages/HomePage.tsx:197`); seven server builders run in parallel (`backend/src/services/pulse.service.ts:13`). Badge/approval/inbox polling also exists in `BottomNav.tsx:18`, `features/approvals/useApprovals.ts:11`, `features/notifications/useCoupleNotifications.ts:6`, and Friends layout. Shared query keys already deduplicate some observers. `features/realtime/invalidation.ts` batches but also uses broad domain prefixes.

**Measure:** actual mounted query keys and requests/five minutes, section p95/error rates, pool wait, invalidation fan-out and mutation-to-visible age. Exercise dropped events, SSE unavailable, background, offline and reconnect; an open stream is not durable delivery.

**Solution:** where dependency tests prove coverage, use SSE as the freshness hint with slower jittered polling fallback, foreground-aware scheduling and immediate focus/reconnect resync. Narrow invalidations by domain only after testing every dependent view. Keep maximum-staleness bounds, clock-driven updates, pulse partial results and revocation clearing.

**Acceptance/rollback:** fewer observed redundant requests with no breach of per-domain freshness or recovery budgets. Medium/high risk; restore previous polling intervals/invalidation map per domain if stale/missed updates appear. Do not disable all polling in one release.

## P1 — `/me`, wallet recovery and credentials

**Evidence:** `backend/src/controllers/me.controller.ts:11` waits for couple/wallet views. `backend/src/services/wallet.service.ts:179` scans at most 20 pending sources per each of three kinds, processes them sequentially and invokes daily reward recovery; `:230` waits before returning wallet. `backend/src/db/connection.ts:11` configures pool maximum 10. Auth and SSE heartbeat/delivery perform current credential reads (`middleware/auth.ts:13`, `services/credential.service.ts:52`, `services/realtime.service.ts:33`).

**Measure:** `/me` normal and synthetic backlog p50/p95/p99, per-source repair count/time, oldest pending age, credential-read rate and pool checkout wait under REST+SSE together. A configured pool of 10 is not proof of saturation; bounded recovery does not mean a fixed 60 full repairs always execute.

**Solution:** if recovery dominates, assess a smaller explicit request repair budget plus durable background progress, fair ordering and backlog monitoring. Retain pending wallet completion, immutable journal, idempotency and honest pending-vs-settled UI. Index subscribers by user/space if event scans dominate. Credential coalescing/caching must prove equivalent revocation, not add a TTL revocation delay. Pool tuning is not part of the requested code-only roadmap.

**Acceptance/rollback:** no lost/duplicate financial effects under retries/concurrency/interruption; source/journal/balance reconcile exactly; bounded fair oldest-age and API latency. High risk: reversible recovery scheduling with current bounded online repair as fallback, no deletion of pending intents or journal. Never label an unsettled reward as paid to make `/me` faster.

## P2 — Long lists, comments, media and fonts

**Evidence:** Friends feed, Stories and finance flatten retained pages (`frontend/src/pages/FriendsFeedPage.tsx:30`, `pages/StoriesPage.tsx:64`, `features/finance/FinanceViews.tsx:95`). Legacy comments cap at500; couple comments and Friends story/event threads now have additive cursor pages, including bounded root/reply/context contracts. Media signing scales with returned media (`services/friendStory.service.ts:130`). `PhotoGrid.tsx`, upload image helpers and `main.tsx` already use image/layout/font optimizations.

**Measure:** prolonged-scroll heap/GC/DOM, React commits, refetch growth, signing count/time, response/download/decoded-image bytes and actual rendered size. Profile media upload/save/view separately; font weights only count as unnecessary after measuring actual use.

**Solution:** stable comment cursors with deterministic tie ordering and explicit reply contract; measured windowing/bounded retention that preserves scroll, focus, keyboard/screen-reader access and optimistic state. Responsive thumbnails/media variants, lazy decode and justified font-weight reduction with Vietnamese visual tests. Deduplicate signing only within authorized scope; never share private signed URLs across accounts or bypass block/delete/Moment unlock checks.

**Acceptance/rollback:** meet heap/interaction/byte budgets on fixed large fixtures, all authorized comments reachable without pagination duplicates/gaps, no unauthorized media. Medium/high risk. Revert renderer/media variant independently, preserve original source data and compatible cursor contracts.

## P2 — Query plans, savings and outing writes

**Evidence:** savings exact status filtering aggregates entries before page limit with a three-second timeout (`backend/src/repositories/savings.repository.ts:14`); active/reached semantics intentionally avoid incorrect early limit. Friends feed uses author `$in`/exclusions with cursor (`friendStory.repository.ts:54`). On-this-day uses a date suffix regex (`story.repository.ts:79`). Outings use full-snapshot revision CAS with explicit capacity bounds (`friendOuting.repository.ts:20`, `models/FriendOuting.ts:3`); lists already project headers.

**Measure:** separately authorized `explain('executionStats')` on representative friend/exclusion/history distributions; keys/docs examined per result, blocking sorts, timeout/aggregation cost, BSON bytes and outing conflict/retry/write volume. A result limit/timeout bounds output/time, not necessarily examined work.

**Code-only solution:** narrow projections and reduce repeated lookups where actual access/result equivalence is tested; retain exact savings aggregation. Redesign large outing writes only if common measured cost warrants proving equivalent financial journal/idempotency/audit/CAS guarantees. Do not split a ledger casually or replace exact aggregation with an unverified cache. Index additions, backfills and materialized balance/status migrations are excluded from this delivery and are not prerequisites.

**Acceptance/rollback:** exact result sets/totals under edits/deletes/retries/concurrent writes; projection rebuild matches source; before/after plans and read/write budgets. High risk. Keep source aggregation/read path, additive migration/feature switches and reviewed rollback; no balance rewrite or automatic backfill in this scope.

## P3 — Bank sync, reminders, unread scans and push

**Evidence:** bank polling loads active connections and serially syncs with delay (`backend/src/services/bankSync.service.ts:95`). Couple reminders now continue within bounded outer-couple/inner-event budgets; Friends and Moment traversal also retain process-local progress. Restart, poison-record and expiring-window limits still apply. Scheduler jobs are serial with overlap guard/timings (`scheduler.service.ts:104`). Friends unread has a 500-candidate scan budget (`friendNotifications.service.ts:21`); push has bounded concurrency/2,000 pending limit (`push.service.ts:68`). Inbox persistence is separate from best-effort push (`notification.service.ts:115`).

**Measure:** complete cycle duration, scheduler lateness, oldest due age, page/cap saturation, provider throttles/errors, unread visibility work, push queue depth/drops/delivery age. Preserve the distinction between durable inbox and non-durable push transport.

**Solution:** indexed next-due selection, pagination and bounded concurrency/backoff within provider limits. Continue capped reminder work fairly instead of starving later records; retain expiry/send-once claims. Consider visibility-aware unread projections only with correct block/delete/relationship invalidation. Evaluate a durable push queue only if delivery requirements and measured saturation justify it; a RAM queue is not durable.

**Acceptance/rollback:** synthetic backlog/restart/overlap/rate-limit tests prove inbox/send-once/expiry correctness and agreed oldest-age throughput. High risk. Single designated worker ownership and preserved due state allow rollback; do not claim exactly-once provider delivery merely from logical idempotency.

## Outside scope — infrastructure and index operations

The current single-process topology/guard, deployment, pool and startup index behavior remain unchanged. They are not prerequisites for adding modules or extending API/UI contracts. No Redis, shared queue, extra server, replica or index rollout is proposed in this delivery. Query-plan investigations would require a separate authorized synthetic database scope; a source review cannot establish that an index is missing or safe to roll out. Never run startup/index reconciliation as a performance experiment.

## Admin and delivery gates

Admin is already separately loaded. Measure its cold/warm transfer/parse, manual list/search API p95, bytes and interaction response using authorized synthetic records; do not invent a large-list/polling bottleneck. Preserve exact search behavior, admin auth/audit and private search terms. Apply only measured bounded-query/bundle changes, with separate personal/admin regression reports and independent rollback.

1. Capture baselines/freshness requirements first; agree budgets and data handling.
2. Deliver one measured P1 batch at a time, with auth/recovery/realtime regressions.
3. Profile P2 before selecting cursors/media/indexes/projections; authorize DB work separately.
4. Pursue P3 only with backlog/capacity evidence and clear operational ownership.
5. Record build/fixture, baseline/target, samples, before/after, errors, privacy review, correctness results, owner and rollback trigger. Faster acknowledgement is not proof of a faster completed journey or successful money/inbox delivery.

Reference thresholds: [Web Vitals](https://web.dev/articles/vitals). Browser push constraints for the accompanying onboarding: [MDN Notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API), [MDN subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe), [WebKit iOS Home Screen push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
