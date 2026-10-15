// Serve motor_bench_host on port 3001; run with playwright-cli run-code --filename this file.
async (page) => {
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 1500, height: 1050 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sentCommands = [];
    window.confirm = () => true;
    class TestSocket {
      constructor() {
        this.readyState = 1;
        window.testSocket = this;
        setTimeout(() => {
          this.onopen?.();
          // A new browser receives session bindings before it fetches the inventory.
          this.emit({ type: 'bindings', data: { items: [
            { channelId: 1, kind: 2, canBus: 2, motorId: 1, outerLoop: 2 },
            { channelId: 3, kind: 4, canBus: 1, motorId: 2, outerLoop: 2 },
          ] } });
          window.sendInventory();
          window.reading(1, 1180, 1180.7);
          window.reading(3, 5, 4.5);
        }, 0);
      }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
      send(text) { window.sentCommands.push(JSON.parse(text)); }
    }
    window.WebSocket = TestSocket;
    window.sendInventory = () => window.testSocket.emit({ type: 'inventory', data: { items: [
      { kind: 2, canBus: 2, motorId: 1, outerLoop: 2 },
      { kind: 4, canBus: 1, motorId: 2, outerLoop: 2 },
    ] } });
    window.reading = (channelId, ref, speed) => window.testSocket.emit({ type: 'telemetry', data: { items: [
      { channelId, ref, speed, online: true, enabled: true, torque: 299, angle: 131.8, temperature: 25 },
    ] } });
  });
  const equal = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const card = id => page.locator(`.channel[data-ch="${id}"]`);
  const results = [];
  await page.goto('http://127.0.0.1:3001/');
  await card(1).waitFor();
  await page.locator('#waveChannel').selectOption('1');
  // Immediate assertion reproduces the screenshot: card telemetry is present, chart is empty.
  equal(await card(1).locator('[data-role="speed"]').textContent(), '1180.7', 'Card receives live speed');
  equal(await page.locator('#waveActual').textContent(), '1180.7 rpm', 'Restored binding must plot without pressing Bind again');
  equal(await card(1).locator('[data-role="motor"]').inputValue(), '0', 'Restore motor identity');
  equal(await card(1).locator('[data-role="loop"]').inputValue(), '2', 'Restore active control loop');
  equal(await card(2).count(), 0, 'Sparse binding must not invent an intervening card');
  await page.locator('#waveChannel').selectOption('3');
  equal(await page.locator('#waveActual').textContent(), '4.5 rad/s', 'Sparse DM binding restores its own units');
  await page.evaluate(() => { window.sendInventory(); window.sendInventory(); });
  equal(await page.locator('#waveActual').textContent(), '4.5 rad/s', 'Repeated inventory must preserve collected history');
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind' || c.type === 'enable')), [], 'Restoration sends no motor control commands');
  await page.reload();
  await card(3).waitFor();
  await page.locator('#waveChannel').selectOption('1');
  equal(await page.locator('#waveActual').textContent(), '1180.7 rpm', 'Reload resumes plotting for existing board bindings');
  results.push('refresh restores sparse channels, motor choices, loops and rpm/rad/s without rebinding');

  await page.locator('#waveChannel').selectOption('3');
  await page.evaluate(() => window.testSocket.emit({ type: 'bindings', data: { items: [
    { channelId: 1, kind: 2, canBus: 2, motorId: 1, outerLoop: 2 },
  ] } }));
  equal(await page.locator('#waveActual').textContent(), '--', 'Removed board binding cannot retain old chart values');
  await page.locator('#waveChannel').selectOption('1');
  equal(await page.locator('#waveActual').textContent(), '1180.7 rpm', 'Removing another binding preserves this channel history');

  // Simulate a different board whose bindings predate this host service.
  await page.evaluate(() => {
    window.testSocket.emit({ type: 'serial', open: true, path: 'COM_OTHER' });
    window.testSocket.emit({ type: 'bindings', data: { items: [] } });
    window.sendInventory();
    window.reading(1, 900, 890);
  });
  equal(await page.locator('#waveActual').textContent(), '--', 'New serial session discards old chart metadata');
  // The user explicitly identifies the existing motor; this must only restore the display.
  await card(1).locator('[data-role="motor"]').selectOption('');
  await card(1).locator('[data-role="motor"]').selectOption('0');
  await page.evaluate(() => window.reading(1, 900, 890));
  await page.waitForFunction(() => document.querySelector('#waveActual').textContent === '890.0 rpm');
  await card(1).locator('[data-role="loop"]').selectOption('1');
  equal(await page.locator('#waveTarget').textContent(), '--', 'Manual identification respects non-speed loops');
  await card(1).locator('[data-role="loop"]').selectOption('2');
  await page.evaluate(async () => {
    for (const speed of [700, 850, 890, 900]) {
      window.reading(1, 900, speed);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  });
  await page.waitForFunction(() => document.querySelector('#waveActual').textContent === '900.0 rpm');
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind' || c.type === 'enable')), [], 'Manual chart recovery sends no motor commands');
  await page.screenshot({ path: 'output/playwright/speed-waveform-restored.png', fullPage: true });
  await card(1).locator('[data-role="motor"]').selectOption('');
  equal(await page.locator('#waveActual').textContent(), '--', 'Clearing a manual identification removes its chart metadata');
  await page.evaluate(() => window.reading(7, 100, 99));
  await card(7).waitFor();
  await card(7).locator('[data-role="motor"]').selectOption('0');
  await page.locator('#waveChannel').selectOption('7');
  await page.evaluate(() => window.reading(7, 100, 99));
  await page.waitForFunction(() => document.querySelector('#waveActual').textContent === '99.0 rpm');
  equal(await card(6).count(), 0, 'Unknown telemetry must create only its actual sparse channel');

  await page.evaluate(() => {
    window.testSocket.emit({ type: 'serial', open: true, path: 'COM_PRESET_MOTORS' });
    window.sendInventory();
  });
  await card(0).locator('[data-role="motor"]').selectOption('0');
  await card(0).locator('[data-role="bind"]').click();
  await page.evaluate(() => window.reading(0, 100, 99));
  equal(await card(0).getAttribute('data-bind-pending'), null, 'Telemetry releases the pending flag even when host identity is unknown');
  const identifications = await page.evaluate(() => window.sentCommands.filter(c => c.type === 'identifyChannel').length);
  await card(0).locator('[data-role="motor"]').selectOption('');
  await card(0).locator('[data-role="motor"]').selectOption('0');
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'identifyChannel').length), identifications + 2, 'Successful but unconfirmed binding can be explicitly identified for future reloads');
  results.push('unknown existing bindings can be identified locally; new serial sessions clear stale metadata');
  equal(errors, [], 'Browser errors');
  return results;
}
