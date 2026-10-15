import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelBindings } from '../motor_bench_host/channel_bindings.js';

const dji = { channelId: 1, kind: 2, canBus: 2, motorId: 1, outerLoop: 2 };
const dm = { channelId: 3, kind: 4, canBus: 1, motorId: 2, outerLoop: 1 };
const emptyBoard = () => {
  const state = new ChannelBindings();
  state.inventory([]);
  return state;
};

test('only telemetry confirms a sent binding for browser reloads', () => {
  const state = emptyBoard();
  state.request(dji);
  assert.deepEqual(state.snapshot(), []);
  assert.equal(state.telemetry([{ channelId: 1 }]), true);
  assert.deepEqual(state.snapshot(), [dji]);
  assert.equal(state.telemetry([{ channelId: 1 }]), false);
});

test('duplicate requests cannot replace an occupied or pending channel identity', () => {
  const state = emptyBoard();
  state.request(dji);
  state.request({ ...dm, channelId: 1 });
  state.telemetry([{ channelId: 1 }]);
  state.request({ ...dm, channelId: 1 });
  state.telemetry([{ channelId: 1 }]);
  assert.deepEqual(state.snapshot(), [dji]);
  state.telemetry([{ channelId: 3 }]);
  state.request(dm);
  state.telemetry([{ channelId: 3 }]);
  assert.deepEqual(state.snapshot(), [dji], 'Unknown occupied channel cannot be identified by a rejected rebind');
});

test('unbind rejection preserves metadata; confirmation permits reusing the channel', () => {
  const state = emptyBoard();
  state.request(dji);
  state.telemetry([{ channelId: 1 }]);
  state.unbind({ channelId: 1, result: 3 });
  assert.deepEqual(state.snapshot(), [dji]);
  state.unbind({ channelId: 1, result: 0 });
  assert.deepEqual(state.snapshot(), []);
  state.request({ ...dm, channelId: 1 });
  state.telemetry([{ channelId: 1 }]);
  assert.deepEqual(state.snapshot(), [{ ...dm, channelId: 1 }]);
});

test('confirmed empty channel releases a failed request but host send failure does not', () => {
  const state = emptyBoard();
  state.request(dji);
  state.unbind({ channelId: 1, result: 1, boardConfirmed: false });
  state.request({ ...dm, channelId: 1 });
  state.telemetry([{ channelId: 1 }]);
  assert.deepEqual(state.snapshot(), [dji]);
  state.reset();
  state.inventory([]);
  state.request(dji);
  state.unbind({ channelId: 1, result: 1 });
  state.request({ ...dm, channelId: 1 });
  state.telemetry([{ channelId: 1 }]);
  assert.deepEqual(state.snapshot(), [{ ...dm, channelId: 1 }]);
});

test('inventory removal and serial session reset discard old identities and pending requests', () => {
  const state = emptyBoard();
  state.request(dji);
  state.request(dm);
  state.telemetry([{ channelId: 1 }, { channelId: 3 }]);
  state.inventory([dm]);
  assert.deepEqual(state.snapshot(), [dm]);
  state.request(dji);
  state.reset();
  state.telemetry([{ channelId: 1 }, { channelId: 3 }]);
  assert.deepEqual(state.snapshot(), []);
});

test('a bind rejected by an unknown existing board channel cannot be confirmed by its first telemetry', () => {
  const state = new ChannelBindings();
  state.inventory([dji, dm]);
  state.request({ ...dm, channelId: 1 });
  state.telemetry([{ channelId: 1 }]);
  assert.deepEqual(state.snapshot(), [], 'Old board telemetry must not confirm a guessed identity');
});

test('explicit display identification can recover unknown bindings and persist across clients', () => {
  const state = new ChannelBindings();
  state.inventory([dji, dm]);
  state.telemetry([{ channelId: 1 }]);
  state.identify(dji);
  assert.deepEqual(state.snapshot(), [{ ...dji, identified: true }]);
  state.identify({ ...dji, outerLoop: 1 });
  assert.deepEqual(state.snapshot(), [{ ...dji, outerLoop: 1, identified: true }]);
  state.inventory([dm]);
  state.inventory([dji, dm]);
  state.request(dji);
  state.telemetry([{ channelId: 1 }]);
  assert.deepEqual(state.snapshot(), [dji], 'Inventory removal of an identified motor frees its actual channel');
});

test('display identification cannot invent a motor or replace a confirmed binding', () => {
  const state = emptyBoard();
  state.inventory([dji, dm]);
  state.request(dji);
  state.telemetry([{ channelId: 1 }]);
  state.identify({ ...dm, channelId: 1 });
  state.identify(dm);
  assert.deepEqual(state.snapshot(), [dji]);
});

test('clearing a user identification does not discard a confirmed board binding', () => {
  const state = new ChannelBindings();
  state.inventory([dji]);
  state.telemetry([{ channelId: 1 }]);
  state.identify(dji);
  state.identify({ channelId: 1, kind: 0 });
  assert.deepEqual(state.snapshot(), []);
  state.unbind({ channelId: 1, result: 0 });
  state.request(dji);
  state.telemetry([{ channelId: 1 }]);
  state.identify({ channelId: 1, kind: 0 });
  assert.deepEqual(state.snapshot(), [dji]);
});
