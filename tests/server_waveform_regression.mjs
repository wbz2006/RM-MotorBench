// Real HTTP/WebSocket/server/protocol; only the serial device is replaced. Node >=18.19.
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { register } from 'node:module';
import WebSocket from '../motor_bench_host/node_modules/ws/wrapper.mjs';
import { FrameParser, FrameType, buildFrame, buildHeartbeatAck } from '../motor_bench_host/protocol.js';

const dji = { channelId: 1, kind: 2, canBus: 2, motorId: 1, outerLoop: 2 };
const dm = { channelId: 3, kind: 4, canBus: 1, motorId: 2, outerLoop: 1 };
const board = { motors: [], bindings: new Map(), frames: [] };
class TestSerialPort extends EventEmitter {
  static async list() { return [{ path: 'TEST_WAVEFORM_ONLY' }]; }
  constructor(options, callback) {
    super();
    assert.equal(options.path, 'TEST_WAVEFORM_ONLY');
    this.isOpen = true;
    this.parser = new FrameParser();
    queueMicrotask(() => callback(null));
  }
  emitFrame(type, payload) { setImmediate(() => this.emit('data', buildFrame(type, payload))); }
  telemetry() {
    const items = [...board.bindings.values()];
    const payload = Buffer.alloc(3 + 21 * items.length);
    payload[0] = items.length;
    items.forEach((binding, i) => {
      const offset = 3 + i * 21;
      payload.writeUInt16LE(binding.channelId, offset);
      payload.writeUInt16LE(3, offset + 2);
      payload.writeFloatLE(1180, offset + 4);
      payload.writeFloatLE(1180.7, offset + 8);
    });
    this.emitFrame(FrameType.TELEMETRY, payload);
  }
  write(bytes) {
    for (const { type, payload } of this.parser.push(bytes)) {
      board.frames.push(type);
      if (type === FrameType.HEARTBEAT) {
        setImmediate(() => this.emit('data', buildHeartbeatAck()));
      } else if (type === FrameType.INVENTORY_QUERY) {
        this.emitFrame(FrameType.INVENTORY_REPORT, Buffer.from([
          board.motors.length, ...board.motors.flatMap(m => [m.kind, m.canBus, m.motorId, m.outerLoop]),
        ]));
      } else if (type === FrameType.MOTOR_BIND) {
        const [channelId, kind, canBus, motorId, outerLoop] = payload;
        if (!board.bindings.has(channelId)) board.bindings.set(channelId, { channelId, kind, canBus, motorId, outerLoop });
        // Rejected duplicate bindings still have telemetry from the old motor.
        this.telemetry();
      } else if (type === FrameType.MOTOR_UNBIND) {
        const channelId = payload[1];
        const result = board.bindings.delete(channelId) ? 0 : 1;
        this.emitFrame(FrameType.UNBIND_ACK, Buffer.from([channelId, result]));
      }
    }
  }
  close(callback) { this.isOpen = false; this.emit('close'); callback?.(); }
}
globalThis.__waveformTestSerialPort = TestSerialPort;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier === 'serialport') return {
      url: 'data:text/javascript,export const SerialPort = globalThis.__waveformTestSerialPort;', shortCircuit: true,
    };
    return nextResolve(specifier, context);
  }
`)}`);

let server;
const createServer = http.createServer;
http.createServer = (...args) => (server = createServer(...args));
process.argv = [process.execPath, 'server.js', '--port', '0'];
await import('../motor_bench_host/server.js');
http.createServer = createServer;
if (!server.listening) await once(server, 'listening');
const sockets = [];
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  sockets.push(ws);
  ws.messages = [];
  ws.on('message', text => ws.messages.push(JSON.parse(text)));
  await once(ws, 'open');
  return ws;
}
function wait(ws, predicate, start = 0) {
  const found = ws.messages.slice(start).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', listener); reject(Error('Timed out waiting for server report')); }, 3000);
    function listener(text) {
      const message = JSON.parse(text);
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', listener);
      resolve(message);
    }
    ws.on('message', listener);
  });
}
const send = (ws, command) => ws.send(JSON.stringify(command));
const bindings = (ws, length, start = 0) => wait(ws, m => m.type === 'bindings' && m.data.items.length === length, start);
try {
  const first = await connect();
  send(first, { type: 'openSerial', path: 'TEST_WAVEFORM_ONLY' });
  await wait(first, m => m.type === 'inventory');
  board.motors = [dji, dm];
  send(first, { type: 'scanMotors' });
  await wait(first, m => m.type === 'inventory' && m.data.items.length === 2);
  send(first, { type: 'bind', ...dji });
  await bindings(first, 1);
  send(first, { type: 'bind', ...dm });
  await bindings(first, 2);
  const refreshed = await connect();
  assert.deepEqual((await bindings(refreshed, 2)).data.items, [dji, dm]);
  send(first, { type: 'unbind', channelId: 1 });
  assert.deepEqual((await bindings(refreshed, 1)).data.items, [dm]);

  let start = first.messages.length;
  send(first, { type: 'closeSerial' });
  await wait(first, m => m.type === 'serial' && !m.open, start);
  // A different serial session already has a motor bound, before any telemetry.
  board.bindings = new Map([[7, { ...dji, channelId: 7 }]]);
  start = first.messages.length;
  send(first, { type: 'openSerial', path: 'TEST_WAVEFORM_ONLY' });
  await wait(first, m => m.type === 'inventory', start);
  send(first, { type: 'bind', ...dm, channelId: 7 });
  await wait(first, m => m.type === 'telemetry' && m.data.items.some(it => it.channelId === 7), start);
  const unknown = await connect();
  assert.deepEqual((await bindings(unknown, 0)).data.items, [], 'Rejected bind cannot claim old board telemetry');
  const before = board.frames.length;
  send(first, { type: 'identifyChannel', ...dji, channelId: 7 });
  assert.deepEqual((await bindings(unknown, 1)).data.items, [{ ...dji, channelId: 7, identified: true }]);
  assert.equal(board.frames.slice(before).filter(type => type !== FrameType.HEARTBEAT).length, 0, 'Display recovery sends no serial command');
  const identified = await connect();
  assert.deepEqual((await bindings(identified, 1)).data.items, [{ ...dji, channelId: 7, identified: true }]);
  console.log('PASS: real server restores bindings across clients, unbinds and serial sessions; unknown-channel identification is display-only');
  start = first.messages.length;
  send(first, { type: 'closeSerial' });
  await wait(first, m => m.type === 'serial' && !m.open, start);
} finally {
  for (const ws of sockets) ws.terminate();
  await new Promise(resolve => server.close(resolve));
}
