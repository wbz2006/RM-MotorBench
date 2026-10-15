# Board confirmation timeout repair

The timeout copy suggests upgrading firmware without checking compatibility. The current page also retains its online status when board replies stop. Read-only queries to the running service received no heartbeat, telemetry, inventory, or control report during the investigation.

The actual firmware heartbeat structure contains an eight-byte payload but declares nine bytes, so the packet is truncated. Keep the existing nine-byte protocol by explicitly adding its zero-filled reserved byte in both board headers, and validate the complete transmitted frame and CRC using the real firmware module. Mark this repair as firmware 1.1.

Change timeout text to describe missing replies. If an opened serial port receives no valid board reply for more than three seconds, mark the board unresponsive, stop inventory polling, and cancel pending response timers. Resume the online indication after a valid reply. Continue to attempt emergency stop delivery.

Build the corrected C-board firmware and run the browser, protocol, and native firmware checks. Do not flash the physical board or enable a motor; deliver the compiled repair for the user's existing flashing workflow.
