import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeedHistory } from '../motor_bench_host/waveform.js';

const reading = (ref, speed, online = true) => ({ ref, speed, online });

test('keeps board target and measured speed at the same receive time', () => {
  const history = new SpeedHistory();
  history.append(0, reading(1500, 1475), 100);
  assert.deepEqual(history.view(0, 200, 1000), [{ time: 100, ref: 1500, speed: 1475 }]);
});

test('limits retained age and count independently', () => {
  const ageLimited = new SpeedHistory({ retentionMs: 1000, maxPoints: 100 });
  for (const time of [0, 500, 1000, 1500]) ageLimited.append(0, reading(time, time), time);
  assert.deepEqual(ageLimited.view(0, 1500, 10000).map(p => p.time), [500, 1000, 1500]);
  const countLimited = new SpeedHistory({ retentionMs: 10000, maxPoints: 3 });
  for (const time of [0, 10, 20, 30, 40]) countLimited.append(0, reading(1, 2), time);
  assert.deepEqual(countLimited.view(0, 40, 10000).map(p => p.time), [20, 30, 40]);
});

test('selects a time window without mixing channels or future samples', () => {
  const history = new SpeedHistory();
  history.append(0, reading(100, 90), 10);
  history.append(2, reading(-100, -120), 20);
  history.append(0, reading(200, 190), 30);
  history.append(0, reading(300, 290), 50);
  assert.deepEqual(history.view(0, 40, 20), [{ time: 30, ref: 200, speed: 190 }]);
  assert.deepEqual(history.view(2, 40, 100), [{ time: 20, ref: -100, speed: -120 }]);
});

test('offline and nonfinite values create gaps rather than fabricated zero speed', () => {
  const history = new SpeedHistory();
  history.append(0, reading(100, 99), 0);
  history.append(0, reading(100, 99, false), 10);
  history.append(0, reading(NaN, Infinity), 20);
  assert.deepEqual(history.view(0, 20, 100), [
    { time: 0, ref: 100, speed: 99 },
    { time: 10, ref: null, speed: null },
    { time: 20, ref: null, speed: null },
  ]);
});

test('a paused snapshot stays intact as live history changes or is trimmed', () => {
  const history = new SpeedHistory({ maxPoints: 1 });
  history.append(0, reading(100, 90), 0);
  const snapshot = history.snapshot();
  history.append(0, reading(200, 190), 10);
  history.clear(0);
  assert.deepEqual(snapshot.get(0), [{ time: 0, ref: 100, speed: 90 }]);
  assert.deepEqual(history.view(0, 20, 100), []);
});

test('disconnect and removal do not connect different channel lifetimes', () => {
  const history = new SpeedHistory();
  history.append(0, reading(100, 90), 0);
  history.append(2, reading(200, 190), 0);
  history.break(10);
  assert.deepEqual(history.view(0, 10, 100).at(-1), { time: 10, ref: null, speed: null });
  history.remove(0);
  history.append(0, reading(300, 290), 20);
  assert.deepEqual(history.view(0, 20, 100), [{ time: 20, ref: 300, speed: 290 }]);
  assert.equal(history.view(2, 20, 100).length, 2);
});

test('rejects out-of-order timestamps without corrupting the trace', () => {
  const history = new SpeedHistory();
  history.append(0, reading(100, 90), 20);
  assert.equal(history.append(0, reading(200, 190), 10), false);
  assert.deepEqual(history.view(0, 30, 100), [{ time: 20, ref: 100, speed: 90 }]);
});
