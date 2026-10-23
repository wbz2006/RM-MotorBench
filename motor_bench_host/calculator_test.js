import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoaderSpeed, calculateLoaderStep } from './calculator.js';
import { FrameParser, FrameType, buildPositionStep, parsePositionStepAck } from './protocol.js';

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

test('single/double feeder steps use output-shaft degrees and only external reduction', () => {
  assert.deepEqual(calculateLoaderStep(36, 8), { perShot: 1620, delta: 1620, shots: 1 });
  assert.deepEqual(calculateLoaderStep(36, 8, 2, -1), { perShot: 1620, delta: -3240, shots: 2 });
  assert.equal(calculateLoaderStep(1, 8).delta, 45); // M2006 direct output: firmware applies internal 36:1.
  assert.equal(calculateLoaderStep(1, 8, 2).delta, 90);
  assert.equal(calculateLoaderStep(2, 8).delta, 90); // Additional external 2:1.
  assert.equal(calculateLoaderStep(19, 10).delta, 684);
  for (const args of [[0, 8], [36, 0], [36, 1.5], [Infinity, 8], [36, 8, 3], [36, 8, 1, 0], [101, 1], [1e-8, 8]])
    assert.throws(() => calculateLoaderStep(...args));
});

test('position-step wire preserves angle and request ID, rejects unsafe or malformed input', () => {
  const frame = new FrameParser().push(buildPositionStep(2, 65535, -3240))[0];
  assert.equal(frame.type, FrameType.POSITION_STEP);
  assert.equal(frame.payload.length, 7);
  assert.equal(frame.payload[0], 2);
  assert.equal(frame.payload.readUInt16LE(1), 65535);
  assert.equal(frame.payload.readFloatLE(3), -3240);
  const ack = Buffer.alloc(8);
  ack[0] = 2; ack.writeUInt16LE(65535, 1); ack.writeFloatLE(4860, 4);
  assert.deepEqual(parsePositionStepAck(ack), { channelId: 2, requestId: 65535, result: 0, target: 4860 });
  assert.equal(parsePositionStepAck(ack.subarray(0, 7)), null);
  for (const args of [[8, 0, 45], [0, -1, 45], [0, 0, NaN], [0, 0, 36001], [0, 0, 0]])
    assert.throws(() => buildPositionStep(...args));
});
