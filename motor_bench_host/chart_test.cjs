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
      .chart-box { height: 300px; } .chart-viewport { height: 250px; }</style></head>
      <body><div class="channel"><div class="chart-box"><div class="chart-viewport"><canvas data-role="chart"></canvas></div></div></div>
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
    // Use the production template and CSS: a fixed-height fixture hides grid/flex sizing loops.
    const channelTemplate = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      .match(/<template id="channelTpl">([\s\S]*?)<\/template>/)[1];
    const layoutFixture = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head>
      <body><main class="channels"></main><template>${channelTemplate}</template>
      <script type="module">
        import { MotorChart } from '/chart.js';
        window.layoutCharts = [];
        window.resetLayout = (count = 1) => {
          layoutCharts.forEach(chart => chart.destroy());
          document.querySelector('.channels').replaceChildren();
          for (let i = 0; i < count; i++) {
            document.querySelector('.channels').append(document.querySelector('template').content.cloneNode(true));
          }
          window.layoutCharts = [...document.querySelectorAll('canvas')].map(canvas => new MotorChart(canvas));
        };
        window.sampleLayout = async () => {
          const samples = [];
          for (let frame = 0; frame < 24; frame++) {
            layoutCharts.forEach(chart => chart.push(Math.sin(frame) * 20, Math.cos(frame) * 2, 30));
            await new Promise(requestAnimationFrame);
            samples.push({
              pageHeight: document.documentElement.scrollHeight,
              heights: [...document.querySelectorAll('.channel, .bind-row, .control, .chart-box, canvas')]
                .map(element => element.getBoundingClientRect().height),
            });
          }
          return samples;
        };
        resetLayout();
      </script></body></html>`;
    const server = http.createServer((req, res) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); }
      else if (req.url === '/layout') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(layoutFixture); }
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

      win.setContentSize(1440, 1000);
      await win.loadURL(`http://127.0.0.1:${server.address().port}/layout`);
      async function assertStableLayout(label) {
        const samples = await evaluate('sampleLayout()');
        const initial = samples[3]; // Allow the first layout and ResizeObserver notifications to settle.
        for (const sample of samples.slice(4)) {
          assert.ok(sample.heights.every((height, i) => Math.abs(height - initial.heights[i]) <= 1),
            `${label}: chart and adjacent controls must not grow during streaming: ${JSON.stringify({ initial, sample })}`);
          assert.ok(Math.abs(sample.pageHeight - initial.pageHeight) <= 1, `${label}: page height stays stable`);
        }
        assert.equal(await evaluate(`layoutCharts.every(chart =>
          chart.canvas.height === Math.round(chart.canvas.getBoundingClientRect().height * devicePixelRatio)
          && chart.canvas.width === Math.round(chart.canvas.getBoundingClientRect().width * devicePixelRatio))`),
          true, `${label}: backing pixels still match the CSS size and device scale`);
      }
      for (const dpr of [1, 1.25, 2]) {
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: 1440, height: 1000, deviceScaleFactor: dpr, mobile: false,
        });
        await evaluate('resetLayout()');
        await assertStableLayout(`single channel, DPR ${dpr}`);
      }
      await screenshot('chart-layout-desktop');
      const collapsedHeight = await evaluate('document.querySelector("canvas").getBoundingClientRect().height');
      await evaluate('document.querySelector(".loop-card details").open = true');
      await assertStableLayout('expanded PID help');
      const expandedHeight = await evaluate('document.querySelector("canvas").getBoundingClientRect().height');
      assert.ok(expandedHeight > collapsedHeight, 'chart still stretches to fit taller adjacent controls');
      await evaluate('document.querySelector(".loop-card details").open = false');
      await assertStableLayout('collapsed PID help');
      const restoredHeight = await evaluate('document.querySelector("canvas").getBoundingClientRect().height');
      assert.ok(Math.abs(restoredHeight - collapsedHeight) <= 1,
        `chart can shrink back after controls collapse: ${JSON.stringify({ collapsedHeight, expandedHeight, restoredHeight })}`);
      await evaluate('resetLayout(2)');
      await assertStableLayout('two channels');
      for (const width of [860, 390]) {
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width, height: 1000, deviceScaleFactor: 2, mobile: false,
        });
        await evaluate('resetLayout()');
        await assertStableLayout(`single channel, ${width}px`);
      }
      assert.deepEqual(exceptions, []);
      console.log('PASS chart: interpolated intersections, orange guide, filtering, live updates, units, empty ranges, clear/leave/destroy, high DPI, stable production grid/flex layouts, expand/collapse and narrow layouts.');
    } finally {
      clearTimeout(timeout);
      win?.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
