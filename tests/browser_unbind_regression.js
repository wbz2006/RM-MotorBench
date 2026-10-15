// Run with playwright-cli run-code --filename tests/browser_unbind_regression.js.
// Serve motor_bench_host on port 3001. Only the hardware WebSocket is replaced.
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
        this.motors = [1, 2, 3].map(motorId => ({ kind: 2, canBus: 2, motorId, outerLoop: 2 }));
        setTimeout(() => {
          this.onopen?.();
          this.emit({ type: 'inventory', data: { items: this.motors } });
          const unbound = new URL(location.href).searchParams.get('unbound');
          this.emit({ type: 'telemetry', data: { items: [0, 1, 2].filter(id => String(id) !== unbound).map(channelId => ({
            channelId, online: true, enabled: false, ref: 0, speed: 0,
            torque: 0, angle: 0, temperature: 25,
          })) } });
        }, 0);
      }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
      send(text) { window.sentCommands.push(JSON.parse(text)); }
    }
    window.WebSocket = TestSocket;
  });

  function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  const results = [];
  const card = id => page.locator(`.channel[data-ch="${id}"]`);
  const channelIds = () => page.locator('#channels .channel').evaluateAll(els => els.map(el => Number(el.dataset.ch)));
  const ack = (channelId, result) => page.evaluate(({ channelId, result }) => {
    window.testSocket.emit({ type: 'unbindAck', data: { channelId, result } });
  }, { channelId, result });
  const inventory = () => page.evaluate(() => {
    window.testSocket.emit({ type: 'inventory', data: { items: window.testSocket.motors } });
  });
  async function check(name, body, unboundChannel = null) {
    errors.length = 0;
    await page.goto(`http://127.0.0.1:3001/index.html${unboundChannel === null ? '' : `?unbound=${unboundChannel}`}`);
    await card(2).locator('[data-role="motor"] option[value="2"]').waitFor({ state: 'attached' });
    for (const id of [0, 1, 2]) await card(id).locator('[data-role="motor"]').selectOption(String(id));
    try {
      await body();
      equal(errors, [], 'Browser errors');
      results.push({ name, pass: true });
    } catch (error) {
      results.push({ name, pass: false, error: error.message });
    }
  }

  await check('cancelled or rejected unbind preserves the card', async () => {
    await page.evaluate(() => { window.confirm = () => false; });
    await card(1).locator('[data-role="unbind"]').click();
    equal(await page.evaluate(() => window.sentCommands.filter(c => c.type === 'unbind')), [], 'Cancelled request');
    await page.evaluate(() => { window.confirm = () => true; });
    await card(1).locator('[data-role="unbind"]').click();
    equal(await channelIds(), [0, 1, 2], 'Card stays until the board confirms');
    equal(await page.evaluate(() => window.sentCommands.slice(-2)), [
      { type: 'enable', channelId: 1, enable: false }, { type: 'unbind', channelId: 1 },
    ], 'Stop precedes unbind');
    await ack(1, 1);
    equal(await channelIds(), [0, 1, 2], 'Rejected unbind');
    equal(await card(1).locator('[data-role="motor"]').inputValue(), '1', 'Selection after rejection');
    if (!(await page.locator('#linkText').textContent()).includes('解绑失败')) throw Error('Missing failure notice');
  });

  await check('successful unbind removes only that card and keeps motor inventory', async () => {
    await card(2).locator('[data-role="num"]').fill('1500');
    await card(2).locator('[data-role="pKp"]').fill('42');
    await card(1).locator('[data-role="unbind"]').click();
    await ack(1, 0);
    equal(await channelIds(), [0, 2], 'Confirmed unbind must remove the card');
    equal(await card(2).locator('[data-role="num"]').inputValue(), '1500', 'Remaining speed');
    equal(await card(2).locator('[data-role="pKp"]').inputValue(), '42', 'Remaining PID');
    equal(await card(2).locator('[data-role="motor"]').inputValue(), '2', 'Remaining motor');
    equal(await page.locator('#remoteChannel option').evaluateAll(els => els.map(el => el.value)), ['0', '2'], 'Remote channels');
    equal(await card(2).locator('[data-role="motor"] option').count(), 4, 'Registered motors are retained');
    equal(await page.evaluate(() => window.sentCommands.some(c => c.type === 'removeMotor')), false, 'No motor removal');
    await card(2).locator('[data-role="zero"]').click();
    equal(await page.evaluate(() => window.sentCommands.at(-1)), { type: 'setRef', channelId: 2, ref: 0 }, 'Remaining channel ID');
  });

  await check('an already unbound channel zero is removed after board confirmation', async () => {
    equal(await card(0).locator('[data-role="status"]').textContent(), '未绑定', 'Unbound channel zero');
    await card(2).locator('[data-role="pKp"]').fill('42');
    await card(0).locator('[data-role="unbind"]').click();
    equal(await channelIds(), [0, 1, 2], 'Wait for confirmation even without telemetry');
    await ack(0, 1);
    equal(await channelIds(), [1, 2], 'The board confirms channel zero was already unbound');
    await inventory();
    equal(await channelIds(), [1, 2], 'Inventory must not recreate channel zero');
    equal(await page.locator('#remoteChannel option').evaluateAll(els => els.map(el => el.value)), ['1', '2'], 'Remote choices remove channel zero');
    equal(await page.locator('#waveChannel option').evaluateAll(els => els.map(el => el.value)), ['1', '2'], 'Waveform choices remove channel zero');
    equal(await card(2).locator('[data-role="pKp"]').inputValue(), '42', 'Other PID edits survive');
    await page.locator('#addChannel').click();
    equal(await channelIds(), [0, 1, 2], 'Channel zero can be added again');
    equal(await card(0).locator('[data-role="motor"] option').count(), 4, 'Registered motors remain selectable');
    equal(await page.evaluate(() => window.sentCommands.some(c => c.type === 'removeMotor')), false, 'No motor removal');
  }, 0);

  await check('unbind removes channel zero after a failed bind instead of leaving an empty card', async () => {
    await card(0).locator('[data-role="bind"]').click();
    await card(0).locator('[data-role="unbind"]').click();
    equal(await channelIds(), [0, 1, 2], 'Pending bind still waits for unbind confirmation');
    await ack(0, 1);
    equal(await channelIds(), [1, 2], 'Confirmed failed bind must remove the empty card');
    await inventory();
    equal(await channelIds(), [1, 2], 'Refresh must not restore the failed binding card');
  }, 0);

  await check('a local serial write failure must not remove an unconfirmed channel zero', async () => {
    await card(0).locator('[data-role="unbind"]').click();
    await page.evaluate(() => window.testSocket.emit({
      type: 'unbindAck', data: { channelId: 0, result: 1, boardConfirmed: false },
    }));
    equal(await channelIds(), [0, 1, 2], 'No board confirmation on serial write failure');
    if (!(await page.locator('#linkText').textContent()).includes('解绑失败')) throw Error('Missing failure notice');
  }, 0);

  await check('inventory and source reports do not recreate removed cards or break remaining controls', async () => {
    await card(2).locator('[data-role="pKp"]').fill('42');
    await ack(1, 0);
    await inventory();
    equal(await channelIds(), [0, 2], 'Inventory refresh must not resurrect the card');
    equal(await card(2).locator('[data-role="pKp"]').inputValue(), '42', 'Repeated inventory preserves PID edits');
    await page.evaluate(() => window.testSocket.emit({ type: 'controlReport', data: {
      result: 0, source: 1, channelId: 2, online: true, switchRight: 1,
      ready: true, rocker: 0, maxRef: 3000,
    } }));
    equal(await card(2).locator('[data-role="num"]').isDisabled(), true, 'Remote mode after removal');
    await page.evaluate(() => window.testSocket.emit({ type: 'controlReport', data: {
      result: 0, source: 0, channelId: 255, online: true, switchRight: 1,
      ready: true, rocker: 0, maxRef: 0,
    } }));
    equal(await card(2).locator('[data-role="num"]').isDisabled(), false, 'Web mode after removal');
  });

  await check('a newly registered motor reuses a free channel without replacing other cards', async () => {
    await card(2).locator('[data-role="pKp"]').fill('42');
    await card(2).locator('[data-role="num"]').fill('1500');
    await ack(1, 0);
    await page.evaluate(() => {
      document.querySelector('.channel[data-ch="2"]').keepMarker = true;
      window.testSocket.emit({ type: 'motorAck', data: {
        result: 0, kind: 3, canBus: 2, motorId: 4, channelId: 255, detail: 10,
      } });
      window.testSocket.motors.unshift({ kind: 3, canBus: 2, motorId: 4, outerLoop: 2 });
      window.testSocket.emit({ type: 'inventory', data: { items: window.testSocket.motors } });
    });
    equal((await channelIds()).sort(), [0, 1, 2], 'Reuse the freed channel ID');
    equal(await card(2).evaluate(el => el.keepMarker), true, 'Existing DOM survives');
    equal(await card(2).locator('[data-role="motor"]').inputValue(), '3', 'Motor identity survives ACK and inventory reordering');
    equal(await card(2).locator('[data-role="pKp"]').inputValue(), '42', 'Motor addition preserves PID edits');
    equal(await card(2).locator('[data-role="num"]').inputValue(), '1500', 'Motor addition preserves speed input');
    await card(1).locator('[data-role="motor"]').selectOption('0');
    await card(1).locator('[data-role="bind"]').click();
    equal(await page.evaluate(() => window.sentCommands.at(-1)), {
      type: 'bind', channelId: 1, kind: 3, canBus: 2, motorId: 4, outerLoop: 2,
    }, 'Reused channel sends the correct bind');
  });

  await check('all cards can be removed and a retained motor can be rebound', async () => {
    for (const id of [1, 0, 2]) await ack(id, 0);
    await inventory();
    equal(await channelIds(), [], 'Last card is removable');
    equal(await page.locator('#remoteChannel option').count(), 0, 'No removed remote choices');
    await page.locator('#addChannel').click();
    equal(await channelIds(), [0], 'Restore the first free channel');
    await card(0).locator('[data-role="motor"]').selectOption('1');
    await card(0).locator('[data-role="bind"]').click();
    equal(await page.evaluate(() => window.sentCommands.at(-1)), {
      type: 'bind', channelId: 0, kind: 2, canBus: 2, motorId: 2, outerLoop: 2,
    }, 'Retained motor can be rebound');
  });

  await check('adding a channel during inventory refresh preserves existing choices', async () => {
    await ack(1, 0);
    await card(2).locator('[data-role="pKp"]').fill('42');
    await page.locator('#rescan').click();
    await page.locator('#addChannel').click();
    equal(await card(2).locator('[data-role="motor"]').inputValue(), '2', 'Selection while inventory is pending');
    equal(await card(2).locator('[data-role="pKp"]').inputValue(), '42', 'PID while inventory is pending');
    await inventory();
    equal(await card(2).locator('[data-role="motor"]').inputValue(), '2', 'Selection after inventory returns');
    equal(await card(2).locator('[data-role="pKp"]').inputValue(), '42', 'PID after inventory returns');
  });

  await check('channel creation respects the eight firmware slots', async () => {
    for (let i = 0; i < 5; i++) await page.locator('#addChannel').click();
    equal((await channelIds()).sort(), [0, 1, 2, 3, 4, 5, 6, 7], 'Firmware channel limit');
    equal(await page.locator('#addChannel').isDisabled(), true, 'Limit disables creation');
    await ack(7, 0);
    equal(await page.locator('#addChannel').isDisabled(), false, 'Removal frees a slot');
  });

  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.pass)) throw Error(JSON.stringify(results));
  return results;
}
