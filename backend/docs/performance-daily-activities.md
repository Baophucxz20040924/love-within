# Daily activities: offline performance evidence

For solutions covering startup, auth, Home, feeds/media, finance, DB/jobs and scaling, see the [whole-app performance roadmap](performance-whole-app.md). This document remains narrowly scoped mock evidence, not a whole-app benchmark.

## Status and scope

**Mock/simulated evidence, not real MongoDB, HTTP, storage, push, or iPhone measurements.** The executable is `backend/scripts/measure-daily-activities.cjs`. It compares the actual baseline Moment service text from `git show HEAD:backend/src/services/moment.service.ts` with the updated service text, executing both through fail-closed VM imports. It does not reimplement the post method.

Only the Moment commit acknowledgement and one explicit follow-up view journey are covered. **Check-in and ledger are not benchmarked**: their updated contracts were not ready when this evidence was prepared. There are no extrapolated numbers for them. Reward-policy activation, batched reward views, quest refresh, notifications, and realtime are mocked at service boundaries; their internal queries and performance are unknown.

No database, sockets, environment files, providers, migrations, fixtures from another database, or dependency installation are involved. The VM has no real module loader, `process`, `fetch`, or timers; all service imports must match an explicit mock allowlist, including a safe monotonic `node:perf_hooks` clock. The host uses only local filesystem/Git, an **already installed** TypeScript compiler, and timers for artificial latency. This is a trusted-source test harness, not a security sandbox for hostile source code. It never imports Mongoose or production env/provider code.

## Run

From the repository root, with its existing backend TypeScript dev dependency available:

```sh
node backend/scripts/measure-daily-activities.cjs --check
node backend/scripts/measure-daily-activities.cjs --samples 30 --delay-ms 5 --repo-delay-ms 1
```

From an isolated worktree, point at the updated checkout **read-only**, without copying or editing its source:

```sh
node backend/scripts/measure-daily-activities.cjs --updated-root /absolute/path/to/updated/checkout --check
node backend/scripts/measure-daily-activities.cjs --updated-root /absolute/path/to/updated/checkout --samples 30 --delay-ms 5 --repo-delay-ms 1
```

`--updated-root` is a repository root, not `backend/`. The compiler is resolved from an existing installation in the script checkout or the updated checkout; nothing is installed. The script's own worktree supplies Git history. Default baseline is `HEAD`; after integrating/committing the change, pin the original baseline with `--baseline-ref 251fa38d73b8d830272d9c1e0d5301cfb1044615` rather than comparing two updated contracts.

Output is JSON on stdout, suitable for redirecting to a local scratch artifact if needed. It includes source SHA-256 hashes, baseline commit, runtime, settings, p50/p95, DTO bytes, per-step timings, and exact call-count ranges. It prints neither the synthetic DTOs nor source paths/log content. A failed assertion or unmocked import exits nonzero; it does not silently substitute a result.

`--check` is offline and uses three samples with zero injected delay. It is a **structural contract check**, not a performance gate; do not publish its timing percentiles. It checks:

- Updated `post` returns exactly `{ saved: true, localDate, sessionId, postedAt }` from the simulated committed post.
- Policy activation is awaited before the source write.
- One source read, storage HEAD boundary, and source write are exercised for a successful commit (all boundary counts are reported).
- Signing, reward-view construction, quest refresh, notifications, realtime, and story lookup do not run before the updated receipt. Injecting failures at those forbidden boundaries does not affect its acknowledgement.
- The baseline can reject after the mocked source was already saved when realtime fails; this is not a real crash/recovery test.
- An explicit updated follow-up view uses `dailyRewardService.getMomentRewardViews`, signs the two available photos, and returns both photos.
- Updated post log fields, if emitted, are finite numeric values from the allowlist `lateMin`, `headMs`, `commitMs`, `totalMs`; identifiers or payload fields fail the check.
- Unknown imports, including a socket module or an unmocked env module, are rejected.

## Method and interpretation

Fixture time is fixed at `2026-11-15T10:05:00Z`, inside a version-3 session's reward/capture window. All IDs, captions, photo keys, and URLs are synthetic. A fresh fixture is supplied for every operation, including warm samples, so repeated posts never turn into duplicate-write paths.

The scenarios are:

1. `post.first`: first partner posts; baseline returns a one-photo view, updated returns the commit receipt.
2. `post.second`: second partner posts; baseline returns a two-photo view, updated returns the receipt.
3. `post.second.with-view`: baseline's one post returns the two-photo view; updated post is followed by `today()` to fetch that view. This deliberately exposes the deferred read/signing work and extra DTO bytes rather than presenting the receipt as equivalent to a fully rendered screen.

