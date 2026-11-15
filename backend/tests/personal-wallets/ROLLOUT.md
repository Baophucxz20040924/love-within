# Personal wallets: gated cutover and reconciliation

This is an operator runbook, not a script that runs against a live application. No production or existing local application-data migration was executed. Migration was exercised only on synthetic legacy wallets in fresh, isolated local test collections. Savings, bank imports, savings write locks and savings balances are out of scope.

## Preconditions / stop the old writers

1. Back up the database and capture counts/sums and the deployment revision. Export the wallet, ledger, couple EXP, checkin/quest/bucket reward flags, bucket day counters and market redemption collections together.
2. Stop/drain **all** old API instances, job workers, schedulers and any manual reward/seed writers. Do not mix shared-wallet and personal-wallet writers in a rolling deployment. Confirm all in-flight requests have drained. Do not kill a listener you do not own.
3. Run a read-only inventory while writers are stopped. For every legacy wallet, validate a nonnegative safe-integer raw `coinBalance`, an existing couple, exactly two distinct ObjectIds, and no conflicting migration version. Sort the two IDs lexicographically. Expected split is ceil(total/2) to the smaller ID and floor(total/2) to the larger. Include balances 0, even and odd. Pending redemptions were **already deducted**: never add their held coins back to the split input.
4. Inventory ambiguous legacy partial rewards / ledger gaps and historical declined/cancelled redemptions. Report them; do not create compensating Xu automatically. Legacy claimed flags do not prove whether both coin and EXP were paid. New code only resumes source rows with explicit `rewardIntent`.
5. Inventory duplicate open redemptions grouped by `{coupleId,itemId,buyerUserId}` over statuses `requested`, `accepted`, `reserving`, `refunding`. Abort cutover if duplicates exist. Resolve each with a documented human decision and a ledger audit; never silently delete or refund them to make an index succeed.

## Required indexes (before enabling new writes)

Use a reviewed DB administration session with writers stopped. Inspect existing index definitions, not merely their names. No index should be dropped except the obsolete bucket counter TTL below.

- Preserve `wallets` unique `{coupleId:1}`.
- Preserve unique source indexes (checkin couple/user/date, quest couple/key/date, bucket reward day couple/date).
- `walletoperations` has its built-in unique string `_id` and `{coupleId:1,status:1}`. No TTL.
- `ledgerentries`: unique `{operationKey:1}`, partial filter `{operationKey:{$type:'string'}}`. Legacy rows without operationKey remain unchanged. Also `{coupleId:1,ownerUserId:1,createdAt:-1}`.
- `marketredemptions` `market_request_key`: unique `{coupleId:1,buyerUserId:1,requestKey:1}`, partial filter `{requestKey:{$type:'string'}}`.
- `marketredemptions` `market_one_open`: unique `{coupleId:1,itemId:1,buyerUserId:1}`, partial filter `{status:{$in:['reserving','requested','accepted','refunding']}}`. MongoDB must support `$in` in partial indexes (MongoDB 6+). Do not substitute a weaker filter; deployment must fail closed otherwise.
- Remove the existing `bucketrewarddays` TTL index on `createdAt` (normally `createdAt_1`) **after inspecting its expireAfterSeconds and key**. New day documents retain bounded operationIds so retries from older days cannot consume a second slot or bypass the cap. Do not use syncIndexes indiscriminately.

Market request creation checks the presence of both named unique indexes before reserving. An index-build failure is a deployment failure, not permission to continue. Verify every required definition before starting APIs; disabling autoIndex is not a replacement for creating indexes.

## Migration / first reads

Deploy the new backend and frontend together, then enable only the new writers. New couples start with two zero balances. First `/wallet` or `/me` read lazily CAS-migrates a legacy wallet. The Mongo aggregation computes the split from the stored balance and stores version 2, sorted member snapshot, both balances and `migration.{originalBalance,allocations,migratedAt}` in the **same update**. `coinBalance` is frozen historical input and never spent again. A crash after that update needs no guessed repair; the complete audit is already stored. Concurrent first readers read the winning migration. Invalid data returns `WALLET_REVIEW_REQUIRED` without guessing ownership.

Reconcile each migrated wallet's original balance against the pre-cutover export. Migration allocations sum exactly to original balance; after new operations, current balance per member equals its migration allocation plus committed coin ledger deltas for that owner. Legacy shared ledger balanceAfter remains shared and is labelled “Ví chung trước chuyển đổi”; do not reinterpret actorUserId as owner.

## Durable writes / recovery

