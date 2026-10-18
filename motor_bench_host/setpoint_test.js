import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetpointProgram, sampleSetpoint } from './setpoint.js';

const sine = (options = {}, limit = 7000) => createSetpointProgram({
  mode: 'sine', amplitude: 500, offset: 100, period: 4, cycles: 2, ...options,
}, limit);
const steps = (options = {}, limit = 7000) => createSetpointProgram({
  mode: 'steps', steps: '0, 500, -200, 0', dwell: 0.1, cycles: 2, ...options,
}, limit);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('sine follows offset, amplitude and real elapsed time across repeated cycles', () => {
  const p = sine();
  for (const [time, ref] of [[0, 100], [1, 600], [2, 100], [3, -400], [4, 100], [5, 600]]) {
    near(sampleSetpoint(p, time).ref, ref);
  }
  assert.equal(sampleSetpoint(p, 4).cycle, 2);
  assert.deepEqual(sampleSetpoint(p, 8), { ref: 0, done: true, cycle: 2 });
  assert.equal(sampleSetpoint(p, 100).ref, 0);
});

test('step dwell boundaries, signed targets, repetitions and final zero', () => {
  const p = steps();
  for (const [time, ref, step, cycle] of [
    [0, 0, 1, 1], [0.099, 0, 1, 1], [0.1, 500, 2, 1], [0.2, -200, 3, 1],
    [0.3, 0, 4, 1], [0.4, 0, 1, 2], [0.5, 500, 2, 2], [0.6, -200, 3, 2],
  ]) {
    const point = sampleSetpoint(p, time);
    assert.deepEqual(point, { ref, done: false, cycle, step });
  }
  assert.deepEqual(sampleSetpoint(p, 0.8), { ref: 0, done: true, cycle: 2 });
  assert.equal(sampleSetpoint(steps({ steps: '100', cycles: 1 }), 0.1).ref, 0);
});

test('step list accepts Chinese commas, spaces and decimals in motor-native units', () => {
  const p = steps({ steps: '0， 1.25\n-2.5', dwell: 1 }, 40);
  assert.deepEqual(p.steps, [0, 1.25, -2.5]);
  assert.equal(sampleSetpoint(p, 2).ref, -2.5);
  const dm = sine({ amplitude: 1, offset: 0, cycles: 1 }, 40);
  near(sampleSetpoint(dm, 1).ref, 1);
});

test('rejects out-of-range waveforms instead of silently clipping their shape', () => {
  assert.throws(() => sine({ amplitude: 6000, offset: 1001 }), /限幅/);
  assert.doesNotThrow(() => sine({ amplitude: 6000, offset: -1000 }));
  assert.throws(() => sine({ amplitude: 41 }, 40));
  assert.throws(() => steps({ steps: '0, -7001' }));
});

test('rejects blank, nonfinite, malformed and too-fast or unbounded parameters', () => {
  for (const change of [
    { amplitude: NaN }, { amplitude: Infinity }, { amplitude: -1 }, { offset: -Infinity },
    { period: 0 }, { period: 0.49 }, { period: 3601 }, { cycles: 0 }, { cycles: 1.5 }, { cycles: 1001 },
  ]) assert.throws(() => sine(change));
  for (const change of [{ steps: '' }, { steps: '0,' }, { steps: ',100' }, { steps: '0, bad' }, { steps: 'Infinity' },
    { steps: Array(65).fill('0').join(',') }, { dwell: 0 }, { dwell: 0.09 }, { dwell: NaN }]) {
    assert.throws(() => steps(change));
  }
  assert.throws(() => sine({ mode: 'other' }));
  assert.throws(() => sampleSetpoint(sine(), NaN));
  assert.throws(() => sampleSetpoint(sine(), -1));
});
