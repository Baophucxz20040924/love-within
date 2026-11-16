# Discovery mobile browser fixtures

This suite exercises permanent Home links through missing, waiting, posted, both and failed pulse responses; empty destinations; the Friends event strip in empty and error states; and creator cancellation/deletion versus non-creator and void-history restrictions. Error fixtures first let startup access verification succeed, then fail a normal activity poll or event-list navigation; initial verification errors correctly keep the existing privacy screen closed instead. The deletion fixture checks the operation ID and expected revision sent by the UI and returns a synthetic operation receipt.

Use an **already running, owned loopback production preview** and externally installed Playwright/Chromium. The suite does not install dependencies, build, start a server, or contact a backend. See `scripts/browser/README.md` for the external tooling setup.

```sh
LW_UI_URL=http://localhost:5175 node frontend/tests/discovery/browser.mjs --local-mock-runtime
```

`LW_UI_URL` must be a credential-free HTTP(S) loopback origin. `LW_PW_HOME` points to the directory containing external `playwright-core` (defaults to the OS temp `lw_pw` directory); `CHROME` selects the browser executable; `LW_HEADED=1` shows the browser. The default browser location follows the push browser fixture's Windows Chromium setup.

The isolated 360 px contexts use synthetic session data. All API requests are intercepted, unknown API calls and external requests fail closed, and only local preview documents/assets are allowed through. Screenshots and a sanitized result JSON are written to a unique OS temp directory printed on completion; inputs are masked and no credentials, storage exports, HARs or traces are saved. This is frontend fixture evidence only, not a test of real backend authorization, persistence, networking, or a physical device.
