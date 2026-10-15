/**
 * server.js —— 电机测试台上位机服务
 *
 * 职责:把浏览器(WebSocket)与 A 板串口连起来。
 *   浏览器 --WebSocket--> 本服务 --USB 串口--> A 板(UART7/8) --CAN--> 电机
 *
 * 运行:
 *   npm install          (安装 serialport 与 ws)
 *   node server.js       (默认监听 http://localhost:8080)
 *   PORT=9000 node server.js
 *   串口可用 --port 参数指定,如:node server.js --port COM5 --baud 115200
 *
 * @note  安全:本服务只监听 127.0.0.1。若需要让手机/平板在同一局域网访问,
 *        用 --host 0.0.0.0 显式开启,并自行确认实验室网络环境可信
 *        (开启后任何同网设备都能控制电机)。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ChannelBindings } from './channel_bindings.js';
import {
  FrameParser,
  FrameType,
  MotorKind,
  LoopType,
  buildBind,
  buildSetRef,
  buildEnable,
  buildAllStop,
  buildHeartbeat,
  buildQuery,
  buildInventoryQuery,
  buildMotorAdd,
  buildMotorRemove,
  buildUnbind,
  buildControlSource,
  buildChassisControl,
  buildChassisEnable,
  parseControlReport,
  parseUnbindAck,
  buildSetPid,
  buildPidQuery,
  parsePidReport,
  parsePidSetAck,
  parseHeartbeatAck,
  parseTelemetry,
  parseInventory,
  parseMotorAddAck,
  MBResult,
} from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = { port: 3000, baud: 115200, host: '127.0.0.1', serial: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      const v = argv[++i];
      if (/^\d+$/.test(v)) out.port = Number(v);
      else out.serial = v;
    } else if (a === '--baud' || a === '-b') {
      out.baud = Number(argv[++i]);
    } else if (a === '--host') {
      out.host = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log('用法: node server.js [--port 3000] [--serial COM5] [--baud 115200] [--host 127.0.0.1]');
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

/* ---------------- 静态文件服务 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safe);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */

const wss = new WebSocketServer({ server });
const parser = new FrameParser();
const channelBindings = new ChannelBindings();

function bindingReport() {
  return { type: 'bindings', data: { items: channelBindings.snapshot() } };
}

/** 串口实例,未连接时为 null */
let serialPort = null;
let heartbeatTimer = null;

/** 向所有浏览器广播 */
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

/** 通过串口发原始字节 */
/**
 * 把一帧写入串口
 * @returns {boolean} 是否真的发出去了
 *
 * @note 必须返回布尔值:调用方(如 addMotor)据此判断要不要给浏览器回一个
 *       "没发出去"的失败应答。若返回 undefined,`!writeToSerial(...)`
 *       恒为真,每一次添加都会被误判成失败。
 */
/* ---------------- 收包诊断计数(排查上行不通时用) ---------------- */
let rxDiagCount = 0;
let rxTotalBytes = 0;

function writeToSerial(buf) {
  if (serialPort && serialPort.isOpen) {
    serialPort.write(buf);
    return true;
  }
  broadcast({ type: 'error', message: '串口未连接,指令未下发' });
  return false;
}

/**
 * 把浏览器发来的 JSON 指令翻译成协议帧
 * @param {object} cmd
 */
function handleCommand(cmd) {
  switch (cmd.type) {
    case 'bind':
      if (writeToSerial(
        buildBind(cmd.channelId, {
          kind: cmd.kind,
          canBus: cmd.canBus,
          motorId: cmd.motorId,
          outerLoop: cmd.outerLoop ?? LoopType.SPEED_LOOP,
        }),
      )) channelBindings.request(cmd);
      break;
    case 'setRef':
      writeToSerial(buildSetRef(cmd.channelId, Number(cmd.ref)));
      break;
    case 'enable':
      writeToSerial(buildEnable(cmd.channelId, !!cmd.enable));
      break;
    case 'stopAll':
      writeToSerial(buildAllStop());
      break;
    case 'query':
      writeToSerial(buildQuery());
      break;
    default:
      broadcast({ type: 'error', message: `未知指令: ${cmd.type}` });
  }
}

