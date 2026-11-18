# Whole-app performance solution and delivery roadmap

## Status and scope

This is a **static-code-evidenced roadmap**, not a report of measured production bottlenecks, latency, capacity or speedup. Priorities order investigation and delivery dependencies. They do not establish that a particular query, component or configured pool is slow in production.

The [daily activities evidence](performance-daily-activities.md) is a separate offline Moment simulation. Its artificial delays and VM boundary counts are not real Mongo operations, HTTP latency or whole-app results. Save acknowledgement, usable UI, media rendering, reward settlement and inbox delivery are different milestones; measure each separately.

This delivery adds the roadmap and proactive post-auth push onboarding. It does **not** silently implement the database, polling, cache, financial or infrastructure redesigns below. Those require measured, independently reversible batches and their own correctness acceptance. No production telemetry, real database/explain/load test or provider call was performed for this document.

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

**Evidence:** `frontend/src/components/AppLayout.tsx:14` schedules all-page idle prefetch; `frontend/src/app/lazyPages.ts:63` and the Friends loader map supply the imports. Auth bootstrap/startSession and `frontend/src/features/realtime/RealtimeSync.tsx:64` verify identity/scope at different lifecycle points. Personal/admin splitting already exists.

**Hypothesis to measure:** broad prefetch may compete with useful route/media work; repeated verification may overlap. Count transferred/used/prefetched bytes, cached requests, startup long tasks, navigation-to-ready and verification calls by lifecycle. Static imports or multiple call sites alone do not prove duplication.

**Solution:** selective next-route prefetch in small idle batches, respecting Data Saver/connection capability and preserving on-demand imports. Coalesce only truly equivalent in-flight auth checks with the same generation, user, scope and revocation semantics. Never bypass PIN, credential checks or cache clearing on access loss. Do not merge intentionally independent post-resume verification just to reduce request count.

**Acceptance/rollback:** meet baseline-derived startup/navigation budgets with logout, same-account re-login, account switch, PIN and revoked-session tests unchanged. Medium risk for prefetch, high for auth. Roll back scheduling/coalescing independently to original lazy imports/verification.

## P1 — Home, polling, invalidation and SSE

**Evidence:** Home pulse polls at 30s (`frontend/src/pages/HomePage.tsx:197`); seven server builders run in parallel (`backend/src/services/pulse.service.ts:13`). Badge/approval/inbox polling also exists in `BottomNav.tsx:18`, `features/approvals/useApprovals.ts:11`, `features/notifications/useCoupleNotifications.ts:6`, and Friends layout. Shared query keys already deduplicate some observers. `features/realtime/invalidation.ts` batches but also uses broad domain prefixes.

**Measure:** actual mounted query keys and requests/five minutes, section p95/error rates, pool wait, invalidation fan-out and mutation-to-visible age. Exercise dropped events, SSE unavailable, background, offline and reconnect; an open stream is not durable delivery.

**Solution:** where dependency tests prove coverage, use SSE as the freshness hint with slower jittered polling fallback, foreground-aware scheduling and immediate focus/reconnect resync. Narrow invalidations by domain only after testing every dependent view. Keep maximum-staleness bounds, clock-driven updates, pulse partial results and revocation clearing.

**Acceptance/rollback:** fewer observed redundant requests with no breach of per-domain freshness or recovery budgets. Medium/high risk; restore previous polling intervals/invalidation map per domain if stale/missed updates appear. Do not disable all polling in one release.

## P1 — `/me`, wallet recovery, credentials and Mongo pool

**Evidence:** `backend/src/controllers/me.controller.ts:11` waits for couple/wallet views. `backend/src/services/wallet.service.ts:179` scans at most 20 pending sources per each of three kinds, processes them sequentially and invokes daily reward recovery; `:230` waits before returning wallet. `backend/src/db/connection.ts:11` configures pool maximum 10. Auth and SSE heartbeat/delivery perform current credential reads (`middleware/auth.ts:13`, `services/credential.service.ts:52`, `services/realtime.service.ts:33`).

