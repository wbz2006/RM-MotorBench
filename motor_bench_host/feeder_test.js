import test from 'node:test';
import assert from 'node:assert/strict';
import { FeederController } from './feeder.js';

const options = { target: 2160, threshold: 1300, lowSpeed: 0.3, detectMs: 300,
  reverseAngle: 10, reverseSpeed: 360, reverseTimeout: 3000, maxRetries: 2, anglePeriod: 0, roundsPerTurn: 8 };
const sample = (controller, at, speed = 0, load = 2000, angle = 0) => controller.sample({ at, speed, load, angle });

test('ignores startup, high-current normal motion and transient stalls', () => {
  const c = new FeederController(options, 0);
  assert.equal(sample(c, 500), null);
  assert.equal(sample(c, 1000, 2160), null);
  assert.equal(sample(c, 1100), null);
  assert.equal(sample(c, 1300, 0, 1000), null);
  assert.equal(sample(c, 1500), null);
  assert.equal(sample(c, 1800), -360);
  assert.equal(c.jams, 1);
});

test('uses signed actual reverse travel, resumes original speed and stops on retry limit', () => {
  const c = new FeederController(options, 0);
  sample(c, 1000, 0, 2000, 100);
  assert.equal(sample(c, 1300, 0, 2000, 100), -360);
  assert.equal(sample(c, 1400, 0, 2000, 105), null);
  assert.equal(sample(c, 1500, 0, 2000, 95), null);
  assert.equal(sample(c, 1600, 0, 2000, 90), 2160);
  sample(c, 2600);
  assert.equal(sample(c, 2900), -360);
  assert.equal(sample(c, 3000, 0, 2000, -10), 2160);
  sample(c, 4000);
  assert.equal(sample(c, 4300), 0);
  assert.equal(c.phase, 'stopped');
  assert.match(c.reason, /重试上限/);
  assert.equal(sample(c, 5000), null);
});

test('handles opposite feeding direction and wrapped DM feedback', () => {
  const c = new FeederController({ ...options, target: -2160, anglePeriod: 100 }, 0);
  sample(c, 1000, 0, 2000, 45);
  assert.equal(sample(c, 1300, 0, 2000, 45), 360);
  assert.equal(sample(c, 1400, 0, 2000, -48), null);
  assert.equal(sample(c, 1500, 0, 2000, -45), -2160);
});

test('estimates shots from furthest net disk travel without recounting recovery motion', () => {
  const c = new FeederController(options, 0, 0);
  sample(c, 1000, 2160, 1000, 45);
  assert.equal(c.shots, 1);
  sample(c, 1300, 0, 2000, 45);
  assert.equal(c.shots, 1, 'jam detection does not increment emitted shots');
  sample(c, 1400, 0, 2000, 35);
  assert.equal(c.shots, 0, 'reversed travel reduces net forward angle');
  sample(c, 1500, 0, 2000, 45);
  assert.equal(c.shots, 1, 'recovery back to prior progress is counted once');
  sample(c, 2500, 2160, 1000, 135);
  assert.equal(c.shots, 3, 'new forward travel advances the estimate');
});

test('records the last angle when a run is stopped', () => {
  const c = new FeederController(options, 0, 0);
  c.sample({ at: 1000, speed: 2160, load: 1000, angle: 45 });
  c.recordAngle(90);
  assert.equal(c.shots, 2);
  c.stop('手动停止');
  c.recordAngle(135);
  assert.equal(c.shots, 3);
});

test('stops a stalled reverse and resets retries only after stable normal feeding', () => {
  const c = new FeederController(options, 0);
  sample(c, 1000); sample(c, 1300);
  assert.equal(sample(c, 4300), 0);
  assert.match(c.reason, /回退超时/);
  const good = new FeederController(options, 0);
  sample(good, 1000); sample(good, 1300); sample(good, 1400, 0, 2000, -10);
  sample(good, 2400, 2160, 1000);
  assert.equal(good.attempts, 1);
  sample(good, 3400, 2160, 1000);
  assert.equal(good.attempts, 0);
});
