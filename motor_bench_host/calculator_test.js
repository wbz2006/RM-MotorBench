import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoaderSpeed } from './calculator.js';

test('matches original burst-fire formula and converts deg/s to rotor rpm', () => {
  const result = calculateLoaderSpeed(8, 36, 8);
  assert.equal(result.rotorRpm, 2160);
  assert.equal(result.diskRpm, 60);
  assert.ok(Math.abs(result.rotorRad - 72 * Math.PI) < 1e-10);
  assert.equal(result.rotorRpm * 6, 8 * 360 * 36 / 8);
});

test('uses actual loading count, reduction and fractional rate; zero rate stops', () => {
  assert.equal(calculateLoaderSpeed(8, 36, 10).rotorRpm, 1728);
  assert.equal(calculateLoaderSpeed(2.5, 19, 10).rotorRpm, 285);
  assert.equal(calculateLoaderSpeed(2, 1, 8).rotorRpm, 15);
  assert.deepEqual(calculateLoaderSpeed(0, 36, 8), { diskRpm: 0, rotorRpm: 0, rotorRad: 0 });
});

test('rejects missing/negative inputs, zero reduction, fractional loading and overflow', () => {
  for (const args of [[NaN, 36, 8], [-1, 36, 8], [Infinity, 36, 8], [8, 0, 8], [8, -1, 8], [8, Infinity, 8], [8, 36, 0], [8, 36, 1.5], [8, 36, NaN], [Number.MAX_VALUE, 36, 8]]) {
    assert.throws(() => calculateLoaderSpeed(...args));
  }
});