**Measure:** `/me` normal and synthetic backlog p50/p95/p99, per-source repair count/time, oldest pending age, credential-read rate and pool checkout wait under REST+SSE together. A configured pool of 10 is not proof of saturation; bounded recovery does not mean a fixed 60 full repairs always execute.

**Solution:** if recovery dominates, assess a smaller explicit request repair budget plus durable background progress, fair ordering and backlog monitoring. Retain pending wallet completion, immutable journal, idempotency and honest pending-vs-settled UI. Index subscribers by user/space if event scans dominate. Credential coalescing/caching must prove equivalent revocation, not add a TTL revocation delay. Tune pool only with Mongo capacity/concurrency evidence.

**Acceptance/rollback:** no lost/duplicate financial effects under retries/concurrency/interruption; source/journal/balance reconcile exactly; bounded fair oldest-age and API latency. High risk: reversible recovery scheduling with current bounded online repair as fallback, no deletion of pending intents or journal. Never label an unsettled reward as paid to make `/me` faster.

## P2 — Long lists, comments, media and fonts

**Evidence:** Friends feed, Stories and finance flatten retained pages (`frontend/src/pages/FriendsFeedPage.tsx:30`, `pages/StoriesPage.tsx:64`, `features/finance/FinanceViews.tsx:95`). Comments cap at 500 (`backend/src/repositories/friendStory.repository.ts:192`, `story.repository.ts:101`), rather than supporting unlimited history. Media signing scales with returned media (`services/friendStory.service.ts:130`). `PhotoGrid.tsx`, upload image helpers and `main.tsx` already use image/layout/font optimizations.

**Measure:** prolonged-scroll heap/GC/DOM, React commits, refetch growth, signing count/time, response/download/decoded-image bytes and actual rendered size. Profile media upload/save/view separately; font weights only count as unnecessary after measuring actual use.

**Solution:** stable comment cursors with deterministic tie ordering and explicit reply contract; measured windowing/bounded retention that preserves scroll, focus, keyboard/screen-reader access and optimistic state. Responsive thumbnails/media variants, lazy decode and justified font-weight reduction with Vietnamese visual tests. Deduplicate signing only within authorized scope; never share private signed URLs across accounts or bypass block/delete/Moment unlock checks.

**Acceptance/rollback:** meet heap/interaction/byte budgets on fixed large fixtures, all authorized comments reachable without pagination duplicates/gaps, no unauthorized media. Medium/high risk. Revert renderer/media variant independently, preserve original source data and compatible cursor contracts.

## P2 — Query plans, savings and outing writes

**Evidence:** savings exact status filtering aggregates entries before page limit with a three-second timeout (`backend/src/repositories/savings.repository.ts:14`); active/reached semantics intentionally avoid incorrect early limit. Friends feed uses author `$in`/exclusions with cursor (`friendStory.repository.ts:54`). On-this-day uses a date suffix regex (`story.repository.ts:79`). Outings use full-snapshot revision CAS with explicit capacity bounds (`friendOuting.repository.ts:20`, `models/FriendOuting.ts:3`); lists already project headers.

**Measure:** separately authorized `explain('executionStats')` on representative friend/exclusion/history distributions; keys/docs examined per result, blocking sorts, timeout/aggregation cost, BSON bytes and outing conflict/retry/write volume. A result limit/timeout bounds output/time, not necessarily examined work.

**Solution:** choose additive indexes and narrow projections from actual plans, including write/storage overhead. Consider indexed month/day or savings balance/status projection only with migration/reconciliation/rebuild design. Redesign large outing writes only if common measured cost warrants proving equivalent financial journal/idempotency/audit/CAS guarantees. Do not split a ledger casually or replace exact aggregation with an unverified cache.

