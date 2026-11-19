# API design and code-extensibility review

Review baseline: `0e59338` (2026-11-18), working-tree follow-up through 2026-11-19. **Scale here means extending code and supporting longer histories on the existing infrastructure.** No replicas, Redis, additional services, deployment changes, schema migrations or index rollout are prerequisites or deliverables. This is a source/offline assessment, not a production capacity report. See [whole-app performance](performance-whole-app.md) and [offline inventory](offline-tests.md).

## Assessment

Keep the modular monolith. Routes validate and authenticate, services enforce business rules, repositories own persistence queries. Consistent envelopes, fresh credentials, private-space ACLs and financial journals are useful extension boundaries. A framework rewrite, generic repository framework or microservice split would add work without evidence of benefit.

The main coding problems were incomplete history contracts, repeated per-row ACL work, missing client cancellation plumbing and capped background traversal/lifecycle gaps. The changes below address these incrementally, without moving authorization into caches or changing accounting.

## Implemented in the working tree

| Batch | Change | Compatibility / rollback |
| --- | --- | --- |
| Matched guards and validation | Wallet/quest auth only on matched methods/paths; publish complete Zod parsed values atomically | Matched endpoints still check current credentials/membership. Unknown paths now reach normal 404 rather than accidental wallet auth. Revert composition independently. |
| Startup and observations | Two selected serial idle loaders per shell; bounded numeric recovery observations; Moment continuation | Ordinary lazy navigation and all recovery awaits remain. Disable prefetch/observations independently; no migration. |
| Ledger history | Add `GET /api/ledger/page?limit=20&type=coin\|exp&cursor=…`, max50; `{items,nextCursor}`; Profile displays one page20 with older/newer/latest | Legacy `/api/ledger` array50 retained. Own coin/shared EXP/legacy shared coin visibility and `ownWallet → recoverRewards → read` retained. |
| Couple comment history | Add `GET /api/stories/:id/comments/page?limit=20&cursor=…`, max50; same page envelope; one active polling page rendered chronologically | Legacy comments array500 and mutations retained. Live story check each page; draft/composer, count, confirmation, realtime prefix invalidation retained. |
| Selected GET cancellation | Query signals reach existing transport for couple/Friends story feed/detail, outing list/detail/event entry and new pages | Optional final parameter preserves imperative callers. Shared refresh, deadlines and session/access fences unchanged. Client abort is not Mongo cancellation. |
| Outing list ACL | Request-local pair lookup and exact-roster block chunks; no global permission cache | Candidate page/cursor and restricted historical membership retained; no unbounded visible-row refill. Detail/mutation/replay/postcommit authorization stays live. Can revert list alone to sequential checks. |
| Bank lifecycle | Track initial/interval/jitter timers; generation admission; interrupt jitter; bounded10s join; true active-cycle overlap guard; one shutdown promise | Started sync completes existing persistence/finally path. Timeout does not cancel providers or guarantee completion before DB disconnect. No parallelism or provider redesign. |
| Friends reminder fairness | ASC `(startAt,_id)` process-local continuation, max500 candidates including already-sent, checkpoint completed candidates, job-local single-flight | Current live2h window and claim/recipient rules retained. No durable queue or exactly-once delivery promise. |
| Friends threaded history | Add root/reply `/comments/page`, `/comments/:rootId/replies/page` and bounded `/comments/:commentId/context` for stories/events; shared lazy reply UI | Legacy arrays/mutations retained. Live resource/root/target ACL; viewer/resource/root cursor scopes. No whole-thread count or scan. |
| Couple reminder fairness | At most50 couples and500 event candidates/run, inner `_id` seek plus outer continuation, current couple re-read and single-flight | Auto milestones once per current local day/timezone window/traversal; new window rechecks. Claims are not delivery receipts. |
| Push shutdown | Close admission after HTTP/background joins; idempotent10s drain of admitted active/waiting jobs before DB disconnect | Timeout retains counters/ownership and does not cancel provider work. No durable outbox/retry. |
| `/me` repair/read seam | Await existing repair, then read/validate settled wallet and fresh couple; build couple view from that post-repair document | `getView` compatibility retained. No creation/migration/reward on repository read seam; pending races fail503. Default `/me` is still repair-capable, not read-only. |

### Pagination contract

