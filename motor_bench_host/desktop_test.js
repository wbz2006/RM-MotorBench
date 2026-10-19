// Exercise the actual portable EXE without opening a serial port or driving motors.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const artifact = `MotorBench-${version}-Windows-x64.exe`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), '电机测试台 发布验证-'));
const executable = path.join(temp, artifact);
let child;
let cdp;
let exited = false;
let output = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`${description}超时\n${output}`);
}

try {
  await fs.writeFile(executable, await fs.readFile(path.join(root, 'dist', artifact)));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const debugPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32') };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temp, 'profile')}`], {
    cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('error', error => { output += error.stack; });
  child.on('exit', () => { exited = true; });

  const page = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
    } catch { return false; }
  }, '桌面窗口启动');
  cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  cdp.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(key, { resolve, reject, timer });
      cdp.send(JSON.stringify({ id: key, method, params }));
    });
  }
  await command('Runtime.enable');
  await command('Page.enable');
  await until(async () => {
    const result = await command('Runtime.evaluate', { expression: 'document.readyState === "complete" && !!document.querySelector("#refreshPorts")', returnByValue: true });
    return result.result.value;
  }, '界面加载');

  const checked = await command('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const assets = ['index.html', 'ui.js', 'style.css', 'protocol.js', 'chart.js', 'fishbone.js', 'setpoint.js', 'calculator.js', 'calculator-ui.js'];
      for (const asset of assets) {
        const response = await fetch('/' + asset);
        if (!response.ok || !(await response.text()).length) throw new Error('Missing asset: ' + asset);
      }
      const ports = await new Promise((resolve, reject) => {
        const ws = new WebSocket(location.origin.replace('http:', 'ws:'));
        const timer = setTimeout(() => { ws.close(); reject(new Error('Native serial enumeration timed out')); }, 8000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'listPorts' }));
        ws.onmessage = event => {
          const message = JSON.parse(event.data);
          if (message.type === 'ports' || message.type === 'error') {
            clearTimeout(timer); ws.close();
            if (message.type === 'error') reject(new Error(message.message));
            else resolve(message.ports);
          }
        };
        ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new Error('WebSocket failed')); };
      });
      return { title: document.title, assets: assets.length, ports: ports.length, nodeExposed: typeof require !== 'undefined' || typeof process !== 'undefined' };
    })()`,
  });
  assert.equal(checked.exceptionDetails, undefined, JSON.stringify(checked.exceptionDetails));
  assert.equal(checked.result.value.nodeExposed, false);
  assert.deepEqual(exceptions, [], JSON.stringify(exceptions));
  const screenshot = await command('Page.captureScreenshot');
  await fs.writeFile(path.join(root, 'dist', 'desktop-smoke.png'), Buffer.from(screenshot.data, 'base64'));
  await command('Page.close');
  await until(() => exited, '关闭窗口退出');
  await until(async () => {
    try { await fetch(page.url, { signal: AbortSignal.timeout(1000) }); return false; }
    catch { return true; }
  }, '串口后台退出', 5000);
  console.log('PASS portable EXE: Chinese/spaced path, no Node on PATH, desktop UI, assets, native serial enumeration, sandbox and clean exit.');
  console.log(JSON.stringify(checked.result.value));
} finally {
  cdp?.close();
  if (child && !exited) {
    const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => kill.once('exit', resolve));
  }
  // Only remove this test's own mkdtemp directory.
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
