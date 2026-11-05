import {
  FrameParser,
  FrameType,
  LoopType,
  buildAllStop,
  buildBind,
  buildEnable,
  buildHeartbeat,
  buildInventoryQuery,
  buildMotorAdd,
  buildMotorRemove,
  buildPidQuery,
  buildPositionStep,
  buildQuery,
  buildSetLoop,
  buildSetPid,
  buildSetRef,
  buildUnbind,
  parseHeartbeatAck,
  parseInventory,
  parseLoopSetAck,
  parseMotorAddAck,
  parsePidReport,
  parsePidSetAck,
  parsePositionStepAck,
  parseTelemetry,
  parseUnbindAck,
} from './protocol.js';

let tcpPath = 'TCP://192.168.4.1:7000';
const parser = new FrameParser();
let socket;
let connected = false;
let heartbeatTimer = null;
let burstTimer = null;

function emit(message) {
  socket.onmessage?.({ data: JSON.stringify(message) });
}

function encode(frame) {
  let binary = '';
  for (const byte of frame) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function write(...frames) {
  if (!connected) {
    emit({ type: 'error', message: 'ESP32-S3 未连接，指令未下发' });
    return false;
  }
  window.MotorBenchAndroid.sendBytes(encode(Buffer.concat(frames)));
  return true;
}

function sendHeartbeat() {
  write(buildHeartbeat());
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  let burst = 0;
  burstTimer = setInterval(() => {
    sendHeartbeat();
    if (++burst === 8) {
      clearInterval(burstTimer);
      burstTimer = null;
    }
  }, 30);
  heartbeatTimer = setInterval(sendHeartbeat, 200);
}

function stopHeartbeat() {
  clearInterval(burstTimer);
  clearInterval(heartbeatTimer);
  burstTimer = heartbeatTimer = null;
}

function onFrame(frame) {
  const parsers = {
    [FrameType.HEARTBEAT]: parseHeartbeatAck,
    [FrameType.TELEMETRY]: parseTelemetry,
    [FrameType.INVENTORY_REPORT]: parseInventory,
    [FrameType.MOTOR_ADD_ACK]: parseMotorAddAck,
    [FrameType.PID_REPORT]: parsePidReport,
    [FrameType.PID_SET_ACK]: parsePidSetAck,
    [FrameType.UNBIND_ACK]: parseUnbindAck,
    [FrameType.LOOP_SET_ACK]: parseLoopSetAck,
    [FrameType.POSITION_STEP_ACK]: parsePositionStepAck,
  };
  const typeNames = {
    [FrameType.HEARTBEAT]: 'heartbeat',
    [FrameType.TELEMETRY]: 'telemetry',
    [FrameType.INVENTORY_REPORT]: 'inventory',
    [FrameType.MOTOR_ADD_ACK]: 'motorAck',
    [FrameType.PID_REPORT]: 'pidReport',
    [FrameType.PID_SET_ACK]: 'pidAck',
    [FrameType.UNBIND_ACK]: 'unbindAck',
    [FrameType.LOOP_SET_ACK]: 'loopAck',
    [FrameType.POSITION_STEP_ACK]: 'positionStepAck',
  };
  const parse = parsers[frame.type];
  if (!parse) return;
  const data = parse(frame.payload);
  if (data) emit({ type: typeNames[frame.type], data });
}

function onTcpOpened(path = tcpPath) {
  if (connected) return;
  connected = true;
  emit({ type: 'serial', open: true, path, baud: 115200 });
  startHeartbeat();
  write(buildInventoryQuery());
}

function onTcpClosed(reason = '') {
  if (!connected) return;
  connected = false;
  stopHeartbeat();
  parser.buffer = Buffer.alloc(0);
  emit({ type: 'serial', open: false, path: tcpPath });
  if (reason) emit({ type: 'error', message: `ESP32-S3 Wi-Fi TCP 已断开：${reason}` });
}

window.__motorBenchAndroidOpened = onTcpOpened;
window.__motorBenchAndroidClosed = onTcpClosed;
window.__motorBenchAndroidData = base64 => {
  for (const frame of parser.push(Buffer.from(base64, 'base64'))) onFrame(frame);
};
window.__motorBenchAndroidPause = () => {
  window.dispatchEvent(new Event('motorbenchpause'));
  if (connected) write(buildAllStop());
};
window.__motorBenchAndroidWifiState = text => {
  const status = document.querySelector('#wifiStatus');
  if (status) status.textContent = text;
};

function handleCommand(command) {
  switch (command.type) {
    case 'listPorts':
      emit({ type: 'ports', ports: [] });
      break;
    case 'connectWifi':
      tcpPath = `TCP://${command.host}:${command.port}`;
      window.MotorBenchAndroid.connectWifi(command.host, command.port);
      break;
    case 'closeSerial':
      if (connected) write(buildAllStop());
      stopHeartbeat();
      window.MotorBenchAndroid.closeTcp();
      onTcpClosed();
      break;
    case 'scanMotors': write(buildInventoryQuery()); break;
    case 'bind':
      write(buildBind(command.channelId, {
        kind: command.kind,
        canBus: command.canBus,
        motorId: command.motorId,
        outerLoop: command.outerLoop ?? LoopType.SPEED_AND_CURRENT_LOOP,
      }));
      break;
    case 'setRef': write(buildSetRef(command.channelId, Number(command.ref))); break;
    case 'enable':
      if (command.enable) write(buildEnable(command.channelId, true), buildSetRef(command.channelId, Number(command.ref ?? 0)));
      else write(buildEnable(command.channelId, false));
      break;
    case 'positionStep': write(buildPositionStep(command.channelId, command.requestId, command.delta, command.tolerance)); break;
    case 'stopAll': write(buildAllStop()); break;
    case 'resetChannels': write(buildAllStop(), buildUnbind(0)); break;
    case 'query': write(buildQuery()); break;
    case 'addMotor': write(buildMotorAdd(command.kind, command.canBus, command.motorId, command.rxId ?? 0)); break;
    case 'removeMotor': write(buildMotorRemove(command.kind, command.canBus, command.motorId, command.rxId ?? 0)); break;
    case 'unbind': write(buildUnbind(command.channelId)); break;
    case 'setLoop': write(buildSetLoop(command.channelId, command.mask)); break;
    case 'pidSet': write(buildSetPid(command.channelId, command.loop, command.pid ?? {})); break;
    case 'pidQuery': write(buildPidQuery(command.channelId)); break;
    default: emit({ type: 'error', message: `Android 通信不支持指令：${command.type}` });
  }
}

export function createAndroidSocket(native) {
  socket = {
    readyState: 0,
    onopen: null,
    onclose: null,
    onmessage: null,
    send: data => {
      try {
        handleCommand(JSON.parse(data));
      } catch (error) {
        emit({ type: 'error', message: error.message });
      }
    },
    close: () => native.closeTcp(),
  };
  queueMicrotask(() => {
    socket.readyState = 1;
    socket.onopen?.();
    emit({ type: 'hello', protocol: 'motor-bench/1.0', capabilities: ['resetChannels', 'setLoop', 'positionStep', 'positionStepTolerance', 'wifiTcp'] });
    emit({ type: 'ports', ports: [] });
    emit({ type: 'serial', open: false });
  });
  return socket;
}
