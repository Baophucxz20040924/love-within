# Personal-wallet browser verification

Use the external Playwright installation documented in `scripts/browser/README.md`; no frontend dependency is added.

The browser source never starts servers, reads environment files or writes tokens/storage dumps. It creates two synthetic accounts in the operator-owned local API4002, pairs them, seeds one check-in through the API, and drives shop creation, redemption, decline, cancellation and fulfillment through UI5175. It checks personal wallet ownership, no seller payout, insufficient personal funds despite partner funds, owner-scoped coin ledgers, and mounted buyer balance refresh after a partner decline. Screenshots mask inputs. API response and UI assertions are separate from concurrency/legacy migration coverage in the Mongo suite.

Preferred isolated runner (build backend first; inspect ports and reuse the owned Vite5175 proxy):

```sh
node backend/tests/personal-wallets/run-browser.cjs --local-mock-runtime
```

It uses fresh random-prefix collections in the exact local `lookwithin_dev` database, starts one owned API per suite, and sequentially runs wallet and moment browser tests. Graceful API shutdown removes only that child's exact created collections and leaves Vite running. Existing application collections/indexes and unowned listeners are untouched. See `backend/tests/personal-wallets/ROLLOUT.md` for safety boundaries and production cutover prerequisites.

Direct browser-only command when a correctly configured owned mock runtime is already running:

```sh
node frontend/tests/personal-wallets/browser.mjs --local-mock-runtime
```

This does not verify a physical phone, installed PWA, real push, live banking, or production migration. The legacy ignored PowerShell smoke scripts target port4000; do not run them against an unowned listener. Moment browser data/storage are intercepted UI fixtures, unlike wallet API mutations in this suite.
