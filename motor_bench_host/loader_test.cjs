// Real browser UI, simulated board, no serial port or motor output.
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
    const timeout = setTimeout(() => { console.error('Loader browser test timed out'); app.exit(1); }, 45000);
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const context = { http, fs, path, __dirname };
    vm.runInNewContext(source.slice(source.indexOf('const MIME = {'), source.indexOf('/* ---------------- WebSocket')) +
      'globalThis.server = server;', context);
    const server = context.server;
    const wss = new WebSocketServer({ server });
    const commands = [];
    const exceptions = [];
    let socket, win, pulse;
    let capability = true, emitTelemetry = true, enabled = false, angle = 0, ref = 0;
    let ticks = 0;
    const send = (type, data) => socket.send(JSON.stringify({ type, data }));
    const feedback = () => send('telemetry', { items: [{ channelId: 0, online: true, enabled, angle, ref,
      speed: 0, torque: 0, temperature: 25 }] });
    const motor = { kind: 3, canBus: 1, motorId: 1, rxId: 0 };
    wss.on('connection', ws => {
      socket = ws;
      ws.send(JSON.stringify({ type: 'hello', capabilities: ['resetChannels', 'setLoop', 'positionStep', 'positionStepTolerance'] }));
      ws.send(JSON.stringify({ type: 'serial', open: true, path: 'MOCK-LOADER' }));
      pulse = setInterval(() => {
        if (++ticks % 6 === 0) send('heartbeat', { fwVersion: '1.25', boardFlags: capability ? 159 : 31, uptimeS: 10 });
        if (emitTelemetry) feedback();
      }, 50);
      ws.on('message', raw => {
        const command = JSON.parse(raw); commands.push(command);
        if (command.type === 'resetChannels') send('unbindAck', { channelId: 0, result: 0 });
        if (command.type === 'unbind') send('unbindAck', { channelId: command.channelId, result: 0 });
        if (command.type === 'scanMotors') send('inventory', { items: [motor] });
        if (command.type === 'bind') feedback();
        if (command.type === 'setLoop') { enabled = false; ref = angle = 0; send('loopAck', { channelId: 0, mask: command.mask, result: 0 }); feedback(); }
        if (command.type === 'enable') { enabled = command.enable; if (!enabled) ref = 0; feedback(); }
        if (command.type === 'stopAll') { enabled = false; ref = 0; feedback(); }
      });
    });
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const value = name => evaluate(`document.querySelector('[data-test="${name}"]').value`);
    const text = name => evaluate(`document.querySelector('[data-test="${name}"]').textContent`);
    const input = (name, value) => evaluate(`document.querySelector('[data-test="${name}"]').value=${JSON.stringify(value)}; document.querySelector('[data-test="${name}"]').dispatchEvent(new Event('input', {bubbles:true}))`);
    const pointer = type => evaluate(`document.querySelector('[data-test=pad]').dispatchEvent(new PointerEvent('${type}', {button:0, pointerId:1, bubbles:true, cancelable:true}))`);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(check, label) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { if (await check()) return; await delay(25); }
      throw new Error('Timed out: ' + label + '\nCommands: ' + JSON.stringify(commands) + '\nBrowser errors: ' + JSON.stringify(exceptions));
    }
    const steps = () => commands.filter(c => c.type === 'positionStep');
    const acknowledge = (command, result = 0) => {
      ref += command.delta;
      send('positionStepAck', { channelId: 0, requestId: command.requestId, result, target: ref });
    };
    async function start() {
      if (!enabled) { angle = ref = 0; await click('[data-test=start]'); await until(() => enabled, 'enable from calculator'); }
      await until(() => evaluate('!document.querySelector("[data-test=start]").disabled'), 'ready');
      await click('[data-test=start]');
      assert.equal(await evaluate('document.querySelector("[data-role=slider]").disabled'), true);
      assert.equal(await evaluate('document.querySelector("[data-role=num]").disabled'), true);
      assert.equal(await evaluate('document.querySelector("[data-role=zero]").disabled'), true);
    }
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      win = new BrowserWindow({ width: 1440, height: 1050, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.on('message', (_, method, params) => {
        if (method === 'Runtime.exceptionThrown') exceptions.push(params);
      });
      await win.loadURL(`http://127.0.0.1:${server.address().port}`);
      await win.webContents.debugger.sendCommand('Runtime.enable');
      await until(() => evaluate('document.querySelectorAll(".channel").length === 1'), 'motor inventory');
      await evaluate('document.querySelector("[data-role=motor]").value="0"; document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"))');
      await click('[data-role=bind]');
      await until(() => evaluate('!document.querySelector("[data-role=loopAngle]").disabled'), 'binding');
      await click('[data-role=calculatorTab]');
      await evaluate('document.querySelector("[data-role=calculatorType]").value="loaderPosition"; document.querySelector("[data-role=calculatorType]").dispatchEvent(new Event("change"))');
      await input('rounds', '8');
      assert.equal(await value('perShot'), '45', 'M2006 gearing is opt-in');
      assert.equal(await evaluate('document.querySelector("[data-test=gearbox]").checked'), false);
      await evaluate('document.querySelector("[data-test=gearbox]").click()');
      assert.equal(await value('perShot'), '1620');
      assert.equal(await evaluate('document.querySelector("[data-test=start]").disabled'), false, 'calculator offers position setup in speed mode');
      await click('[data-test=start]');
      await until(() => evaluate('document.querySelector("[data-role=unit]").textContent === "deg"'), 'position mode');
      await start();
      const manualBefore = commands.filter(c => c.type === 'setRef').length;
      await evaluate('document.querySelector("[data-role=num]").value="5000"; document.querySelector("[data-role=num]").dispatchEvent(new Event("change"))');
      assert.equal(commands.filter(c => c.type === 'setRef').length, manualBefore, 'manual changes cannot interfere');
      await evaluate('document.querySelector("[data-test=pad]").scrollIntoView({block:"center"})');
      const padCenter = await evaluate('(() => { const r = document.querySelector("[data-test=pad]").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed', ...padCenter, button:'left', clickCount:1});
      await until(() => steps().length === 1, 'single trigger');
      assert.equal(steps()[0].delta, 45);
      await pointer('pointerdown');
      acknowledge(steps()[0]);
      await until(async () => await value('requested') === '1', 'accepted counter');
      assert.equal(await value('completed'), '0');
      angle = ref - 2.5;
      await delay(250);
      assert.equal(await value('completed'), '0', 'position outside shared 5% tolerance remains busy');
      assert.match(await text('status'), /剩余 90°.*容差 81°/);
      angle = ref - 0.81; // Actual reported residual: ~0.81 output degrees, not exact target.
      await until(async () => await value('completed') === '1', 'single settles with real residual');
      await pointer('pointerdown');
      assert.equal(steps().length, 1, 'holding does not repeat even after completion');
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased', ...padCenter, button:'left', clickCount:1});
      assert.equal(steps().length, 1, 'native click after pointerdown does not double-trigger');
      await input('shots', '2');
      await pointer('pointerdown'); await pointer('pointerup');
      await until(() => steps().length === 2, 'double trigger');
      assert.equal(steps()[1].delta, 90);
      await pointer('pointerdown'); await pointer('pointerup');
      assert.equal(steps().length, 2, 'press during a move is not queued');
      acknowledge(steps()[1]); angle = ref;
      await until(async () => await value('completed') === '3', 'double settled');
      assert.equal(await value('requested'), '3');
      assert.equal(await value('target'), '4860', 'nominal pitch is retained across residuals');
      // Feedback can move outside the ready tolerance after the three settled samples.
      // Reject locally before sending a request that the board would reject as busy.
      angle = ref + 4.6;
      await delay(150);
      await pointer('pointerdown'); await pointer('pointerup');
      assert.equal(steps().length, 2, 'drift outside ready tolerance does not send a step');
      assert.match(await text('padLabel'), /等待回稳/);
      angle = ref;
      await delay(150);
      await click('[data-test=stop]');
      await until(() => !enabled, 'exit disables motor');
      assert.equal(await evaluate('document.querySelector("[data-role=num]").disabled'), false);
      await input('direction', '-1');
      await input('shots', '1');
      await evaluate('document.querySelector("[data-role=num]").value="0"');
      await start();
      await pointer('pointerdown'); await pointer('pointerup');
      await until(() => steps().length === 3, 'reverse trigger');
      assert.equal(steps()[2].delta, -45);
      acknowledge(steps()[2], 7);
      await until(() => !enabled, 'firmware rejection stops test');
      assert.equal(await value('requested'), '0', 'rejected request never counts');
      assert.match(await text('status'), /上一位置目标尚未到位/);
      await start();
      await pointer('pointerdown');
      await until(() => steps().length === 4, 'pending trigger');
      await evaluate('window.dispatchEvent(new Event("blur"))');
      await until(() => !enabled, 'blur stops test');
      acknowledge(steps()[3]);
      await delay(150);
      assert.equal(await value('requested'), '0', 'late ACK cannot resume or count');
      await start(); emitTelemetry = false;
      await until(() => !enabled, 'stale telemetry stops test');
      emitTelemetry = true;
      await start();
      await pointer('pointerdown'); await pointer('pointerup');
      await until(() => steps().length === 5, 'ACK timeout trigger');
      await until(() => !enabled, 'missing ACK stops test');
      assert.match(await text('status'), /回执超时/);
      await start();
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {code:"Space", bubbles:true, cancelable:true}))');
      await until(() => !enabled, 'space emergency stop');
      assert.equal(await evaluate('document.querySelector("[data-test=pad]").disabled'), true);
      await input('tolerance', '0.1');
      await start();
      await pointer('pointerdown'); await pointer('pointerup');
      await until(() => steps().length === 6, 'strict precision trigger');
      acknowledge(steps()[5]); angle = ref - 0.81;
      await delay(250);
      assert.equal(await value('completed'), '0', 'strict tolerance is respected, not a forced unlock');
      assert.equal(await value('positionError'), '29.16');
      assert.equal(await value('effectiveTolerance'), '1.62');
      angle = ref - 0.02;
      await until(async () => await value('completed') === '1', 'strict precision settles');
      await click('[data-test=stop]');
      await until(() => !enabled, 'strict precision exit');
      await input('tolerance', '0');
      assert.equal(await evaluate('document.querySelector("[data-test=start]").disabled'), true, 'zero tolerance rejected');
      await input('tolerance', '10.1');
      assert.equal(await evaluate('document.querySelector("[data-test=start]").disabled'), true, 'above 10% tolerance rejected');
      await input('tolerance', '5');
      await input('drive', 'reduction');
      await input('ratio', '36');
      assert.equal(await evaluate('document.querySelector("[data-test=ratioHint]").hidden'), false);
      assert.match(await text('ratioHint'), /避免与已勾选的内置减速箱重复计算/);
      await input('drive', 'direct');
      assert.equal(await evaluate('document.querySelector("[data-test=ratioHint]").hidden'), true);
      // Exercise both built-in gearboxes through the real calculator adapter.
      const gearing = await evaluate(`(async () => {
        const { initLoaderTest } = await import('./loader-test-ui.js');
        const results = [];
        for (const builtInRatio of [36, 19]) {
          const host = document.createElement('div'); document.body.appendChild(host);
          let command;
          const test = initLoaderTest(host, {
            getState: () => ({ builtInRatio, positionMode:true, enabled:true, angle:0, ref:0, tolerance:1, receivedAt:performance.now() }),
            disable() {}, displayTarget() {}, onLockChange() {}, trigger(step) { command = step; }
          });
          test.show(true);
          const get = name => host.querySelector('[data-test="' + name + '"]');
          get('rounds').value = '8'; get('rounds').dispatchEvent(new Event('input'));
          const uncheckedAngle = get('perShot').value;
          get('start').click(); get('pad').click();
          const unchecked = { ...command };
          test.stop(); get('gearbox').click();
          const checkedAngle = get('perShot').value;
          get('start').click(); get('pad').click();
          results.push({ builtInRatio, uncheckedAngle, checkedAngle, unchecked, checked:{ ...command } });
          test.destroy(); host.remove();
        }
        return results;
      })()`);
      for (const result of gearing) {
        assert.equal(result.uncheckedAngle, '45');
        assert.equal(result.checkedAngle, String(45 * result.builtInRatio));
        assert.equal(result.unchecked.delta, 45 / result.builtInRatio);
        assert.equal(result.unchecked.tolerance, 2.25 / result.builtInRatio);
        assert.equal(result.checked.delta, 45);
        assert.equal(result.checked.tolerance, 2.25);
      }
      const layout = () => evaluate(`(() => {
        const root = document.querySelector('.loader-test');
        const r = root.querySelector('.loader-test-readouts').getBoundingClientRect();
        const button = root.querySelector('[data-test=start]').getBoundingClientRect();
        const fields = [...root.querySelectorAll('.loader-test-settings label:not([hidden])')].map(label => {
          const l = label.getBoundingClientRect(), c = label.querySelector('input,select').getBoundingClientRect();
          return { top:l.top, controlTop:c.top, controlHeight:c.height };
        });
        return { width:r.width, height:r.height, rootHeight:root.getBoundingClientRect().height, buttonOffset:button.top-r.top, fields };
      })()`);
      emitTelemetry = false;
      for (const width of [1440, 860, 390, 320]) {
        win.setSize(width, 1050);
        angle = 0; feedback(); await delay(80);
        const before = await layout();
        for (const sample of [-0.001, 138.646, -999999.999, 999999.999]) {
          angle = sample; feedback(); await delay(30);
          const after = await layout();
          assert.equal(after.height, before.height, 'numeric changes preserve readout height');
          assert.equal(after.rootHeight, before.rootHeight, 'numeric changes preserve calculator height');
          assert.equal(after.buttonOffset, before.buttonOffset, 'numeric changes do not move buttons');
        }
        for (const field of before.fields) {
          assert.equal(field.controlTop - field.top, 44, 'all field controls share the same label height');
          assert.equal(field.controlHeight, 36);
        }
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true,
          `no horizontal overflow at ${width}px: ` + JSON.stringify(await evaluate(`
            [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1)
              .map(e => ({tag:e.tagName, class:e.className, text:e.textContent.slice(0,70), right:e.getBoundingClientRect().right})).slice(-12)`)));
        if (process.env.MOTORBENCH_LOADER_SCREENSHOTS) {
          fs.mkdirSync(process.env.MOTORBENCH_LOADER_SCREENSHOTS, { recursive:true });
          angle = 138.646; feedback(); await delay(40);
          await evaluate('document.querySelector(".loader-test").scrollIntoView({block:"center"})');
          fs.writeFileSync(path.join(process.env.MOTORBENCH_LOADER_SCREENSHOTS, `loader-${width}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
      angle = ref; emitTelemetry = true;
      capability = false;
      send('heartbeat', { fwVersion: '1.25', boardFlags: 31, uptimeS: 10 });
      await until(() => evaluate('document.querySelector("[data-test=start]").disabled'), 'old firmware capability received');
      assert.equal(await evaluate('document.querySelector("[data-test=start]").disabled'), true, 'old firmware stays blocked');
      assert.deepEqual(exceptions, []);
      console.log('PASS loader browser: M2006/M3508 opt-in gearing and rotor readouts, shared percentage tolerance, cumulative targets, single/double counts, hold/busy/drift guards, emergency stop and connection failures; stable numeric layout and aligned fields at 1440/860/390/320px');
    } finally {
      clearTimeout(timeout); clearInterval(pulse); win?.destroy();
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  }).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
}