Cold means a fresh VM/module for each sample; module evaluation is measured separately as `freshVmLoadMs`. Transpilation and compiler startup are excluded. Warm means the same VM/module after five discarded warmups. Neither means database, storage, network, mobile, or process-cache cold/warm. No cache hit is invented; policy and signing boundary calls still occur whenever the source requests them.

`--delay-ms` requests a timer delay on **each signing, quest, notification, and realtime invocation**. `--repo-delay-ms` requests a timer delay on each mocked repository, storage HEAD, policy activation, and reward-view boundary. These values are artificial assumptions, not estimated production latencies. Host timers can overshoot substantially, especially on Windows; inspect measured `stepMs`, not just requested delay values. There are no hard timing thresholds.

Percentiles use nearest-rank over individual samples. `serviceMs` includes awaited service execution and small structural assertions, but excludes VM evaluation and JSON serialization. Serialization is reported independently. `dtoBytes` counts UTF-8 JSON payloads only, excluding HTTP envelopes, headers, compression, image upload, and network round trips. The with-view updated value is the **sum of receipt and refresh**; its reward object is explicitly synthetic, so this is not a production response-size measurement. Concurrent step durations overlap and must not be summed as request latency.

`callsPerOperation` is a set of **query-shaped repository boundary counts and service/storage calls, not measured database queries**. For example, `rewardPolicyService.ensure` may perform multiple real database operations, whereas `storyRepository.aliveIds` with an empty input may perform none. Quest refresh, notification delivery, and reward views may hide multiple reads/writes. This harness cannot assign their true query counts.

### Observed boundary counts

Counts below were invariant in the mock run; zero means no call on that measured path, not no eventual background work.

| Boundary | Baseline first / second post | Updated receipt | Updated receipt + second-post view |
| --- | ---: | ---: | ---: |
| Moment `findDay` | 1 / 1 | 1 | 2 |
| Moment `addPost` | 1 / 1 | 1 | 1 |
| Storage HEAD | 1 / 1 | 1 | 1 |
| Story `aliveIds` | 1 / 1 | 0 | 1 |
| Storage signing | 1 / 2 | 0 | 2 |
| Quest refresh | 1 / 1 | 0 | 0 |
| Partner notification | 1 / 1 | 0 | 0 |
| Realtime | 1 / 1 | 0 | 0 |
| Policy `ensure` | 0 / 0 | 1 | 2 after frozen-timezone integration (1 in original timing run) |
| Batched reward view | 0 / 0 | 0 | 1 |

This demonstrates removal of those effect/signing boundaries from the acknowledgement path, **not removal of total system work**. Storage HEAD, policy activation, and source read/write still block acknowledgement. The follow-up read still signs; the worker/reward recovery path is outside the measurement.

### Example measured run (mock only)

Recorded on Windows x64, Node `v24.18.0`, TypeScript `5.6.3`; 30 samples per row, five warmups, requested effect delay 5 ms and other boundary delay 1 ms. Windows timer scheduling made many individual waits closer to a scheduler tick than their requested 1–5 ms. These elapsed times are host-specific simulation outputs, **not an API speedup claim or an SLO**.

Baseline commit: `251fa38d73b8d830272d9c1e0d5301cfb1044615`.

- Baseline service SHA-256: `216d4e8843d88a8bce6c7a1e8de00a80db76c8e45ddff6d4b2933b3ee3eae82d`
- Updated service SHA-256: `b0e56c6940cd6d3927f91fa738ec6e0d8fea54b7f72f8c2f6de2c6c567839b15`

| Scenario | Phase | Baseline p50 / p95 ms | Updated p50 / p95 ms | Baseline / updated DTO bytes |
| --- | --- | ---: | ---: | ---: |
| First post | Cold VM | 121.918 / 123.829 | 60.426 / 62.162 | 610 / 107 |
| First post | Warm VM | 124.283 / 126.595 | 61.976 / 63.681 | 610 / 107 |
| Second post | Cold VM | 138.078 / 139.744 | 59.816 / 61.921 | 798 / 107 |
| Second post | Warm VM | 140.050 / 142.840 | 62.164 / 63.348 | 798 / 107 |
| Second post including view | Cold VM | 136.766 / 143.319 | 121.622 / 124.400 | 798 / 962 |
| Second post including view | Warm VM | 139.904 / 141.404 | 124.024 / 125.656 | 798 / 962 |

These numbers are deliberately not summarized as a percentage improvement. The updated commit contract does less work and returns less information; fetching the view adds work and a second payload. The new policy/reward internals are mocked and the baseline's effects do not disappear from eventual system cost. Re-run and preserve emitted hashes when the source changes.

