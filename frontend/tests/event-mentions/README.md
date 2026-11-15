# Event discussion mentions

The event discussion reuses the comment mention field with a separate `event-mentionable` query namespace. Suggestions come from `GET /api/friends/events/:id/mentionable?q=...`, not the writer's direct friend list. Eligible users are the creator and still-authorized invitees across every RSVP state, excluding self and bilateral blocks. The server checks membership, exact display name and UTF-16 offsets in the trimmed body before saving spans. Replies prefill a structured mention only when the comment author remains eligible; otherwise the name is plain text. Existing comments without spans remain readable.

## Local browser verification

Read `scripts/browser/README.md` first. Inspect ports 4000/4001/5173 and 4002/5175; never stop unowned listeners. Use an operator-owned API with `backend/tests/realtime/mock-runtime.cjs` on 4002 and `frontend/tests/realtime/dev-server.mjs` on 5175. Only Mongo `mongodb://127.0.0.1:27017/lookwithin_dev` and mock providers. No `.env` or credentials. Run separately from API/integration suites; stop the owned API afterward and leave Vite.

```sh
node frontend/tests/event-mentions/browser.mjs --local-mock-runtime
```

External Playwright only, no frontend dependency. The suite creates three synthetic accounts, two friendships and an event. Two guests deliberately are not friends with each other; the mentioned guest has declined the event. Login, picker selection, root comment and reply submission run through UI. The actual REST response confirms saved spans, and rendered links confirm the read path. A bilateral block then checks rejected writes, empty suggestions and plain-text historical spans. Inputs are masked in screenshots; no credentials, storage state, traces or HAR are saved. Test data remains in local development Mongo. Open the screenshots manually; assertions alone do not establish visual quality or physical-phone/PWA behavior.
