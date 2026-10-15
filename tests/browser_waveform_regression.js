// Serve motor_bench_host on port 3001, then use playwright-cli run-code --filename this file.
async (page) => {
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.confirm = () => true;
    window.sentCommands = [];
    class TestSocket {
      constructor() {
        this.readyState = 1;
        window.testSocket = this;
        setTimeout(() => {
          this.onopen?.();
          this.emit({ type: 'inventory', data: { items: [
            { kind: 2, canBus: 2, motorId: 1, outerLoop: 2 },
            { kind: 4, canBus: 1, motorId: 2, outerLoop: 2 },
          ] } });
        }, 0);
      }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
      send(text) { window.sentCommands.push(JSON.parse(text)); }
    }
    window.WebSocket = TestSocket;
    window.reading = (channelId, ref, speed, online = true) => window.testSocket.emit({
      type: 'telemetry', data: { count: 1, seq: 1, items: [{
        channelId, ref, speed, online, enabled: false, torque: 0, angle: 0, temperature: 25,
      }] },
    });
  });
  function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const card = id => page.locator(`.channel[data-ch="${id}"]`);
  const readout = async id => parseFloat(await page.locator(id).textContent());
  const results = [];
  await page.goto('http://127.0.0.1:3001/');
  await card(1).waitFor();
  equal(await page.locator('#waveCanvas').count(), 1, 'Missing real-time waveform');
  await card(0).locator('[data-role="motor"]').selectOption('0');
  await card(0).locator('[data-role="bind"]').click();
  await card(0).locator('[data-role="bind"]').click();
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length), 1, 'Duplicate bind while confirmation is pending');
  await card(0).locator('[data-role="num"]').fill('2000');
  await page.evaluate(async () => {
    for (const speed of [0, 100, 350, 650, 950, 1100, 1040, 990, 970, 960, 955, 950]) {
      window.reading(0, 1000, speed);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  });
  await page.waitForFunction(() => parseFloat(document.querySelector('#waveTarget').textContent) === 1000);
  equal(await readout('#waveActual'), 950, 'Actual speed readout');
  equal(await readout('#waveError'), 50, 'Speed tracking error');
  const pixels = () => page.locator('#waveCanvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let target = 0, actual = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - 77) < 8 && Math.abs(data[i + 1] - 163) < 8 && Math.abs(data[i + 2] - 255) < 8) target++;
      if (Math.abs(data[i] - 62) < 8 && Math.abs(data[i + 1] - 207) < 8 && Math.abs(data[i + 2] - 142) < 8) actual++;
    }
    return { target, actual };
  });
  const lines = await pixels();
  if (lines.target < 10 || lines.actual < 10) throw Error(`Missing overlaid trace pixels: ${JSON.stringify(lines)}`);
  results.push('two real Canvas traces use board target, measured speed and tracking error');

  await page.locator('#wavePause').click();
  await page.evaluate(() => window.reading(0, 1500, 1400));
  await page.waitForTimeout(100);
  equal(await readout('#waveTarget'), 1000, 'Paused target must freeze');
  equal(await readout('#waveActual'), 950, 'Paused actual must freeze');
  await page.locator('#wavePause').click();
  await page.waitForFunction(() => parseFloat(document.querySelector('#waveTarget').textContent) === 1500);
  equal(await readout('#waveActual'), 1400, 'Resume shows data collected while paused');
  equal(await readout('#waveError'), 100, 'Tracking error sign');
  results.push('pause freezes display while telemetry continues; resume catches up');

  // The board rejects using the same motor on a second channel and sends no bind ACK.
  await card(1).locator('[data-role="motor"]').selectOption('0');
  await card(1).locator('[data-role="bind"]').click();
  await card(1).locator('[data-role="unbind"]').click();
  await page.evaluate(() => window.testSocket.emit({ type: 'unbindAck', data: { channelId: 1, result: 1 } }));
  equal(await card(1).count(), 0, 'Confirmed unbound channel must remove its card');
  const failedBindCount = await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length);
  await page.locator('#addChannel').click();
  await card(1).locator('[data-role="motor"]').selectOption('1');
  await card(1).locator('[data-role="bind"]').click();
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length), failedBindCount + 1, 'A confirmed unbound channel must recover from a failed bind');
  results.push('failed binding recovers after the board confirms the pending channel is unbound');
  await page.locator('#waveChannel').selectOption('1');
  await page.evaluate(() => window.reading(1, 5, 4.5));
  await page.waitForFunction(() => document.querySelector('#waveActual').textContent.includes('rad/s'));
  equal(await readout('#waveTarget'), 5, 'DM target');
  equal(await readout('#waveActual'), 4.5, 'DM measured speed');
  await page.locator('#waveChannel').selectOption('0');
  equal(await readout('#waveTarget'), 1500, 'Channel histories stay separate');
  await page.locator('#waveWindow').selectOption('30');
  equal(await page.locator('#waveWindow').inputValue(), '30', 'Time-window control');
  const before = await page.evaluate(() => window.sentCommands.length);
  await page.locator('#waveClear').click();
  equal(await page.locator('#waveTarget').textContent(), '--', 'Clear current channel readings');
  equal(await page.evaluate(() => window.sentCommands.length), before, 'Waveform controls do not issue motor commands');
  const cleared = await pixels();
  equal(cleared, { target: 0, actual: 0 }, 'Clear removes both traces');
  await page.locator('#waveChannel').selectOption('1');
  equal(await readout('#waveTarget'), 5, 'Clear leaves other channel history intact');
  results.push('channel isolation, rpm/rad/s units, time window and local-only clear');

  const binds = await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length);
  await card(1).locator('[data-role="motor"]').selectOption('0');
  await card(1).locator('[data-role="loop"]').selectOption('1');
  await card(1).locator('[data-role="bind"]').click();
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length), binds, 'Occupied channel must not be rebound');
  equal(await page.locator('#waveActual').textContent(), '4.5 rad/s', 'Rejected rebind must preserve confirmed display units and history');
  results.push('duplicate binding cannot replace the plotted motor or loop metadata');

  const removeDmChannel = () => page.evaluate(() => window.testSocket.emit({ type: 'unbindAck', data: { channelId: 1, result: 0 } }));
  await removeDmChannel();
  await page.locator('#addChannel').click();
  await card(1).locator('[data-role="motor"]').selectOption('1');
  await card(1).locator('[data-role="loop"]').selectOption('1');
  await card(1).locator('[data-role="bind"]').click();
  await page.locator('#waveChannel').selectOption('1');
  await page.evaluate(() => window.reading(1, 3, 4.5));
  if (!(await page.locator('#waveStatus').textContent()).includes('速度环')) throw Error('Non-speed target is presented as speed');
  equal(await page.locator('#waveTarget').textContent(), '--', 'Non-speed target cannot share speed axis');
  await removeDmChannel();
  await page.locator('#addChannel').click();
  await card(1).locator('[data-role="motor"]').selectOption('1');
  await card(1).locator('[data-role="bind"]').click();
  await page.locator('#waveChannel').selectOption('1');
  await page.evaluate(() => window.reading(1, 5, 4.5, false));
  await page.waitForFunction(() => document.querySelector('#waveStatus').textContent.includes('离线'));
  if (!(await page.locator('#waveStatus').textContent()).includes('离线')) throw Error('Offline motor is shown as live');
  await page.evaluate(() => window.testSocket.emit({ type: 'serial', open: false }));
  if (!(await page.locator('#waveStatus').textContent()).includes('关闭')) throw Error('Serial disconnect is hidden');
  results.push('non-speed-loop targets are excluded; offline and disconnected states are explicit');

  await page.evaluate(() => window.testSocket.emit({ type: 'serial', open: true, path: 'COM_OTHER_BOARD' }));
  await page.locator('#waveChannel').selectOption('0');
  await page.evaluate(() => window.reading(0, 5, 4.5));
  await page.waitForTimeout(80);
  equal(await page.locator('#waveTarget').textContent(), '--', 'Another serial session cannot inherit the previous board units');
  const sessionBinds = await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length);
  await card(1).locator('[data-role="bind"]').click();
  equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'bind').length), sessionBinds + 1, 'Old telemetry and pending flags must not block a fresh session');
  await page.locator('#waveChannel').selectOption('1');
  await page.evaluate(() => window.reading(1, 5, 4.5));
  await page.waitForFunction(() => document.querySelector('#waveActual').textContent === '4.5 rad/s');
  results.push('new serial sessions discard stale binding metadata, pending state and old traces');

  await page.evaluate(() => window.testSocket.emit({ type: 'unbindAck', data: { channelId: 1, result: 0 } }));
  equal(await page.locator('#waveChannel').inputValue(), '0', 'Removed selected channel falls back');
  await page.evaluate(() => window.testSocket.emit({ type: 'unbindAck', data: { channelId: 0, result: 0 } }));
  equal(await page.locator('#waveChannel option').count(), 0, 'No removed channel choices');
  await page.locator('#addChannel').click();
  equal(await page.locator('#waveChannel').inputValue(), '0', 'Reused channel can be selected');
  equal(await page.locator('#waveTarget').textContent(), '--', 'Reused channel does not inherit old data');
  results.push('unbind removes waveform history and reused IDs start empty');
  equal(errors, [], 'Browser errors');

  const paths = await page.evaluate(async () => {
    const { SpeedWaveform } = await import('/waveform.js');
    const canvas = document.querySelector('#waveCanvas');
    const ctx = canvas.getContext('2d');
    const moveTo = ctx.moveTo, lineTo = ctx.lineTo;
    let segments;
    const record = action => {
      if (ctx.strokeStyle === '#4da3ff' || ctx.strokeStyle === '#3ecf8e') segments[ctx.strokeStyle][action]++;
    };
    ctx.moveTo = function (...args) { record('moves'); return moveTo.apply(this, args); };
    ctx.lineTo = function (...args) { record('lines'); return lineTo.apply(this, args); };
    try {
      return [
        [{ time: 0, ref: 100, speed: 90 }, { time: 10, ref: 100, speed: 95 },
          { time: 2000, ref: 200, speed: 150 }, { time: 2010, ref: 200, speed: 195 }],
        [{ time: 0, ref: 100, speed: 90 }, { time: 10, ref: 100, speed: 95 },
          { time: 100, ref: null, speed: null }, { time: 110, ref: 200, speed: 150 }, { time: 120, ref: 200, speed: 195 }],
      ].map(points => {
        segments = { '#4da3ff': { moves: 0, lines: 0 }, '#3ecf8e': { moves: 0, lines: 0 } };
        SpeedWaveform.prototype.paint.call({ canvas, ctx }, points, 3000, 3000, 'rpm');
        return segments;
      });
    } finally {
      ctx.moveTo = moveTo;
      ctx.lineTo = lineTo;
    }
  });
  for (const path of paths) equal(path, {
    '#4da3ff': { moves: 2, lines: 4 }, '#3ecf8e': { moves: 2, lines: 2 },
  }, 'Actual Canvas paths must break across missing or offline data');
  results.push('Canvas paths break at offline samples and communication gaps instead of bridging them');

  await page.setViewportSize({ width: 390, height: 844 });
  const sizes = await page.locator('#waveCanvas').evaluate(canvas => ({
    width: canvas.getBoundingClientRect().width, viewport: innerWidth,
  }));
  if (sizes.width > sizes.viewport || sizes.width < 200) throw Error(`Bad narrow-screen chart size: ${JSON.stringify(sizes)}`);
  await page.screenshot({ path: 'output/playwright/speed-waveform-mobile.png', fullPage: true });
  return results;
}
