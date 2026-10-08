# Browser smoke summary

- Result: **PASS**, 2 Playwright tests.
- Browser: installed Google Chrome via Playwright's `channel: "chrome"`, headless, viewport 1440 × 960.
- Services: local Vite dev server and loopback Node Demo Gateway; fixture backend only.
- Root `pnpm demo:dev` was also started and checked: Gateway health returned `ok:fixture`, Vite returned HTTP 200.
- Scenario 1: synthetic patient appears, prompt streams in chunks, activity events appear, citation opens the labeled evidence drawer.
- Scenario 2: complex synthetic case exposes simulated specialist metadata; Stop aborts the stream and the terminal cancellation acknowledgement appears in Agent Activity.
- No GPU, model service, external medical data, or public endpoint used.

Screenshots in `screenshots/` are synthetic UI acceptance evidence:

- `desktop-main.png`
- `evidence-drawer.png`
- `complex-case.png`