wss.on('connection', (ws) => {
  broadcast({ type: 'clients', count: wss.clients.size });
  ws.send(JSON.stringify({ type: 'hello', protocol: 'motor-bench/1.0' }));
  ws.send(JSON.stringify(bindingReport()));

  ws.on('message', (data) => {
    let cmd;
    try {
      cmd = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (cmd.type === 'identifyChannel') {
      // Display metadata supplied by the user; never send this to the motor.
      channelBindings.identify(cmd);
      broadcast(bindingReport());
    } else if (cmd.type === 'controlSource') {
      try {
        writeToSerial(cmd.source >= 2
          ? buildChassisControl(cmd.source, cmd.channels, Number(cmd.maxRef), cmd.reverseMask)
          : buildControlSource(cmd.source, cmd.channelId, Number(cmd.maxRef)));
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    } else if (cmd.type === 'chassisEnable') {
      try { writeToSerial(buildChassisEnable(cmd.enable)); }
      catch (error) { ws.send(JSON.stringify({ type: 'error', message: error.message })); }
    } else if (cmd.type === 'listPorts') {
      listSerialPorts().catch((e) =>
        ws.send(JSON.stringify({ type: 'error', message: `枚举串口失败: ${e.message}` })),
      );
    } else if (cmd.type === 'openSerial') {
      openSerial(cmd.path, cmd.baud ?? args.baud)
        .then((info) => ws.send(JSON.stringify({ type: 'serial', open: true, ...info })))
        .catch((e) => ws.send(JSON.stringify({ type: 'error', message: `打开串口失败: ${e.message}` })));
    } else if (cmd.type === 'closeSerial') {
      closeSerial();
      ws.send(JSON.stringify({ type: 'serial', open: false }));
    } else if (cmd.type === 'scanMotors') {
      // 向板端询问"这块板上登记了哪些电机",界面据此列出可选项
      writeToSerial(buildInventoryQuery());
    } else if (cmd.type === 'addMotor') {
      /*
       * 动态创建电机:按用户填写的实际电调拨码 ID 下发给板端。
       * 板端负责校验(rx_id 冲突 / 过滤器耗尽)并回应答帧 0x8A,
       * 界面据 MBResultText 显示具体原因。
       *
       * @attention 这里的失败应答是"本机就没发出去",与板端拒绝是两回事,
       *   必须给出对应错误码 —— 早前误用了 NO_RESOURCE(资源不足),
       *   会让用户以为是板子上过滤器用完了,排查方向完全跑偏。
       */
      const { kind, canBus, motorId } = cmd;
      if (!writeToSerial(buildMotorAdd(kind, canBus, motorId))) {
        ws.send(JSON.stringify({
          type: 'motorAck',
          data: { result: MBResult.BAD_PARAM, kind, canBus, motorId,
                  channelId: 0xff, detail: 0 },
        }));
        ws.send(JSON.stringify({ type: 'error', message: '串口未连接,请先打开串口' }));
      }
    } else if (cmd.type === 'removeMotor') {
      const { kind, canBus, motorId } = cmd;
      if (!writeToSerial(buildMotorRemove(kind, canBus, motorId))) {
        ws.send(JSON.stringify({
          type: 'motorAck',
          data: { result: MBResult.BAD_PARAM, kind, canBus, motorId,
                  channelId: 0xff, detail: 0 },
        }));
        ws.send(JSON.stringify({ type: 'error', message: '串口未连接,请先打开串口' }));
      }
    } else if (cmd.type === 'unbind') {
      /*
       * 解绑通道:释放固件侧的通道占用,使该通道能改绑别的电机。
       *
       * @attention 不能用 enable=0 代替。只停机不解绑的话,
       *   mb_channels[ch].is_used 仍是 1,下一次 bind 会撞上
       *   MB_ERR_DUPLICATE 被静默拒绝 —— 界面以为换成功了,实际没换。
       */
      const { channelId } = cmd;
      if (!writeToSerial(buildUnbind(channelId))) {
        ws.send(JSON.stringify({
          type: 'unbindAck',
          data: { channelId, result: MBResult.BAD_PARAM, boardConfirmed: false },
        }));
        ws.send(JSON.stringify({ type: 'error', message: '串口未连接,请先打开串口' }));
      }
    } else if (cmd.type === 'pidSet') {      /*
       * 运行期写入 PID。板端回 0x8C 帧确认,驱动前会停机并清历史量。
       *
       * @attention 未使能也允许下发 —— 整定本来就是"电机不转时先把参数调好"。
       *   这与 MOTOR_SET 不同(那条要求已使能,防止误转)。
       */
      const { channelId, loop, pid } = cmd;
      if (!writeToSerial(buildSetPid(channelId, loop, pid || {}))) {
        ws.send(JSON.stringify({
          type: 'pidAck',
          data: { channelId, loop, result: MBResult.BAD_PARAM, detail: 0 },
        }));
        ws.send(JSON.stringify({ type: 'error', message: '串口未连接,请先打开串口' }));
      }
    } else if (cmd.type === 'pidQuery') {
      const { channelId } = cmd;
      if (!writeToSerial(buildPidQuery(channelId))) {
        ws.send(JSON.stringify({ type: 'error', message: '串口未连接,请先打开串口' }));
      }
    } else {
      handleCommand(cmd);
    }
  });

  ws.on('close', () => {
    if (wss.clients.size === 0 && serialPort?.isOpen) writeToSerial(buildAllStop());
    broadcast({ type: 'clients', count: wss.clients.size });
  });
});

/* ---------------- 串口 ---------------- */

let SerialPortModule = null;
async function getSerialPortModule() {
  if (SerialPortModule) return SerialPortModule;
  SerialPortModule = await import('serialport');
  return SerialPortModule;
}

async function listSerialPorts() {
  const { SerialPort } = await getSerialPortModule();
  const ports = await SerialPort.list();
  broadcast({ type: 'ports', ports: ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer })) });
}

