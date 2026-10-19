// Electron only owns the window; the existing serial bridge runs in a Node child.
const { app, BrowserWindow, dialog } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let window;
let backend;
let quitting = false;
let log;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!backend) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Let the bridge send ALL_STOP and close the port before ending its process.
    const fallback = setTimeout(() => backend?.kill(), 3000);
    fallback.unref();
    if (backend.connected) backend.send({ type: 'shutdown' });
    else backend.kill();
  });

  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('电机测试台启动失败', error.message);
    app.quit();
  });
}

async function start() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  log = fs.createWriteStream(path.join(app.getPath('userData'), 'desktop.log'), { flags: 'w' });
  log.on('error', () => {});
  const url = await new Promise((resolve, reject) => {
    // Port 0 selects a free local port, independent of the browser edition.
    backend = fork(path.join(__dirname, 'server.js'), ['--port', '0'], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    backend.stdout.pipe(log, { end: false });
    backend.stderr.pipe(log, { end: false });
    const timeout = setTimeout(() => reject(new Error('本地串口服务启动超时。')), 20000);
    backend.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    backend.once('exit', (code) => {
      clearTimeout(timeout);
      backend = null;
      if (quitting) app.exit(0);
      else {
        reject(new Error(`本地串口服务已退出（${code}）。`));
        if (window) {
          dialog.showErrorBox('串口服务已退出', '请重新启动电机测试台。日志位于：\n' + app.getPath('userData'));
          app.quit();
        }
      }
    });
    backend.once('message', (message) => {
      if (message?.type !== 'ready') return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${message.port}`);
    });
  });

  window = new BrowserWindow({
    title: '电机测试台',
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== url) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window.show());
  await window.loadURL(url);
}