All new comment/ledger histories use descending `(createdAt,_id)` seek and `limit+1`, with no count query. Cursor codec validates version/resource/scope/order, canonical timestamp/ObjectId/base64url and a1024-character ceiling. Ledger scope includes couple, owner and type; couple comments scope includes couple/story, and Friends comments include resource kind/ID, viewer and root-or-roots. A cursor is only a position, never an authorization token. Live auth/ACL applies on every request. Ledger seek and visibility are separate `$and` predicates so one `$or` cannot overwrite the other.

Friends context is a direct bounded target lookup, not a scan through root pages. Both consumers accept direct `?comment=` links; existing event inbox DTOs still lack a comment ID, so no inbox-target redesign is claimed.

These are **live pages**, not snapshots or stable page numbers. Inserts/deletes can change revisited pages. Frontend cursor stacks retain navigation positions, not multiple mounted polling observers. Keys distinguish page DTOs from legacy arrays under existing invalidation prefixes, scoped by identity/couple/resource. Errors hide stale private rows; add success returns comments to newest and invalidates active queries rather than appending an optimistic page overlay.

Limits bound returned rows/payload/rendering, not Mongo examined documents or query latency. Existing index definitions were not changed or deployed; `_id` tie ordering is not proof of an optimal query plan.

### Security/business boundaries retained

- Current credential version on authorized requests; no cross-request auth TTL cache.
- Non-enumerating social ACLs, both-direction block checks, private media signing only after visibility.
- Finance owner/share boundaries; no private bank notes in shared attachments.
- Wallet permanent business keys, immutable fingerprints/provenance, journal/CAS/recovery and frozen policy/timezone.
- Outing revision/capacity/receipt semantics; list snapshots never authorize writes or replay responses.
- Moment durable save acknowledgement distinct from media, settlement, inbox and best-effort push.
- PIN remains an application privacy screen, not a substitute for backend authorization.

## Next code-only phases, in order

| Priority | Separate deliverable | Acceptance before adoption |
| --- | --- | --- |
| P1 | Independent durable recovery before considering a read-only default `/me` | Internal repair/read seam is delivered; moving repair out of the GET is not. Require durable fair progress, scheduler-unavailable fallback and exact journal reconciliation. Never drop financial awaits just to shorten a GET. |
| P1 | Auth/read freshness coalescing within equivalent lifecycle boundaries | Same generation/user/scope/access epoch; preserve resume/revocation verification and SSE-unavailable fallback. Measure mounted observers/invalidation before changing intervals. |
| P2 | Define required durable retry/outbox semantics | In-memory push drain is delivered, durable retry is not. Distinguish source committed, claimed, inbox persisted, queue admitted, provider accepted and device displayed; expiry and per-recipient idempotency. Requirements first, no new queue service assumed. |
| P2 | Profile long feed rendering/signing and narrow projections | Fixed fixtures, heap/DOM/focus/scroll/bytes and visibility parity. Optimize measured work, not configured caps. No automatic DB/index changes. |

## Remaining limitations

Moment/Friends/couple reminder checkpoints are in-process. Restart loses position; late inserts/reschedules behind a checkpoint wait for a later sweep. A pre-claim poison failure can impede progress, and a due window can expire before a full traversal. Claim-before-emit still permits claimed-but-undelivered failures; this wave adds no retry guarantee. Bank list is still loaded and processed serially; lifecycle repair is not a throughput redesign. Push drain timeout is a bounded wait, not provider completion or delivery. `/me` uses post-repair values but is not a transaction snapshot under concurrent writes. Existing frontend refresh single-flight/generation/access fences and150ms domain batching were retained; no unproven auth/invalidation narrowing was applied.

The current process guard/topology, startup index behavior and deployment remain untouched. Multi-replica design is outside this roadmap, not a prerequisite for code extensibility.

## Verification boundaries

Offline fixtures load actual source with explicit fake persistence/provider/timer boundaries. Browser fixtures intercept all API/external requests and use synthetic DTOs. They establish contract, state and query-structure behavior—not Mongo query plans, real races/crash recovery, provider delivery, physical iPhone/Safari compatibility, latency, QPS or percentage speedup. Local/remote execution and unrun checks are recorded in the linked performance document.

No real DB/index/backfill/balance mutation, bank/email/push/AI call, dependency install, commit, push or deployment belongs to this follow-up. Database/load work would need a separately authorized synthetic scope. Do not publish private architecture artifacts externally.
