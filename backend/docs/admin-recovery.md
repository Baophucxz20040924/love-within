# Admin and account recovery operations

## Provisioning (operator only)

The API never creates an administrator at startup. Public registration reserves `admin@phucxz.com`; an account with this email alone is not an admin. Both its persisted `role: admin` and exact normalized reserved email are required.

The existing **Deploy backend (dev)** workflow targets the database configured for the VPS `api` service. Set `ADMIN_BOOTSTRAP_PASSWORD` as a secret in the GitHub `dev` environment before running that workflow. Each deployment pulls the exact new API image, passes the secret through SSH stdin to its compiled bootstrap command, and only after success persists the image and restarts the services. A missing secret, reserved-email collision, or bootstrap failure fails the deployment. The secret is not persisted in the VPS environment file. Re-running does not reset an existing admin's password; changing the GitHub secret does not rotate credentials.

Alternatively, from the backend directory, an authorized operator must explicitly supply `MONGODB_URI` in the process environment and pipe one initial password to:

```sh
npm run bootstrap:admin -- --password-stdin
```

Use a secret-manager pipe or another protected input mechanism. Do not put the password in source, command arguments, shell history, screenshots, or deployment logs. This command intentionally does not load `.env`. It does not supply a default password, print the password, or accept interactive echoed input. It creates the user email unique index before inserting. Verify the database URI and inspect account ownership before running it.

The initial password must be at least six characters (bootstrap-only exception), at most 72 UTF-8 bytes, with no NUL or internal newline. Choose a strong value. A weak initial password is not made safe by the separate admin UI. Admin change-password requires at least eight characters and should be used before public exposure; it is not mandatory on first login.

An existing non-admin reserved-email account is a hard collision: the command refuses to promote or overwrite it. An existing legitimate admin is left unchanged, including its password and credential version. Re-running is not an admin password recovery mechanism. Concurrent inserts are protected by email uniqueness. No bootstrap or real reset is part of the automated tests.

## Admin workflow

Use the separate `/admin/login` page. The 15-minute `adminToken` is held only in RAM, has no refresh token, and does not authorize app, PIN, realtime, or push endpoints. Reloading requires login again. The server checks both the role and reserved email against current database credentials on every admin request.

1. Search an exact email and verify the returned name/email before resetting.
2. Submit the observed `credentialVersion` and your current admin password.
3. A successful response contains a cryptographically random temporary password and its 24-hour deadline. Copy it only on an explicit operator action and deliver it privately. Do not send it through push or ordinary app notifications.
4. The plaintext is not persisted and cannot be fetched again. Clear it on dismissal, masking, or session expiry.
5. **Never automatically retry a reset after a lost response.** It may already have committed. Reload status, verify the target, and explicitly authorize another reset if a new secret is needed. An outdated expected version returns 409.

`/admin/change-password` requires current password plus a new matching password/confirmation. Success revokes all previous admin tokens, including the caller's; sign in again. The normal user reset endpoint never resets admins.

Audit records contain static action, actor/target ObjectIds, timestamp, and success/failure only. They never include password, token, hash, email, or error payload. No request body logging should be added around these routes. Existing per-worker rate limits apply to admin login, lookup, reset/change, and recovery completion; these are not distributed quotas.

## API contract

All successful JSON uses the existing `{ "data": ... }` envelope and `Cache-Control: no-store`.

- `POST /api/auth/login {email,password}` returns the existing `{accessToken,refreshToken}` for a normal app user, or `{status:"password_change_required",passwordChangeToken,expiresAt}` for a valid temporary password. No app tokens are included with the latter. Admins cannot use app login.
- `POST /api/auth/password-change {passwordChangeToken,newPassword,confirmPassword}` returns full app tokens only after a successful atomic credential update. The grant expires after 15 minutes or the temporary password deadline, whichever is earlier. It is single-use by credential-version CAS. A replacement grant can be obtained by signing in again while the temporary password remains valid.
- `POST /api/admin/login {email,password}` returns `{adminToken,expiresAt}`.
- `GET /api/admin/users?email=...` returns `{user:null}` or `{user:{id,displayName,email,credentialVersion,mustChangePassword,temporaryPasswordExpiresAt}}`. No private app content or password hashes are returned.
- `POST /api/admin/users/:id/reset-password {expectedCredentialVersion,currentAdminPassword}` returns `{temporaryPassword,expiresAt,credentialVersion}` once.
- `POST /api/admin/change-password {currentPassword,newPassword,confirmPassword}` returns `{changed:true}`.

Admin requests after login use `Authorization: Bearer <adminToken>`. Purpose-bound admin/recovery tokens cannot be used as ordinary access or refresh tokens, even when signing keys are shared. New passwords require at least eight characters, at most 72 UTF-8 bytes, and no NUL. Confirmation must match. Recovery cannot reuse the temporary password; admin change cannot reuse its current password. PIN configuration/hash is not changed by account recovery.

## Revocation and concurrency

New tokens carry `cv` and a strict token type. A legacy app token lacking `cv` means version zero only; it remains valid only for an existing version-zero non-admin, non-recovery user. Missing legacy database role/version are treated as `user`/zero, while malformed versions fail closed. Any credential rotation increments the persisted version.

Login and refresh issue from the version snapshot actually authenticated, never from a newer user fetched after bcrypt. A concurrent reset can therefore make their response unusable, but cannot grant the new version using an old password/token. Reset/reset and reset/completion updates use atomic version comparisons. Completion additionally checks forced-change state, exact temporary deadline, and database-time temporary/grant expiry. Tokens are issued from the committed completion result. Already committed business requests cannot be undone by resetting credentials.

Credential revocation is checked at authorization points, not a transaction spanning every application collection. An already-authorized request can finish after a reset if the reset races its final database write; this includes PIN configuration after its last credential recheck. Reset itself never changes PIN hashes/configuration. Strict cancellation of every in-flight cross-document write is not guaranteed; review PIN/device settings if the old password was compromised.

Local realtime revocation after commit is supplementary; current credential checks are the authorization boundary. Cross-worker realtime behavior retains the application's existing deployment limits. Push consumers must bind subscriptions to the current version and revalidate before sends. Notifications already delivered by the OS cannot be recalled.

## Local verification

`npm run test:credentials` builds and runs synthetic in-memory credential/admin unit tests without reading `.env`, connecting to Mongo, starting HTTP, or contacting providers. The suite covers token-purpose separation, legacy zero, forced change, version snapshots, races, one-use completion, bootstrap collision/rerun/concurrent-insert winner checks, audit-safe outputs, and asynchronous middleware failure forwarding. `npm run test:bootstrap-deploy` builds and verifies the compiled command with mocks and the deployment transport with a fake SSH process; the dev workflow runs both suites before building the image.

An operator may separately run the opt-in synthetic Mongo test:

```sh
npm run test:credentials:mongo -- --local-lookwithin-dev
```

It can connect only to `mongodb://127.0.0.1:27017/lookwithin_dev`. It creates UUID-tagged `example.invalid` users and deletes only its own tagged IDs in `finally`. It neither bootstraps nor queries/mutates the real reserved admin account, starts a server, reads `.env`, or contacts providers. It exercises actual Mongo CAS for legacy migration, reset/reset, one-time completion, reset/change, role guards, and commit-time expiry. Mock tests do not prove provider delivery or real-device behavior.
