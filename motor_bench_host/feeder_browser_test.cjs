// Real UI and WebSocket commands against a simulated board; no hardware output.
const path = require('node:path');
const { spawn } = require('node:child_process');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const http = require('node:http');
  const vm = require('node:vm');
  const { WebSocketServer } = require('ws');
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const timeout = setTimeout(() => { console.error('Feeder browser test timed out'); app.exit(1); }, 60000);
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const context = { http, fs, path, __dirname };
    vm.runInNewContext(source.slice(source.indexOf('const MIME = {'), source.indexOf('/* ---------------- WebSocket')) +
      'globalThis.server = server;', context);
    const server = context.server;
    const wss = new WebSocketServer({ server });
    const commands = [], exceptions = [];
    let socket, win, pulse;
    let enabled = false, angle = 36000, ref = 0, speed = 0, torque = 1000, emitTelemetry = true, fw = '1.27';
    let ticks = 0;
    const send = (type, data) => socket.send(JSON.stringify({ type, data }));
    const feedback = () => send('telemetry', { items: [{ channelId: 0, online: true, enabled, angle, ref, speed, torque, temperature: 25 }] });
    wss.on('connection', ws => {
      socket = ws;
      ws.send(JSON.stringify({ type: 'hello', capabilities: ['resetChannels', 'setLoop', 'positionStep', 'positionStepTolerance'] }));
      ws.send(JSON.stringify({ type: 'serial', open: true, path: 'MOCK-FEEDER' }));
      pulse = setInterval(() => {
        if (++ticks % 6 === 0) send('heartbeat', { fwVersion: fw, boardFlags: 191, uptimeS: 10 });
        if (emitTelemetry) feedback();
      }, 50);
      ws.on('message', raw => {
        const c = JSON.parse(raw); commands.push(c);
        if (c.type === 'resetChannels') send('unbindAck', { channelId: 0, result: 0 });
        if (c.type === 'unbind') send('unbindAck', { channelId: c.channelId, result: 0 });
        if (c.type === 'scanMotors') send('inventory', { items: [{ kind: 3, canBus: 1, motorId: 1, rxId: 0 }] });
        if (c.type === 'bind') feedback();
        if (c.type === 'enable') { enabled = c.enable; ref = enabled ? c.ref ?? 0 : 0; feedback(); }
        if (c.type === 'setRef') { ref = c.ref; feedback(); }
        if (c.type === 'stopAll') { enabled = false; ref = 0; feedback(); }
      });
    });
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const click = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
    const field = name => '[data-feeder=' + name + ']';
    const input = (name, value) => evaluate('document.querySelector(' + JSON.stringify(field(name)) + ').value=' + JSON.stringify(value) + '; document.querySelector(' + JSON.stringify(field(name)) + ').dispatchEvent(new Event("input",{bubbles:true}))');
    const value = name => evaluate('document.querySelector(' + JSON.stringify(field(name)) + ').value');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(check, label) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) { if (await check()) return; await delay(25); }
      throw new Error('Timed out: ' + label + '\n' + JSON.stringify(exceptions));
    }
    async function enable() {
      await until(() => evaluate('!document.querySelector("[data-role=enable]").disabled'), 'enable ready');
      await evaluate('document.querySelector("[data-role=num]").value="0"');
      await click('[data-role=enable]');
      await until(() => enabled, 'enabled');
    }
    async function start() {
      speed = 2160; torque = 1000;
      if (!enabled) {
        await enable();
        await until(async () => await value('phase') === '正常拨弹', 'enable automatically calibrates and starts');
        return;
      }
      await until(() => evaluate('!document.querySelector("[data-feeder=start]").disabled'), 'start ready');
      const before = commands.filter(c => c.type === 'setRef').length;
      await click(field('start'));
      await until(() => ref === 2160 && commands.filter(c => c.type === 'setRef').length > before, 'feeding target');
    }
    async function jam() {
      speed = 0; torque = 2000;
      await until(() => ref === -360, 'reverse command');
    }
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      win = new BrowserWindow({ width: 1440, height: 1100, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.on('message', (_, method, params) => { if (method === 'Runtime.exceptionThrown') exceptions.push(params); });
      await win.loadURL('http://127.0.0.1:' + server.address().port);
      await win.webContents.debugger.sendCommand('Runtime.enable');
      await until(() => evaluate('document.querySelectorAll(".channel").length === 1'), 'inventory');
      await evaluate('document.querySelector("[data-role=motor]").value="0"; document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"))');
      await click('[data-role=bind]');
      await until(() => evaluate('!document.querySelector("[data-role=enable]").disabled'), 'binding');
      await click('[data-role=calculatorTab]');
      await evaluate('document.querySelector("[data-role=calculatorType]").value="feeder"; document.querySelector("[data-role=calculatorType]").dispatchEvent(new Event("change"))');
      await input('rounds', '8'); await input('drive', 'reduction'); await input('ratio', '36');
      assert.equal(await value('target'), '2160 rpm');
      assert.equal(await evaluate('document.querySelector("[data-feeder=start]").disabled'), true);
      await input('reverseTimeout', '10'); await input('retries', '10');
      speed = 2160;
      await until(() => evaluate('document.querySelector("[data-feeder=status]").textContent.includes("填写拨弹参数")'), 'feeder ready');
      await enable();
      await until(async () => await value('phase') === '采集正常基准', 'enable starts calibration');
      assert.equal(ref, 2160, 'enable uses feeder target instead of displayed zero');
      assert.equal(await evaluate('document.querySelector("[data-role=num]").disabled'), true);
      for (let i = 0; i < 5; i++) {
        await delay(400); speed = 0; torque = 4000; await delay(100); speed = 2160; torque = 1000;
      }
      await until(async () => (await value('baseline')).includes('1000 raw'), 'normal baseline');
      assert.equal(await value('threshold'), '1300');
      await until(async () => await value('phase') === '正常拨弹', 'calibration automatically starts anti-jam');
      assert.equal(await value('reverseTimeout'), '10');
      assert.equal(await value('retries'), '10');
      const manualBefore = commands.filter(c => c.type === 'setRef').length;
      await evaluate('document.querySelector("[data-role=num]").value="5000"; document.querySelector("[data-role=num]").dispatchEvent(new Event("change"))');
      await delay(100);
      assert.equal(commands.filter(c => c.type === 'setRef').length, manualBefore, 'mode owns target');
      torque = 4000; await delay(1200);
      assert.equal(ref, 2160, 'high load at normal speed does not jam');
      speed = 0; await delay(150); speed = 2160; await delay(150);
      assert.equal(ref, 2160, 'brief slowdown does not jam');
      await jam();
      assert.equal(await value('threshold'), '1300', 'abnormal load never relearns baseline');
      angle += 72; await delay(100);
      assert.equal(ref, -360, 'forward coast cannot complete reverse');
      angle = 35964; await delay(100);
      assert.equal(ref, -360, 'one disk degree is insufficient');
      angle = 35640; speed = -360;
      await until(() => ref === 2160, '10 disk degrees resumes original target');
      assert.equal(await value('jams'), '1');
      assert.equal(await value('jamRate'), '—', 'no complete revolution is reported as an undefined rate');
      assert.equal(await value('jamRatio'), '1 / 0 发');
      angle += 2592;
      await until(async () => await value('jamRatio') === '1 / 1 发', 'actual forward disk travel estimates one emitted shot');
      assert.equal(await value('jamRate'), '100.00%');
      angle += 1620;
      await click(field('stop'));
      await until(() => !enabled && value('jamRatio').then(result => result === '1 / 2 发'), 'stop flushes final angle and retains statistics');
      assert.equal(await value('jamRate'), '50.00%');
      await click('[data-role=zero]');
      await until(() => ref === 0, 'manual zero cancels mode');
      assert.equal(await value('phase'), '未接管');
      await delay(400); assert.equal(ref, 0);
      await input('reverseTimeout', '0.5');
      await start(); await jam();
      await until(() => !enabled, 'reverse timeout stops motor');
      assert.match(await evaluate('document.querySelector("[data-feeder=status]").textContent'), /回退超时/);
      await start(); await jam();
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",bubbles:true,cancelable:true}))');
      await until(() => !enabled, 'space stop');
      const afterStop = commands.filter(c => c.type === 'setRef').length;
      await delay(1200);
      assert.equal(commands.filter(c => c.type === 'setRef').length, afterStop, 'no delayed resume');
      await input('reverseTimeout', '3'); await input('retries', '3');
      speed = 2160; torque = 1000;
      await enable();
      await until(async () => await value('phase') === '采集正常基准', 'default parameters start calibration');
      await delay(600);
      await click(field('stop'));
      await until(() => !enabled, 'stop during calibration');
      const captureStop = commands.length;
      await delay(3500);
      assert.equal(await value('phase'), '未接管');
      assert.equal(commands.slice(captureStop).some(c => (c.type === 'enable' && c.enable) || c.type === 'setRef'), false, 'cancelled calibration cannot auto-start');
      await start(); emitTelemetry = false;
      await until(() => !enabled, 'stale telemetry stops');
      emitTelemetry = true; await delay(150);
      assert.equal(await value('baseline'), '未采集', 'link interruption invalidates baseline');
      fw = '1.26';
      await until(() => evaluate('document.querySelector("[data-feeder=status]").textContent.includes("1.27")'), 'old firmware requirement');
      assert.match(await evaluate('document.querySelector("[data-feeder=status]").textContent'), /1.27/);
      fw = '1.27';
      await until(() => evaluate('document.querySelector("#fwText").textContent.includes("1.27")'), 'firmware restored');
      if (process.env.MOTORBENCH_FEEDER_SCREENSHOT) {
        win.setContentSize(1440, 1400);
        await evaluate('document.querySelector(".feeder-mode").scrollIntoView({block:"start"})');
        await delay(150);
        fs.writeFileSync(process.env.MOTORBENCH_FEEDER_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      }
      for (const width of [1440, 860, 390, 320]) {
        win.setContentSize(width, 1100); await delay(100);
        assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'no horizontal overflow at ' + width);
      }
      assert.deepEqual(exceptions, []);
      console.log('PASS feeder browser: enable-calibrate-auto-start with 10/10 and default recovery settings, intermittent-speed sample filtering, cancelled calibration, fixed threshold, target ownership, spike rejection, disk-angle reverse, resume, zero/Space stop, reverse timeout, stale telemetry, old firmware and responsive layout');
    } finally {
      clearTimeout(timeout); clearInterval(pulse); win?.destroy();
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  }).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
}
