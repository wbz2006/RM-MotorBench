# Serial error loop repair

The user cannot dismiss connection errors because adding a motor without an open serial port produces a local failure acknowledgement, which starts inventory polling. Every poll produces another blocking alert.

Connection failures will appear in one dismissible inline notice. Commands requiring a serial connection will stop locally when the port is closed; inventory retries and pending response timers will stop on disconnect. Failed sends must not start response timeouts or overwrite the connection guidance. An inventory timeout must report missing board replies, rather than claiming a successful connection.

Keep the existing firmware, protocol, motor controls, and emergency stop behavior. Do not open or enable hardware automatically. Test the real HTML and UI in Tabbit with only the hardware WebSocket boundary replaced, then reload the user's page and verify ordinary port enumeration.
