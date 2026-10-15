# Serial Error Loop Implementation Plan

**Goal:** Keep the page usable after a serial connection failure.

**Architecture:** Track whether the serial port is open in the existing browser UI. Show one inline connection notice and cancel inventory polling and response timers when the connection closes.

**Tech Stack:** Existing HTML, CSS, JavaScript modules, Node, and Tabbit browser tests. No new dependencies.

## Constraints

- Keep firmware and protocol unchanged.
- Keep emergency stop delivery when connected.
- Do not open or enable hardware automatically.

## Repair and verification

- [x] Add `tests/serial_ui_regression.js`, executing the real UI with a controlled WebSocket boundary; demonstrate the existing alert/polling failures.
- [x] Modify `motor_bench_host/index.html` and `style.css` to provide a dismissible inline connection notice.
- [x] Modify `motor_bench_host/ui.js`: replace error alerts, gate board commands on an open port, return a send result, cancel inventory and response timers on disconnect, and avoid false connection-success messages on query timeout.
- [x] Run the browser regression against the edited files, plus the existing protocol and control tests. Nine browser cases passed; `npm test` reported `ALL PASSED`; syntax and control-protocol checks passed.
- [x] Independently review the change. The read-only reviewer found no material regressions.
- [x] Loaded a fresh page with real port enumeration and selected COM19. The old page's blocking dialog prevented attachment; a desktop coordinate click was rejected because its target could not be confirmed. The safe alternative used the known local URL in a new browser tab. Verified the real service connection and all four enumerated ports; preserved the original user tab and closed the simulated regression page.
