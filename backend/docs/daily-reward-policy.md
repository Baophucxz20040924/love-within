# Daily reward policy v2 and moment acknowledgement

## Rules

Coin rewards and EXP claims are separate:

| Activity on a v2 day | Personal coins | EXP (unchanged) |
| --- | --- | --- |
| First member checks in | 0 until both check in | 5 for the personal check-in |
| Both check in | Each gets `5 + commonStreak - 1` | Daily-checkin quest still claims 5 shared EXP |
| First valid daily moment photo | Photographer gets 10 | No new personal EXP |
| Both photos in the same existing reward window | Each gets another 10, maximum 20 each/day | Moment quest still claims 5 shared EXP |

A common check-in streak counts consecutive **completed couple-local days**, not either member's personal streak. It starts at 1 under v2 and resets after a day without both check-ins. No new cap is imposed. Timely moment eligibility uses the stored prompt and exclusive reward deadline with Mongo's accepted-post timestamp, never the camera clock. Late photos remain eligible for the base 10 and the existing independent photo streak.

## Activation and rollout

- Couple creation records v2 policy in the same insert for genuinely new couples.
- Existing couples get a create-once/CAS activation marker. V2 starts on the next local date after activation; repeated reads/deploys must not move that date.
- The activation marker freezes the reward timezone. Check-in dates and their DB-time source fence, quest dates, and new moment schedules use this timezone; later couple timezone edits do not silently move reward days. Existing saved moment deadlines remain authoritative.
- Dates before that marker retain the prior personal and quest coin rules. Existing frozen intents always retain their exact actor, operation ID, owner, coin, EXP and allocations.
- Do **not** rewrite old ledger rows, infer missing payouts from displayed deltas, import old streaks, or backfill balances. There is no automatic historical compensation in this change.
- Stop/drain all older API writers before enabling this release. A mixed-version deployment can create old-policy intents on new-policy days. Do not use a rolling overlap with old reward writers.
- Build/create additive indexes through the normal deployment process: daily settlement unique business key, pending sources, Checkin couple/date, and moment effects/settlement markers. Do not drop legacy indexes or run `syncIndexes` blindly.
- Confirm the scheduler runs on exactly the designated instance. The `daily-rewards.recover` job must be registered. Scheduler-disabled local runs do not provide autonomous recovery.

## Durability and recovery

All coin changes use the existing wallet operation journal, immutable fingerprints and permanent business-key tombstones. No separate direct balance update is allowed.

New check-in inserts mark their source pending before settlement. A posted moment atomically stores its photo, DB timestamp, pending reward marker and pending side-effect marker. Thus a crash before intent creation remains discoverable. Settlement recovery works in bounded batches; predecessor days are resolved before a new common streak is frozen. If a bounded pass cannot prove the predecessor chain, it leaves the reward pending rather than guessing.

The moment response is now a durable acknowledgement:

```json
{"saved":true,"localDate":"2026-11-18","sessionId":"<uuid>","postedAt":"<server timestamp>"}
```

This confirms the photo commit, not completion of wallet/inbox delivery. It deliberately does not sign images or wait for refetch, quest refresh, notification persistence or payout. Clients must refetch the scoped day/month for the photo view and show pending coins until a payout receipt is available. The client observes the exact date/session receipt separately: while the signed view is still loading, it shows saved/updating state and suppresses recapture, without inventing a photo URL, unlocking a partner image or claiming payment.

Moment-specific effects are claimed with a short CAS lease. Each new post freezes whether it was the second post, preventing retry from changing a first-post notification into a different event. The worker settles rewards, refreshes quests, persists idempotent inbox events, and emits invalidations. Failure leaves the source pending. Leases are fenced by token; a concurrent partner post cannot be cleared by an old worker. Both lease claims and retry delays use Mongo `$$NOW`. Due-time ordering moves failed records behind earlier-due/fresh work instead of allowing the oldest failures to monopolize a batch. Push remains best-effort after durable inbox persistence.

Do not run an offline wallet recovery command while any API worker is alive. Online replay and the registered job are the supported paths for this release. No production recovery or data mutation was performed during development.

## Rollback

A code-only rollback to a release that ignores v2 policy is unsafe: it could issue legacy coins after activation. Roll back only to a version that understands the persisted policy and pending-source schemas, or disable reward-writing endpoints while deploying a compatible fix. Never delete policy markers, settlements, wallet operations, receipts or ledger entries to make an older release run. Do not reverse legitimate payments with ad-hoc scripts.

## Observability and acceptance

Moment save logs contain numeric HEAD/commit/total timings only; no caption, storage key, signed URL, token or image bytes. Scheduler counters expose retry activity. A confirmed save and a pending payout are different UI states.

Required checks include paired check-in streak/gap/concurrency, pre-intent crash recovery, legacy frozen intent replay, duplicate quest claim exclusion, server deadline boundaries, post receipt with hanging signing/effects/refetch, exact-original-session reconciliation after midnight, and account/PIN/background fencing. Mock results do not establish production latency, real storage delivery or actual iPhone compatibility.

### Local verification, 2026-11-18

- Backend build/typecheck and isolated daily-reward, existing wallet, moment, notification, media, realtime and push suites passed. Water-proof service/route/ACL mocks passed 7 checks.
- Frontend build passed. Moment UI/retention/fault tests passed 24 checks and transport deadlines passed 5. Reward UI passed 16 checks; manual-water UI passed 8. Existing app-lock, realtime, session-mutation, media and notification regressions also passed.
- `scripts/browser/daily-rewards-water.mjs` passed 8 mock-only checkpoints in two 360x780 Vietnamese contexts. It captured 10 screenshots; visual review covered the saved state with held refetch, decoded proof/reviewer, foreign-session rejection, exact-session reconciliation and ledger labels. Only the deliberately injected moment POST 503 occurred; no unexpected browser errors or blocked calls. Each member sent exactly one moment POST/upload despite reconciliation; manual proof sent one upload/PUT/POST and one partner approval.
- The browser run found quest-row mobile overflow and duplicate React sibling keys; both were fixed before the final passing run. Saved-receipt UI now suppresses recapture while the signed view is held.
- Offline performance structural comparison passed; timings in the separate performance document are artificial-delay simulations, not measured production improvements.

All browser API/provider traffic was intercepted. No real Mongo concurrency/crash test, provider delivery, physical iPhone test, balance mutation, commit, push or deployment was performed. Real database/index and release acceptance remain separate operator-authorized steps.
