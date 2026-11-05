import net from 'node:net';
import { EventEmitter } from 'node:events';

const HANDSHAKE = Buffer.from([0x4d, 0x42, 0x57, 0x31]);
const HANDSHAKE_OK = Buffer.from([0x4d, 0x42, 0x4f, 0x4b]);
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10000];

/**
 * TCP transport with the same small surface used by SerialPort.
 * The first four bytes are consumed by the ESP32 bridge and prove that the
 * peer is the MotorBench bridge before protocol frames are exchanged.
 */
export class TcpPort extends EventEmitter {
  constructor({ host, port, autoOpen = true }, callback = () => {}) {
    super();
    this.path = `TCP://${host}:${port}`;
    this.host = host;
    this.port = port;
    this.baudRate = 0;
    this.isOpen = false;
    this._socket = null;
    this._manualClose = false;
    this._initialCallback = callback;
    this._initialSettled = false;
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._hasOpened = false;
    this._handshake = Buffer.alloc(0);
    if (autoOpen) this._connect();
  }

  write(data, callback) {
    if (!this.isOpen) {
      const error = new Error('TCP 连接未建立');
      if (callback) callback(error);
      return false;
    }
    this._socket.write(data, callback);
    return true;
  }

  close(callback = () => {}) {
    this._manualClose = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    const socket = this._socket;
    this._socket = null;
    this.isOpen = false;
    if (!socket) {
      callback();
      return;
    }
    socket.once('close', callback);
    socket.destroy();
  }

  _connect() {
    if (this._manualClose || this._socket) return;
    this._handshake = Buffer.alloc(0);
    const socket = net.createConnection({ host: this.host, port: this.port });
    this._socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.on('connect', () => {
      this.emit('diagnostic', { state: 'connected', localAddress: socket.localAddress });
      socket.write(HANDSHAKE);
    });
    socket.on('data', chunk => this._onData(chunk));
    socket.on('error', error => {
      this.emit('diagnostic', { state: 'error', code: error.code, message: error.message });
      if (!this._initialSettled) this._settleInitial(error);
      this.emit('error', error);
    });
    socket.on('close', hadError => {
      this.emit('diagnostic', { state: 'closed', hadError, manual: this._manualClose });
      const wasOpen = this.isOpen;
      if (this._socket === socket) this._socket = null;
      this.isOpen = false;
      if (wasOpen) this.emit('close');
      if (!this._initialSettled) this._settleInitial(new Error('TCP 连接已关闭'));
      if (!this._manualClose && this._hasOpened) this._scheduleReconnect();
    });
  }

  _onData(chunk) {
    if (!this.isOpen) {
      this._handshake = Buffer.concat([this._handshake, chunk]);
      if (this._handshake.length < HANDSHAKE_OK.length) return;
      const response = this._handshake.subarray(0, HANDSHAKE_OK.length);
      if (!response.equals(HANDSHAKE_OK)) {
        this._socket?.destroy(new Error('ESP32-S3 握手响应无效'));
        return;
      }
      this._handshake = this._handshake.subarray(HANDSHAKE_OK.length);
      this.isOpen = true;
      this.emit('diagnostic', { state: 'handshake_ok' });
      this._hasOpened = true;
      this._retryAttempt = 0;
      this.emit('open');
      this._settleInitial();
      const payload = this._handshake;
      this._handshake = Buffer.alloc(0);
      if (payload.length) this.emit('data', payload);
      return;
    }
    this.emit('data', chunk);
  }

  _settleInitial(error) {
    if (this._initialSettled) return;
    this._initialSettled = true;
    this._initialCallback(error);
  }

  _scheduleReconnect() {
    if (this._retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this._retryAttempt, RETRY_DELAYS_MS.length - 1)];
    this._retryAttempt++;
    this.emit('diagnostic', { state: 'reconnect_scheduled', attempt: this._retryAttempt, delayMs: delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, delay);
  }
}

export function parseTcpPath(value) {
  const match = /^TCP:\/\/([^:]+):(\d+)$/.exec(value ?? '');
  if (!match) throw new Error('Wi-Fi 地址格式应为 TCP://主机:端口');
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TCP 端口必须为 1~65535');
  return { host: match[1], port };
}
