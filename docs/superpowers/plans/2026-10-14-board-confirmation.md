# Board Confirmation Repair Implementation Plan

**Goal:** Correct malformed heartbeat replies and accurately report missing board responses.

**Architecture:** Preserve the nine-byte heartbeat payload with an explicit reserved byte in the packed C structure. Track recent valid replies in the browser, independently of whether the serial port remains open.

**Tech Stack:** Existing C firmware, JavaScript UI, native GCC tests, ARM GCC build, and Tabbit regression program.

## Constraints

- Preserve the existing protocol, including the nine-byte heartbeat payload.
- Never disable emergency stop delivery based on reply freshness.
- Do not flash the physical board or enable motors.

## Steps

- [x] Add real-wire heartbeat length and CRC assertions in `tests/firmware_behavior_test.c`; verify the length assertion fails with the current firmware.
- [x] Add and reproduce browser reply-freshness regression in `tests/serial_ui_regression.js`.
- [x] Add the reserved byte, firmware 1.1 version, and layout assertions to both board `motor_bench.h` headers.
- [x] Update `motor_bench_host/ui.js` to track reply freshness and describe confirmation timeouts without inferring firmware compatibility.
- [x] Native A/C firmware tests, ten browser cases, selftests, syntax, and control protocol checks passed. C-board ELF/HEX built successfully.
- [x] Independently review the change. Fixed the reviewer's timing-sensitive regression-test expectation; no production defect found. Deliver the corrected C-board build through the user's existing C-board flashing task; physical flashing and hardware confirmation remain user actions.

Firmware artifact: `basic_framework_ctype_usb-master/build/basic_framework_CTYPE.hex`

SHA256: `7E773DC2EBC8D086EDEE6B2E0E6AE924FBDFB4B2C2B7CE915836DD2F6CB78516`
