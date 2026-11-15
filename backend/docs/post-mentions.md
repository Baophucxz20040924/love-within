# Post mentions in Hội bạn bè

The post composer supports selecting accepted, unblocked friends with `@`. Plain typed names without selected spans remain plain text. Tags never grant access: posts still belong to the author's current friends, subject to blocks, deletion and report hiding.

## Contract

`POST /api/friends/stories` and `PATCH /api/friends/stories/:id` accept optional `mentions: { userId, offset, length }[]`. Indices are JavaScript UTF-16 positions in the **trimmed body**, with at most 10 sorted, non-overlapping spans matching `@displayName`. New occurrences must name a current accepted, unblocked friend, not the author. Existing same-user, same-literal-text occurrences may be retained/moved after a profile rename or relationship change; they do not trigger a new notification or confer visibility. Viewers receive no linked span for people blocked either way; the original body stays readable.

Missing mentions on create means empty. On edit, omission preserves spans only if the normalized body is unchanged; a changed body clears them. Explicit `[]` clears tags. Existing documents need no backfill. Content writes use an internal revision (legacy missing = zero), independent of reactions/votes. Overlapping edits can return `409 CONTENT_CONFLICT`; the composer retains its draft. This guards requests racing during processing, not stale drafts submitted sequentially from different devices. Poll no-votes guards remain atomic.

`GET /api/friends/stories/mentionable?q=` searches the draft author's accepted, unblocked friends without a saved post. The existing `/:id/mentionable` remains comment-specific. Draft and comment picker caches are separate.

## Notifications and realtime

`post_mention` uses the post as its entity and links to `/friends/posts/:id`. Existing `mention` continues to use a comment entity and comment deep link. Push belongs to the `social` preference group and never includes post text. Notification list and badge both require current post access and a current mention of the recipient; only the list requests body excerpts.

Create/edit attempts notification delivery for distinct newly tagged recipients after persistence. An atomic insert-once operation uses the existing unique `(userId, groupKey)` index, with `post_mention:<postId>` as group key. An existing row is not bumped or marked unread and does not push again, including after removal/re-addition. This deduplication lasts while the row exists (90-day TTL; block/unfriend/delete can purge it), not forever. Notification failures do not fail a saved post. Delivery is best-effort, not durable/exactly-once.

Existing SSE `friend-posts` and `friend-notifications` domains refresh post bodies, notification excerpts and current-span visibility. No stream protocol or deployment topology change is required beyond deploying both updated backend and frontend.

## Verification

```sh
npm --prefix backend run test:mentions
npm --prefix frontend run test:mentions
npm --prefix backend run test:realtime
npm --prefix frontend run test:realtime
npm --prefix backend run typecheck
npm --prefix backend run build
npm --prefix frontend run build
```

Browser verification is separate and sequential, with owned local mocks only. Follow `scripts/browser/README.md` process-ownership and credential rules. `frontend/tests/post-mentions/browser.mjs` uses API4002/UI5175 and external Playwright; it never launches or kills servers, saves credentials, or calls providers. The existing `backend/tests/realtime/mock-runtime.cjs` and `frontend/tests/realtime/dev-server.mjs` supply the safe fixture. Inspect listener ownership first, stop only the API you created afterwards, leave Vite running.

```sh
node frontend/tests/post-mentions/browser.mjs
```

The browser suite exercises mobile-emulated creation, accent-insensitive search, focus/keyboard/Escape/multiline, UTF-16 spans, profile links, live notification navigation with polling disabled, edits without duplicate unread churn, removal/re-addition, comment regression, poll/photo composition and blocked/unrelated boundaries. Screenshots and sanitized result JSON live outside the repository. It does not prove physical-phone keyboard/PWA background behavior, real Web Push delivery or deployed CDN streaming.
