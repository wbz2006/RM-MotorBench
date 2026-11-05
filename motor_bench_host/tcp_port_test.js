import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { TcpPort, parseTcpPath } from './tcp-port.js';
import { buildFrame, FrameType } from './protocol.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(emitter, event) {
  return new Promise(resolve => emitter.once(event, resolve));
}

test('TcpPort reconnects after a dropped bridge connection and resumes byte transfer', async () => {
  const sockets = [];
  let connectionCount = 0;
  const server = net.createServer(socket => {
    sockets.push(socket);
    connectionCount++;
    socket.once('data', handshake => {
      assert.deepEqual([...handshake], [0x4d, 0x42, 0x57, 0x31]);
      socket.write(Buffer.from([0x4d, 0x42, 0x4f, 0x4b]));
      socket.on('data', data => socket.write(data));
    });
  });
  const portNumber = await listen(server);
  const port = new TcpPort({ host: '127.0.0.1', port: portNumber });
  const errors = [];
  port.on('error', error => errors.push(error));
  try {
    await waitFor(port, 'open');
    const firstReceived = waitFor(port, 'data');
    assert.equal(port.write(Buffer.from([1, 2, 3])), true);
    assert.deepEqual([...await firstReceived], [1, 2, 3]);

    const disconnected = waitFor(port, 'close');
    const reconnected = waitFor(port, 'open');
    sockets[0].destroy();
    await disconnected;
    await reconnected;
    assert.equal(connectionCount, 2);

    const secondReceived = waitFor(port, 'data');
    assert.equal(port.write(Buffer.from([4, 5, 6])), true);
    assert.deepEqual([...await secondReceived], [4, 5, 6]);
    assert.ok(errors.every(error => error.code === 'ECONNRESET'));
  } finally {
    await new Promise(resolve => port.close(resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('parseTcpPath validates the host and port form', () => {
  assert.deepEqual(parseTcpPath('TCP://192.168.4.1:7000'), { host: '192.168.4.1', port: 7000 });
  assert.throws(() => parseTcpPath('TCP://192.168.4.1:0'), /1~65535/);
  assert.throws(() => parseTcpPath('COM5'), /TCP/);
});

test('server persists link stalls, recovery, statistics and TCP reconnects', { timeout: 15000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-link-log-'));
  const sockets = new Set();
  const peerErrors = [];
  let ready;
  let acknowledge = true;
  const bridge = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', error => peerErrors.push(error));
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.write(Buffer.from('MBOK'));
      ready?.();
      socket.on('data', () => {
        if (acknowledge) socket.write(buildFrame(FrameType.HEARTBEAT, Buffer.alloc(8)));
      });
    });
  });
  const tcpPort = await listen(bridge);
  const child = fork(new URL('./server.js', import.meta.url), ['--port', '0'], {
    env: { ...process.env, LOCALAPPDATA: tmp }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.resume();
  child.stderr.resume();
  let ws;
  try {
    const [message] = await once(child, 'message');
    ws = new WebSocket(`ws://127.0.0.1:${message.port}`);
    await once(ws, 'open');
    const connected = new Promise(resolve => { ready = resolve; });
    ws.send(JSON.stringify({ type: 'connectWifi', host: '127.0.0.1', port: tcpPort }));
    await connected;
    await new Promise(resolve => setTimeout(resolve, 300));
    acknowledge = false;
    await new Promise(resolve => setTimeout(resolve, 1700));
    acknowledge = true;
    await new Promise(resolve => setTimeout(resolve, 3300));
    const reconnected = new Promise(resolve => { ready = resolve; });
    for (const socket of sockets) socket.destroy();
    await reconnected;
    ws.send(JSON.stringify({ type: 'closeSerial' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const logDir = path.join(tmp, 'RM-MotorBench', 'logs');
    const entries = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    for (const event of ['SERVER_START', 'TRANSPORT_OPEN', 'BOARD_DATA_STALLED',
      'BOARD_DATA_RESUMED', 'RX_GAP', 'LINK_STATS', 'TRANSPORT_CLOSED']) {
      assert.ok(entries.some(entry => entry.event === event), event);
    }
    assert.ok(entries.every(entry => !Number.isNaN(Date.parse(entry.time))));
    assert.ok(entries.some(entry => entry.state === 'reconnect_scheduled' && entry.delayMs === 500));
    const stats = entries.find(entry => entry.event === 'LINK_STATS');
    assert.ok(stats.heartbeats > 0 && stats.txBytes > 0 && stats.maxRxGapMs >= 1000);
    assert.ok(peerErrors.every(error => error.code === 'ECONNRESET'));
  } finally {
    ws?.terminate();
    const exited = once(child, 'exit');
    child.send({ type: 'shutdown' });
    await exited;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => bridge.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
