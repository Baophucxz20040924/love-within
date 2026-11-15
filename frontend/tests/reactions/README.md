# Reaction people verification

Both story card summaries open “Người đã thả cảm xúc”. Love derives its two-person list from authenticated couple data. Dark requests `GET /api/friends/stories/:id/reactions?limit=50&cursor=...` only while the sheet is mounted. The endpoint checks story access on every page, filters bilateral blocks, omits deleted profiles and returns only public profile fields plus reaction type. Ordering is by user ID, not reaction time; concurrent mutations are not a snapshot. Aggregate counts can exceed visible people because identities are filtered.

## Isolated checks

```sh
npm --prefix frontend run test:reactions
npm --prefix frontend run test:realtime
npm --prefix backend run test:reactions
```

Component/API mocks cover URL encoding, paging, deduplication, loading, retry, empty and denied-cache states. Realtime mocks cover cancellation/removal of reaction queries. Backend route/service mocks cover ACL-first ordering, bilateral blocks, missing profiles, public fields, pagination and input validation.

## Local browser

Read `scripts/browser/README.md` first. Inspect ports 4000/4001/5173 and 4002/5175, never stop an unowned listener. Use the operator-owned mock API via `backend/tests/realtime/mock-runtime.cjs` on 4002 and the dedicated Vite proxy `frontend/tests/realtime/dev-server.mjs` on 5175. Only local Mongo `mongodb://127.0.0.1:27017/lookwithin_dev`; no real providers or `.env` access. Run separately from other browser/API suites. Stop the owned API afterward; leave Vite.

```sh
npm --prefix frontend run test:reactions:browser
```

External Playwright only, no frontend browser dependency. The suite creates synthetic users/pair/friendships/posts/reactions and leaves them in local development data. It checks actual endpoint pagination/ACL, Dark feed/detail/profile and Love feed/detail sheets, reaction labels, own marker, Escape/focus restoration, bilateral block filtering and author revocation. Screenshots mask inputs; no tokens, storage dumps, traces or HAR are saved. Review images manually. Browser emulation does not prove physical-device or installed-PWA behavior.
