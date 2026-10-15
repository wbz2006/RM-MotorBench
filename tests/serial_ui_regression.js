// Run this browser program with Tabbit's nodejs command and stdin redirection.
// The HTML, DOM events, UI module, and timers are real; only hardware I/O is replaced.
await page.addInitScript(() => {
  window.alerts = [];
  window.alert = (message) => window.alerts.push(message);
  window.sentCommands = [];
  class TestSocket {
    constructor() {
      this.readyState = 1;
      this.serialOpen = false;
      window.testSocket = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    emit(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    send(text) {
      const cmd = JSON.parse(text);
      window.sentCommands.push(cmd);
      setTimeout(() => {
        if (cmd.type === 'listPorts') {
          this.emit({ type: 'ports', ports: [{ path: 'COM19', manufacturer: 'Microsoft' }] });
        } else if (cmd.type === 'openSerial') {
          this.serialOpen = true;
          this.emit({ type: 'serial', open: true, path: cmd.path });
        } else if (cmd.type === 'closeSerial') {
          this.serialOpen = false;
          this.emit({ type: 'serial', open: false });
        } else if (!this.serialOpen) {
          this.emit({ type: 'error', message: '串口未连接,指令未下发' });
          if (cmd.type === 'addMotor') {
            this.emit({ type: 'motorAck', data: {
              result: 1, kind: cmd.kind, canBus: cmd.canBus,
              motorId: cmd.motorId, channelId: 255, detail: 0,
            } });
            this.emit({ type: 'error', message: '串口未连接,请先打开串口' });
          }
        }
      }, 0);
    }
    disconnect() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  window.WebSocket = TestSocket;
});

const results = [];
async function reset() {
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
  await page.locator('#portSelect option[value="COM19"]').waitFor({ state: 'attached' });
}
// Absence of repeated queries must be checked over several actual polling periods.
async function pollingWindow() {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 650)));
}
async function check(name, body) {
  await reset();
  try {
    await body();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  }
}

await check('adding without a port neither alerts nor sends queries', async () => {
  await page.locator('#addMotor').click();
  await pollingWindow();
  const actual = await page.evaluate(() => ({
    alerts: window.alerts.length,
    boardCommands: window.sentCommands.filter((cmd) => cmd.type !== 'listPorts').length,
    message: document.querySelector('#addMsg').textContent,
  }));
  assert.equal(actual.alerts, 0, 'Connection errors opened blocking alerts');
  assert.equal(actual.boardCommands, 0, 'Disconnected add started board commands/polling');
  assert.match(actual.message, /串口/);
});

await check('rescan without a port does not start polling', async () => {
  await page.locator('#rescan').click();
  await pollingWindow();
  assert.equal(await page.evaluate(() => window.sentCommands.filter((cmd) => cmd.type === 'scanMotors').length), 0);
  assert.equal(await page.evaluate(() => window.alerts.length), 0);
});

await check('closing the serial port cancels pending inventory queries', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => window.sentCommands.some((cmd) => cmd.type === 'scanMotors'));
  await page.locator('#closePort').click();
  await page.waitForFunction(() => !window.testSocket.serialOpen);
  const before = await page.evaluate(() => window.sentCommands.filter((cmd) => cmd.type === 'scanMotors').length);
  await pollingWindow();
  assert.equal(await page.evaluate(() => window.sentCommands.filter((cmd) => cmd.type === 'scanMotors').length), before);
  assert.equal(await page.evaluate(() => window.alerts.length), 0);
});

await check('service disconnect cancels inventory retries', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => window.sentCommands.some((cmd) => cmd.type === 'scanMotors'));
  await page.evaluate(() => window.testSocket.disconnect());
  const before = await page.evaluate(() => window.sentCommands.length);
  await pollingWindow();
  assert.equal(await page.evaluate(() => window.sentCommands.length), before);
  assert.equal(await page.evaluate(() => window.alerts.length), 0);
});

await check('repeated backend errors remain one dismissible notice', async () => {
  await page.evaluate(() => {
    for (let i = 0; i < 25; i++) {
      window.testSocket.emit({ type: 'error', message: '串口未连接,指令未下发' });
    }
  });
  assert.equal(await page.evaluate(() => window.alerts.length), 0);
  await expect(page.locator('#connectionNotice')).toBeVisible();
  await page.locator('#dismissNotice').click();
  await expect(page.locator('#connectionNotice')).toBeHidden();
  await page.locator('#refreshPorts').click();
  await page.waitForFunction(() => window.sentCommands.filter((cmd) => cmd.type === 'listPorts').length === 2);
});

await check('an unanswered inventory query does not claim a working connection', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => document.querySelector('#addMsg').textContent.length > 0 ||
    !document.querySelector('#connectionNotice').hidden, null, { timeout: 6000 });
  const message = await page.evaluate(() => document.querySelector('#addMsg').textContent +
    document.querySelector('#connectionMessage').textContent);
  assert.doesNotMatch(message, /连接正常/);
  assert.match(message, /未收到|未回复/);
});

await check('connected motor addition and emergency stop still send commands', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => window.testSocket.serialOpen);
  await page.locator('#addMotor').click();
  await page.locator('#estop').click();
  const commands = await page.evaluate(() => window.sentCommands);
  assert.ok(commands.some((cmd) => cmd.type === 'addMotor' && cmd.motorId === 1));
  assert.ok(commands.some((cmd) => cmd.type === 'stopAll'));
  assert.equal(await page.evaluate(() => window.alerts.length), 0);
});

await check('an empty inventory reply prevents repeated heartbeat-driven queries', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => window.testSocket.serialOpen);
  await page.evaluate(() => {
    window.testSocket.emit({ type: 'inventory', data: { items: [] } });
    for (let i = 0; i < 5; i++) {
      window.testSocket.emit({ type: 'heartbeat', data: { fwVersion: '1.0', uptimeS: 1 } });
    }
  });
  const before = await page.evaluate(() => window.sentCommands.filter((cmd) => cmd.type === 'scanMotors').length);
  await pollingWindow();
  assert.equal(await page.evaluate(() => window.sentCommands.filter((cmd) => cmd.type === 'scanMotors').length), before);
});

await check('disconnect cancels motor and control-source response timeouts', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => window.testSocket.serialOpen);
  await page.evaluate(() => {
    window.testSocket.emit({ type: 'heartbeat', data: { fwVersion: '1.1', uptimeS: 1 } });
    document.querySelector('#addMotor').click();
    document.querySelector('#applySource').click();
    window.testSocket.disconnect();
  });
  // Let both three-second response deadlines pass to detect stale callbacks.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 3300)));
  assert.match(await page.locator('#addMsg').textContent(), /断开/);
  assert.match(await page.locator('#remoteStatus').textContent(), /断开/);
});

await check('a stalled board is marked unresponsive and recovers on a real reply', async () => {
  await page.locator('#openPort').click();
  await page.waitForFunction(() => window.testSocket.serialOpen);
  await expect(page.locator('#linkDot')).not.toHaveClass(/online/, { timeout: 5500 });
  await expect(page.locator('#connectionNotice')).toBeVisible();
  await page.evaluate(() => window.testSocket.emit({ type: 'heartbeat', data: { fwVersion: '1.1', uptimeS: 1 } }));
  await expect(page.locator('#linkDot')).toHaveClass(/online/);
  await expect(page.locator('#connectionNotice')).toBeHidden();
});

globalThis.serialUiResults = results;
const failed = results.filter((result) => !result.pass);
assert.equal(failed.length, 0, JSON.stringify(results));
return results;
