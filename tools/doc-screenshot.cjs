// Generate README images in ../docs/images/:
//   architecture.png  — rasterize architecture.svg at 2x
//   ui-annotated.png  — real UI driven by a simulated board, annotated ①–④
// Never opens a serial port; mirror of guidance_test.cjs harness.
const path = require('node:path');
const { spawn } = require('node:child_process');
const hostDir = path.join(__dirname, '..', 'motor_bench_host');
const hostRequire = require('node:module').createRequire(path.join(hostDir, 'package.json'));

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(hostRequire('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow } = hostRequire('electron');
  const fs = require('node:fs');
  const http = require('node:http');
  const vm = require('node:vm');
  const { WebSocketServer } = hostRequire('ws');
  const ASSETS = path.join(__dirname, '..', 'docs', 'images');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const timeout = setTimeout(() => { console.error('doc-screenshot timed out'); app.exit(1); }, 120000);
    try {
      // One phase per process: an offscreen window that already rendered the SVG
      // leaves the shared session unable to load the next http:// URL.
      if (process.argv.includes('--ui')) await renderUi();
      else await renderSvg();
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });

  async function renderSvg() {
    // Inline the SVG and force it to fill the viewport: capture pixels track the
    // window's logical size while the page rasterizes at the system DPI, so a
    // plain loadFile renders larger than the viewport and gets cropped.
    // Usage: node tools/doc-screenshot.cjs [--svg=<basename>] [--w=<px>] [--h=<px>]
    const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split('=')[1];
    const name = arg('svg', 'architecture');
    const W = Number(arg('w', 1560)), H = Number(arg('h', 850));
    const render = path.join(ASSETS, `.${name}-render.html`);
    fs.writeFileSync(render, `<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden;background:#fbfbfa">` +
      fs.readFileSync(path.join(ASSETS, `${name}.svg`), 'utf8').replace('<svg ',
        '<svg style="display:block;width:100vw;height:100vh" preserveAspectRatio="xMidYMid meet" '));
    const win = new BrowserWindow({
      width: W, height: H, useContentSize: true, show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await win.loadFile(render);
    await delay(700);
    win.webContents.invalidate();
    await delay(200);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ASSETS, `${name}.png`), image.toPNG());
    console.log(`${name}.png`, JSON.stringify(image.getSize()));
    win.destroy();
    fs.rmSync(render, { force: true });
  }

  async function renderUi() {
    const source = fs.readFileSync(path.join(hostDir, 'server.js'), 'utf8');
    const context = { http, fs, path, __dirname: hostDir };
    vm.runInNewContext(source.slice(source.indexOf('const MIME = {'),
      source.indexOf('/* ---------------- WebSocket')) + ' globalThis.staticServer = server;', context);
    const server = context.staticServer;
    const wss = new WebSocketServer({ server });

    const FW = '1.22';
    // GM6020 / M3508 / M2006 on CAN1, DM4310 (RX 0x302) on CAN2 — a typical bench.
    const motors = [
      { kind: 1, canBus: 1, motorId: 1, rxId: 0 },
      { kind: 2, canBus: 1, motorId: 2, rxId: 0 },
      { kind: 3, canBus: 1, motorId: 3, rxId: 0 },
      { kind: 4, canBus: 2, motorId: 6, rxId: 770 },
    ];
    const targets = [800, 2000, 3000, 8]; // rpm · rpm · rpm · rad/s
    let socket;
    let allEnabled = false;
    const send = (type, data) => socket.send(JSON.stringify({ type, data }));
    const pulse = () => send('heartbeat', { fwVersion: FW, uptimeS: 360, inventoryCount: motors.length });

    wss.on('connection', ws => {
      socket = ws;
      // Transport-level frames (hello/serial/ports) are flat; board data
      // (heartbeat/inventory/telemetry/acks) carries a `data` wrapper —
      // same shapes the real server.js and guidance_test.cjs use.
      ws.send(JSON.stringify({ type: 'hello', capabilities: ['resetChannels', 'setLoop'] }));
      ws.send(JSON.stringify({ type: 'serial', open: false }));
      ws.on('message', raw => {
        const command = JSON.parse(raw);
        if (command.type === 'listPorts') ws.send(JSON.stringify({ type: 'ports', ports: [{ path: 'COM17', manufacturer: 'Motor Bench CDC' }] }));
        if (command.type === 'unbind') send('unbindAck', { channelId: command.channelId, result: 0 });
        if (command.type === 'setLoop') send('loopAck', { channelId: command.channelId, mask: command.mask, result: 0 });
      });
    });

    const win = new BrowserWindow({
      width: 1680, height: 1080, useContentSize: true, show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true },
    });
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    async function until(check, label) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await delay(30);
      }
      let diag = '';
      try {
        diag = await evaluate(`JSON.stringify({
          msg: document.querySelector('#connectionMessage')?.textContent,
          err: document.querySelector('#connectionError')?.textContent,
          channels: document.querySelectorAll('.channel').length,
          registry: document.querySelector('#registryCount')?.textContent,
          link: document.querySelector('#linkText')?.textContent,
          feedback: document.querySelector('#feedbackState')?.textContent,
          hints: [...document.querySelectorAll('[data-role=channelHint]')].map(e => e.textContent.slice(0, 40)),
        })`);
      } catch { /* window may be gone */ }
      throw new Error(`Timed out: ${label} — ${diag}`);
    }

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    await until(() => evaluate('!!document.querySelector("#openPort")'), 'ui ready');
    await delay(300);
    await until(() => evaluate('!document.querySelector("#openPort").disabled'), 'port listed');
    await click('#openPort');
    socket.send(JSON.stringify({ type: 'serial', open: true, path: 'COM17' }));
    await delay(200);
    send('inventory', { items: motors });
    await until(() => evaluate('document.querySelectorAll(".channel").length === 4'), '4 channels from inventory');
    let heartbeat = setInterval(pulse, 300);

    // The UI clears channels 0–7 (unbind → ack each) after the serial opens;
    // binds issued before that chain finishes are silently dropped.
    await until(() => evaluate('document.querySelector("#connectionMessage").textContent.includes("清单已就绪")'), 'channel reset done');
    for (let i = 0; i < 4; i++) {
      await evaluate(`(() => {
        const card = document.querySelectorAll('.channel')[${i}];
        const select = card.querySelector('[data-role=motor]');
        select.value = '${i}';
        select.dispatchEvent(new Event('change'));
        card.querySelector('[data-role=bind]').click();
        return true;
      })()`);
      await delay(150);
    }
    // Telemetry must flow before waiting for the online state — the UI derives
    // "N/N 在线" from received telemetry, not from the bind alone.
    let telemetryTimer = setInterval(() => {
      const t = Date.now() / 1000;
      const items = motors.map((motor, i) => {
        const base = targets[i];
        const speed = i === 3
          ? +(base + Math.sin(t * 1.3 + i) * 1.6).toFixed(2)
          : Math.round(base + Math.sin(t * (1.1 + i * 0.3) + i * 2) * base * 0.16);
        return {
          channelId: i, online: true, enabled: allEnabled, ref: base, speed,
          torque: i < 3 ? Math.round(400 + 260 * Math.sin(t * 0.9 + i)) : +(1.2 + 0.35 * Math.sin(t * 1.3)).toFixed(2),
          angle: Math.round((t * 60 + i * 90) % 3600) / 10,
          temperature: 27 + i,
        };
      });
      send('telemetry', { items });
    }, 60);

    await until(() => evaluate('document.querySelector("#feedbackState").textContent.includes("4/4 在线")'), 'all motors online');

    await until(() => evaluate(`[...document.querySelectorAll('.channel [data-role=enable]')].every(b => !b.disabled)`), 'all bindable+online');
    for (let i = 0; i < 4; i++) {
      await evaluate(`document.querySelectorAll('.channel')[${i}].querySelector('[data-role=enable]').click()`);
      await delay(120);
    }
    allEnabled = true;
    await until(() => evaluate(`[...document.querySelectorAll('.channel [data-role=enable]')].every(b => b.classList.contains('on'))`), 'all enabled');

    for (let i = 0; i < 4; i++) {
      await evaluate(`(() => {
        const num = document.querySelectorAll('.channel')[${i}].querySelector('[data-role=num]');
        num.value = '${targets[i]}';
        num.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await delay(120);
    }

    await delay(6000); // let the curves accumulate history

    const pageHeight = await evaluate('document.documentElement.scrollHeight');
    win.setContentSize(1680, Math.min(Math.ceil(pageHeight) + 10, 5400));
    await evaluate('window.scrollTo(0, 0)');
    await delay(400);
    const tagged = await evaluate(`(() => {
      const spots = [
        { sel: '#setup .setup-group', label: '① 连接控制板', pos: 'above' },
        { sel: '#openAddMotor', label: '② ＋ 添加电机', pos: 'above-right' },
        { sel: '.channel', label: '③ 电机通道卡片', pos: 'above' },
        { sel: '#estop', label: '④ 全部急停', pos: 'left' },
      ];
      const style = document.createElement('style');
      style.textContent =
        '.doc-box{position:absolute;z-index:9999;pointer-events:none;border:2.5px solid #ffd166;border-radius:10px;box-shadow:0 0 0 4px rgba(255,209,102,.22)}' +
        '.doc-tag{position:absolute;z-index:10000;pointer-events:none;background:#ffd166;color:#241c07;font:700 15px/1.7 Consolas,monospace;padding:2px 14px;border-radius:999px;white-space:nowrap}';
      document.body.appendChild(style);
      for (const { sel, label, pos } of spots) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const left = r.left + window.scrollX, top = r.top + window.scrollY;
        const box = document.createElement('div');
        box.className = 'doc-box';
        Object.assign(box.style, {
          left: left - 7 + 'px', top: top - 7 + 'px',
          width: r.width + 14 + 'px', height: r.height + 14 + 'px',
        });
        document.body.appendChild(box);
        const tag = document.createElement('div');
        tag.className = 'doc-tag';
        tag.textContent = label;
        document.body.appendChild(tag);
        const tw = tag.offsetWidth, th = tag.offsetHeight;
        if (pos === 'left') {
          tag.style.left = left - tw - 18 + 'px';
          tag.style.top = top + r.height / 2 - th / 2 + 'px';
        } else if (pos === 'above-right') {
          tag.style.left = left + r.width - tw + 'px';
          tag.style.top = Math.max(2, top - th - 12) + 'px';
        } else {
          tag.style.left = left + 'px';
          tag.style.top = Math.max(2, top - th - 12) + 'px';
        }
      }
      return document.querySelectorAll('.doc-box').length;
    })()`);
    if (tagged !== 4) throw new Error(`expected 4 callouts, got ${tagged}`);
    await delay(250);
    win.webContents.invalidate();
    await delay(200);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ASSETS, 'ui-annotated.png'), image.toPNG());
    console.log('ui-annotated.png', JSON.stringify(image.getSize()));

    clearInterval(heartbeat);
    clearInterval(telemetryTimer);
    win.destroy();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
