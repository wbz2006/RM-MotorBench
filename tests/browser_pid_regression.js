// Serve motor_bench_host on port 3001; run with playwright-cli run-code --filename this file.
// Only hardware I/O is replaced. Forms, browser storage, navigation and UI code are real.
async (page) => {
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.confirm = () => true;
    window.sentCommands = [];
    class TestSocket {
      constructor() {
        this.readyState = 1;
        window.testSocket = this;
        this.motors = [
          { kind: 2, canBus: 2, motorId: 1, outerLoop: 2 },
          { kind: 2, canBus: 2, motorId: 2, outerLoop: 2 },
          { kind: 2, canBus: 1, motorId: 1, outerLoop: 2 },
          { kind: 3, canBus: 2, motorId: 1, outerLoop: 2 },
        ];
        setTimeout(() => {
          this.onopen?.();
          this.emit({ type: 'inventory', data: { items: this.motors } });
        }, 0);
      }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
      send(text) { window.sentCommands.push(JSON.parse(text)); }
    }
    window.WebSocket = TestSocket;
    if (location.search.includes('storage=blocked')) {
      Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new DOMException('Storage disabled', 'SecurityError'); };
    }
  });

  function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const card = id => page.locator(`.channel[data-ch="${id}"]`);
  const field = role => card(0).locator(`[data-role="${role}"]`);
  const roles = ['pKp', 'pKi', 'pKd', 'pMaxOut', 'pIntLim'];
  const tuned = ['42.5', '3.25', '0.5', '12500', '8500'];
  const defaults = ['20', '1', '0', '15000', '10000'];
  const form = () => Promise.all(roles.map(role => field(role).inputValue()));
  const edit = async values => {
    for (let i = 0; i < roles.length; i++) await field(roles[i]).fill(values[i]);
  };
  const selectFirstMotor = async () => {
    await card(3).waitFor();
    await field('motor').selectOption('0');
  };
  const results = [];
  async function check(name, body) {
    errors.length = 0;
    await page.goto('http://127.0.0.1:3001/');
    await selectFirstMotor();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await selectFirstMotor();
    try {
      await body();
      equal(errors, [], 'Browser errors');
      results.push({ name, pass: true });
    } catch (error) {
      results.push({ name, pass: false, error: error.message });
    }
  }

  await check('last edited PID survives bind, page reload and channel recreation', async () => {
    equal(await form(), defaults, 'Initial model defaults');
    await edit(tuned);
    await field('bind').click();
    equal(await form(), tuned, 'Bind must not replace edits with model defaults');
    await page.reload();
    await selectFirstMotor();
    equal(await form(), tuned, 'Browser reload restores all five fields');
    await field('unbind').click();
    await page.evaluate(() => window.testSocket.emit({ type: 'unbindAck', data: { channelId: 0, result: 1 } }));
    equal(await card(0).count(), 0, 'Unbind removes the card');
    await page.locator('#addChannel').click();
    await field('motor').selectOption('0');
    equal(await form(), tuned, 'A recreated channel restores motor settings');
    equal(await page.evaluate(() => window.sentCommands.filter(cmd => cmd.type === 'pidSet').length), 0, 'Restoration never applies PID automatically');
    await field('pidApply').click();
    equal(await page.evaluate(() => window.sentCommands.at(-1)), {
      type: 'pidSet', channelId: 0, loop: 0,
      pid: { Kp: 42.5, Ki: 3.25, Kd: 0.5, MaxOut: 12500, IntegralLimit: 8500 },
    }, 'Apply uses the remembered values');
  });

  await check('PID memory follows motor identity instead of channel or inventory index', async () => {
    await edit(tuned);
    for (const [motor, kp, ki] of [['1', '77', '0'], ['2', '99', '4']]) {
      await field('motor').selectOption(motor);
      equal(await form(), defaults, 'Another ID or CAN bus starts with its own defaults');
      await field('pKp').fill(kp);
      await field('pKi').fill(ki);
    }
    await field('motor').selectOption('3');
    equal(await form(), ['10', '1', '0', '5000', '5000'], 'Another model has independent defaults');
    await field('motor').selectOption('0');
    equal(await form(), tuned, 'First motor restores its own settings');
    await field('motor').selectOption('1');
    equal((await form()).slice(0, 2), ['77', '0'], 'Zero Ki is remembered for the second motor');
    await field('motor').selectOption('2');
    equal((await form()).slice(0, 2), ['99', '4'], 'CAN bus is part of motor identity');
    await card(1).locator('[data-role="motor"]').selectOption('0');
    equal(await card(1).locator('[data-role="pKp"]').inputValue(), '42.5', 'Settings follow the motor onto another channel');
    await page.evaluate(() => window.testSocket.emit({ type: 'inventory', data: { items: window.testSocket.motors.toReversed() } }));
    equal(await card(1).locator('[data-role="pKp"]').inputValue(), '42.5', 'Inventory reordering preserves the motor identity');
    await field('motor').selectOption('3');
    equal(await form(), tuned, 'Selection after inventory reordering restores the same motor');
    await page.reload();
    await selectFirstMotor();
    equal(await form(), tuned, 'A new inventory session retains the motor settings');
  });

  await check('speed, current and angle loops remember separate values', async () => {
    await edit(tuned);
    await field('pidLoop').selectOption('1');
    equal((await form()).slice(0, 2), ['0.7', '0.1'], 'Current loop starts with its defaults');
    await field('pKp').fill('0.85');
    await field('pKi').fill('0');
    await field('pidLoop').selectOption('2');
    equal((await form()).slice(0, 2), ['0', '0'], 'Angle loop starts with its defaults');
    await field('pKp').fill('8');
    await field('pKi').fill('0.2');
    await field('pidLoop').selectOption('0');
    equal(await form(), tuned, 'Speed loop survives switching');
    await page.reload();
    await selectFirstMotor();
    await field('pidLoop').selectOption('1');
    equal((await form()).slice(0, 2), ['0.85', '0'], 'Current loop survives reload');
    await field('pidLoop').selectOption('2');
    equal((await form()).slice(0, 2), ['8', '0.2'], 'Angle loop survives reload');
  });

  await check('restore defaults replaces the remembered settings', async () => {
    await edit(tuned);
    await field('pidLoop').selectOption('1');
    await field('pKp').fill('0.85');
    await field('pidLoop').selectOption('0');
    await field('pidReset').click();
    equal(await form(), defaults, 'Explicit reset uses model defaults');
    await page.reload();
    await selectFirstMotor();
    equal(await form(), defaults, 'Reset remains effective after reload');
    await field('pidLoop').selectOption('1');
    equal(await field('pKp').inputValue(), '0.85', 'Reset leaves the other control loop intact');
  });

  await check('board readback displays live values without overwriting the last tuning', async () => {
    await edit(tuned);
    await field('bind').click();
    await field('pidQuery').click();
    await page.evaluate(() => window.testSocket.emit({ type: 'pidReport', data: {
      channelId: 0, kind: 2,
      speed: { Kp: 12.5, Ki: 0, Kd: 1, MaxOut: 9000, IntegralLimit: 6000 },
    } }));
    equal(await form(), ['12.5', '0', '1', '9000', '6000'], 'Board values are displayed');
    await page.reload();
    await selectFirstMotor();
    equal(await form(), tuned, 'Board readback does not overwrite the last manual tuning');
  });

  await check('readback cannot overwrite the memory of a different selected motor', async () => {
    await field('motor').selectOption('1');
    await edit(tuned);
    // A pre-existing board binding may silently reject this request; no telemetry confirms B.
    await field('bind').click();
    await field('pidQuery').click();
    await page.evaluate(() => window.testSocket.emit({ type: 'pidReport', data: {
      channelId: 0, kind: 2,
      speed: { Kp: 12.5, Ki: 0, Kd: 1, MaxOut: 9000, IntegralLimit: 6000 },
    } }));
    await field('motor').selectOption('0');
    await field('motor').selectOption('1');
    equal(await form(), tuned, 'A board report with no motor ID cannot overwrite selected motor B memory');
    await field('motor').selectOption('0');
    await field('pidQuery').click();
    await field('motor').selectOption('1');
    await page.evaluate(() => window.testSocket.emit({ type: 'pidReport', data: {
      channelId: 0, kind: 2,
      speed: { Kp: 12.5, Ki: 0, Kd: 1, MaxOut: 9000, IntegralLimit: 6000 },
    } }));
    equal(await form(), tuned, 'A late reply must not change the newly selected motor');
    await page.reload();
    await selectFirstMotor();
    await field('motor').selectOption('1');
    equal(await form(), tuned, 'A late reply must not overwrite another motor memory');
  });

  await check('removing a selected motor clears its persistence identity', async () => {
    await edit(tuned);
    await page.evaluate(() => window.testSocket.emit({ type: 'inventory', data: {
      items: window.testSocket.motors.slice(1),
    } }));
    equal(await field('motor').inputValue(), '', 'Removed motor is no longer selected');
    equal(await field('pKp').isDisabled(), true, 'A missing motor cannot be edited');
    await page.evaluate(() => window.testSocket.emit({ type: 'inventory', data: { items: window.testSocket.motors } }));
    await field('motor').selectOption('0');
    equal(await form(), tuned, 'Removing the motor does not overwrite its remembered form');
  });

  await check('empty, negative and corrupted values do not replace a valid saved form', async () => {
    await edit(tuned);
    await field('pKp').fill('');
    await field('pKi').fill('-1');
    await page.reload();
    await selectFirstMotor();
    equal(await form(), tuned, 'Invalid edits preserve the last complete valid form');
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) localStorage.setItem(key, '{broken JSON');
    });
    await page.reload();
    await selectFirstMotor();
    equal(await form(), defaults, 'Corrupted storage falls back to model defaults');
  });

  await check('unavailable browser storage does not break the PID controls', async () => {
    await page.goto('http://127.0.0.1:3001/index.html?storage=blocked');
    await selectFirstMotor();
    equal(await form(), defaults, 'Defaults still load without storage');
    await edit(tuned);
    await field('pidApply').click();
    equal(await page.evaluate(() => window.sentCommands.at(-1).pid), {
      Kp: 42.5, Ki: 3.25, Kd: 0.5, MaxOut: 12500, IntegralLimit: 8500,
    }, 'Manual application still works');
  });

  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.pass)) throw Error(JSON.stringify(results));
  return results;
}
