# Hidden-space privacy screen

Dark Within access is concealed on a new document, hidden/pagehide, and restored BFCache documents. Foreground/online/SSE verification never grants entry. The existing four heart taps → Đăng nhập → Lên thuyền gesture is required again; login credentials and selected space are not cleared. The grant is document-memory only and bound to the session generation. Pending notification navigation keeps only the latest destination for that session.

A retained route snapshot keeps mounted composer drafts and file previews behind the cover. Native image/camera pickers receive no bypass: if the browser reports hidden, reentry is required. Document eviction/reload may lose nonpersistent draft attachments. Media pauses and never automatically resumes. Independent access-verification and hidden-lock reasons share masking, including portals, inertness and modal focus pause. The verification screen is neutral and has checking/failure/retry states.

This is concealment, **not authentication or an authorization boundary**. Someone who knows the gesture or can inspect the browser/device may access the retained session. It cannot erase old browser history, retract signed media URLs, hide OS push text, or guarantee the timing/content of native app-switcher screenshots. Notification settings are deliberately unchanged; configure OS preview settings separately if necessary. A native shell/OS-specific testing would be needed for stronger screenshot guarantees.

## Checks

- `npm --prefix frontend run test:privacy`: isolated actual-controller/mask tests with mocked DOM.
- `npm --prefix frontend run test:privacy:browser`: external Playwright against localhost mock API4002/UI5175; follow `scripts/browser/README.md`, inspect listener ownership, use only `lookwithin_dev`, and run separately from smoke/process lifecycles. No frontend Playwright dependency, real providers, saved sessions, traces or HAR.
- `npm --prefix frontend run build`
- `npm --prefix frontend run test:realtime`
- `node frontend/scripts/test-auth-storage.cjs`
- `node frontend/scripts/test-session-mutations.cjs`
- `npm --prefix frontend run test:media`
- `npm --prefix frontend run test:mentions`

Browser evidence is written to the external tooling shots directory, not committed. Inspect screenshots as well as result.json. The checking/failed presentation tests use the *loaded* Vite module URL (including its update timestamp) to avoid creating a second singleton store through an unversioned dynamic import. Real offline/online recovery is tested separately. Synthetic hidden/pagehide/BFCache events are not proof of physical-phone/native-picker/OS snapshot behavior. Installed HTTPS PWA, real BFCache eligibility and platform task-switcher behavior remain device checks.

Bootstrap JS/CSS are static same-origin assets and part of the service-worker shell v5, with an opaque neutral shield before React loads; no CSP policy is relaxed. An old installed worker/document must receive the app update/reload before it gains the new behavior.