- WalletOperation `_id` is `coupleId:businessOperationId`; immutable fingerprint binds actor, beneficiaries, exact amounts, reason and source. Keep terminal operations permanently while business records can be replayed. Never TTL or manually delete tombstones.
- Wallet has one bounded `pending` slot and monotonic `revision`. Balance mutation and pending receipt are one atomic write. A stale worker cannot apply after receipt clear because every apply and clear advances revision. Terminal operation lookup is before wallet snapshot and repeated after snapshot.
- EXP increment, derived level and `expReceipt` are one atomic Couple update fenced by `expRevision`. It is not safe to use a separate “EXP done” flag. Do not edit `expRevision` or clear receipts manually.
- Recovery upserts ledger rows by unique operationKey, marks the permanent operation committed/rejected, then clears only the matching Couple and Wallet receipts. Unknown outcome stays pending; no timeout takeover or blind credit/debit retry with a new key.
- Wallet reads recover the exact pending journal and up to 20 explicit pending intents per reward source per request, including older days. Checkin/quest source intents are persisted at claim; bucket intent and eligibility are persisted atomically with markDone. They freeze amounts, day and claimant, and are never reset after unknown payment. Optional bucket story media is validated before markDone; a frozen payload and reserved Story ID gate reward until story completion is durably confirmed. Story replay checks an immutable creation fingerprint and includes soft-deleted success without resurrecting it. Unknown story outcomes stay gated (no blind revert); wallet recovery skips a failed gate rather than blocking unrelated balances. Gate promotion fences by original doneAt and reserved ID, and reopening is blocked until the gate completes. Old claimed rows without intent are not replayed. Repeat authenticated wallet reads to drain a backlog; source-specific actions also resume. A bucket cap denial is terminally marked `rewardDenied`, without paying or releasing a consumed slot.
- Market first creates a private `reserving` row with stable requestKey, redemption ID and price snapshot. Only confirmed debit publishes `requested`. A definite insufficient-funds rejection closes the reservation; an uncertain result does not. Request retry with the same key resumes even after item edit/archive. History reads also resume reservations.
- Cancel/decline CAS to `refunding` with a durable target/actor intent; the one refund key always credits buyerUserId. Only confirmed credit transitions to declined/cancelled and allows “refunded” copy. Historical terminal rows without intent are never automatically refunded. History reads resume refunding rows. Accepted/fulfilled never pay a seller.
- Realtime is dirty invalidation only; no member balances are sent in SSE. Each member refetches their own wallet. Auth/space/lock epoch handling and query clearing remain in place.

For an unresolved pending record, capture Wallet, Couple receipt/revision, WalletOperation, relevant ledger entries and source/redemption. Leave the lock/receipt intact. Fix the root cause and retry the original operation through the new code. Do not run offline recovery concurrently with API workers. Do not alter a payload to force a replay. A migration rollback must restore the complete coordinated backup with writers stopped; never set version back to legacy after personal transactions exist.

## Focused validation

No providers, credentials or servers are loaded by the focused unit harness:

```
node backend/tests/personal-wallets/service.cjs
node backend/tests/personal-wallets/market.cjs
node backend/tests/personal-wallets/rewards.cjs
node backend/tests/personal-wallets/moment-rewards.cjs
node backend/tests/personal-wallets/frontend.cjs
node backend/tests/personal-wallets/bucket-completion.cjs
npm --prefix backend run typecheck
npm --prefix frontend run build
```

Standalone Mongo integration is deliberately not in the unit command. Run separately from browser/API regressions with explicit local opt-in:

```
node backend/tests/personal-wallets/mongo.cjs --local-lookwithin-dev
```

It connects only to `mongodb://127.0.0.1:27017/lookwithin_dev`. The test-only `namespace.cjs` maps every Mongoose model to a fresh random `verify_wallet_<random>_` collection before connecting, disables auto-index/create, verifies mappings and creates required indexes only in newly created collections. It never changes existing app collections or their indexes. Cleanup drops only the exact collection names successfully created by that process. Abrupt termination can leave its private collections; it never cleans another process's prefix. Pure namespace tests compile real Mongoose models without a connection. This harness is not a production migration or offline recovery tool, and the mapping is a test guard, not a general security sandbox.

Coverage includes actual aggregation migration, CAS concurrency, receipt/ledger/EXP failure boundaries, terminal-before-snapshot replay, stale-worker fencing, reservation races, cancel-vs-decline and legacy buyer refunds. No dotenv or providers are loaded. Do not claim this integration passed until it has actually been run.

For sequential browser verification, inspect ports 4000/4001/4002/5173/5175 first, leave unowned listeners untouched, build backend and reuse the owned Vite5175 proxy:

```
node backend/tests/personal-wallets/run-browser.cjs --local-mock-runtime
```

The runner refuses occupied4002, starts a fresh owned `mock-runtime.cjs` child for each suite using the fresh-collection namespace (separate rate-limit state), runs the personal-wallet and moment browser suites sequentially, then sends `stop` over each child's stdin to close SSE connections and clean up its exact collections. It never imports `server.ts` or runs `syncIndexes`, never starts the scheduler, and uses mock providers only. Vite is left running. This does not prepare production indexes or validate an in-place production cutover.

Browser follow-up: two isolated sessions with synthetic users; individual checkin creates different balances; shared quest splits the total; spending fails when only partner funds suffice; seller decline refunds buyer only; reload/retry does not duplicate debit/refund; personal vs legacy ledger labels; SSE refetch; logout/account switch/lock hides previous wallet. Physical phone/PWA/push testing is separate and is not established by these tests.
