# Verification — 2026-11-15

All application changes are integrated in the primary working tree. No commit, push, production deployment, or existing-data wallet migration was performed.

## Daily 30-minute revision — passed locally

The sections below this revision record describe the previously verified three-session implementation. They are historical evidence, not acceptance of the new policy.

- Integrated v3 backend/frontend. Backend build and frontend production build passed;13 backend moment tests,6 push tests,14 frontend moment tests and full personal-wallet unit suite passed.
- Passed scoped Mongo moment integration: one persisted schedule, post/notification/Story CAS, DB-stamped timestamp/lateness and literal metadata, reward/capture boundaries, late pair streak and preserved legacy/v2 history. Only fresh namespaced collections were created and cleaned.
- Passed scoped Mongo personal-wallet suite including daily quest regression: stale lower progress cannot demote completion;40 Xu credits20 per member and5 shared EXP exactly once across replay. Reward unit tests cover late pair claim rejection, old10Xu policy and immutable intent recovery.
- Passed event mentions, backend/frontend realtime, PIN/app-lock and27 session-mutation regressions, plus social/media regressions and whitespace checks.
- Sequential browser run passed: `personal-wallets-1794753337305` and `moments-1794753365479`. Moments:11 UI fixture scenarios including retained preview/late upload across reward cutoff, neutral Home CTA, midnight expiry, no-PIN camera visibility, stale responses and old history. Screenshot review: Home after reward expiry, capture sheet and midnight-expired state. Moment/storage routes remain mocked; actual repository acceptance is established separately by Mongo tests, not browser fixtures.
- Owned API children16716 and39380 stopped with exit0 and removed their exact scoped collections; Vite remains running. No production, real phone/camera/PWA/push verification, commit or push.

## Previously passed on integrated source

- Backend TypeScript build and frontend production build.
- Backend wallet suites: namespace guards, operation/recovery/fencing, market reservation/refunds and same-key lookup race, checkin/quest/bucket intents, completion/Story gates and ABA guard, frontend retry identity/copy.
- Backend event mentions, moments/scheduler, push expiry, privacy-lock, reactions, mentions, media, realtime suites.
- Frontend app-lock, event mentions, moments (8 cases), reactions, mentions, media, realtime and 27 isolated session-mutation scenarios.
- `git diff --check` (only Git line-ending warnings, no whitespace errors).
- Actual standalone Mongo moment repository integration: concurrent schedule/post/notification/Story CAS, authoritative cutoff and same-session binding. Random couple fixture only; no existing index changes.
- Actual standalone Mongo personal-wallet integration: synthetic legacy split, concurrent wallet/reward operations, failures after balance/ledger/EXP/commit/clear, terminal lookup and stale-worker fencing, same-key request race, cancel/decline refund race, legacy buyer refund, bucket pending/paid ABA, durable source/Story gates and lost acknowledgements. All models use fresh process-scoped collections in local `lookwithin_dev`; cleanup removes only owned collections. Story media/provider boundary is mocked in bucket scenarios.

## Browser evidence

External Playwright/Chromium; mobile viewport emulation, synthetic accounts, local mock providers only.

- Event mentions: `event-mentions-1794747031637` — non-mutual invited guest with declined RSVP; picker/root/reply persistence; bilateral block removes links via realtime; creator friendship revocation removes access. Viewport screenshots reviewed.
- Personal wallets: `personal-wallets-1794750305903` — two accounts, individual check-in, buyer-only debit/refund, seller decline, buyer cancel, accepted/fulfilled coin sink, personal insufficiency despite partner funds, owner-scoped ledgers and mounted buyer balance refresh. Earlier identical-flow screenshots `personal-wallets-1794749718945` reviewed.
- Moments: `moments-1794750339685` — 8 UI cases including no-PIN camera visibility return, background upload retry, Home idle/cutoff, capture/preview expiry, delayed PUT/POST, next-session isolation, multi-session history and legacy read-only. Moment/storage endpoints are deterministic route fixtures, not HTTP backend acceptance proof. Earlier viewport screenshots `moments-1794749860332` reviewed.

Evidence directories are under external `%TEMP%/lw_pw/shots/`, not committed into the repository. Inputs are masked; no tokens, storage-state dumps, traces or HAR were saved.

## Failures found and corrected

- No-PIN camera visibility epochs discarded a valid selected file; separated local draft validity from strict per-mutation epochs.
- Backgrounded upload could leave the still-mounted draft busy; stale continuations now stop while valid draft controls settle.
- Browser paused timers blocked access verification; Date-only fixed clock retains real auth/realtime timers. Visibility cases await both shield and access verification; temporarily concealed UI is not treated as success.
- Bucket completion could persist `done` without reward intent; intent and completion now persist atomically. Follow-up complete→reopen ABA cannot overwrite the original claim.
- Lost market acknowledgement followed by terminal replay gave misleading new-request success copy; replay is now reported truthfully, without automatic extra purchase.
- Actual Mongo concurrency found a same-key reservation between initial request lookup and open-request lookup; the second lookup now resumes that same key rather than returning conflict. Deterministic unit regression and Mongo rerun passed.
- Sharing one mock API across browser suites exhausted rate limits. Runner now starts and gracefully stops a fresh owned, scoped API for each suite; limits were not weakened.

## Limits and runtime cleanup

No physical phone, native camera hardware, installed HTTPS PWA, OS background snapshots, real push delivery, banking or production cutover verified. Generic legacy PowerShell smoke lifecycles were not run because port4000 is owned by an unrelated runtime; dedicated focused suites, scoped Mongo and owned browser runtime were used instead. Compatibility-only ignored smoke-script edits from the test worktree were not integrated.

Owned API children stopped cleanly after browser runs and cleaned their scoped collections; API4002 is absent. Existing unowned4000/5173 listeners were untouched. Owned Vite5175 remains running. Do not run offline recovery while any API worker is alive.

Before production deployment follow `ROLLOUT.md`: drain old shared-wallet writers, audit duplicate open requests and ambiguous historical partial rewards, prepare exact unique indexes and remove the obsolete bucket-day TTL only after inspection. Do not mix old and new wallet writers during a rolling deployment.
