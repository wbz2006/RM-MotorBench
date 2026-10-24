// Exercise canvas rendering and pointer readouts in Chromium, without a board or serial bridge.
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
  const profile = path.join(app.getPath('temp'), 'motorbench-chart-test');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const timeout = setTimeout(() => { console.error('Chart browser test timed out'); app.exit(1); }, 20000);
    const fixture = `<!doctype html><html><head><link rel="stylesheet" href="/style.css">
      <style>body { padding: 12px; } .channel { display: block; padding: 12px; }
      .chart-box { height: 300px; } .channel canvas[data-role=chart] { height: 250px; }</style></head>
      <body><div class="channel"><div class="chart-box"><canvas data-role="chart"></canvas></div></div>
      <script type="module">
        import { MotorChart } from '/chart.js';
        window.chart = new MotorChart(document.querySelector('canvas'));
        window.seed = (count = 10) => {
          chart.clear(); chart.setWindow(10); chart.setFilter(false);
          for (let i = 0; i < count; i++) chart.push(i * 20, i * 0.2, 120);
          chart.draw();
        };
        window.move = async (index, y = 90) => {
          const rect = chart.canvas.getBoundingClientRect();
          chart.canvas.dispatchEvent(new PointerEvent('pointermove', {
            clientX: rect.left + 44 + (chart.cssW - 88) * index / (chart.window - 1),
            clientY: rect.top + y,
          }));
          await new Promise(requestAnimationFrame);
        };
        window.orangeAt = index => {
          const x = (44 + (chart.cssW - 88) * index / (chart.window - 1)) * chart.dpr;
          const pixels = chart.ctx.getImageData(Math.floor(x) - 1, Math.round(13 * chart.dpr), 3, 1).data;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 245 && pixels[i + 1] > 145 && pixels[i + 1] < 175
                && pixels[i + 2] < 85 && pixels[i + 3] > 80) return true;
          }
          return false;
        };
        seed();
      </script></body></html>`;
    const server = http.createServer((req, res) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); }
      else if (req.url === '/chart.js' || req.url === '/style.css') {
        res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        res.end(fs.readFileSync(path.join(__dirname, req.url.slice(1))));
      } else { res.writeHead(404); res.end(); }
    });
    let win;
    const exceptions = [];
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function screenshot(name) {
      if (!process.env.MOTORBENCH_CHART_SCREENSHOTS) return;
      fs.mkdirSync(process.env.MOTORBENCH_CHART_SCREENSHOTS, { recursive: true });
      win.webContents.invalidate();
      await delay(100);
      fs.writeFileSync(path.join(process.env.MOTORBENCH_CHART_SCREENSHOTS, name + '.png'),
        (await win.webContents.capturePage()).toPNG());
    }
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      win = new BrowserWindow({ width: 820, height: 420, show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.on('message', (_, method, params) => {
        if (method === 'Runtime.exceptionThrown') exceptions.push(params);
      });
      await win.loadURL(`http://127.0.0.1:${server.address().port}`);
      await win.webContents.debugger.sendCommand('Runtime.enable');
      await delay(100); // Let ResizeObserver settle before hovering.
      assert.equal(await evaluate('chart.tooltip.hidden'), true);
      await evaluate('move(2.5)');
      assert.equal(await evaluate('chart.tooltip.hidden'), false);
      assert.equal(await evaluate('chart.tooltip.textContent'), '实测转速  50 rpm\n反馈  0.5 raw\n设定值  120 rpm');
      assert.equal(await evaluate('orangeAt(2.5)'), true, 'an orange vertical line is actually rendered');
      await screenshot('chart-cursor-desktop');
      await evaluate('move(6.5)');
      assert.equal(await evaluate('orangeAt(6.5) && !orangeAt(2.5)'), true, 'line moves and the previous line is cleared');
      assert.match(await evaluate('chart.tooltip.textContent'), /130 rpm/);
      await evaluate('chart.setUnits("deg", "N·m")');
      assert.equal(await evaluate('chart.tooltip.textContent'), '实测位置  130 deg\n反馈  1.3 N·m\n设定值  120 deg');

      await evaluate('chart.clear(); chart.setFilter(true); chart.setFilterAlpha(0.5); chart.push(0, 0, 100); chart.push(100, 2, 100); move(0.5)');
      assert.equal(await evaluate('chart.tooltip.textContent'), '实测位置  25 deg\n反馈  0.5 N·m\n设定值  100 deg', 'readout follows the displayed filtered line');
      await evaluate('chart.clear()');
      assert.equal(await evaluate('chart.tooltip.hidden'), true, 'clear removes stale readouts');
      await evaluate('seed(3); move(4)');
      assert.equal(await evaluate('chart.tooltip.hidden && orangeAt(4)'), true, 'blank part of a partial window has a guide but no invented values');
      for (const index of [0, 2]) {
        await evaluate(`move(${index})`);
        assert.equal(await evaluate('chart.tooltip.hidden'), false, 'endpoints remain readable');
      }
      await evaluate('move(-0.5)');
      assert.equal(await evaluate('chart.tooltip.hidden'), true, 'axis margin is outside the plot');
      await evaluate('move(1, 0)');
      assert.equal(await evaluate('chart.tooltip.hidden'), true, 'top margin is outside the plot');
      await evaluate('move(1); chart.canvas.dispatchEvent(new PointerEvent("pointerleave")); new Promise(requestAnimationFrame)');
      assert.equal(await evaluate('chart.tooltip.hidden && !orangeAt(1)'), true, 'leaving removes both the line and the readout');
      await evaluate('seed(); move(2.5); chart.push(200, 2, 120); new Promise(requestAnimationFrame)');
      assert.match(await evaluate('chart.tooltip.textContent'), /70 deg/, 'live scrolling updates the readout under a stationary pointer');

      win.webContents.setZoomFactor(2);
      await delay(150);
      await evaluate('seed(); move(2.5)');
      assert.equal(await evaluate('orangeAt(2.5)'), true, 'guide uses CSS coordinates on a high DPI canvas');
      assert.match(await evaluate('chart.tooltip.textContent'), /50 deg/);
      win.webContents.setZoomFactor(1);
      win.setContentSize(320, 420);
      await delay(150);
      await evaluate('seed(); move(8.8)');
      assert.equal(await evaluate(`(() => {
        const tip = chart.tooltip.getBoundingClientRect(), canvas = chart.canvas.getBoundingClientRect();
        return !chart.tooltip.hidden && tip.left >= canvas.left && tip.right <= canvas.right + 1;
      })()`), true, 'readout stays inside a narrow canvas at the right edge');
      await screenshot('chart-cursor-mobile');
      // Long windows are rendered from averaged buckets; read their actual segments.
      await evaluate('chart.clear(); chart.setWindow(300); for (let i = 0; i < 300; i++) chart.push(i % 2 ? 100 : 0, 0, 100); move(10.5)');
      assert.match(await evaluate('chart.tooltip.textContent'), /50 deg/, 'readout matches bucketed curves rather than the unsmoothed samples');
      await evaluate('chart.destroy(); chart.canvas.dispatchEvent(new PointerEvent("pointermove"))');
      assert.equal(await evaluate('document.querySelectorAll(".chart-tooltip").length'), 0, 'destroy removes tooltip and pointer handlers');
      assert.deepEqual(exceptions, []);
      console.log('PASS chart: interpolated intersections, orange guide, filtering, live updates, units, empty ranges, clear/leave/destroy, high DPI and narrow layouts.');
    } finally {
      clearTimeout(timeout);
      win?.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