async function openSerial(portPath, baud) {
  const { SerialPort } = await getSerialPortModule();
  if (serialPort && serialPort.isOpen) await closeSerial();

  return new Promise((resolve, reject) => {
    const sp = new SerialPort(
      { path: portPath, baudRate: baud, autoOpen: true },
      (err) => {
        if (err) return reject(err);
        channelBindings.reset();
        broadcast({ type: 'serial', open: true, path: portPath, baud });
        startHeartbeat();
        // 立刻拉一次电机清单,让界面马上知道这块板能测哪些电机
        sp.write(buildInventoryQuery());
        resolve({ path: portPath, baud });
      },
    );
    sp.on('data', (chunk) => {
      /*
       * 【诊断】原始收包日志。
       * 固件侧已用 [tx] COMPLETE 证明数据离开了芯片,若这里仍然没有任何输出,
       * 说明数据没到主机;若这里有字节但界面无反应,则是解析或广播环节的问题。
       * 只打印前若干包,避免 50Hz 遥测刷屏。
       */
      rxDiagCount += 1;
      if (rxDiagCount <= 10 || process.env.MB_VERBOSE_RX) {
        const hex = chunk.subarray(0, 32).toString('hex').match(/../g)?.join(' ') ?? '';
        console.log(`[RX] +${chunk.length}B  ${hex}${chunk.length > 32 ? ' ...' : ''}`);
      }
      rxTotalBytes += chunk.length;

      for (const fr of parser.push(chunk)) {
        if (fr.type === FrameType.HEARTBEAT) {
          const ack = parseHeartbeatAck(fr.payload);
          if (ack) broadcast({ type: 'heartbeat', data: ack });
        } else if (fr.type === FrameType.TELEMETRY) {
          const tm = parseTelemetry(fr.payload);
          if (tm) {
            if (channelBindings.telemetry(tm.items)) broadcast(bindingReport());
            broadcast({ type: 'telemetry', data: tm });
          }
        } else if (fr.type === FrameType.INVENTORY_REPORT) {
          const inv = parseInventory(fr.payload);
          if (inv) {
            channelBindings.inventory(inv.items);
            broadcast(bindingReport());
            broadcast({ type: 'inventory', data: inv });
          }
        } else if (fr.type === FrameType.MOTOR_ADD_ACK) {
          const ack = parseMotorAddAck(fr.payload);
          if (ack) broadcast({ type: 'motorAck', data: ack });
        } else if (fr.type === FrameType.PID_REPORT) {
          const rep = parsePidReport(fr.payload);
          if (rep) broadcast({ type: 'pidReport', data: rep });
        } else if (fr.type === FrameType.PID_SET_ACK) {
          const ack = parsePidSetAck(fr.payload);
          if (ack) broadcast({ type: 'pidAck', data: ack });
        } else if (fr.type === FrameType.UNBIND_ACK) {
          const ack = parseUnbindAck(fr.payload);
          if (ack) {
            channelBindings.unbind(ack);
            broadcast({ type: 'unbindAck', data: ack });
            broadcast(bindingReport());
          }
        } else if (fr.type === FrameType.CONTROL_REPORT) {
          const report = parseControlReport(fr.payload);
          if (report) broadcast({ type: 'controlReport', data: report });
        }
      }
    });
    sp.on('error', (e) => broadcast({ type: 'error', message: `串口错误: ${e.message}` }));
    sp.on('close', () => {
      channelBindings.reset();
      broadcast({ type: 'serial', open: false });
      stopHeartbeat();
      console.log(`[RX] 本次连接累计收到 ${rxTotalBytes} 字节,共 ${rxDiagCount} 个数据包`);
      rxDiagCount = 0;
      rxTotalBytes = 0;
    });
    serialPort = sp;
  });
}

