// Exercise the actual browser UI against a simulated board; never open a serial port.
const path = require('node:path');
const { spawn } = require('node:child_process');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {
    env, windowsHide: true, stdio: 'inherit',
  });
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
    const timeout = setTimeout(() => { console.error('Guidance browser test timed out'); app.exit(1); }, 30000);
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const context = { http, fs, path, __dirname };
    vm.runInNewContext(source.slice(source.indexOf('const MIME = {'),
      source.indexOf('/* ---------------- WebSocket')) + ' globalThis.staticServer = server;', context);
    const server = context.staticServer;
    const wss = new WebSocketServer({ server });
    const commands = [];
    const exceptions = [];
    let socket;
    let autoReset = false;
    let heartbeat;
    let win;
    const send = (type, data) => socket.send(JSON.stringify({ type, data }));
    let fwVersion = '1.12';
    let boardFlags = 0;
    const pulse = () => send('heartbeat', { fwVersion, boardFlags, uptimeS: 60, inventoryCount: 1 });
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
    async function until(check, label) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(25);
      }
      throw new Error(`Timed out: ${label}`);
    }
    async function screenshot(name) {
      if (!process.env.MOTORBENCH_GUIDANCE_SCREENSHOTS) return;
      fs.mkdirSync(process.env.MOTORBENCH_GUIDANCE_SCREENSHOTS, { recursive: true });
      win.webContents.invalidate();
      await delay(250);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(process.env.MOTORBENCH_GUIDANCE_SCREENSHOTS, name + '.png'), image.toPNG());
    }
    const motor = { kind: 2, canBus: 1, motorId: 2, rxId: 0 };
    const telemetry = (online, enabled) => send('telemetry', { items: [{
      channelId: 0, online, enabled, ref: 0, speed: 0, torque: 0, angle: 0, temperature: 28,
    }] });
    wss.on('connection', ws => {
      socket = ws;
      ws.send(JSON.stringify({ type: 'hello', capabilities: ['resetChannels', 'setLoop'] }));
      ws.send(JSON.stringify({ type: 'serial', open: false }));
      ws.on('message', raw => {
        const command = JSON.parse(raw);
        commands.push(command);
        if (command.type === 'listPorts') ws.send(JSON.stringify({ type: 'ports', ports: [] }));
        if (autoReset && command.type === 'unbind') send('unbindAck', { channelId: command.channelId, result: 0 });
      });
    });
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
      await until(() => evaluate('document.querySelector("#portSelect").textContent.includes("未发现串口")'), 'port scan');
      assert.equal(await evaluate('document.querySelector("#openPort").disabled'), true);
      assert.equal(await evaluate('document.querySelector("#addFirstMotor").disabled'), true);
      assert.match(await text('#serviceState'), /已连接/);
      assert.match(await text('#guideMessage'), /供电和 USB 数据线/);
      await screenshot('guidance-empty');

      socket.send(JSON.stringify({ type: 'ports', ports: [{ path: 'MOCK-USB', manufacturer: 'Motor Bench CDC' }] }));
      await until(() => evaluate('!document.querySelector("#openPort").disabled'), 'port available');
      await click('#openPort');
      assert.equal(commands.filter(c => c.type === 'enable').length, 0);
      socket.send(JSON.stringify({ type: 'serial', open: true, path: 'MOCK-USB' }));
      await until(() => evaluate('document.querySelector("#guideTitle").textContent.includes("等待控制板")'), 'serial without board response');
      assert.match(await text('#boardState'), /等待应答/);
      assert.equal(await evaluate('document.querySelector("#addMotor").disabled'), true);

      autoReset = true;
      send('unbindAck', { channelId: 0, result: 0 });
      await until(() => evaluate('document.querySelector("#connectionMessage").textContent.includes("正在同步电机清单")'), 'reset acknowledged but no inventory');
      assert.equal(await evaluate('document.querySelector("#addMotor").disabled'), true);
      send('inventory', { items: [] });
      autoReset = false;
      heartbeat = setInterval(pulse, 300);
      await until(() => evaluate('document.querySelector("[aria-current=step]").dataset.step === "add"'), 'empty inventory acknowledged');
      assert.equal(await evaluate('document.querySelector("#addFirstMotor").disabled'), false);
      await click('#addFirstMotor');
      assert.equal(await evaluate('document.querySelector("#addForm").hidden'), false);
      assert.equal(await evaluate('document.activeElement.id'), 'addKind');
      await evaluate('document.querySelector("#addKind").value = "4"; document.querySelector("#addKind").dispatchEvent(new Event("change"))');
      assert.match(await text('#addIdHelp'), /Master ID/);
      await evaluate('document.querySelector("#addKind").value = "2"; document.querySelector("#addKind").dispatchEvent(new Event("change")); document.querySelector("#addId").value = "2"');
      await click('#addMotor');
      await until(() => commands.some(c => c.type === 'addMotor'), 'add request');
      assert.equal(await evaluate('document.querySelectorAll(".channel").length'), 0, 'request alone does not create a channel');
      assert.equal(await evaluate('document.querySelector("[aria-current=step]").dataset.step'), 'add');
      send('motorAck', { ...motor, result: 0 });
      send('inventory', { items: [motor] });
      await until(() => evaluate('document.querySelectorAll(".channel").length === 1'), 'confirmed motor creates channel');
      assert.equal(await evaluate('document.querySelector("[aria-current=step]").dataset.step'), 'bind');
      assert.equal(await evaluate('document.querySelector("[data-role=enable]").disabled'), true);
      assert.match(await text('[data-role=channelHint]'), /先选择/);
      assert.equal(await evaluate('document.querySelector("[data-role=channelHint]").getBoundingClientRect().bottom <= document.querySelector(".bind-row").getBoundingClientRect().top'), true, 'channel hint appears before configuration even in desktop grid');
      await evaluate('const select = document.querySelector("[data-role=motor]"); select.value = "0"; select.dispatchEvent(new Event("change"))');
      assert.match(await text('[data-role=channelHint]'), /点击标题行/);
      await click('[data-role=bind]');
      assert.match(await text('[data-role=channelHint]'), /等待板端遥测/);
      assert.equal(await evaluate('document.querySelector("[aria-current=step]").dataset.step'), 'bind');
      assert.equal(await evaluate('document.querySelector("[data-role=bind]").disabled'), true, 'no duplicate bind while awaiting feedback');
      telemetry(false, false);
      await until(() => evaluate('document.querySelector("#guideTitle").textContent.includes("离线")'), 'bound but offline');
      assert.match(await text('[data-role=channelHint]'), /CAN 接线/);
      assert.equal(await evaluate('document.querySelector("[data-role=enable]").disabled'), true);
      telemetry(true, false);
      await until(() => evaluate('!document.querySelector("[data-role=enable]").disabled'), 'live motor feedback');
      assert.match(await text('#feedbackState'), /1\/1 在线/);
      boardFlags = 0x20; pulse();
      await until(async () => (await text('#linkText')) === 'A 板在线', 'A identity from heartbeat');
      boardFlags = 0x40; pulse();
      await until(async () => (await text('#linkText')) === 'C 板在线', 'C identity changes even at the same firmware version');
      telemetry(true, false);
      await delay(40);
      assert.equal(await text('#linkText'), 'C 板在线', 'telemetry does not overwrite the heartbeat board identity');
      await screenshot('guidance-board-c');
      boardFlags = 0x60; pulse();
      await until(async () => (await text('#linkText')) === 'MC02 板在线', 'MC02 identity');
      telemetry(true, false);
      await delay(100);
      assert.equal(await text('#linkText'), 'MC02 板在线', 'telemetry preserves MC02 identity');
      boardFlags = 0; pulse();
      await until(async () => (await text('#linkText')) === '控制板在线', 'legacy firmware remains generic');
      const controlCount = () => commands.filter(c => ['enable', 'setRef'].includes(c.type)).length;
      const before = controlCount();
      await click('#guideAction');
      assert.equal(controlCount(), before, 'guide only navigates and never starts output');
      await click('[data-role=enable]');
      await until(() => commands.some(c => c.type === 'enable' && c.enable), 'manual enable request');
      assert.equal(await evaluate('document.querySelector("[data-step=test]").dataset.state'), 'current', 'enable request alone cannot complete the guide');
      telemetry(true, true);
      await until(() => evaluate('document.querySelector("[data-step=test]").dataset.state === "done"'), 'enabled telemetry completes guide');
      await evaluate('window.scrollTo(0, 0)');
      await screenshot('guidance-running');
      await evaluate('document.querySelector(".channel").scrollIntoView({ block: "start" })');
      await screenshot('guidance-channel');

      telemetry(false, false);
      await until(() => evaluate('document.querySelector("[data-role=enable]").disabled'), 'motor disconnected');
      telemetry(true, false);
      await until(() => evaluate('!document.querySelector("[data-role=enable]").disabled'), 'motor recovered');
      assert.match(await text('[data-role=channelHint]'), /当前未使能/);
      assert.equal(commands.filter(c => c.type === 'enable' && c.enable).length, 1, 'recovery never resumes output');
      await evaluate('window.confirm = () => true; undefined');
      await click('[data-role=unbind]');
      assert.equal(await evaluate('document.querySelector("[data-role=unbind]").disabled'), true);
      send('unbindAck', { channelId: 0, result: 1 });
      await until(() => evaluate('!document.querySelector("[data-role=unbind]").disabled'), 'failed unbind permits retry');
      assert.equal(await evaluate('document.querySelector("[data-role=motor]").disabled'), true, 'failed unbind keeps the confirmed binding');

      for (const width of [860, 390, 320]) {
        win.setContentSize(width, 950);
        await delay(100);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `no horizontal overflow at ${width}px`);
        if (width === 390) {
          await evaluate('window.scrollTo(0, 0)');
          await screenshot('guidance-mobile');
        }
      }
      win.setContentSize(1440, 1000);
      await until(() => evaluate('document.querySelector("#feedbackState").textContent.includes("0/1 在线") && document.querySelector("[data-role=enable]").disabled'), 'stale telemetry while board heartbeat continues');
      assert.equal(await evaluate('document.querySelector("[data-role=enable]").disabled'), true);
      assert.match(await text('#guideMessage'), /当前运行状态无法确认/);
      pulse();
      assert.equal(await evaluate('document.querySelector("[data-role=enable]").disabled'), true, 'board heartbeat cannot substitute for motor feedback');
      telemetry(true, false);
      await until(() => evaluate('!document.querySelector("[data-role=enable]").disabled'), 'fresh motor telemetry restores controls');
      // Exercise numeric-input and enable paths, which can bypass a slider's limits.
      await click('[data-role=unbind]');
      send('unbindAck', { channelId: 0, result: 0 });
      await until(() => evaluate('!document.querySelector("[data-role=motor]").disabled'), 'channel released');
      send('inventory', { items: [{ kind: 4, canBus: 1, motorId: 6, rxId: 770 }] });
      await until(() => evaluate('document.querySelector("[data-role=motor]").textContent.includes("DM4310")'), 'DM4310 inventory');
      await evaluate('document.querySelector("[data-role=motor]").value = "0"; document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"))');
      assert.doesNotMatch(await text('[data-role=targetHelp]'), /10 rad\/s²/, 'older firmware has no ramp claim');
      fwVersion = '1.16'; pulse();
      await evaluate('document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"))');
      await until(async () => /10 rad\/s²/.test(await text('[data-role=targetHelp]')), 'DM4310 ramp hint');
      assert.match(await text('[data-role=targetHelp]'), /最终目标.*归零.*平滑减速.*停机.*立即/);
      fwVersion = '1.17'; pulse();
      await until(async () => /100 rad\/s².*200 rad\/s²/.test(await text('[data-role=targetHelp]')), 'fast ramp and separate zero braking hint');
      await click('[data-role=bind]'); telemetry(true, false);
      await until(() => evaluate('!document.querySelector("[data-role=num]").disabled'), 'DM4310 ready');
      assert.match(await text('[data-role=targetHelp]'), /20\.94.*200 rpm/);
      for (const role of ['slider', 'num']) {
        assert.equal(await evaluate(`document.querySelector('[data-role=${role}]').min`), '-20.94');
        assert.equal(await evaluate(`document.querySelector('[data-role=${role}]').max`), '20.94');
      }
      assert.equal(await text('[data-role=zero]'), '快速归零');
      assert.equal(await evaluate('document.querySelector("[data-role=zero]").classList.contains("quick-zero")'), true);
      for (const [input, expected] of [[30, 20.94], [-30, -20.94], [12.5, 12.5]]) {
        const count = commands.length;
        await evaluate(`document.querySelector('[data-role=num]').value = '${input}'; document.querySelector('[data-role=num]').dispatchEvent(new Event('change'))`);
        await until(() => commands.slice(count).some(c => c.type === 'setRef'), 'DM4310 clamped manual target');
        assert.equal(commands.filter(c => c.type === 'setRef').at(-1).ref, expected);
      }
      await evaluate('document.querySelector("[data-role=num]").value = "30"');
      const beforeEnable4310 = commands.length;
      await click('[data-role=enable]');
      await until(() => commands.slice(beforeEnable4310).some(c => c.type === 'enable'), 'DM4310 enable target');
      assert.equal(commands.filter(c => c.type === 'enable').at(-1).ref, 20.94);
      telemetry(true, true);
      await until(() => evaluate('document.querySelector("[data-role=enable]").classList.contains("on")'), 'DM4310 enabled');
      const beforeZero = commands.length;
      await click('[data-role=zero]');
      await until(() => commands.slice(beforeZero).some(c => c.type === 'setRef'), 'quick zero target');
      assert.equal(commands.filter(c => c.type === 'setRef').at(-1).ref, 0);
      assert.equal(commands.slice(beforeZero).some(c => c.type === 'enable' || c.type === 'stopAll'), false, 'quick zero preserves enable');
      await evaluate('document.querySelector("[data-role=presetAmplitude]").value = "21"');
      await click('[data-role=presetStart]');
      assert.match(await text('[data-role=presetStatus]'), /20\.94/);
      for (const width of [390, 320]) {
        win.setContentSize(width, 950); await delay(100);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `quick zero fits ${width}px`);
      }
      win.setContentSize(1440, 1000);
      await evaluate('document.querySelector("[data-role=zero]").scrollIntoView({block:"center"})');
      await screenshot('dm4310-quick-zero');
      await click('[data-role=loopAngle]');
      await until(() => commands.some(c => c.type === 'setLoop' && c.mask === 7), 'DM4310 position requested');
      send('loopAck', { channelId: 0, mask: 7, result: 0 });
      await until(() => evaluate('document.querySelector("[data-role=unit]").textContent === "deg"'), 'DM4310 position ready');
      assert.equal(await text('[data-role=zero]'), '归零');
      assert.equal(await evaluate('document.querySelector("[data-role=zero]").classList.contains("quick-zero")'), false);
      await evaluate('document.querySelector("[data-role=loopAngle]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))');
      assert.equal(await evaluate('document.querySelector("[data-role=pMaxOut]").max'), '20.94');
      assert.match(await text('[data-role=pidOutputHelp]'), /目标位置使用 deg.*20\.94/);
      await click('[data-role=loopAngle]');
      await until(() => commands.filter(c => c.type === 'setLoop').at(-1)?.mask === 3, 'DM4310 return to speed requested');
      send('loopAck', { channelId: 0, mask: 3, result: 0 });
      await until(() => evaluate('document.querySelector("[data-role=unit]").textContent === "rad/s"'), 'DM4310 return to speed');
      await click('[data-role=unbind]');
      send('unbindAck', { channelId: 0, result: 0 });
      await until(() => evaluate('!document.querySelector("[data-role=motor]").disabled'), 'DM4310 channel released');
      fwVersion = '1.18'; pulse();
      for (const kind of [1, 2, 3, 5, 6]) {
        send('inventory', { items: [{ kind, canBus: 1, motorId: 1, rxId: kind === 6 ? 34 : 0 }] });
        await delay(40);
        await evaluate('document.querySelector("[data-role=motor]").value = "0"; document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"))');
        await click('[data-role=bind]'); telemetry(true, false);
        await until(() => evaluate('!document.querySelector("[data-role=num]").disabled'), `kind ${kind} ready`);
        assert.equal(await text('[data-role=zero]'), '快速归零');
        assert.equal(await evaluate('document.querySelector("[data-role=zero]").classList.contains("quick-zero")'), true);
        fwVersion = '1.15'; boardFlags = 0x1e; pulse();
        await delay(40);
        assert.equal(await text('[data-role=zero]'), '快速归零', 'explicit capability works independently of the board version');
        boardFlags = 0x0e; pulse();
        await until(async () => (await text('[data-role=zero]')) === '归零', 'same-version capability loss updates the button');
        fwVersion = '1.23'; boardFlags = 0x0e; pulse();
        await delay(40);
        assert.equal(await text('[data-role=zero]'), '归零', 'new versions require the capability instead of guessing from a version number');
        boardFlags = 0x1e; pulse();
        await until(async () => (await text('[data-role=zero]')) === '快速归零', 'synchronized A/C firmware restores fast zero');
        assert.match(await text('[data-role=targetHelp]'), kind <= 3 ? /30000 rpm\/s.*60000 rpm\/s/ : /100 rad\/s².*200 rad\/s²/);
        const enableStart = commands.length;
        await click('[data-role=enable]');
        await until(() => commands.slice(enableStart).some(c => c.type === 'enable' && c.enable), `kind ${kind} enable request delivered`);
        telemetry(true, true);
        await until(() => evaluate('document.querySelector("[data-role=enable]").classList.contains("on")'), `kind ${kind} enabled`);
        const zeroStart = commands.length;
        await click('[data-role=zero]');
        await until(() => commands.slice(zeroStart).some(c => c.type === 'setRef'), `kind ${kind} zero sent`);
        assert.deepEqual(commands.slice(zeroStart).filter(c => ['setRef', 'enable', 'stopAll'].includes(c.type)), [{type:'setRef',channelId:0,ref:0}]);
        if (kind <= 3) {
          await click('[data-role=loopSpeed]');
          await until(() => commands.filter(c => c.type === 'setLoop').at(-1)?.mask === 1, `kind ${kind} current mode`);
          send('loopAck', {channelId:0,mask:1,result:0});
          await until(async () => (await text('[data-role=zero]')) === '归零', 'current mode uses ordinary zero');
          assert.doesNotMatch(await text('[data-role=targetHelp]'), /快速制动/);
          await click('[data-role=loopSpeed]');
          await until(() => commands.filter(c => c.type === 'setLoop').at(-1)?.mask === 3, 'speed mode requested');
          send('loopAck', {channelId:0,mask:3,result:0});
          await until(async () => (await text('[data-role=zero]')) === '快速归零', 'speed mode uses fast zero');
        }
        await click('[data-role=unbind]');send('unbindAck',{channelId:0,result:0});
        await until(() => evaluate('!document.querySelector("[data-role=motor]").disabled'), `kind ${kind} released`);
      }
      send('inventory', { items: [{ kind: 7, canBus: 1, motorId: 1, rxId: 0 }] });
      await until(() => evaluate('document.querySelector("[data-role=motor]").textContent.includes("DM8009P")'), 'DM8009P inventory');
      await evaluate('document.querySelector("[data-role=motor]").value = "0"; document.querySelector("[data-role=motor]").dispatchEvent(new Event("change"))');
      await click('[data-role=bind]');
      telemetry(true, false);
      await until(() => evaluate('!document.querySelector("[data-role=num]").disabled'), 'DM8009P ready');
      for (const role of ['slider', 'num']) {
        assert.equal(await evaluate(`document.querySelector('[data-role=${role}]').min`), '-17.6');
        assert.equal(await evaluate(`document.querySelector('[data-role=${role}]').max`), '17.6');
      }
      assert.match(await text('[data-role=targetHelp]'), /24 V.*17\.6.*168 rpm/);
      assert.equal(await text('[data-role=zero]'), '快速归零');
      assert.match(await text('[data-role=targetHelp]'), /100 rad\/s².*200 rad\/s²/);
      await evaluate('document.querySelector("[data-role=zero]").scrollIntoView({block:"center"})');
      await screenshot('dm8009p-quick-zero');

      for (const [input, expected] of [[26.3, 17.6], [-26.3, -17.6], [12.5, 12.5]]) {
        const count = commands.length;
        await evaluate(`document.querySelector('[data-role=num]').value = '${input}'; document.querySelector('[data-role=num]').dispatchEvent(new Event('change'))`);
        await until(() => commands.slice(count).some(c => c.type === 'setRef'), 'manual speed target');
        assert.equal(commands.filter(c => c.type === 'setRef').at(-1).ref, expected);
        assert.equal(await evaluate('Number(document.querySelector("[data-role=num]").value)'), expected);
      }
      await evaluate('document.querySelector("[data-role=num]").value = "30"');
      const enableCount = commands.filter(c => c.type === 'enable').length;
      await click('[data-role=enable]');
      await until(() => commands.filter(c => c.type === 'enable').length > enableCount, 'enable with clamped target');
      assert.equal(commands.filter(c => c.type === 'enable').at(-1).ref, 17.6);
      telemetry(true, true);
      await until(() => evaluate('!document.querySelector("[data-role=presetStart]").disabled'), 'automatic output available');
      await evaluate('document.querySelector("[data-role=presetAmplitude]").value = "18"');
      const beforePreset = commands.filter(c => c.type === 'setRef').length;
      await click('[data-role=presetStart]');
      assert.match(await text('[data-role=presetStatus]'), /17\.6/);
      assert.equal(commands.filter(c => c.type === 'setRef').length, beforePreset, 'out-of-range preset sends no target');

      await click('[data-role=loopAngle]');
      await until(() => commands.some(c => c.type === 'setLoop' && c.mask === 7), 'position cascade requested');
      send('loopAck', { channelId: 0, mask: 7, result: 0 });
      await until(() => evaluate('!document.querySelector("[data-role=num]").disabled && document.querySelector("[data-role=unit]").textContent === "deg"'), 'position cascade confirmed');
      await evaluate('document.querySelector("[data-role=loopAngle]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))');
      assert.match(await text('[data-role=pidTitle]'), /位置环/);
      assert.equal(await evaluate('document.querySelector("[data-role=pMaxOut]").max'), '17.6');
      assert.match(await text('[data-role=pidOutputHelp]'), /目标速度（rad\/s）.*目标位置使用 deg.*17\.6/);
      const angleCount = commands.filter(c => c.type === 'setRef').length;
      await evaluate('document.querySelector("[data-role=num]").value = "180"; document.querySelector("[data-role=num]").dispatchEvent(new Event("change"))');
      await until(() => commands.filter(c => c.type === 'setRef').length > angleCount, 'position target sent');
      assert.equal(commands.filter(c => c.type === 'setRef').at(-1).ref, 180, 'position target is an angle, not a capped speed');
      await evaluate('document.querySelector("[data-role=pMaxOut]").value = "100"');
      const pidCount = commands.filter(c => c.type === 'pidSet').length;
      await click('[data-role=pidApply]');
      assert.match(await text('[data-role=pidMsg]'), /0～17\.6 rad\/s（24 V.*未下发/);
      assert.equal(commands.filter(c => c.type === 'pidSet').length, pidCount);
      await evaluate('document.querySelector("[data-role=pMaxOut]").value = "17.6"');
      await click('[data-role=pidApply]');
      await until(() => commands.filter(c => c.type === 'pidSet').length > pidCount, 'valid position PID sent');
      assert.equal(commands.filter(c => c.type === 'pidSet').at(-1).pid.MaxOut, 17.6);
      send('pidAck', { channelId: 0, loop: 2, result: 0 });

      assert.equal(await text('[data-role=zero]'), '归零');
      clearInterval(heartbeat);
      await until(() => evaluate('document.querySelector("#boardState").textContent.includes("等待应答")'), 'board timeout');
      assert.equal(await evaluate('document.querySelector("[data-role=enable]").disabled'), true);
      assert.match(await text('[data-role=channelHint]'), /供电、USB 数据线和固件/);

      socket.close();
      await until(() => evaluate('document.querySelector("#serviceState").textContent.includes("已断开")'), 'service disconnected');
      assert.equal(await text('#guideAction'), '重新加载');
      assert.equal(await evaluate('document.querySelector("#addMotor").disabled'), true);
      assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
      console.log('PASS guidance: acknowledged steps, empty state entry, ID help, binding wait, offline recovery, manual enable, board/service loss, 1440/860/390/320px layouts.');
    } catch (error) {
      console.error(error);
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      win?.destroy();
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
