# RTT logging HardFault repair

Live non-halting SWD reads confirmed the motor task faults at `SEGGER_RTT_vprintf` address `0x0800a8f8`, reading invalid address `0x466a6000`. The task stack contains its enable log. The formatter supports no floating-point conversions, so the enable and PID logs leave variadic floating-point arguments unconsumed and the appended color-reset `%s` reads an invalid pointer. The prior native tests replaced logging with no-op macros and missed this path.

Remove floating-point arguments from the two diagnostic messages in both board modules. Preserve all motor and PID state changes and protocol replies. Identify the corrected firmware as 1.2. Run native firmware behavior tests with the actual production log macro and RTT formatter, replacing only RTT host I/O, and explicitly cover fractional PID updates plus enable/disable.

Build the corrected C-board firmware and review it before physical verification. Verify communication using heartbeat, read-only queries, and motor stop commands; do not enable physical motors as part of validation.
