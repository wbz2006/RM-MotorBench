import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

test('static assets bypass cache and versioned root loads the current PID interface', async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf('const MIME = {');
  const end = source.indexOf('/* ---------------- WebSocket');
  assert.ok(start > 0 && end > start);
  const context = { http, fs, path, __dirname: root };
  // Run the real HTTP handler without the WebSocket/serial bridge or live board.
  vm.runInNewContext(source.slice(start, end) + ' globalThis.staticServer = server;', context);
  const server = context.staticServer;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [route, file] of [
      ['/', 'index.html'], ['/?v=20261019-dm4310-defaults', 'index.html'],
      ['/index.html?v=20261019-dm4310-defaults', 'index.html'],
      ['/ui.js?v=20261019-dm4310-defaults', 'ui.js'], ['/protocol.js', 'protocol.js'],
      ['/style.css?v=20261019-dm4310-defaults', 'style.css'],
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('cache-control'), 'no-store', route);
      assert.equal(await response.text(), fs.readFileSync(path.join(root, file), 'utf8'), route);
    }
    const html = await (await fetch(base + '/?v=20261019-dm4310-defaults')).text();
    assert.match(html, /UI 20261024-loader-control/);
    assert.match(html, /style\.css\?v=20261024-loader-control/);
    assert.match(html, /ui\.js\?v=20261024-loader-control/);
    assert.doesNotMatch(html, /pid-workflow-note|pidTuningHint|data-role="pidLoop"/);
    assert.match(html, /data-role="pidPanel" data-loop="0"/);
    assert.match(html, /pMaxOutUnit/);
    const ui = await (await fetch(base + '/ui.js?v=20261019-dm4310-defaults')).text();
    assert.match(ui, /stopForPidEdit/);
    assert.match(ui, /输出限幅须为/);
    const { MBResult, MBResultText } = await import('./protocol.js');
    assert.doesNotMatch(MBResultText[MBResult.BAD_PARAM], /总线|ID/);
    assert.doesNotMatch(MBResultText[MBResult.UNSUPPORTED], /尚未接入/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
