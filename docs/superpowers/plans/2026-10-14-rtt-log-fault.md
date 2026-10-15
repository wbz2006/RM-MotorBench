# RTT Log Fault Implementation Plan

**Goal:** Prevent enable/stop and PID diagnostics from faulting the motor task.

**Architecture:** Keep the shipped RTT formatter unchanged and use its supported integer formatting in the two affected diagnostics. Upgrade native behavior coverage to use the production logger.

**Tech Stack:** Existing C modules, SEGGER RTT formatter, native GCC, ARM GCC, OpenOCD, and Node protocol bridge.

## Constraints

- Preserve actual motor output and PID calculations.
- Do not enable physical motors during verification.
- Review and compile the corrected build before programming the C board.

## Steps

- [x] Read live fault registers and task stack without stopping the board; correlate the instruction with the shipped RTT source.
- [x] Make native tests use the actual log macro/formatter and reproduce access violation `3221225477` with the original enable diagnostic.
- [x] Remove the two unsupported floating-point diagnostic calls from both board modules and identify firmware 1.2.
- [x] Native A/C behavior with real logging, protocol selftests, control protocol, and C-board CAN/CRC checks passed. C-board 1.2 ELF/HEX compiled successfully.
- [x] Independent read-only review found no material issue. Backed up the live 1.1 flash region, programmed the same C board with 1.2, and received `Verified OK`.
- [x] On physical hardware, restored M3508 CAN1 ID1, channel 0 speed loop, remote maximum 3000 rpm. Executed twenty STOP commands and a PID query followed by writing back the same reported speed PID values. No physical enable commands were issued.
- [x] Observed continuous replies for thirty seconds after these operations: 178 heartbeats, 1707 telemetry frames, 1728 control reports; maximum reply gap 21 ms. CFSR and HFSR both read zero. Latest channel remained disabled; CAN motor feedback was offline.

Build SHA256: `3017378CE83D6BC5E4A39237F9E8B8823ADC17226BB94702C399AF9B6E623087`

Previous firmware backup: `C:/Users/20802/.codex/visualizations/2026/10/14/01a13a10-6b49-7eb0-937d-222b77536d9f/rtt-fault-before/ctype-1.1-flash.bin`
