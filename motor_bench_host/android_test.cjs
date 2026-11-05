// Actual web UI and protocol; only the Android TCP bridge is simulated.
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
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const p = await import('./protocol.js');
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const context = { http, fs, path, __dirname };
    vm.runInNewContext(source.slice(source.indexOf('const MIME = {'), source.indexOf('/* ---------------- WebSocket')) + ' globalThis.server = server;', context);
    const server = context.server;
    const writes = [];
    const exceptions = [];
    const parser = new p.FrameParser();
    let win, heartbeat;
    let linked = false;
    const timeout = setTimeout(() => { console.error('Android test timed out'); app.exit(1); }, 30000);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const click = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
    const receive = bytes => evaluate('window.__motorBenchAndroidData(' + JSON.stringify(bytes.toString('base64')) + ')');
    const pulse = () => receive(p.buildHeartbeatAck({ fwMinor: 12, inventory: 1, flags: 32, uptime: 60 }));
    const inventory = () => receive(p.buildFrame(p.FrameType.INVENTORY_REPORT, Buffer.from([1, 1, 1, 1, 3, 0, 0])));
    const telemetry = enabled => receive(p.buildTelemetry([{ channelId: 0, online: true, enabled, temperature: 28 }]));
    async function until(check, label) {
      const end = Date.now() + 5000;
      while (Date.now() < end) { if (await check()) return; await delay(25); }
      throw new Error('Timed out: ' + label);
    }
    async function nativeMessage(raw) {
      const message = JSON.parse(raw);
      if (message.op === 'connect') {
        assert.equal(message.host, '192.168.4.1'); assert.equal(message.port, 7000);
        linked = true;
        await evaluate('window.__motorBenchAndroidOpened()');
        return;
      }
      for (const frame of parser.push(Buffer.from(message.data, 'base64'))) {
        writes.push(frame);
        if (!linked) continue;
        if (frame.type === p.FrameType.HEARTBEAT) await pulse();
        if (frame.type === p.FrameType.INVENTORY_QUERY) await inventory();
        if (frame.type === p.FrameType.MOTOR_UNBIND) await receive(p.buildFrame(p.FrameType.UNBIND_ACK, Buffer.from([frame.payload[1], 0])));
        if (frame.type === p.FrameType.MOTOR_BIND) await telemetry(false);
        if (frame.type === p.FrameType.MOTOR_ENABLE) await telemetry(!!frame.payload[1]);
      }
    }
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
      await win.loadURL('about:blank');
      const debug = win.webContents.debugger;
      debug.attach('1.3');
      debug.on('message', (_, method, params) => {
        if (method === 'Runtime.exceptionThrown') exceptions.push(params);
        if (method === 'Runtime.bindingCalled') nativeMessage(params.payload).catch(error => exceptions.push(error.message));
      });
      await debug.sendCommand('Runtime.enable');
      await debug.sendCommand('Page.enable');
      await debug.sendCommand('Emulation.setScrollbarsHidden', { hidden: true });
      await debug.sendCommand('Runtime.addBinding', { name: 'motorbenchNative' });
      await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: 'window.MotorBenchAndroid = { connectWifi(host, port) { motorbenchNative(JSON.stringify({op:"connect", host, port})); }, sendBytes(data) { motorbenchNative(JSON.stringify({op:"write", data})); }, closeTcp() { window.__motorBenchAndroidClosed(); } };' });
      await win.loadURL('http://127.0.0.1:' + server.address().port);
      await until(() => evaluate('document.body.dataset.appScreen === "control"'), 'automatic connection opens control');
      await until(() => evaluate('!document.querySelector("#addFirstMotor").disabled'), 'reset ACKs and inventory');
      const browserFrames = await evaluate('(async () => { const p = await import("./protocol.js"); return [p.buildSetRef(0, -125.5), p.buildPositionStep(0, 65535, 45, 2.25), p.buildSetPid(0, 2, {Kp:20,Ki:1,Kd:0,MaxOut:15000,IntegralLimit:10000})].map(b => Array.from(b)); })()');
      assert.deepEqual(browserFrames, [p.buildSetRef(0, -125.5), p.buildPositionStep(0, 65535, 45, 2.25), p.buildSetPid(0, 2, {Kp:20,Ki:1,Kd:0,MaxOut:15000,IntegralLimit:10000})].map(b => Array.from(b)), 'browser serialization matches Node protocol');
      assert.deepEqual([...new Set(writes.filter(f => f.type === p.FrameType.MOTOR_UNBIND).map(f => f.payload[1]))].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
      heartbeat = setInterval(() => { if (linked) pulse().catch(error => exceptions.push(error.message)); }, 200);
      await click('.android-tabs [data-screen=connection]');
      await pulse();
      assert.equal(await evaluate('document.body.dataset.appScreen'), 'connection');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#channels")).display'), 'none');
      await click('.android-tabs [data-screen=control]');
      await evaluate('document.querySelector("[data-role=motor]").selectedIndex = 1; document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"));');
      await click('[data-role=bind]');
      await until(() => evaluate('!document.querySelector("[data-role=enable]").disabled'), 'motor feedback');
      await evaluate('window.confirm = () => true; undefined');
      await click('[data-role=enable]');
      await until(() => writes.some(f => f.type === p.FrameType.MOTOR_SET), 'target after enable');
      const enabled = writes.findIndex(f => f.type === p.FrameType.MOTOR_ENABLE && f.payload[1] === 1);
      assert.equal(writes[enabled + 1].type, p.FrameType.MOTOR_SET);
      assert.equal(writes[enabled + 1].payload.readFloatLE(1), 0);
      for (const [width, height] of [[320,740], [390,844], [844,390], [800,1100]]) {
        win.setContentSize(width, height); await delay(150);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'fits width ' + width);
        if (process.env.MOTORBENCH_ANDROID_SCREENSHOTS) {
          fs.mkdirSync(process.env.MOTORBENCH_ANDROID_SCREENSHOTS, { recursive: true });
          await evaluate('window.scrollTo(0, 0)');
          fs.writeFileSync(path.join(process.env.MOTORBENCH_ANDROID_SCREENSHOTS, 'control-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
        }
      }
      const before = writes.length;
      await evaluate('window.__motorBenchAndroidPause()');
      await until(() => writes.slice(before).some(f => f.type === p.FrameType.ALL_STOP), 'background all-stop');
      linked = false;
      await evaluate('window.__motorBenchAndroidClosed("test")');
      assert.equal(await evaluate('document.body.dataset.appScreen'), 'connection');
      assert.equal(await evaluate('document.querySelector(".android-tabs [data-screen=control]").disabled'), true);
      assert.deepEqual(exceptions, []);
      console.log('PASS Android: auto connection, reset ACKs, tabs, command bytes, background stop, disconnect, 320/390/844/800px layouts');
    } catch (error) { console.error(error); console.error(exceptions); process.exitCode = 1; }
    finally {
      clearInterval(heartbeat); clearTimeout(timeout);
      if (win) win.destroy();
      await new Promise(resolve => server.close(resolve));
      app.exit(process.exitCode ?? 0);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
