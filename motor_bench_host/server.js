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

/** 串口实例,未连接时为 null */
let serialPort = null;
let heartbeatTimer = null;
let heartbeatBurstTimer = null;

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
      writeToSerial(
        buildBind(cmd.channelId, {
          kind: cmd.kind,
          canBus: cmd.canBus,
          motorId: cmd.motorId,
          /*
           * @attention 默认值与固件建电机时的配置保持一致:
           *   SPEED_AND_CURRENT_LOOP(速度外环 + 电流内环)。
           * 原先默认是单环 SPEED_LOOP(2),而固件建电机用 3 ——
           * 上位机旧版本若不传 outerLoop,就会静默降级成"没有电流内环",
           * 表现为低速爬行差、负载突变时跟随不上,且没有任何报错。
           */
          outerLoop: cmd.outerLoop ?? LoopType.SPEED_AND_CURRENT_LOOP,
        }),
      );
      break;
    case 'setRef':
      writeToSerial(buildSetRef(cmd.channelId, Number(cmd.ref)));
      break;
    case 'enable':
      if (cmd.enable) {
        const ref = Number(cmd.ref ?? 0);
        if (!Number.isFinite(ref)) {
          broadcast({ type: 'error', message: '目标值必须为有限数值' });
          break;
        }
        // Firmware enables at zero. Apply the value actually shown in this card,
        // including zero, in the same serial write and in protocol order.
        writeToSerial(Buffer.concat([
          buildEnable(cmd.channelId, true), buildSetRef(cmd.channelId, ref),
        ]));
      } else {
        writeToSerial(buildEnable(cmd.channelId, false));
      }
      break;
    case 'stopAll':
      writeToSerial(buildAllStop());
      break;
    case 'resetChannels':
      // Start with channel 0. The page sends the next unbind after each ACK.
      // Serial writes do not define USB packet boundaries; avoid a 61-byte burst.
      writeToSerial(Buffer.concat([buildAllStop(), buildUnbind(0)]));
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
  ws.send(JSON.stringify({ type: 'hello', protocol: 'motor-bench/1.0', capabilities: ['resetChannels'] }));
  // A page reload does not close the Node-owned USB serial connection.
  ws.send(JSON.stringify({ type: 'serial', open: !!serialPort?.isOpen,
    path: serialPort?.path, baud: serialPort?.baudRate }));

  ws.on('message', (data) => {
    let cmd;
    try {
      cmd = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (cmd.type === 'listPorts') {
      listSerialPorts().catch((e) =>
        ws.send(JSON.stringify({ type: 'error', message: `枚举串口失败: ${e.message}` })),
      );
    } else if (cmd.type === 'openSerial') {
      openSerial(cmd.path, cmd.baud ?? args.baud)
        .then((info) => ws.send(JSON.stringify({ type: 'serial', open: true, ...info })))
        .catch((e) => ws.send(JSON.stringify({ type: 'error', message: `打开串口失败: ${e.message}` })));
    } else if (cmd.type === 'closeSerial') {
      closeSerial()
        .then(() => {
          if (!serialPort?.isOpen) ws.send(JSON.stringify({ type: 'serial', open: false }));
        })
        .catch((e) => ws.send(JSON.stringify({ type: 'error', message: `关闭串口失败: ${e.message}` })));
    } else if (cmd.type === 'scanMotors') {
      // 向板端询问"这块板上登记了哪些电机",界面据此列出可选项
      writeToSerial(buildInventoryQuery());
    } else if (cmd.type === 'addMotor') {
      /*
       * 动态创建电机:按用户填写的实际电调拨码 ID 下发给板端。
       * 板端负责校验(rx_id 冲突 / 过滤器耗尽)并回应答帧 0x8A,
       * 界面据 MBResultText 显示具体原因。
       *
       * @param rxId 反馈 ID(2026-10-17 新增,达妙 DM 专用)。
       *   DJI 系传 0 或不传(默认 0) —— 驱动的 rx_id 内部算;
       *   DM 系必须传电机实际的反馈 ID,否则板端收不到回传。
       *
       * @attention 这里的失败应答是"本机就没发出去",与板端拒绝是两回事,
       *   必须给出对应错误码 —— 早前误用了 NO_RESOURCE(资源不足),
       *   会让用户以为是板子上过滤器用完了,排查方向完全跑偏。
       */
      const { kind, canBus, motorId, rxId = 0 } = cmd;
      if (!Number.isInteger(rxId) || rxId < 0 || rxId > 0x7ff) {
        ws.send(JSON.stringify({ type: 'error', message: '反馈 ID 必须为 0~2047 的整数' }));
        return;
      }
      if (!writeToSerial(buildMotorAdd(kind, canBus, motorId, rxId))) {
        ws.send(JSON.stringify({
          type: 'motorAck',
          data: { result: MBResult.BAD_PARAM, kind, canBus, motorId,
                  channelId: 0xff, detail: 0 },
        }));
        ws.send(JSON.stringify({ type: 'error', message: '串口未连接,请先打开串口' }));
      }
    } else if (cmd.type === 'removeMotor') {
      /* rxId 须与添加时一致,否则板端找不到目标返回 NOT_PROVISIONED */
      const { kind, canBus, motorId, rxId = 0 } = cmd;
      if (!Number.isInteger(rxId) || rxId < 0 || rxId > 0x7ff) {
        ws.send(JSON.stringify({ type: 'error', message: '反馈 ID 必须为 0~2047 的整数' }));
        return;
      }
      if (!writeToSerial(buildMotorRemove(kind, canBus, motorId, rxId))) {
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
          data: { channelId, result: MBResult.BAD_PARAM },
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

  ws.on('close', () => broadcast({ type: 'clients', count: wss.clients.size }));
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
          if (tm) broadcast({ type: 'telemetry', data: tm });
        } else if (fr.type === FrameType.INVENTORY_REPORT) {
          const inv = parseInventory(fr.payload);
          if (inv) broadcast({ type: 'inventory', data: inv });
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
          if (ack) broadcast({ type: 'unbindAck', data: ack });
        }
      }
    });
    sp.on('error', (e) => broadcast({ type: 'error', message: `串口错误: ${e.message}` }));
    sp.on('close', () => {
      if (serialPort && serialPort !== sp) return;
      if (serialPort === sp) serialPort = null;
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
  const closingPort = serialPort;
  serialPort = null;
  if (closingPort && closingPort.isOpen) {
    await new Promise((resolve, reject) => closingPort.close((error) => error ? reject(error) : resolve()));
  }
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
  heartbeatBurstTimer = setInterval(() => {
    writeToSerial(buildHeartbeat());
    if (++burst >= 8) {
      clearInterval(heartbeatBurstTimer); // 8 × 30ms ≈ 240ms
      heartbeatBurstTimer = null;
    }
  }, 30);

  heartbeatTimer = setInterval(() => writeToSerial(buildHeartbeat()), 200);
}
function stopHeartbeat() {
  if (heartbeatBurstTimer) {
    clearInterval(heartbeatBurstTimer);
    heartbeatBurstTimer = null;
  }
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
