# Love notification inbox

`/notifications` replaces the former approvals destination; `/approvals` redirects to `/notifications?filter=approvals`. The activity inbox and pending approval queue remain independent. Reading a notification never approves a request. Existing pending requests and savings application Retry remain available even if no historical notification exists.

## Persistence and privacy

All 18 existing couple event types, including moment prompt/post/completion, now persist minimal references before optional push delivery. Inbox persistence does not depend on devices, push preferences or quiet hours. Recipient/current active couple membership is checked on emission and every list/count/read/seen operation. Old-couple history is inaccessible after re-pairing. Destination business APIs remain responsible for their own authorization and availability checks.

Rows do not contain photo URLs, letter/question contents, proposal payloads or bank notes. External push remains generic: `Love Within` / `Bạn có một thông báo mới` / `/`. There is no historical notification backfill or scheduler `notifiedAt` reset. Moment timing, rewards, streaks and recipient rules are unchanged.

Unique `(userId, coupleId, eventKey)` insertion prevents duplicate rows and duplicate enqueue on source retries. Failed inbox/push delivery is best effort and does not roll back a saved business action. This is not a durable outbox or exactly-once provider guarantee. Notification retention is 90 days through Mongo TTL; actual removal depends on the TTL monitor.

## Seen and read

- Seen controls the bell/title badge; read controls each row's unread appearance.
- Each returned page has a stable server-issued snapshot token containing exactly the returned IDs. Lookahead and unloaded history are not included.
- Seen/read-loaded acknowledgements accept one token or a maximum of 25 tokens per request, scoped to recipient and active couple. Snapshots expire after 24 hours; reload the list if expired.
- **“Đọc các thông báo đã tải” reads loaded pages only**, not the entire unseen history. Later arrivals, including backdated inserts, are excluded from an earlier snapshot.
- Seen changes only invalidate `couple-notification-unread`; read changes only invalidate `couple-notifications`. Idempotent acknowledgements publish nothing, avoiding a feed/refetch loop.

## Verification

- `npm run test:notifications`: isolated model/repository/service/producer tests, no database or provider.
- Frontend `npm run test:notifications` and `npm run test:notifications:browser`: component checks and explicit local mock browser checks. Browser requires an already owned loopback preview and external Playwright; it does not prove backend persistence or physical-device delivery.
- `node backend/tests/couple-notifications/mongo.cjs --run-local-mongo` is a separate opt-in fixture for the permitted local `lookwithin_dev` database. It writes synthetic IDs and cleans only those recipient/couple rows, while User/Couple dependencies are mocked. It was **not executed during this implementation** because the environment blocked its cleanup permission. Do not treat isolated tests as Mongo integration evidence.