async function closeSerial() {
  stopHeartbeat();
  if (serialPort && serialPort.isOpen) {
    await new Promise((r) => serialPort.close(() => r()));
  }
  serialPort = null;
}

/**
 * 心跳:200ms 一次
 * @note 与固件 MB_LINK_TIMEOUT_COUNT(守护计数 5,守护任务 100Hz)配合,
 *       约 1 秒收不到心跳,板端会自动全停。这是链路保护的核心。
 */
function startHeartbeat() {
  stopHeartbeat();
  writeToSerial(buildHeartbeat());

  /*
   * 打开串口时先密集发几次心跳。
   * @attention 板端有一条安全门闩:心跳尚未建立(link_online=0)时,
   *   会拒收建/拆电机等指令。若只每 200ms 发一次,
   *   用户在打开串口后立刻点"添加",很可能落在第一个心跳到达之前,
   *   于是被静默拒绝 —— RTT 里能看到 "REJECTED motor 0x08 by link gate"。
   *   这里在开场密集补发几个,把建链时间压到几十毫秒内。
   */
  let burst = 0;
  const burstTimer = setInterval(() => {
    writeToSerial(buildHeartbeat());
    if (++burst >= 8) clearInterval(burstTimer); // 8 × 30ms ≈ 240ms
  }, 30);

  heartbeatTimer = setInterval(() => writeToSerial(buildHeartbeat()), 200);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/* ---------------- 退出时确保电机停止 ---------------- */

async function shutdown() {
  console.log('\n正在关闭:先下发全停指令…');
  try {
    if (serialPort && serialPort.isOpen) {
      serialPort.write(buildAllStop());
      await new Promise((r) => setTimeout(r, 120)); // 等一帧真正发出去
    }
  } catch {
    /* 忽略 */
  }
  await closeSerial();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---------------- 启动 ---------------- */

server.listen(args.port, args.host, () => {
  console.log(`电机测试台上位机已启动: http://${args.host}:${args.port}`);
  console.log(`默认串口波特率: ${args.baud}`);
  console.log('按 Ctrl+C 退出(退出时会自动下发全停)');
});