**Acceptance/rollback:** exact result sets/totals under edits/deletes/retries/concurrent writes; projection rebuild matches source; before/after plans and read/write budgets. High risk. Keep source aggregation/read path, additive migration/feature switches and reviewed rollback; no balance rewrite or automatic backfill in this scope.

## P3 — Bank sync, reminders, unread scans and push

**Evidence:** bank polling loads active connections and serially syncs with delay (`backend/src/services/bankSync.service.ts:95`). Reminder traversal pages active couples with event cap warnings (`services/jobs/coupleEventsRemind.job.ts:151`). Scheduler jobs are serial with overlap guard/timings (`scheduler.service.ts:104`). Friends unread has a 500-candidate scan budget (`friendNotifications.service.ts:21`); push has bounded concurrency/2,000 pending limit (`push.service.ts:68`). Inbox persistence is separate from best-effort push (`notification.service.ts:115`).

**Measure:** complete cycle duration, scheduler lateness, oldest due age, page/cap saturation, provider throttles/errors, unread visibility work, push queue depth/drops/delivery age. Preserve the distinction between durable inbox and non-durable push transport.

**Solution:** indexed next-due selection, pagination and bounded concurrency/backoff within provider limits. Continue capped reminder work fairly instead of starving later records; retain expiry/send-once claims. Consider visibility-aware unread projections only with correct block/delete/relationship invalidation. Evaluate a durable push queue only if delivery requirements and measured saturation justify it; a RAM queue is not durable.

**Acceptance/rollback:** synthetic backlog/restart/overlap/rate-limit tests prove inbox/send-once/expiry correctness and agreed oldest-age throughput. High risk. Single designated worker ownership and preserved due state allow rollback; do not claim exactly-once provider delivery merely from logical idempotency.

## P3 — Index lifecycle and scaling topology

**Evidence:** startup waits for parallel model `syncIndexes()` (`backend/src/server.ts:15`, `db/connection.ts:32`); reconciliation can remove indexes absent from definitions. Realtime is in-process and explicitly requires one API process (`services/realtime.service.ts:142`); worker ownership is also process-sensitive.

**Solution/measurement:** inventory deployed/declared indexes, startup/index-build time and write impact before reviewed additive migrations. Never run blind destructive index sync as a performance experiment. Before multiple replicas, design cross-process pub/sub, revocation propagation, reconnect/resync and scheduler leases/ownership/failover. A larger pool or extra replicas alone is not a safe fix.

**Acceptance/rollback:** authorized isolated rehearsal with no unintended index drop; multi-process event/revocation/leader-loss tests before rollout. High risk. Keep tested single-instance topology, drain incompatible writers, stop rollout on ownership ambiguity; index rollback requires explicit operator review. Do not introduce Redis/queues without a demonstrated need and operational design.

## Admin and delivery gates

Admin is already separately loaded. Measure its cold/warm transfer/parse, manual list/search API p95, bytes and interaction response using authorized synthetic records; do not invent a large-list/polling bottleneck. Preserve exact search behavior, admin auth/audit and private search terms. Apply only measured bounded-query/bundle changes, with separate personal/admin regression reports and independent rollback.

1. Capture baselines/freshness requirements first; agree budgets and data handling.
2. Deliver one measured P1 batch at a time, with auth/recovery/realtime regressions.
3. Profile P2 before selecting cursors/media/indexes/projections; authorize DB work separately.
4. Pursue P3 only with backlog/capacity evidence and clear operational ownership.
5. Record build/fixture, baseline/target, samples, before/after, errors, privacy review, correctness results, owner and rollback trigger. Faster acknowledgement is not proof of a faster completed journey or successful money/inbox delivery.

Reference thresholds: [Web Vitals](https://web.dev/articles/vitals). Browser push constraints for the accompanying onboarding: [MDN Notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API), [MDN subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe), [WebKit iOS Home Screen push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
