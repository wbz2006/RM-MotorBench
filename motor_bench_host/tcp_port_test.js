import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TcpPort, parseTcpPath } from './tcp-port.js';

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