## Recommended real instrumentation (not deployed by this script)

Use monotonic `performance.now()` for durations; use wall time only for normal application timestamps. Capture coarse, fixed-name spans around existing awaits, never add extra queries or await telemetry delivery on the commit path:

- Moment: policy activation, target lookup/validation, storage HEAD, source CAS/commit, receipt serialization, and service total. `headMs`, `commitMs`, `totalMs` are useful numeric log fields, but service total is **not** HTTP end-to-end latency.
- Follow-up Moment view: repository reads, batched reward-view resolution, story-link lookup, signing, DTO serialization, response bytes. Distinguish this read from commit acknowledgement.
- Background effects: claim/lease, quest or reward reconciliation, inbox persistence, push dispatch, realtime dispatch, completion marker; also queue-age histogram and retry/outcome counters. Keep these separate from request latency.
- Later, after contracts are stable: check-in policy/source commit, wallet reconciliation, and receipt; ledger scoped query, page size, projection, serialization, and returned bytes. Do not populate these metrics with this script's Moment numbers.

Privacy rules for any future implementation:

- Prefer aggregated histograms/counters with fixed low-cardinality names and bounded labels such as operation, step, source version, outcome class, and cache hit/miss. Do not use user/couple/day/session/operation IDs as labels, even hashed ones.
- Never log captions, photo keys, signed URLs/query strings, access tokens, push endpoints, names, request bodies, wallet balances, reward intent bodies, or raw database filters/errors. Do not include IDs merely to correlate timings. Use numeric durations/counts/bytes; if error categories are needed, map to a small allowlist, not raw exception text.
- Keep explicit sampling/retention limits. Loggers must not perform blocking remote delivery. Metrics errors must not fail source commits. Do not add synchronous view/signing work just to obtain a measurement.
- For browser/device evidence, measure upload separately from commit acknowledgement and the later view refresh. Record sanitized aggregate durations, never photo data or response contents. Test foreground/background and slow network on an actual iPhone before making a mobile responsiveness claim.

## Prioritized follow-up improvements

1. **Measure acknowledgement separately from rendering/reward delivery.** Already implemented: receipt-only commit, background client invalidations, numeric HEAD/commit/total spans. Keep worker queue-age and pending-reward metrics alongside request p95 so a fast acknowledgement cannot hide a stalled payout.
2. **Reduce image-signing/read amplification if view spans dominate.** The mock confirms two signing calls for a fully visible pair, still present after this change. Consider lazy signing on photo-open or an ACL-scoped batch endpoint; do not cache partner photos across accounts or bypass the own-post unlock rule. Compare both time-to-save and time-to-photo.
3. **Measure water pending-list growth.** Current manual submission loads the caller's daily logs to sum pending ml. If real query/response measurements justify it, replace that sum with an indexed status/user/day aggregate and paginate review/history lists. Keep pending separate from approved totals.
4. **Keep reward/history reads bounded.** Implemented: bounded chronological settlement recovery and batch provenance reads for at most 31 moment days. Profile wallet reads with long pending backlogs; consider a smaller request repair budget and dedicated worker throughput only after proving recovery latency and fairness. Ledger metadata is carried directly, not inferred by N+1 source queries.
5. **Provision additive indexes and measure actual plans before adding infrastructure.** Use explain/operation counts on separately authorized synthetic local data, then load-test the designated worker. Redis, new queues and global signed-URL caches are not justified by these mock numbers.

These are ranked investigation targets, not claims that they are production bottlenecks. No numerical production improvement or capacity estimate is established here.

## Limits and integration checks

The commit receipt is **not a `MomentDayView`**. Clients must not replace a full day cache entry with it; display saved state from the receipt and refresh the selected day separately. A successful acknowledgement does not itself assert that notifications, realtime, or wallet rewards have completed.

The updated service requires `rewardPolicyService.ensure` and `dailyRewardService.getMomentRewardViews`. Because those imports are mocked, this harness can pass even when the real modules are missing, untyped, or incorrect during parallel integration. A full typecheck, route/client contract tests, and real repository/recovery correctness tests remain required. The in-memory `addPost` is not evidence of atomic marker durability, CAS behavior, duplicate suppression, transaction isolation, or reward exactly-once semantics.

No Mongo fixture is reused. If a separately authorized real database test is later added, it must use **only `lookwithin_dev`** with explicit isolation/cleanup and must never default to an existing fixture database. There are no real database numbers, check-in numbers, ledger numbers, load/concurrency results, or iPhone numbers in this document.
