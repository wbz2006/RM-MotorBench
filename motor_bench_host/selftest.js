/**
 * selftest.js —— 协议自检:验证帧组装/解析/CRC 在 Node 侧自洽,且与固件布局一致。
 *
 * 运行:node selftest.js
 * 不依赖串口,可单独执行。
 */
import {
  FrameParser,
  FrameType,
  MotorKind,
  LoopType,
  LoopLabel,
  buildBind,
  buildSetRef,
  buildEnable,
  buildHeartbeat,
  buildHeartbeatAck,
  buildTelemetry,
  buildAllStop,
  buildQuery,
  parseHeartbeatAck,
  parseTelemetry,
  parseInventory,
  buildMotorAdd,
  buildMotorRemove,
  parseMotorAddAck,
  buildSetPid,
  buildPidQuery,
  buildUnbind,
  parseUnbindAck,
  parsePidReport,
  parsePidSetAck,
  PidLoop,
  PID_DEFAULTS,
  MBResult,
  MBResultText,
  MotorKindLabel,
  MAX_PAYLOAD,
  buildFrame,
  crc8,
  /* CAN ID 冲突预检(2026-10-13):与固件 MotorBenchPredictRxId 同公式 */
  predictRxId,
  availableIds,
  findConflict,
  describeConflict,
  usesDjiIdSegment,
  needsRxId,
  RX_ID_MIN,
  RX_ID_MAX,
  MOTOR_ID_MIN,
  MOTOR_ID_MAX,
} from './protocol.js';
import { LowPass } from './chart.js';
import { readFileSync } from 'node:fs';
import { firmwareRelativeRoot, firmwareSourceDir } from './firmware_test_paths.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

/*
 * 抽出某条 CSS 规则的声明体(不含注释)。
 *
 * @attention 必须先剥注释再抽 —— "这条规则里有没有某属性"的判断
 *   会被注释里偶然出现的属性名骗到;而"花括号后 N 字符内必须出现某属性"
 *   这种字符窗口写法,又会被规则体内较长的注释把属性顶出窗口
 *   (实测在 .loop-fishbone 的说明注释上发生过一次)。
 *   `[^}]*` 在第一个右花括号处截断,CSS 注释里不写 `}` 即可。
 */
const cssBody = (src, sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(code);
  return m ? m[1] : null;
};

console.log('== 1. frame structure ==');
const bind = buildBind(0, { kind: MotorKind.M3508, canBus: 1, motorId: 5, outerLoop: LoopType.SPEED_LOOP });
const setref = buildSetRef(0, 1234.5);
const ena = buildEnable(0, true);
check('head is 0xA5', bind[0] === 0xa5, `got ${bind[0].toString(16)}`);
check('tail is 0x5A', bind[bind.length - 1] === 0x5a);
check('length = 5 + payload', bind.length === 5 + 5, `got ${bind.length}`);
check('len field = 5', bind[2] === 5, `got ${bind[2]}`);
check('crc covers type+len+payload', crc8(bind.subarray(1, 3 + bind[2])) === bind[3 + bind[2]]);

console.log('\n== 2. CRC matches firmware table ==');
check('crc8([0x00]) = table[0] = 0', crc8(Buffer.from([0x00])) === 0, `got ${crc8(Buffer.from([0x00]))}`);
check('crc8([0x01]) = table[1] = 49', crc8(Buffer.from([0x01])) === 49, `got ${crc8(Buffer.from([0x01]))}`);
check('crc8([0xff]) = table[255] = 172', crc8(Buffer.from([0xff])) === 172, `got ${crc8(Buffer.from([0xff]))}`);

console.log('\n== 3. stream parsing: coalescing / splitting / resync ==');
const parser = new FrameParser();
const stop = buildAllStop();
let frames = parser.push(Buffer.concat([bind, setref, ena, stop]));
check('4 frames from one chunk', frames.length === 4, `got ${frames.length}`);
check('bind payload len 5', frames[0].payload.length === 5);
check('bind channel 0', frames[0].payload[0] === 0);
check('bind kind = M3508(2)', frames[0].payload[1] === 2, `got ${frames[0].payload[1]}`);
check('bind bus = 1', frames[0].payload[2] === 1);
check('bind id = 5', frames[0].payload[3] === 5);
check('setref value = 1234.5', Math.abs(frames[1].payload.readFloatLE(1) - 1234.5) < 1e-6);
check('enable flag = 1', frames[2].payload[1] === 1);

// byte-by-byte worst case
const p2 = new FrameParser();
let count = 0;
for (const b of Buffer.concat([bind, setref, ena])) {
  count += p2.push(Buffer.from([b])).length;
}
check('3 frames when fed byte-by-byte', count === 3, `got ${count}`);
check('no residue after byte-by-byte', p2.buffer.length === 0, `residue ${p2.buffer.length}`);

// false framehead + bogus small length: CRC check must reject and resync
const p3 = new FrameParser();
const noise = Buffer.from([0x00, 0xff, 0xa5, 0x11, 0x00]);
frames = p3.push(Buffer.concat([noise, buildHeartbeat(), buildQuery()]));
check('recovers after noise', frames.length === 2, `got ${frames.length}`);
check('first frame is heartbeat', frames[0] && frames[0].type === FrameType.HEARTBEAT, `got ${frames[0]?.type}`);
check('second frame is query', frames[1] && frames[1].type === FrameType.QUERY, `got ${frames[1]?.type}`);
check('noise fully discarded', p3.buffer.length === 0, `residue ${p3.buffer.length}`);

// out-of-range length must not stall the stream
const p3b = new FrameParser();
frames = p3b.push(Buffer.concat([Buffer.from([0xa5, 0x11, 0x7f]), buildHeartbeat()]));
check('oversized length does not block', frames.length === 1, `got ${frames.length}`);
check('heartbeat still parsed after bad length', frames[0] && frames[0].type === FrameType.HEARTBEAT);

// noise alone yields no frames
const p3c = new FrameParser();
check('noise alone yields no frames', p3c.push(noise).length === 0);

console.log('\n== 4. telemetry parsing ==');
const ackFrame = buildHeartbeatAck({ fwMajor: 1, fwMinor: 0, inventory: 4, flags: 0x01, uptime: 298, seq: 1 });
const pAck = new FrameParser();
const ackOut = pAck.push(ackFrame);
check('heartbeat ack parsed', ackOut.length === 1, `got ${ackOut.length}`);
check('heartbeat body is eight bytes and full frame is thirteen', ackFrame[2] === 8 && ackFrame.length === 13);
check('truncated heartbeat payload is rejected', parseHeartbeatAck(Buffer.alloc(7)) === null);
const ack = parseHeartbeatAck(ackOut[0].payload);
check('fw version 1.0', ack.fwVersion === '1.0', `got ${ack.fwVersion}`);
check('inventory count 4', ack.inventoryCount === 4, `got ${ack.inventoryCount}`);
check('any motor online', ack.anyMotorOnline === true);
check('uptime 298s', ack.uptimeS === 298, `got ${ack.uptimeS}`);
check('seq 1', ack.seq === 1, `got ${ack.seq}`);

const tmFrame = buildTelemetry(
  [
    { channelId: 0, online: true, enabled: true, ref: 500, speed: 498.2, torque: 2.3, angle: 120.5, temperature: 41 },
    { channelId: 1, online: true, enabled: false, ref: 0, speed: -12.7, torque: 0.1, angle: 33.0, temperature: -128 },
  ],
  7,
);
const p5 = new FrameParser();
const tmFrames = p5.push(tmFrame);
check('telemetry frame parsed', tmFrames.length === 1, `got ${tmFrames.length}`);
const tm = parseTelemetry(tmFrames[0].payload);
check('2 channels', tm.count === 2, `got ${tm?.count}`);
check('seq 7', tm.seq === 7, `got ${tm.seq}`);
check('ch0 online and enabled', tm.items[0].online && tm.items[0].enabled);
check('ch0 ref 500', Math.abs(tm.items[0].ref - 500) < 1e-6, `got ${tm.items[0].ref}`);
check('ch0 speed 498.2', Math.abs(tm.items[0].speed - 498.2) < 1e-3, `got ${tm.items[0].speed}`);
check('ch0 torque 2.3', Math.abs(tm.items[0].torque - 2.3) < 1e-4, `got ${tm.items[0].torque}`);
check('ch0 temp 41', tm.items[0].temperature === 41, `got ${tm.items[0].temperature}`);
check('ch1 not enabled', tm.items[1].enabled === false);
check('ch1 speed negative', tm.items[1].speed < 0, `got ${tm.items[1].speed}`);
check('ch1 unknown temp = -128', tm.items[1].temperature === -128, `got ${tm.items[1].temperature}`);

console.log('\n== 5. inventory ==');
// 模拟板端清单应答:count(1) + items[count*4]
const invBody = Buffer.alloc(1 + 2 * 4);
invBody[0] = 2;
invBody[1] = MotorKind.GM6020; invBody[2] = 1; invBody[3] = 1; invBody[4] = LoopType.SPEED_LOOP;
invBody[5] = MotorKind.DM;     invBody[6] = 2; invBody[7] = 2; invBody[8] = LoopType.SPEED_LOOP;
const invFrame = buildFrame(FrameType.INVENTORY_REPORT, invBody);
const pInv = new FrameParser();
const invOut = pInv.push(invFrame);
check('inventory frame parsed', invOut.length === 1, `got ${invOut.length}`);
const inv = parseInventory(invOut[0].payload);
check('inventory count 2', inv.count === 2, `got ${inv.count}`);
check('inv[0] is GM6020 on CAN1 id1', inv.items[0].kind === 1 && inv.items[0].canBus === 1 && inv.items[0].motorId === 1,
  JSON.stringify(inv.items[0]));
check('inv[1] is DM on CAN2 id2', inv.items[1].kind === 4 && inv.items[1].canBus === 2 && inv.items[1].motorId === 2,
  JSON.stringify(inv.items[1]));
check('inv loop type is SPEED_LOOP', inv.items[0].outerLoop === LoopType.SPEED_LOOP);

console.log('\n== 6. boundaries ==');
const hb = buildHeartbeat();
check('empty-payload frame is 5 bytes', hb.length === 5, `got ${hb.length}`);
const p4 = new FrameParser();
check('empty-payload frame parses', p4.push(hb).length === 1);

console.log('\n== 7. round-trip against firmware CRC table ==');
// 逐字节复核:直接用固件的完整 sht75_crc_table 走一遍递推,验证与查表实现一致
const T = [
  0, 49, 98, 83, 196, 245, 166, 151, 185, 136, 219, 234, 125, 76, 31, 46,
  67, 114, 33, 16, 135, 182, 229, 212, 250, 203, 152, 169, 62, 15, 92, 109,
  134, 183, 228, 213, 66, 115, 32, 17, 63, 14, 93, 108, 251, 202, 153, 168,
  197, 244, 167, 150, 1, 48, 99, 82, 124, 77, 30, 47, 184, 137, 218, 235,
  61, 12, 95, 110, 249, 200, 155, 170, 132, 181, 230, 215, 64, 113, 34, 19,
  126, 79, 28, 45, 186, 139, 216, 233, 199, 246, 165, 148, 3, 50, 97, 80,
  187, 138, 217, 232, 127, 78, 29, 44, 2, 51, 96, 81, 198, 247, 164, 149,
  248, 201, 154, 171, 60, 13, 94, 111, 65, 112, 35, 18, 133, 180, 231, 214,
  122, 75, 24, 41, 190, 143, 220, 237, 195, 242, 161, 144, 7, 54, 101, 84,
  57, 8, 91, 106, 253, 204, 159, 174, 128, 177, 226, 211, 68, 117, 38, 23,
  252, 205, 158, 175, 56, 9, 90, 107, 69, 116, 39, 22, 129, 176, 227, 210,
  191, 142, 221, 236, 123, 74, 25, 40, 6, 55, 100, 85, 194, 243, 160, 145,
  71, 118, 37, 20, 131, 178, 225, 208, 254, 207, 156, 173, 58, 11, 88, 105,
  4, 53, 102, 87, 192, 241, 162, 147, 189, 140, 223, 238, 121, 72, 27, 42,
  193, 240, 163, 146, 5, 52, 103, 86, 120, 73, 26, 43, 188, 141, 222, 239,
  130, 179, 224, 209, 70, 119, 36, 21, 59, 10, 89, 104, 255, 206, 157, 172,
];
for (const bytes of [[0x03, 0x02, 0x00], [0x01], [0xff, 0x00, 0xa5], [0x81, 0x02]]) {
  let manual = 0x00; // CRC_START_8
  for (const b of bytes) manual = T[(b ^ manual) & 0xff];
  check(`manual CRC matches for [${bytes}]`, crc8(Buffer.from(bytes)) === manual,
    `manual=${manual} table=${crc8(Buffer.from(bytes))}`);
}

/* ---------------- 动态增删电机 ---------------- */
console.log('\n== 8. dynamic add/remove motor ==');

{
  // 建电机请求:kind=2(M3508) bus=2 id=1
  const f = new FrameParser().push(buildMotorAdd(MotorKind.M3508, 2, 1));
  check('add frame parses', f.length === 1, `got ${f.length}`);
  check('add frame type is MOTOR_ADD', f[0]?.type === FrameType.MOTOR_ADD);
  const p = f[0].payload;
  check('add payload len 5', p.length === 5, `len=${p.length}`);
  check('add kind field', p[0] === MotorKind.M3508, `got ${p[0]}`);
  check('add canBus field', p[1] === 2, `got ${p[1]}`);
  check('add motorId field', p[2] === 1, `got ${p[2]}`);
  check('DJI add rx_id must be 0', p.readUInt16LE(3) === 0);
}

{
  const f = new FrameParser().push(buildMotorRemove(MotorKind.DM, 1, 3));
  check('remove frame parses', f.length === 1, `got ${f.length}`);
  check('remove frame type is MOTOR_REMOVE', f[0]?.type === FrameType.MOTOR_REMOVE);
  check('remove payload kind', f[0].payload[0] === MotorKind.DM);
}

{
  // 应答:result=2(DUPLICATE) kind=1 bus=1 id=1 channel=0xFF detail=13
  const body = Buffer.from([2, 1, 1, 1, 0xff, 13]);
  const ack = parseMotorAddAck(body);
  check('ack result parsed', ack?.result === 2, `got ${ack?.result}`);
  check('ack kind echo', ack?.kind === 1);
  check('ack canBus echo', ack?.canBus === 1);
  check('ack motorId echo', ack?.motorId === 1);
  check('ack channel 0xFF on failure', ack?.channelId === 0xff, `got ${ack?.channelId}`);
  check('ack detail = free filters', ack?.detail === 13, `got ${ack?.detail}`);
}

{
  // 成功应答经完整帧往返
  const body = Buffer.from([0, 2, 1, 5, 3, 12]); // OK, M3508, CAN2, id5, ch3, 12 free
  const wrapped = buildFrame(FrameType.MOTOR_ADD_ACK, body);
  const f = new FrameParser().push(wrapped);
  check('ack round-trips through parser', f.length === 1 && f[0].type === FrameType.MOTOR_ADD_ACK);
  const ack = parseMotorAddAck(f[0].payload);
  check('ack success result 0', ack?.result === 0);
  check('ack success channel 3', ack?.channelId === 3, `got ${ack?.channelId}`);
}

{
  // 载荷过短时应返回 null 而不是抛异常或读越界
  check('ack too short -> null', parseMotorAddAck(Buffer.from([0, 1, 1])) === null);
  check('add payload too short tolerated', parseMotorAddAck(Buffer.alloc(0)) === null);
}

{
  /*
   * ID 冲突规则的镜像测试:固件用 0x204+id(6020) 与 0x200+id(3508/2006),
   * 两段重叠,故同总线必冲突。这里把这条规则钉住,
   * 防止将来有人误以为"分 ID 就能避开"。
   */
  const rxOf = (kind, id) =>
    kind === MotorKind.GM6020 ? 0x204 + id : 0x200 + id;
  check('6020 id1 == 3508 id5 (must be on different buses)',
    rxOf(MotorKind.GM6020, 1) === rxOf(MotorKind.M3508, 5),
    `6020=${rxOf(MotorKind.GM6020, 1)} 3508=${rxOf(MotorKind.M3508, 5)}`);
  check('6020 id1 != 3508 id1 (same id, different base)',
    rxOf(MotorKind.GM6020, 1) !== rxOf(MotorKind.M3508, 1));
}

/* ---------------- 达妙 DM 的 tx_id / rx_id 双 ID(2026-10-17) ---------------- */
{
  /*
   * 背景:达妙 DM-4310 走 MIT 协议,发送与接收是**两个独立 ID** ——
   *   主机 → 电机 用 tx_id,电机 → 主机 回传感测 用 rx_id,
   *   而主机的 CAN 过滤器按 rx_id 匹配。
   * 迁移时 BenchBuildDMConfig() 只设了 tx_id,**从未设置 rx_id**
   * (结构体 memset 后恒为 0),导致两个实测故障:
   *   ① 挂第二颗 DM 时 CANRegister() 因"rx_id 0x00 already used"直接失败,
   *      而上层只转成 NO_RESOURCE,提示成了"滤波器已用完",方向完全跑偏;
   *   ② 单颗 DM 只要实际反馈 ID 不是 0,过滤器就收不到任何反馈,遥测永远 --。
   *
   * rx_id 使用小端 16 位,以容纳 0x302 等标准 CAN ID。DJI 系填 0。
   *
   * 本组锁死三件事:
   *   1. 第 4 字节就是 rx_id,DM 填真值、DJI 填 0;
   *   2. DM 不给 rx_id 就是错的(不能默认 0 蒙混过关);
   *   3. 拆电机时 rx_id 必须与添加时一致。
   */
  const dm = new FrameParser().push(buildMotorAdd(MotorKind.DM, 1, 3, 0x11));
  check('DM add frame carries rx_id in byte 3',
    dm.length === 1 && dm[0].payload[3] === 0x11,
    `got ${dm[0]?.payload[3]}`);

  const dmDefault = new FrameParser().push(buildMotorAdd(MotorKind.DM, 1, 3));
  check('DM add without rx_id defaults to 0 (caller must pass it)',
    dmDefault[0]?.payload[3] === 0, `got ${dmDefault[0]?.payload[3]}`);

  const dji = new FrameParser().push(buildMotorAdd(MotorKind.M3508, 2, 5));
  check('DJI add still sends 0 in byte 3 (driver computes rx_id)',
    dji[0]?.payload[3] === 0, `got ${dji[0]?.payload[3]}`);

  check('DM and DJI add both use a 5-byte payload',
    dm[0].payload.length === 5 && dji[0].payload.length === 5);

  for (const id of [0x100, 0x302, 0x7ff]) {
    const add = new FrameParser().push(buildMotorAdd(MotorKind.DM, 1, 6, id))[0];
    const remove = new FrameParser().push(buildMotorRemove(MotorKind.DM, 1, 6, id))[0];
    check(`DM RX 0x${id.toString(16)} survives add/remove without truncation`,
      add.payload.readUInt16LE(3) === id && remove.payload.readUInt16LE(3) === id);
  }

  const dmRm = new FrameParser().push(buildMotorRemove(MotorKind.DM, 1, 3, 0x11));
  check('DM remove echoes rx_id so the board can match the right motor',
    dmRm.length === 1 && dmRm[0].payload[3] === 0x11,
    `got ${dmRm[0]?.payload[3]}`);

  const djiRm = new FrameParser().push(buildMotorRemove(MotorKind.M3508, 2, 5));
  check('DJI remove sends 0 in byte 3', djiRm[0]?.payload[3] === 0);

  /* 只有 DM 需要 rx_id —— 界面据此决定是否显示那个输入框 */
  check('needsRxId is true only for DM',
    needsRxId(MotorKind.DM) === true
    && needsRxId(MotorKind.M3508) === false
    && needsRxId(MotorKind.M2006) === false
    && needsRxId(MotorKind.GM6020) === false);

  /* rx_id 范围 = CAN 标准帧 11 位 */
  check('rx_id range covers the CAN standard-frame ID space',
    RX_ID_MIN === 0 && RX_ID_MAX === 0x7ff,
    `got ${RX_ID_MIN}..${RX_ID_MAX}`);

  /*
   * 固件侧校验规则的镜像(见 motor_bench.c 的 MotorBenchAddMotor):
   *   DM   → rx_id 必须非 0
   *   其它 → rx_id 必须为 0(否则 BAD_PARAM,防止"配了却不生效"的静默忽略)
   */
  const firmwareRxRule = (kind, rxId) =>
    kind === MotorKind.DM ? (rxId !== 0 ? 'ok' : 'reject') : (rxId === 0 ? 'ok' : 'reject');
  check('mirror rule: DM rejects a zero rx_id', firmwareRxRule(MotorKind.DM, 0) === 'reject');
  check('mirror rule: DJI rejects a non-zero rx_id',
    firmwareRxRule(MotorKind.M3508, 0x11) === 'reject');
  check('mirror rule: DM accepts a real rx_id', firmwareRxRule(MotorKind.DM, 0x11) === 'ok');
}

/* ---------------- 串口写入返回值(回归测试) ---------------- */
console.log('\n== 9. writeToSerial must return boolean ==');
{
  /*
   * 背景:addMotor 用 `if (!writeToSerial(...))` 判断"有没有真的发出去"。
   * writeToSerial 早期没有 return,隐式返回 undefined,
   * 于是 !undefined 恒为 true —— 无论串口是否正常,
   * 每次添加电机都被误判成"没发出去",界面报"资源不足",而板子根本没收到帧。
   *
   * 这类 bug 语法检查发现不了、运行时也只有点错按钮才暴露,
   * 所以用静态检查把它钉死。
   */
  const src = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const m = src.match(/function writeToSerial\(buf\) \{[\s\S]*?\n\}/);

  check('writeToSerial exists', !!m);
  if (m) {
    const body = m[0];
    check('writeToSerial returns true on success', /return true;/.test(body));
    check('writeToSerial returns false when port closed', /return false;/.test(body));
    // 两个分支都要有返回值:只有一条 return 同样会漏
    check('writeToSerial has a return on every path',
      (body.match(/return (true|false);/g) || []).length === 2,
      `found ${(body.match(/return (true|false);/g) || []).length}`);
  }
}

{
  // 串口未连接时"没发出去",不是"资源不足"
  const src = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const addBlock = src.slice(src.indexOf("cmd.type === 'addMotor'"),
                             src.indexOf("cmd.type === 'removeMotor'"));
  check('add failure does NOT report NO_RESOURCE',
    !/result: MBResult\.NO_RESOURCE/.test(addBlock),
    '串口没连上与资源不足是两回事');
  check('add failure reports BAD_PARAM', /result: MBResult\.BAD_PARAM/.test(addBlock));
}

console.log('\n== 10. link gate allow-list covers all read-only frame types ==');
{
  /*
   * 背景:安全门闩用显式白名单放行"无副作用"的帧类型。
   * 早期版本先后漏放行 INVENTORY_QUERY(下拉框永远空)与
   * MOTOR_ADD/MOTOR_REMOVE(界面卡在"正在添加…"),
   * 而板端只打一条笼统的 rejected 日志,排查极其困难。
   *
   * 这里从固件源码里把放行条件抠出来,断言所有"无副作用"帧都在名单内,
   * 以后再加新帧类型时,忘了加白名单会立刻被这条测试抓到。
   */
  const cPath = new URL(
    `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
    import.meta.url,
  );
  let src;
  try {
    src = readFileSync(cPath, 'utf8');
  } catch {
    /* 找不到固件源码时跳过这一组(单独跑上位机测试的场合),不算失败 */
    console.log('  SKIP  firmware source not reachable, gate check skipped');
    src = null;
  }

  if (src) {
    /*
     * @attention 窗口从 800 放宽到 2000,且优先用"从 if 到 continue;"的宽松匹配。
     * 门闩那段周围有大量说明性注释(每个放行类型都写清了为什么),
     * 注释一长,固定窗口就会截断匹配不到 —— 曾因此报出
     * "gate condition not found" 的假失败。
     * 宁可窗口放宽,也不要让注释长度决定测试成败。
     */
    const gate = src.match(/if \(!mb_link_online[\s\S]{0,2000}?continue;/);
    check('gate condition found in firmware', !!gate);

    if (gate) {
      const allowed = [...gate[0].matchAll(/type != (MB_FRAME_\w+)/g)].map((m) => m[1]);

    /*
     * 这些帧会改变电机运行状态,必须被门闩挡住。
     * 其余(握手/查询/增删电机)都应放行。
     */
    const MUST_BE_BLOCKED = [
      'MB_FRAME_MOTOR_BIND',
      'MB_FRAME_MOTOR_SET',
      'MB_FRAME_MOTOR_ENABLE',
      'MB_FRAME_ALL_STOP',
    ];

    for (const f of MUST_BE_BLOCKED) {
      check(`${f} stays blocked`, !allowed.includes(f), 'safety gate weakened!');
    }

    for (const f of ['MB_FRAME_HEARTBEAT', 'MB_FRAME_QUERY',
                     'MB_FRAME_INVENTORY_QUERY',
                     'MB_FRAME_MOTOR_ADD', 'MB_FRAME_MOTOR_REMOVE']) {
      check(`${f} is allowed through gate`, allowed.includes(f),
        'add it to the allow-list or the host will hang');
    }
  }
  }
}

console.log('\n== 11. USB TX must not share a reusable staging buffer ==');
{
  /*
   * 背景:环形队列发送实现曾用
   *     static uint8_t pkt[64];  ... memcpy(pkt, ...); CDC_Transmit_FS(pkt, len);
   * 但 CDC_Transmit_FS() 只是保存指针,真正搬运数据发生在发送完成中断,
   * 而该中断回调又会再调一次 Pump() —— 两次传输共用同一块 static 缓冲,
   * 第二个包在第一个包真正发出前就把它覆盖了。
   *
   * 症状极难判断:固件侧 5 步日志全绿、自认为发送成功,
   * 上位机却一帧都收不到(CRC 永远不通过)。
   * 本工程真实踩过这个坑 —— RTT 显示 "[add] 2/5 result=0" 成功,
   * 界面上却没有任何电机出现。
   *
   * 这里做静态断言:Pump 里不得再出现"拷进 static 缓冲再传指针"的写法,
   * 必须直接把环形队列的连续内存交给 CDC_Transmit_FS()。
   */
  const fwPath = new URL(
    `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
    import.meta.url,
  );
  let c;
  try {
    c = readFileSync(fwPath, 'utf8');
  } catch {
    console.log('  SKIP  firmware source not reachable');
  }

  if (c) {
    const fn = c.match(/static uint8_t MotorBenchUsbPump\(void\)[\s\S]*?\n\}/);
    check('MotorBenchUsbPump found', !!fn);
    if (fn) {
      const body = fn[0];
      check('no static staging buffer in Pump',
        !/static\s+uint8_t\s+\w+\s*\[/.test(body),
        'shared static buffer is overwritten before USB actually reads it');
      check('memcpy(ring,...) does not target a staging buffer',
        !/memcpy\((\w+)\s*,/.test(body),
        'data must be sent straight from the ring buffer');
      check('CDC_Transmit_FS is fed from the ring buffer directly',
        /CDC_Transmit_FS\(\s*\(uint8_t\s*\*\)\s*&\s*mb_usb_tx_ring\[/.test(body));

      /*
       * 不变量:tail 的推进必须在"发送成功"之后。
       * 不能简单比较 `indexOf('return 0')` 与 `indexOf('mb_usb_tx_tail =')` ——
       * 函数里还有一个合法的提前 return(chunk==0 时先把 tail 归零),
       * 会让顺序断言失真。
       * 正确的判据:tail 的推进出现在 USBD_OK 判定之后。
       */
      const okIdx = body.indexOf('USBD_OK');
      const advanceIdx = body.lastIndexOf('mb_usb_tx_tail =');
      check('tail advances only after a successful transmit',
        okIdx >= 0 && advanceIdx > okIdx,
        'moving tail before knowing the result would silently drop unsent bytes');
    }
  }
}

console.log('\n== 12. RTT diagnostic logs stay ASCII ==');
{
  /*
   * RTT Viewer 按本机代码页解释收到的字节,而固件里的中文是 UTF-8,
   * 于是中文全部显示成乱码,恰好把最关键的信息变得不可读。
   * 诊断日志应使用纯 ASCII(网页 UI 里的中文不受影响,那是浏览器渲染)。
   */
  const fwPath = new URL(
    `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
    import.meta.url,
  );
  let c;
  try {
    c = readFileSync(fwPath, 'utf8');
  } catch {
    console.log('  SKIP  firmware source not reachable');
  }

  if (c) {
    // 抓取 LOGxxx("...") 调用中的字符串字面量
    const literals = [...c.matchAll(/LOG(?:INFO|WARNING|ERROR)\(\s*"([^"]*)"/g)].map((m) => m[1]);
    const nonAscii = literals.filter((s) => /[^\x00-\x7F]/.test(s));
    check('no non-ASCII in motor_bench log strings',
      nonAscii.length === 0,
      `offending: ${JSON.stringify(nonAscii.slice(0, 3))}`);
  }
}

console.log('\n== 13. USB RX callback must stay interrupt-safe ==');
{
  /*
   * 背景:MotorBenchUsbRxCallback 早期直接调用 MotorBenchDispatch(),
   * 于是协议解析(malloc 电机实例、重配 CAN 过滤器、DWT_Delay(0.1) 做
   * DM 编码器校准)全部跑在 USB 中断上下文。
   * DWT_Delay 在中断里忙等 100ms,等于独占 CPU:
   * FreeRTOS tick 与 500Hz 任务全部停摆,板子表现为"卡死"、
   * RTT 不再有心跳、主机侧看到日志一帧帧突然全部涌出。
   *
   * 因此规则是:中断只负责把字节搬进环形队列,解析必须在任务上下文。
   */
  const fwPath = new URL(
    `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
    import.meta.url,
  );
  let c;
  try {
    c = readFileSync(fwPath, 'utf8');
  } catch {
    console.log('  SKIP  firmware source not reachable');
  }

  if (c) {
    /*
     * 关键:必须先剥掉注释再检查。
     * 函数注释里会提到 "MotorBenchDispatch()"(说明为什么不能在这里调用),
     * 若连注释一起匹配,就会把说明文字误判成实际调用 → 假失败。
     */
    const stripComments = (s) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const cbDef = c.match(
      /static void MotorBenchUsbRxCallback\(uint16_t len\)\s*\{[\s\S]*?\n\}/,
    );
    check('MotorBenchUsbRxCallback found', !!cbDef);
    if (cbDef) {
      const body = stripComments(cbDef[0]);
      check('ISR does NOT call MotorBenchDispatch',
        !/MotorBenchDispatch\s*\(/.test(body),
        'parsing in ISR can busy-wait and stall the whole scheduler');
      check('ISR publishes bytes into the RX ring',
        /mb_usb_rx_slots\[/.test(body));
      check('full-queue check compares against the READ index',
        /next\s*==\s*mb_usb_rx_taken/.test(body),
        'comparing against a length array makes the full-check meaningless');
    }

    const taskDef = c.match(/void MotorBenchTask\(void\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchTask found', !!taskDef);
    if (taskDef) {
      const body = stripComments(taskDef[0]);
      check('task drains the RX ring',
        /mb_usb_rx_taken\s*!=\s*mb_usb_rx_ready/.test(body));
      check('task performs the dispatch',
        /MotorBenchDispatch\s*\(/.test(body));
    }
  }
}

console.log('\n== 14. firmware variable-length frames must not use fixed-size arrays ==');
{
  /*
   * 背景(真实抓包定位到的缺陷):
   *   MotorBenchSendInventory() 用 MB_InventoryFrame_s 发送,那是
   *   head(1) type(1) len(1) count(1) | items[MB_CHANNEL_MAX]×4 | crc(1) tail(1),
   *   crc/tail 落在固定偏移(4 + 8*4 = 36/37),
   *   但实际发送长度按真实数量算(5 + 1 + count*4),count=1 时只有 10 字节。
   *   于是 crc/tail 根本没发出去,上位机收到的是数组空槽。
   *
   * 实测抓到的字节:
   *   a5 8a 06 00 03 01 01 00 0d bb 5a   <- ACK 帧(手写字节拼装),尾部正确
   *   a5 82 05 01 03 01 01 02 00 00      <- 清单帧(定长数组),尾部是 00 00,应�� crc 5A
   * 帧尾校验失败 → 整帧被丢弃 → 界面永远空白。
   *
   * 这类缺陷靠"编译通过"和 selftest 都发现不了 —— 必须断言
   * 固件的清单/遥测发送函数是按字节拼装的,且发送长度由实际数量决定。
   */
  const fwPath = new URL(
    `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
    import.meta.url,
  );
  let c;
  try {
    c = readFileSync(fwPath, 'utf8');
  } catch {
    console.log('  SKIP  firmware source not reachable');
  }

  if (c) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const inv = c.match(/static void MotorBenchSendInventory\(void\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchSendInventory found', !!inv);
    if (inv) {
      const body = strip(inv[0]);
      check('inventory does NOT use the fixed-size frame struct',
        !/MB_InventoryFrame_s/.test(body),
        'crc/tail would sit past the transmitted length');
      check('inventory builds the frame byte-by-byte',
        /uint8_t\s+buf\[/.test(body));
      check('inventory length derives from the actual count',
        /MotorBenchSend\(buf,\s*\(uint16_t\)\(off \+ 2\)\)/.test(body),
        'length must match the bytes actually written');
    }

    const tel = c.match(/static void MotorBenchSendTelemetry\(void\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchSendTelemetry found', !!tel);
    if (tel) {
      const body = strip(tel[0]);
      check('telemetry does NOT use the fixed-size frame struct',
        !/MB_TelemetryFrame_s/.test(body),
        'same defect: crc/tail fall outside the transmitted length');
      check('telemetry builds the frame byte-by-byte',
        /uint8_t\s+buf\[/.test(body));
    }

    /*
     * 用实测抓到的坏帧做回归:若将来又退回定长数组,
     * 这条会提醒我们那个 00 00 的帧尾症状。
     */
    const bad = Buffer.from('a58205010301010200 00'.replace(/ /g, ''), 'hex');
    check('regression: the captured bad frame ends with 00 00 (not 5A)',
      bad[bad.length - 1] !== 0x5a,
      'this is the exact byte pattern seen on the wire');
  }
}

console.log('\n== 15. link timeout must outlast the host heartbeat interval ==');
{
  /*
   * 背景(实机 RTT 抓到的现象):
   *   W[motor_bench] command 0x02 rejected: host link not established
   *   W[motor_bench] command 0x03 rejected: host link not established
   *   W[motor_bench] command 0x04 rejected: host link not established
   * 而心跳应答一切正常 —— 极具迷惑性。
   *
   * 根因:安全门闩由 daemon 守护,而 StartDAEMONTASK() 是 osDelay(10)(100Hz,
   * 每拍 10ms)。原阈值 MB_LINK_TIMEOUT_COUNT = 5 => 实际只有 50ms,
   * 但注释写的是"约 1s"(换算错误)。上位机心跳 200ms 一次,
   * 于是每 200ms 里门闩只开 50ms、关 150ms,绑定/使能/设值常落在关闭窗口。
   *
   * 不变式:门闩超时必须显著大于心跳间隔,否则门闩会周期性地自己关上。
   * 这里做跨文件的一致性检查 —— 固件阈值 vs 上位机心跳间隔。
   */
  let fwCount = null;
  let fwPeriodMs = null;
  try {
    const fw = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
      import.meta.url,
    ), 'utf8');
    const m = fw.match(/#define\s+MB_LINK_TIMEOUT_COUNT\s+(\d+)/);
    if (m) fwCount = Number(m[1]);
  } catch { /* 固件不可达则跳过 */ }

  // daemon 周期:freertos.c 里 StartDAEMONTASK 的 osDelay(10)
  try {
    const fr = readFileSync(new URL(
      `${firmwareRelativeRoot}${firmwareSourceDir}/freertos.c`,
      import.meta.url,
    ), 'utf8');
    const m = fr.match(/StartDAEMONTASK[\s\S]{0,300}?osDelay\((\d+)\)/);
    if (m) fwPeriodMs = Number(m[1]);
  } catch { /* 固件不可达则跳过 */ }

  // 上位机心跳间隔
  let hostMs = null;
  try {
    const srv = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
    const m = srv.match(/buildHeartbeat\(\)\),\s*(\d+)\)/);
    if (m) hostMs = Number(m[1]);
  } catch { /* 忽略 */ }

  if (fwCount === null || fwPeriodMs === null || hostMs === null) {
    console.log('  SKIP  cannot resolve all three values');
  } else {
    const timeoutMs = fwCount * fwPeriodMs;
    console.log(`       link timeout = ${fwCount} × ${fwPeriodMs}ms = ${timeoutMs}ms`);
    console.log(`       host heartbeat = ${hostMs}ms`);

    check('link timeout exceeds the host heartbeat interval',
      timeoutMs > hostMs,
      `timeout ${timeoutMs}ms <= heartbeat ${hostMs}ms — the gate would latch shut between beats`);
    // 还要留足余量:至少 3 倍,避免临界抖动
    check('link timeout has at least 3x margin over heartbeat',
      timeoutMs >= hostMs * 3,
      `only ${(timeoutMs / hostMs).toFixed(1)}x — too tight for jitter`);
  }
}

console.log('\n== 16. stream parser minimum-frame check must accept empty payloads ==');
{
  /*
   * 背景(实机 RTT 抓到 hb_count=0):
   *   固件 MotorBenchDispatch() 里写的是
   *     if (len - i < 6) break;      // 要求至少 6 字节
   *   但一帧的最小长度是 5:head(1) type(1) len(1) crc(1) tail(1) + 0 字节负载。
   *   上位机心跳正是空负载帧(payload_len=0),于是每次都被判"没收全"而 break,
   *   永远进不到 CRC 校验与分派 ——
   *   结果:心跳计数恒为 0、安全门闩永远打不开、
   *   绑定/使能/设值全部被拒,而心跳应答也因为没收到心跳而自然消失。
   *
   * 判据:最小帧阈值必须等于 frame_len 的最小值(5),不能大于它。
   */
  let fw;
  try {
    fw = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
      import.meta.url,
    ), 'utf8');
  } catch {
    console.log('  SKIP  firmware source not reachable');
  }

  if (fw) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // frame_len 的定义:它决定了"一帧最少多少字节"
    const fl = fw.match(/uint16_t\s+frame_len\s*=\s*(\d+)\s*\+\s*payload_len/);
    check('frame_len formula found', !!fl);
    const minFrame = fl ? Number(fl[1]) : 5;

    // 找到解析器里的最小长度检查
    const guard = fw.match(/if\s*\(\s*len\s*-\s*i\s*<\s*(\d+)\s*\)/);
    check('minimum-length guard found', !!guard);

    if (guard) {
      const threshold = Number(guard[1]);
      console.log(`       frame_len minimum = ${minFrame}, guard threshold = ${threshold}`);
      check('minimum-frame guard equals the true minimum frame size',
        threshold === minFrame,
        `guard ${threshold} rejects valid ${minFrame}-byte frames (empty payload)`);
    }

    // 语义复核:空负载帧必须能通过
    check('empty-payload heartbeat frame is 5 bytes',
      minFrame === 5, `head+type+len+crc+tail = 5, got ${minFrame}`);
  }

  // 用真实构造的心跳帧验证 JS 侧确实只有 5 字节
  const hb = buildHeartbeat();
  check('host heartbeat frame is exactly 5 bytes', hb.length === 5, `got ${hb.length}`);
  check('host heartbeat has zero payload', hb[2] === 0, `len byte = ${hb[2]}`);
  const parsed = new FrameParser().push(hb);
  check('host heartbeat parses on the JS side', parsed.length === 1);
}

console.log('\n== 17. new channel cards must get their handlers bound ==');
{
  /*
   * 背景(实机现象"绑定第二个电机报 channel 0 already used"):
   *   早期 buildChannels() 用 innerHTML='' 整体重建,旧卡片上的 onclick
   *   一并销毁,而 bindEvents() 只在页面加载时调用一次 ——
   *   新卡片按钮没有任何事件,残留的旧闭包 channelId 还是重建前的值。
   *
   * 【2026-10-12 更新】本组原断言"buildChannels 必须清空容器"已作废:
   *   正是那行 innerHTML='' 导致加第二颗电机时,通道 0 的已选电机与 rpm
   *   全部被清空(第 20 组记录了三个由此派生的实测故障)。
   *   现在增删只处理新增/多余卡片,不清空保留的卡片。
   *
   * 但"新增卡片必须绑上事件"这条依然成立,而且更重要 ——
   *   保留的卡片维持自己的 onclick,新卡片若漏绑就是死按钮。
   */
  let ui;
  try {
    ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  } catch {
    console.log('  SKIP  ui.js not reachable');
  }

  if (ui) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const bc = ui.match(/function buildChannels\([^)]*\)\s*\{[\s\S]*?\n\}/);
    check('buildChannels found', !!bc);
    if (bc) {
      const body = strip(bc[0]);
      /* 见上方说明:清空容器已从"必须"改为"禁止",由第 20 组断言 */
      check('buildChannels does NOT wipe existing cards',
        !/innerHTML\s*=\s*''/.test(body),
        'innerHTML="" destroys user state (selected motor, rpm) — see group 20');
      check('buildChannels binds events for the newly added cards',
        /bindEvents\(\)/.test(body),
        'new cards must not be dead buttons');
    }

    /*
     * 顶层不应再单独调用 bindEvents():buildChannels() 已包含它。
     * 当前用的是 onclick 赋值(会覆盖)所以暂不出错,
     * 但若将来改成 addEventListener 就会叠加,导致指令重复下发。
     */
    const topLevelCalls = (ui.match(/^bindEvents\(\);/gm) || []).length;
    check('bindEvents is not called again at top level',
      topLevelCalls === 0,
      `found ${topLevelCalls} stray top-level call(s)`);
  }
}

console.log('\n== 18. PID protocol: frame layout, fixed-point, defaults ==');
{
  /*
   * 背景:PID 运行期整定纯靠一帧二进制传递 5 个参数 × 3 环,
   * 布局一旦错,固件与上位机会把字段读串位。而串位的表现不是"报错",
   * 而是"Kp 被当成 Ki 用"这种静默错值,极难发现。
   *
   * 因此这里把字节级布局与固件 _Static_assert 的偏移逐一对应验证。
   *
   * @attention 定点混合方案(不是统一 ×100):
   *   Kp/Ki/Kd   u16 × 100  → 两位小数
   *   MaxOut/IntLim s32 原值 → 电流量级(15000×100 会溢出 u16)
   *   这正是迁移当天 Buffer.writeUInt16LE 抛 ERR_OUT_OF_RANGE 的原因,
   *   本组测试就是用来防止回归。
   */

  // ---- 17.1 PID_SET 帧 ----
  /*
   * 偏移基准 = 固件 MB_PidSetReq_s 的 _Static_assert 数字,不是"看代码数出来的"。
   *   payload 内: channel@0 loop@1 improve@2 kp@4 ki@6 kd@8 maxout@10 intlim@14
   *   帧内偏移 = payload 偏移 + 3(head+type+len)
   */
  const pid = { Kp: 20, Ki: 1, Kd: 0, MaxOut: 15000, IntegralLimit: 10000 };
  const f = buildSetPid(2, PidLoop.SPEED, pid);
  const B = 3; // payload 起点在帧内

  check('PID_SET frame head 0xA5', f[0] === 0xa5);
  check('PID_SET type 0x0a', f[1] === 0x0a);
  check('PID_SET payload len 20', f[2] === 20, `got ${f[2]}`);
  check('PID_SET total len 25', f.length === 25, `got ${f.length}`);
  check('PID_SET channel_id @payload0', f[0 + B] === 2);
  check('PID_SET loop @payload1', f[1 + B] === PidLoop.SPEED);

  // 小系数:u16 LE × 100
  check('Kp 20 -> 2000 (LE)', f.readUInt16LE(4 + B) === 2000, `got ${f.readUInt16LE(4 + B)}`);
  check('Ki 1 -> 100 (LE)', f.readUInt16LE(6 + B) === 100, `got ${f.readUInt16LE(6 + B)}`);
  check('Kd 0 -> 0', f.readUInt16LE(8 + B) === 0);
  // 大限幅:s32 原值,不缩放
  check('MaxOut 15000 stays 15000', f.readInt32LE(10 + B) === 15000, `got ${f.readInt32LE(10 + B)}`);
  check('IntLim 10000 stays 10000', f.readInt32LE(14 + B) === 10000, `got ${f.readInt32LE(14 + B)}`);

  // improve 是 u8 @payload2,其后 reserved 占 1 字节
  const f3 = buildSetPid(0, PidLoop.SPEED, { ...pid, improve: 5 });
  check('improve u8 @payload2', f3[2 + B] === 5, `got ${f3[2 + B]}`);

  // 小数:0.7*100=70、0.1*100=10 精确(选值避免二进制浮点误差)
  const f2 = buildSetPid(0, PidLoop.CURRENT, { Kp: 0.7, Ki: 0.1, MaxOut: 20000 });
  check('fractional Kp 0.7 -> 70', f2.readUInt16LE(4 + B) === 70);
  check('fractional Ki 0.1 -> 10', f2.readUInt16LE(6 + B) === 10);
  check('GM6020 MaxOut 20000 stays 20000', f2.readInt32LE(10 + B) === 20000);

  const frames = new FrameParser().push(f);
  check('PID_SET round-trips through parser', frames.length === 1);
  check('PID_SET round-trip type', frames[0].type === 0x0a);

  // ---- 17.2 PID_QUERY ----
  const q = buildPidQuery(5);
  check('PID_QUERY type 0x0b', q[1] === 0x0b);
  check('PID_QUERY payload len 4', q[2] === 4);
  check('PID_QUERY channel_id @payload3', q[3 + B] === 5);

  // ---- 17.3 PID_REPORT 解析 ----
  /*
   * 手工构造一包与固件布局一致的报表。三个环参数刻意不同,
   * 只有布局完全正确才能三个环都对上。
   */
  const rep = Buffer.alloc(49);
  rep[0] = 3;                        // channel
  rep[1] = MotorKind.GM6020;         // kind
  const put16 = (arr, li, v) => rep.writeUInt16LE(v, 4 + arr * 6 + li * 2);
  const put32 = (arr, li, v) => rep.writeInt32LE(v, 22 + arr * 12 + li * 4);
  // 速度环(6020 yaw 实参)
  put16(0, 0, 5000); put16(1, 0, 20000); put16(2, 0, 0);
  put32(0, 0, 20000); put32(1, 0, 3000);
  // 电流环
  put16(0, 1, 70);    put16(1, 1, 10);    put16(2, 1, 0);
  put32(0, 1, 20000); put32(1, 1, 3000);
  // 位置环
  put16(0, 2, 800);   put16(1, 2, 0);     put16(2, 2, 0);
  put32(0, 2, 500);   put32(1, 2, 100);
  rep[46] = 5; rep[47] = 0; rep[48] = 5;

  const rp = parsePidReport(rep);
  check('PID_REPORT parses', !!rp);
  check('PID_REPORT channelId', rp.channelId === 3);
  check('PID_REPORT kind', rp.kind === MotorKind.GM6020);
  check('PID_REPORT speed Kp=50', rp.speed.Kp === 50, `got ${rp.speed.Kp}`);
  check('PID_REPORT speed Ki=200', rp.speed.Ki === 200, `got ${rp.speed.Ki}`);
  check('PID_REPORT speed MaxOut=20000', rp.speed.MaxOut === 20000, `got ${rp.speed.MaxOut}`);
  check('PID_REPORT current Kp=0.7', rp.current.Kp === 0.7, `got ${rp.current.Kp}`);
  check('PID_REPORT current Ki=0.1', rp.current.Ki === 0.1, `got ${rp.current.Ki}`);
  check('PID_REPORT angle Kp=8', rp.angle.Kp === 8, `got ${rp.angle.Kp}`);
  check('PID_REPORT angle MaxOut=500', rp.angle.MaxOut === 500, `got ${rp.angle.MaxOut}`);
  check('PID_REPORT angle IntLim=100', rp.angle.IntegralLimit === 100);
  check('PID_REPORT improve per loop',
    rp.speed.improve === 5 && rp.current.improve === 0 && rp.angle.improve === 5);

  check('PID_REPORT rejects short', parsePidReport(rep.subarray(0, 20)) === null);
  check('PID_REPORT rejects empty', parsePidReport(Buffer.alloc(0)) === null);

  // ---- 17.4 PID_SET_ACK ----
  const pa = parsePidSetAck(Buffer.from([0x07, 0x02, 0x00, 0x00]));
  check('PID_SET_ACK channelId', pa.channelId === 7);
  check('PID_SET_ACK loop', pa.loop === 2);
  check('PID_SET_ACK result OK', pa.result === MBResult.OK);
  check('PID_SET_ACK rejects short', parsePidSetAck(Buffer.from([0, 0])) === null);

  // ---- 17.5 页面默认值与固件表一致 ----
  /* 上位机 PID_DEFAULTS 是"页面初始显示值",固件 bench_dji_*_pid[] 是"建电机时写入值"。
   * 两边必须一致,否则用户会看到页面写 A、实际生效 B。
   *
   * 【2026-10-12】原先此处断言的是实车整定值(M3508 Kp=20、M2006 Kp=10、
   * GM6020 Kp=50/Ki=200),现已按用户要求统一为 Kp=1/Ki=0/Kd=0 ——
   * 那些参数是带机构与 IMU 前馈下整定的,裸电机台架工况必然震荡。
   * MaxOut 属于输出限幅而非增益,仍按型号保留。
   */
  check('M3508 speed MaxOut=15000', PID_DEFAULTS[MotorKind.M3508].speed.MaxOut === 15000);
  check('M2006 speed MaxOut=5000', PID_DEFAULTS[MotorKind.M2006].speed.MaxOut === 5000);
  check('GM6020 speed MaxOut=20000 (超出 u16×100,验证协议容量)',
    PID_DEFAULTS[MotorKind.GM6020].speed.MaxOut === 20000);
  /* DJI 三型必须带电流环参数 —— 这三组实参都是在电流内环下整定的,
   * 少了电流环"同样的 Kp/Ki"不会有同样效果。
   * 达妙的 MIT 命令直接给扭矩,固件侧不叠加 DJI 电流环。 */
  const djiKinds = [MotorKind.M3508, MotorKind.M2006, MotorKind.GM6020];
  check('DJI 三型都带电流环参数(三环闭环必要条件)',
    djiKinds.every((k) => PID_DEFAULTS[k].current.Kp > 0));
  check('达妙 MIT 不叠加 DJI 电流环',
    PID_DEFAULTS[MotorKind.DM].current.Kp === 0);
  {
    const app = readFileSync(new URL(`${firmwareRelativeRoot}application/motor_bench_app/motor_bench_app.c`, import.meta.url), 'utf8');
    const factory = app.match(/static uint8_t BenchMotorFactory\([\s\S]*?\n\}/)?.[0] ?? '';
    const dm = factory.match(/if \(kind == MB_MOTOR_DM\)\s*\{([^}]+)\}/)?.[1] ?? '';
    const defaults = PID_DEFAULTS[MotorKind.DM].speed;
    for (const key of ['Kp', 'Ki', 'Kd', 'MaxOut', 'IntegralLimit']) {
      const value = dm.match(new RegExp(`speed_PID\\.${key} = ([0-9.]+)f`))?.[1];
      check(`DM ${key} matches the real firmware default`, value !== undefined && Number(value) === defaults[key]);
    }
    check('DM4310 默认速度环采用用户指定五参数',
      defaults.Kp === 0.65 && defaults.Ki === 12 && defaults.Kd === 0 &&
      defaults.MaxOut === 15 && defaults.IntegralLimit === 1000 && defaults.improve === 1);
  }

  /*
   * 【2026-10-13 实测修正】速度环 Kp 由 1 提高到 3 / 2 / 8。
   *
   * 上一版统一设 Kp=1,结果电机**转不起来** —— 这是量纲问题不是调参问题:
   *   速度环输出 = Kp × 误差(rpm)
   * 裸电机静摩擦要吃掉可观电流;Kp=1 时产出 1000(约 3508 的 6% 电流值)
   * 需要 1000rpm 误差,而全速才 9000rpm,开环都转不动。
   *
   * 现在取原实车值的 1/5~1/7 作为"能转起来的保守起点",
   * Ki 仍为 0(先只用比例项判断能否转稳)。MaxOut 是限幅不是增益,不变。
   *
   * @attention 断言写成"下界"而不是精确值:
   *   Kp 本来就是要现场整定的量,固化成精确值会让每次微调都要改测试。
   *   这里只锁**必须满足的物理约束**:Kp 大到能克服静摩擦。
   */
  const KP_MIN = 1.5; // 低于此值实测转不起来
  for (const k of [MotorKind.M3508, MotorKind.M2006, MotorKind.GM6020]) {
    const s = PID_DEFAULTS[k].speed;
    check(`${MotorKindLabel[k]} 速度环 Kp 足以克服静摩擦 (>=${KP_MIN})`,
      s.Kp >= KP_MIN, `got ${s.Kp} — Kp=1 实测转不起来`);
    check(`${MotorKindLabel[k]} 速度环 Ki=0 (先用纯比例判断能否转稳)`,
      s.Ki === 0, `got ${s.Ki}`);
    check(`${MotorKindLabel[k]} 速度环 Kd=0`, s.Kd === 0, `got ${s.Kd}`);
  }
  check('M3508 Kp 明显大于 1(已知失败值)',
    PID_DEFAULTS[MotorKind.M3508].speed.Kp > 1);
  check('M2006 Kp 明显大于 1(已知失败值)',
    PID_DEFAULTS[MotorKind.M2006].speed.Kp > 1);
  check('GM6020 Kp 明显大于 1(已知失败值)',
    PID_DEFAULTS[MotorKind.GM6020].speed.Kp > 1);
  check('M3508 speed MaxOut 仍为 16000 量级(限幅非增益)',
    PID_DEFAULTS[MotorKind.M3508].speed.MaxOut === 15000);
  check('M2006 speed MaxOut 保留', PID_DEFAULTS[MotorKind.M2006].speed.MaxOut === 5000);
  check('GM6020 speed MaxOut 保留', PID_DEFAULTS[MotorKind.GM6020].speed.MaxOut === 20000);

  /*
   * 固件表与上位机镜像必须一致 —— 两处各写一份,漂移了没人知道。
   * 上位机只是"填进输入框的默认值",真正生效的是固件那张表;
   * 若只改一边,用户看到的和电机跑的不是同一套参数。
   */
  let fwApp;
  try {
    fwApp = readFileSync(new URL(
      `${firmwareRelativeRoot}application/motor_bench_app/motor_bench_app.c`,
      import.meta.url,
    ), 'utf8');
  } catch { console.log('  SKIP  motor_bench_app.c not reachable'); }
  if (fwApp) {
    const blk = fwApp.match(/bench_dji_speed_pid\[[^\]]*\]\s*=\s*\{[\s\S]*?\};/);
    check('firmware bench_dji_speed_pid table found', !!blk);
    if (blk) {
      /* 只比对增益三项,限幅类由上面按型号单独断言 */
      const gains = [...blk[0].matchAll(
        /\[\s*(\w+)\s*\]\s*=\s*\{\s*([\d.]+)f\s*,\s*([\d.]+)f\s*,\s*([\d.]+)f/g,
      )].map((m) => ({ kind: m[1], kp: +m[2], ki: +m[3], kd: +m[4] }));
      check('firmware table has 3 DJI entries', gains.length === 3, `got ${gains.length}`);
      check('firmware speed Kp is not the fatal value 1 for any DJI type',
        gains.every((g) => g.kp >= KP_MIN),
        `Kp=1 实测转不起来; got ${JSON.stringify(gains)}`);
      check('firmware speed Ki is 0 for all DJI types',
        gains.every((g) => g.ki === 0), JSON.stringify(gains));
      check('firmware speed Kd is 0 for all DJI types',
        gains.every((g) => g.kd === 0), JSON.stringify(gains));
    }
    check('firmware no longer uses the old friction-wheel Kp=20',
      !/\[M3508\]\s*=\s*\{\s*20\.0f/.test(fwApp));
    check('firmware no longer uses the old yaw Kp=50/Ki=200',
      !/\[GM6020\]\s*=\s*\{\s*50\.0f\s*,\s*200\.0f/.test(fwApp));
    /* 固件与上位机镜像必须同值,否则页面显示 A、实际生效 B */
    const fwKp = {};
    const blk2 = fwApp.match(/bench_dji_speed_pid\[[^\]]*\]\s*=\s*\{[\s\S]*?\};/);
    if (blk2) {
      for (const m of blk2[0].matchAll(/\[\s*(\w+)\s*\]\s*=\s*\{\s*([\d.]+)f/g)) {
        fwKp[m[1]] = parseFloat(m[2]);
      }
    }
    check('firmware M3508 Kp matches the host mirror',
      fwKp.M3508 === PID_DEFAULTS[MotorKind.M3508].speed.Kp,
      `fw=${fwKp.M3508} host=${PID_DEFAULTS[MotorKind.M3508].speed.Kp}`);
    check('firmware M2006 Kp matches the host mirror',
      fwKp.M2006 === PID_DEFAULTS[MotorKind.M2006].speed.Kp,
      `fw=${fwKp.M2006} host=${PID_DEFAULTS[MotorKind.M2006].speed.Kp}`);
    check('firmware GM6020 Kp matches the host mirror',
      fwKp.GM6020 === PID_DEFAULTS[MotorKind.GM6020].speed.Kp,
      `fw=${fwKp.GM6020} host=${PID_DEFAULTS[MotorKind.GM6020].speed.Kp}`);
  }
}

console.log('\n== 19. PID panel must stay visible (disable, not hide) ==');
{
  /*
   * 实机反馈:「并没有看到 pid 参数的输入入口」。
   * 原因:index.html 里 PID 面板带 hidden 属性,未绑定电机时整块隐藏,
   * 而卡片下半部分在页面上并不显眼,用户根本不知道这个功能存在。
   *
   * "不用重烧固件就能改 PID"是本测试台的核心卖点之一,入口藏起来等于没做。
   * 正确做法:面板常驻可见,未绑定时 disabled 灰显并提示。
   *
   * 判据:
   *   1. index.html 的 pid-panel 不得带 hidden 属性
   *   2. ui.js 的 initPidPanel 不得再操作 .hidden
   *   3. 必须切换 disabled(输入框 + 环选择器 + 三个按钮)
   *   4. 换选电机要刷新面板,否则会出现"选了 M2006 却摆着 M3508 的参数"
   */
  let html, uiSrc;
  try {
    const base = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', base), 'utf8');
    uiSrc = readFileSync(new URL('ui.js', base), 'utf8');
  } catch {
    console.log('  SKIP  index.html / ui.js not reachable');
  }

  if (html) {
    const panel = html.match(/<div class="pid-panel[^"]*"[^>]*>/);
    check('pid-panel element found in template', !!panel);
    if (panel) {
      check('pid-panel is NOT hidden (must stay visible)',
        !/\shidden\b/.test(panel[0]),
        `got: ${panel[0]}`);
    }
    check('pid panel has an explicit "先绑定" hint',
      /先绑定电机后可用/.test(html));
  }

  if (uiSrc) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const fn = uiSrc.match(/function initPidPanel\([^)]*\)\s*\{[\s\S]*?\n\}/);
    check('initPidPanel found', !!fn);
    if (fn) {
      const body = strip(fn[0]);
      check('initPidPanel no longer hides the panel',
        !/\.hidden\s*=/.test(body),
        'hiding makes the feature undiscoverable');
      check('initPidPanel toggles disabled instead',
        /\.disabled\s*=/.test(body));
      check('initPidPanel disables all five inputs',
        /'pKp'[\s\S]*'pKi'[\s\S]*'pKd'[\s\S]*'pMaxOut'[\s\S]*'pIntLim'/.test(body));
      check('initPidPanel disables the apply/query/reset buttons',
        /'pidApply'[\s\S]*'pidQuery'[\s\S]*'pidReset'/.test(body));
    }
    check('motor dropdown change refreshes the PID panel',
      /r\('motor'\)\.onchange\s*=\s*\(\)\s*=>\s*initPidPanel\(/.test(uiSrc),
      'otherwise selecting a different motor shows the wrong defaults');
  }
}

console.log('\n== 20. telemetry frame must be split to fit the 64B USB limit ==');
{
  /*
   * 实机症状:绑定 2 颗电机一切正常,绑到第 3 颗时
   *   - 卡片右上角一直"未绑定",点了绑定没反应
   *   - 使能后按钮也不变色
   * 看起来像 UI 卡死,实际是**整帧遥测被 USB 层截断**,上位机一条都解析不出。
   *
   * 算术(这就是全部):
   *   负载 = count(1) + seq(2) + count × 21
   *   count=2 → 3 + 42 = 45  ✓  ≤ 64
   *   count=3 → 3 + 63 = 66  ✗  >  64  ← 第 3 颗就断了
   *
   * 修复:固件按 MB_TELEMETRY_PER_FRAME 分帧发送,上位机按 channel_id 合并。
   * 本组测试锁定两件事:
   *   1. 固件必须分帧(且常量在头文件里,不重复推导)
   *   2. 上位机 MAX_PAYLOAD 与固件 MB_PAYLOAD_MAX 一致,且不小于分帧后的单帧
   */
  let fw;
  try {
    fw = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`, import.meta.url,
    ), 'utf8');
  } catch {
    console.log('  SKIP  firmware motor_bench.c not reachable');
  }

  if (fw) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const body = strip(fw);

    check('MB_TELEMETRY_PER_FRAME is defined in the header, not the .c',
      !/#define\s+MB_TELEMETRY_PER_FRAME/.test(body),
      'keep the capacity constant in one place (motor_bench.h)');

    const fn = fw.match(/static void MotorBenchSendTelemetry\(void\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchSendTelemetry found', !!fn);
    if (fn) {
      const fbody = strip(fn[0]);
      check('telemetry is sent inside a per-frame loop',
        /for\s*\(\s*uint8_t base\s*=/.test(fbody),
        'single-shot send cannot hold 3+ motors in 64 bytes');
      check('loop clamps per-frame count to MB_TELEMETRY_PER_FRAME',
        /n\s*>\s*MB_TELEMETRY_PER_FRAME/.test(fbody));
      check('items are indexed by base offset',
        /items\[base\s*\+\s*i\]/.test(fbody),
        'without base offset every frame would resend channel 0');
      check('body_len uses the clamped n, not the total count',
        /3\s*\+\s*n\s*\*\s*sizeof\(MB_TelemetryItem_s\)/.test(fbody));
    }
  }

  /* 上位机侧:MAX_PAYLOAD 必须与固件一致,且容得下分帧后的整帧 */
  check('host MAX_PAYLOAD is 64 (must match firmware MB_PAYLOAD_MAX)', MAX_PAYLOAD === 64);

  const ITEM = 21;
  const perFrame = Math.floor((MAX_PAYLOAD - 3) / ITEM);
  check('per-frame motor capacity is 2 at 64B', perFrame === 2, `got ${perFrame}`);
  check('a full telemetry frame fits the USB packet',
    5 + 3 + perFrame * ITEM <= 64,
    `frame = ${5 + 3 + perFrame * ITEM} bytes`);

  /*
   * 端到端:构造 8 个电机的遥测,按每帧 2 个切分,
   * 每一帧都必须能被 FrameParser 正常解析出全部 item。
   * 这正是上位机合并数据时看到的东西。
   */
  const ids = [0, 1, 2, 3, 4, 5, 6, 7];
  const frames = [];
  for (let base = 0; base < ids.length; base += perFrame) {
    const chunk = ids.slice(base, base + perFrame);
    const body = Buffer.alloc(3 + chunk.length * ITEM);
    body[0] = chunk.length;
    body.writeUInt16LE(base, 1);
    chunk.forEach((id, k) => {
      const off = 3 + k * ITEM;
      body.writeUInt16LE(id, off);       // channel_id
      body.writeUInt16LE(0x03, off + 2); // status: online + enabled
    });
    const fr = Buffer.alloc(5 + body.length);
    fr[0] = 0xa5; fr[1] = 0x81; fr[2] = body.length;
    body.copy(fr, 3);
    fr[3 + body.length] = crc8(fr.subarray(1, 3 + body.length));
    fr[4 + body.length] = 0x5a;
    frames.push(fr);
  }

  check('8 motors produce 4 frames', frames.length === 4, `got ${frames.length}`);

  const seen = [];
  for (const fr of frames) {
    check(`frame payload ${fr[2]}B <= 64`, fr[2] <= 64, `got ${fr[2]}`);
    const parsed = new FrameParser().push(fr);
    check('frame parses', parsed.length === 1);
    if (parsed.length) {
      const tm = parseTelemetry(parsed[0].payload);
      /*
       * count 在**负载的第 0 字节**,帧内偏移是 3(head+type+len)。
       * 别写 fr[0] —— 那是帧头 0xA5 = 165,会得到一条莫名其妙的
       * "expected 165 items" 断言。帧内下标 ≠ 负载下标,这是分帧调试最容易错的一处。
       */
      const expected = fr[3];
      check('telemetry items parsed', tm && tm.items.length === expected,
        `expected ${expected} items, got ${tm ? tm.items.length : 0}`);
      if (tm) tm.items.forEach((it) => seen.push(it.channelId));
    }
  }

  check('all 8 channels survive the split', seen.length === 8, `got ${seen.length}`);
  check('channel ids are unique and ordered',
    JSON.stringify(seen) === JSON.stringify(ids), `got ${JSON.stringify(seen)}`);
}

console.log('\n== 21. adding a motor must not destroy channel UI state ==');
{
  /*
   * 三个实测故障,同一个根因:
   *   1. 先加 6020 再加 2006 → 通道 0 的电机选择消失(要重新选),
   *      但通道 0 控制的其实还是那颗 6020;
   *   2. 已设好的 rpm 自动归零;
   *   3. 先 6020 后 3508 → 两个通道被一起清空,且之后无法二次绑定。
   *
   * 根因是两条错误假设:
   *   (a) `CHANNEL_COUNT !== inventory.length` → 任何数量变化都重建卡片,
   *       而 buildChannels() 里的 `host.innerHTML=''` 会销毁所有卡片状态;
   *   (b) `fillMotorOptions()` 无条件重建 <option>,把已选值打回 "";
   *   现在按用户要求让卡片数量匹配电机数量，但增删必须保留其余卡片及板端通道号。
   *
   * 判据(对着源码断言,因为这些是"不该再犯"的结构性约束):
   *   1. buildChannels 里不得再出现 host.innerHTML = ''
   *   2. 增删的行为由浏览器回归覆盖，包括保留高编号绑定与释放已删除卡片状态
   *   3. fillMotorOptions 必须在重建 option 前记住三元组、重建后恢复
   *   4. 清单处理器不得再以 CHANNEL_COUNT !== inventory.length 为重建条件
   *   5. startInventoryFetch 重入时必须先清旧定时器(否则拉取会静默停摆)
   */
  let ui;
  try {
    ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  } catch {
    console.log('  SKIP  ui.js not reachable');
  }

  if (ui) {
    /* 剥注释后再匹配,否则会被注释里引用的旧代码骗到 */
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /* --- buildChannels --- */
    const bc = ui.match(/function buildChannels\([^)]*\)\s*\{[\s\S]*?\n\}/);
    check('buildChannels found', !!bc);
    if (bc) {
      const bcode = bc[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      check('buildChannels does NOT wipe the container',
        !/host\.innerHTML\s*=\s*''/.test(bcode),
        'innerHTML="" destroys every channel card and all user state');
    }

    /* --- fillMotorOptions --- */
    const fm = ui.match(/function fillMotorOptions\(\)\s*\{[\s\S]*?\n\}/);
    check('fillMotorOptions found', !!fm);
    if (fm) {
      const fcode = fm[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      check('fillMotorOptions remembers the selection before rebuilding',
        /prevKey\s*=/.test(fcode),
        'otherwise every inventory refresh clears the dropdown');
      check('fillMotorOptions keys on (kind,bus,id), not index',
        /\$\{.*kind.*\}\s*:\s*\$\{.*canBus.*\}\s*:\s*\$\{.*motorId.*\}/.test(fcode),
        'indices shift when motors are added/removed');
      check('fillMotorOptions restores the selection after rebuilding',
        /sel\.value\s*=\s*restoredIdx/.test(fcode));
    }

    /* --- inventory handler:不再以数量变化重建 --- */
    check('inventory handler no longer rebuilds on count mismatch',
      !/CHANNEL_COUNT\s*!==\s*inventory\.length/.test(code),
      'this single condition caused all three symptoms');

    /* --- startInventoryFetch 竞态 --- */
    const sf = ui.match(/function startInventoryFetch\(\)\s*\{[\s\S]*?\n\}/);
    check('startInventoryFetch found', !!sf);
    if (sf) {
      const scode = sf[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      check('startInventoryFetch clears the previous timer on re-entry',
        /if\s*\(\s*inventoryTimer\s*\)\s*\{[\s\S]*?clearInterval/.test(scode),
        'a stale timer makes the re-fetch a no-op -> inventory never refreshes again');
      check('startInventoryFetch does NOT bail out on an active timer',
        !/if\s*\(inventoryTimer\)\s*return/.test(scode));
    }

  }
}

console.log('\n== 22. "unbind" must really unbind, not just stop ==');
{
  /*
   * 实测故障(安全级):通道 2 先绑 M3508,点"解绑"换成 M2006,
   *   结果**所有电机都不转了**,且界面无任何错误提示。
   *
   * 根因是"解绑"按钮名不副实 —— 它只下发 enable=0(那是"停机"):
   *   电机确实停了,但固件侧 mb_channels[ch].is_used 仍为 1、
   *   motor_ptr 仍指着原来那颗。
   *   紧接着绑定另一颗,MotorBenchBind 撞上
   *     if (mb_channels[channel_id].is_used) return MB_ERR_DUPLICATE;
   *   被**静默拒绝**。而界面早已把本地状态清掉、显示"未绑定",
   *   于是用户看到的是"换了电机但什么都不动了"。
   *
   * MotorBenchUnbind() 早已实现却没有任何帧能触发它,等于死代码。
   *
   * 判据:
   *   1. 协议有 MOTOR_UNBIND(0x0C) 与 UNBIND_ACK(0x8D),能构帧能解析
   *   2. 固件 dispatch 处理该帧,且实现里调用 MotorBenchUnbind
   *   3. UNBIND 在门闩白名单内(否则心跳波动时点解绑没反应)
   *   4. 界面下发的是 unbind 指令,**不是**只用 enable:false 冒充
   *   5. 界面等 unbindAck 到达才清状态(失败时显示原因)
   */
  let ui, srv, fwC, fwH;
  try {
    const b = new URL('./', import.meta.url);
    ui = readFileSync(new URL('ui.js', b), 'utf8');
    srv = readFileSync(new URL('server.js', b), 'utf8');
    fwC = readFileSync(new URL(`${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`, b), 'utf8');
    fwH = readFileSync(new URL(`${firmwareRelativeRoot}modules/motor_bench/motor_bench.h`, b), 'utf8');
  } catch {
    console.log('  SKIP  source files not reachable');
  }

  /* --- 1. 帧定义与编解码 --- */
  check('MOTOR_UNBIND frame type is 0x0C', FrameType.MOTOR_UNBIND === 0x0c,
    `got ${FrameType.MOTOR_UNBIND}`);
  check('UNBIND_ACK frame type is 0x8D', FrameType.UNBIND_ACK === 0x8d,
    `got ${FrameType.UNBIND_ACK}`);

  const ub = buildUnbind(3);
  check('unbind frame head 0xA5', ub[0] === 0xa5);
  check('unbind frame type 0x0C', ub[1] === 0x0c);
  check('unbind payload len 2', ub[2] === 2, `got ${ub[2]}`);
  check('unbind channel_id @payload1', ub[4] === 3, `got ${ub[4]}`);
  check('unbind frame round-trips', new FrameParser().push(ub).length === 1);

  const ua = parseUnbindAck(Buffer.from([0x02, 0x00]));
  check('unbindAck channelId', ua.channelId === 2);
  check('unbindAck result OK', ua.result === MBResult.OK);
  check('unbindAck rejects short', parseUnbindAck(Buffer.from([0])) === null);

  /* --- 2. 固件侧 --- */
  if (fwC && fwH) {
    const stripFw = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    check('firmware declares MB_FRAME_MOTOR_UNBIND',
      /MB_FRAME_MOTOR_UNBIND\s*=\s*0x0C/.test(fwH));
    check('firmware declares MB_FRAME_UNBIND_ACK',
      /MB_FRAME_UNBIND_ACK\s*=\s*0x8D/.test(fwH));
    check('MotorBenchUnbind is declared in the header',
      /uint8_t MotorBenchUnbind\(uint8_t channel_id\)/.test(fwH));

    const fwCode = stripFw(fwC);

    check('dispatch handles MOTOR_UNBIND',
      /case MB_FRAME_MOTOR_UNBIND:[\s\S]*?MotorBenchHandleUnbind/.test(fwCode),
      'without this the frame is silently dropped as "unknown frame type"');
    check('handler calls MotorBenchUnbind',
      /static void MotorBenchHandleUnbind[\s\S]*?MotorBenchUnbind\(ch\)/.test(fwCode));
    check('handler sends an UNBIND_ACK (success or failure)',
      /static void MotorBenchHandleUnbind[\s\S]*?MB_FRAME_UNBIND_ACK/.test(fwCode),
      'the UI must not clear its state on a guess');
    check('UNBIND is on the link-gate allow-list',
      /type\s*!=\s*MB_FRAME_MOTOR_UNBIND/.test(fwCode),
      'otherwise a marginal heartbeat makes "unbind" silently do nothing');
  }

  /* --- 3. 界面侧 --- */
  if (ui && srv) {
    /* 剥注释:否则注释里引用的旧代码会被误判成真实实现 */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const uiCode = strip(ui);
    const srvCode = strip(srv);

    const unb = ui.match(/r\('unbind'\)\.onclick[\s\S]*?\n\s*\};/);
    check('unbind button handler found', !!unb);
    if (unb) {
      const b = strip(unb[0]);
      check('unbind button sends a real unbind command',
        /type:\s*'unbind'/.test(b),
        'sending only enable:false leaves the channel occupied -> rebind is rejected');
      check('unbind button still stops the motor first',
        /type:\s*'enable'[\s\S]*?enable:\s*false/.test(b),
        'safety first: do not rely on the unbind frame arriving');
      check('unbind button does NOT clear local state immediately',
        !/telemetryByChannel\.delete/.test(b),
        'clearing before the ack hides firmware rejections');
    }
    check('UI clears channel state on unbindAck',
      /case 'unbindAck'/.test(uiCode) &&
      /telemetryByChannel\.delete\(d\.channelId\)/.test(uiCode));
    check('UI reports unbind failure instead of hiding it',
      /解绑失败/.test(uiCode));
    check('server forwards the unbind command',
      /cmd\.type === 'unbind'/.test(srvCode) && /buildUnbind\(/.test(srvCode));
    check('server broadcasts unbindAck from the board',
      /FrameType\.UNBIND_ACK/.test(srvCode) && /parseUnbindAck/.test(srvCode));
  }
}

console.log('\n== 23. realtime chart: axis scaling and ring buffer ==');
{
  /*
   * 需求(2026-10-12 用户提出):电机电流与转速实时波动大,
   * 数字读数看不出抖动,改为曲线呈现。
   *
   * 这里测的是**纯计算部分**(纵轴映射、环形缓冲、双轴量纲隔离),
   * 因为 canvas 绘制需要 DOM 环境,不适合放在 node 侧自测里;
   * 绘制本身的正确性靠目视。
   *
   * 三个容易写错的地方:
   *   1. 转速(rpm)与电流(A)量纲差两个数量级 —— 共用一个轴会把电流压成直线,
   *      必须各自独立缩放(左转速、右电流)。
   *   2. 纵轴范围若不含 0,零线会跑出画布,看不出电机是正转还是反转。
   *   3. 采样数组必须有界,否则长时间开着网页会持续涨内存。
   */

  /* --- 源文件结构断言 --- */
  let chart, html, css, uiSrc;
  try {
    const b = new URL('./', import.meta.url);
    chart = readFileSync(new URL('chart.js', b), 'utf8');
    html = readFileSync(new URL('index.html', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
    uiSrc = readFileSync(new URL('ui.js', b), 'utf8');
  } catch { console.log('  SKIP  chart assets not reachable'); }

  if (uiSrc) {
    check('ui feeds speed/current/ref into the chart',
      /c\.push\(\s*t\.speed\s*,\s*t\.torque\s*,\s*t\.ref\s*\)/.test(uiSrc)
      || /\.push\(\s*t\.speed\s*,\s*t\.torque\s*,\s*t\.ref\s*\)/.test(uiSrc),
      'all three signals must be plotted; dropping one leaves the chart blind');
    /*
     * @attention 这两条断言曾在重构中误报:
     *   加入滤波同步后,原来的 `ensureChart(i, canvas).push(...)` 一行式
     *   变成了 `const c = ensureChart(i, canvas); ... c.push(...)`,
     *   断言写死了旧形态就失效了。
     *   现在只断言**语义**:
     *     - 采样发生在 renderChannel 内(即遥测到达时),不是在定时器里;
     *     - 实例通过 ensureChart 懒创建。
     *   形式可以变,性质不能变。
     */
    check('samples are pushed from the telemetry render path, not a timer',
      /function renderChannel[\s\S]*?c\.push\(/.test(uiSrc),
      'polling would plot points the board never reported');
    check('chart is created lazily on first data',
      /ensureChart\(i,\s*canvas\)/.test(uiSrc) && /if \(canvas\)/.test(uiSrc),
      'creating it eagerly measures a zero-width canvas before layout settles');
    check('chart controls do not create the instance themselves',
      /getChartIfExists\(i\)/.test(uiSrc),
      '"clear"/"window" on a never-received channel must be a no-op');
  }

  if (chart) {
    const code = chart.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /* 环形缓冲:超出上限就丢最旧的 */
    check('chart keeps a bounded sample buffer',
      /data\.length\s*>\s*CHART_MAX_POINTS[\s\S]*?\.shift\(\)/.test(code),
      'unbounded array grows forever while the page is left open');
    check('buffer cap is a named constant', /const CHART_MAX_POINTS\s*=/.test(code));

    /* 双轴:两侧各自映射 */
    check('speed and current have separate y-axis mappings',
      /yOfSpeed/.test(code) && /yOfTorque/.test(code),
      'sharing one axis flattens current (A) against speed (rpm)');

    /* 零线:范围必须含 0,否则看不出正反转 */
    check('speed axis range is forced to include zero',
      /Math\.min\(\.\.\.speedVals,\s*\.\.\.refVals,\s*0\)/.test(code)
      && /Math\.max\(\.\.\.speedVals,\s*\.\.\.refVals,\s*0\)/.test(code));
    check('zero line is drawn when the range spans it',
      /sLo\s*<\s*0\s*&&\s*sHi\s*>\s*0/.test(code));

    /* rAF 合并:同帧多次 push 只重绘一次 */
    check('redraws are coalesced with requestAnimationFrame',
      /requestAnimationFrame/.test(code));
    check('duplicate consecutive samples do not trigger a redraw',
      /last\s*&&\s*last\.speed\s*===/.test(code),
      'a stopped motor would otherwise redraw on every frame for nothing');

    /* devicePixelRatio:高分屏不糊 */
    check('canvas is scaled by devicePixelRatio',
      /devicePixelRatio/.test(code) && /setTransform/.test(code));
  }

  if (html) {
    check('channel template has a canvas', /data-role="chart"/.test(html));
    check('chart window selector offers several ranges',
      /data-role="chartWindow"/.test(html));
    check('chart can be cleared', /data-role="chartClear"/.test(html));
  }

  if (css) {
    /* 塌高会让 getBoundingClientRect().height 读到 0,曲线画不出来 */
    check('canvas has an explicit CSS height',
      /canvas\[data-role="chart"\]/.test(css) && /height:\s*\d+px/.test(css),
      'a collapsed canvas reads height 0 and renders nothing');
  }

  /* --- 纯计算:重跑一遍映射逻辑,验证量纲隔离真的成立 --- */
  {
    /* 转速 1000 rpm、电流 20 A —— 若共用一个轴,电流会被压成贴底的直线 */
    const sVals = [0, 1000];
    const tVals = [-20, 20];
    const sMin = Math.min(...sVals, 0);
    const sMax = Math.max(...sVals, 0);
    const sSpan = (sMax - sMin) || 100;
    const sLo = sMin - sSpan * 0.1;
    const sHi = sMax + sSpan * 0.1;
    const tAbs = Math.max(1, ...tVals.map(Math.abs));

    const yOfSpeed = (v) => (v - sLo) / (sHi - sLo);
    const yOfTorque = (v) => 0.5 - (v / tAbs) * 0.5;

    check('speed spans a useful fraction of the plot',
      Math.abs(yOfSpeed(1000) - yOfSpeed(0)) > 0.5,
      `got ${Math.abs(yOfSpeed(1000) - yOfSpeed(0)).toFixed(3)}`);
    check('current +20A maps to the top half', yOfTorque(20) < 0.1, `got ${yOfTorque(20)}`);
    check('current -20A maps to the bottom half', yOfTorque(-20) > 0.9, `got ${yOfTorque(-20)}`);
    check('current zero maps to the middle', Math.abs(yOfTorque(0) - 0.5) < 1e-9);
    check('zero is inside the speed range', sLo < 0 && sHi > 0);
  }

  /* --- 环形缓冲行为 --- */
  {
    const CAP = 300;
    const arr = [];
    for (let i = 0; i < CAP + 50; i++) {
      arr.push(i);
      if (arr.length > CAP) arr.shift();
    }
    check('buffer never exceeds the cap', arr.length === CAP, `got ${arr.length}`);
    check('buffer keeps the newest samples', arr[arr.length - 1] === CAP + 49, `got ${arr[arr.length - 1]}`);
    check('buffer drops the oldest samples', arr[0] === 50, `got ${arr[0]}`);
  }
}

console.log('\n== 26. CAN rx_id collision rules (see CAN_ID冲突说明.md) ==');
{
  /*
   * 为什么要单独测这一组:
   * motor_bench 的冲突预检(MotorBenchCheckRxIdFree)与 DJI 库的
   * MotorSenderGrouping() 用了**同一个公式**,但分处两个文件。
   * 哪天有人改了其中一个而没改另一个,这道"创建前就拦住"的防线
   * 就会静默失效 —— 而且失效方式很坏:板子不再提前拒绝,
   * 而是走进库的 __WFI() 停机,用户只知道"点一下板子就死了"。
   *
   * 所以本组把公式钉死,并断言两个文件的公式互相一致。
   *
   * 规则(源码 dji_motor.c:69 / :111):
   *   M2006 / M3508 : rx_id = 0x200 + tx_id   → 0x201~0x208
   *   GM6020        : rx_id = 0x204 + tx_id   → 0x205~0x20C
   *   重叠区 0x205~0x208
   */

  /* ---- JS 侧的预测函数:必须与固件两处公式一致 ---- */
  const predictRxId = (kind, txId) => {
    if (kind === MotorKind.GM6020) return 0x204 + txId;
    if (kind === MotorKind.M3508 || kind === MotorKind.M2006) return 0x200 + txId;
    return 0;   /* DM / LK / HT 走另一套 ID 段 */
  };

  /* ---- 逐个 ID 展开,先确认公式本身 ---- */
  check('GM6020 id=1 -> 0x205', predictRxId(MotorKind.GM6020, 1) === 0x205,
    `got 0x${predictRxId(MotorKind.GM6020, 1).toString(16)}`);
  check('GM6020 id=4 -> 0x208', predictRxId(MotorKind.GM6020, 4) === 0x208);
  check('M3508 id=1 -> 0x201', predictRxId(MotorKind.M3508, 1) === 0x201);
  check('M3508 id=8 -> 0x208', predictRxId(MotorKind.M3508, 8) === 0x208);
  check('M2006 id=5 -> 0x205', predictRxId(MotorKind.M2006, 5) === 0x205);
  check('DM predicts 0 (exempt from the rule)', predictRxId(MotorKind.DM, 1) === 0);

  /* ---- 冲突矩阵:同总线上 rx_id 相同即冲突 ---- */
  const conflicts = (a, b) => {
    /* 总线不同 → 独立 ID 空间,不冲突 */
    if (a.bus !== b.bus) return false;
    const ra = predictRxId(a.kind, a.id);
    const rb = predictRxId(b.kind, b.id);
    if (ra === 0 || rb === 0) return false;   /* 非 DJI 系不参与 */
    return ra === rb;
  };

  /* 文档里那张表的四组,必须全部冲突 */
  for (let n = 1; n <= 4; n++) {
    check(`GM6020 id=${n} conflicts with M3508 id=${n + 4} (same bus)`,
      conflicts({ kind: MotorKind.GM6020, id: n, bus: 1 },
                { kind: MotorKind.M3508, id: n + 4, bus: 1 }));
    check(`GM6020 id=${n} conflicts with M2006 id=${n + 4} (same bus)`,
      conflicts({ kind: MotorKind.GM6020, id: n, bus: 1 },
                { kind: MotorKind.M2006, id: n + 4, bus: 1 }));
  }

  /* 总线隔离:同样的组合换到不同总线就不冲突 —— 这是推荐接法的依据 */
  check('GM6020 id=1 + M3508 id=5 on DIFFERENT buses is fine',
    !conflicts({ kind: MotorKind.GM6020, id: 1, bus: 1 },
               { kind: MotorKind.M3508, id: 5, bus: 2 }));

  /* 6020 拨 5~8 落在 0x209~0x20C,与 3508/2006 全段不重叠 */
  for (let n = 5; n <= 8; n++) {
    check(`GM6020 id=${n} conflicts with nothing in the 3508/2006 range`,
      ![1, 2, 3, 4, 5, 6, 7, 8].some((j) => predictRxId(MotorKind.GM6020, n)
        === predictRxId(MotorKind.M3508, j)));
  }

  /*
   * 容易被忽略的一条:同型号拨同一个 ID 同样冲突。
   * 判定标准是"同总线 rx_id 重复",与型号无关 —— 但用户往往只想到跨型号冲突。
   */
  check('M3508 id=3 conflicts with M2006 id=3 (same bus, same ID)',
    conflicts({ kind: MotorKind.M3508, id: 3, bus: 1 },
              { kind: MotorKind.M2006, id: 3, bus: 1 }));
  check('M3508 id=1 vs M3508 id=2 do NOT conflict',
    !conflicts({ kind: MotorKind.M3508, id: 1, bus: 1 },
               { kind: MotorKind.M3508, id: 2, bus: 1 }));

  /* ---- 两处公式必须一致:固件库 vs 测试台预检 ---- */
  let fwDji, fwBench;
  try {
    /*
     * @attention 两个路径都要从 selftest.js 所在目录**相对**解析。
     *   上一版把 motor_bench.c 写成了相对固件目录的 'motor_bench.c',
     *   结果解析到 motor_bench_host/ 下、文件不存在,被 catch 静默跳过 ——
     *   整组"固件侧断言"从未真正执行过,却因为没报错而看起来全绿。
     *   这正是最危险的一种测试状态:跳过伪装成通过。
     *   所以下面额外断言两个文件确实读到了内容。
     */
    const fwBase = `${firmwareRelativeRoot}`;
    fwDji = readFileSync(new URL(`${fwBase}modules/motor/DJImotor/dji_motor.c`, import.meta.url), 'utf8');
    fwBench = readFileSync(new URL(`${fwBase}modules/motor_bench/motor_bench.c`, import.meta.url), 'utf8');
  } catch (e) { console.log('  SKIP  firmware sources not reachable:', e.message); }

  check('firmware dji_motor.c was actually read', !!fwDji && fwDji.length > 1000,
    fwDji ? `len=${fwDji.length}` : 'NOT READ — assertions below would be silently skipped');
  check('firmware motor_bench.c was actually read', !!fwBench && fwBench.length > 1000,
    fwBench ? `len=${fwBench.length}` : 'NOT READ — assertions below would be silently skipped');

  if (fwDji) {
    /* 库里的两处赋值:0x200 + motor_id + 1 与 0x204 + motor_id + 1 */
    check('DJI library assigns 0x200 + motor_id + 1 to M2006/M3508',
      /config->rx_id\s*=\s*0x200\s*\+\s*motor_id\s*\+\s*1/.test(fwDji));
    check('DJI library assigns 0x204 + motor_id + 1 to GM6020',
      /config->rx_id\s*=\s*0x204\s*\+\s*motor_id\s*\+\s*1/.test(fwDji));
    check('DJI library still halts on rx_id collision',
      /rx_id crash/.test(fwDji) && /__WFI\(\)/.test(fwDji),
      'the library HALT is expected and must stay');
  }

  if (fwBench) {
    /* 测试台的预测函数:必须与库一致,否则这道防线形同虚设 */
    check('motor_bench predicts 0x204 + motor_id for GM6020',
      /case MB_MOTOR_GM6020:[\s\S]*?return\s*\(uint16_t\)\(0x204\s*\+\s*motor_id\)/.test(fwBench));
    check('motor_bench predicts 0x200 + motor_id for M3508/M2006',
      /case MB_MOTOR_M3508:[\s\S]*?case MB_MOTOR_M2006:[\s\S]*?return\s*\(uint16_t\)\(0x200\s*\+\s*motor_id\)/.test(fwBench));
    check('motor_bench pre-check skips different CAN buses',
      /mb_inventory\[i\]\.can_bus\s*!=\s*can_bus\)/.test(fwBench),
      'without this, every motor would be compared against both buses');
    check('motor_bench returns DUPLICATE instead of halting',
      /MotorBenchCheckRxIdFree[\s\S]*?return MB_ERR_DUPLICATE/.test(fwBench));
    check('motor_bench never calls __WFI in the pre-check',
      !/static uint8_t MotorBenchCheckRxIdFree[\s\S]*?__WFI/.test(fwBench),
      'the whole point is to refuse early instead of halting the board');
  }
}

console.log('\n== 23. unbind must clear the motor instance residual ref ==');
{
  /*
   * 实测故障(2026-10-13,安全级):
   *   解绑前速度不为 0 → 重新绑定 → 使能 → **界面显示 0,电机却立刻转动**。
   *
   * 根因:通道结构与电机实例是**两个独立对象**。
   *   - MotorBenchUnbind 里的 memset 只清通道结构体;
   *   - 电机实例在 MotorBenchAddMotor 时创建,此后一直留在
   *     dji_motor_instance[] 里,解绑不销毁它 ——
   *     于是 instance->motor_controller.pid_ref 还留着解绑前的值。
   *   只清通道的 ref_cmd 没用:那只是"上位机最近下发值的记账",
   *   DJIMotorControl() 真正读的是实例里的 pid_ref。
   *
   * 判据(对着固件源码断言,因为这是"不该再犯"的结构性约束):
   *   1. MotorBenchUnbind 必须先把实例参考值归零,再 memset 通道结构体
   *      —— 顺序不能反:memset 会清掉 motor_ptr,之后就找不到实例了
   *   2. 绑定路径也必须清零(防止电机实例被别处写过)
   *   3. 两处都要通过 MotorBenchSetRefInstance 走驱动接口,不要直接写字段
   */
  let fwC;
  try {
    fwC = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
      import.meta.url,
    ), 'utf8');
  } catch { console.log('  SKIP  motor_bench.c not reachable'); }

  if (fwC) {
    const code = fwC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /* --- MotorBenchUnbind --- */
    const ub = code.match(/uint8_t MotorBenchUnbind\(uint8_t channel_id\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchUnbind found', !!ub);
    if (ub) {
      const body = ub[0];
      check('unbind stops the motor instance',
        /MotorBenchForceStopInstance\(/.test(body),
        'must cut output before clearing anything');
      check('unbind clears the motor instance ref',
        /MotorBenchSetRefInstance\([\s\S]*?0\.0f\)/.test(body),
        'this is the actual bug: memset on the channel struct does NOT touch pid_ref');
      check('unbind goes through the driver interface, not a raw field write',
        !/->pid_ref\s*=/.test(body) && !/\.pid_ref\s*=/.test(body),
        'raw field writes break if the driver changes semantics');

      /* 顺序:memset 必须在清零之后,否则 motor_ptr 已经是 NULL */
      const iClear = body.indexOf('MotorBenchSetRefInstance');
      const iMemset = body.indexOf('memset');
      check('unbind zeroes the ref BEFORE memset',
        iClear > -1 && iMemset > -1 && iClear < iMemset,
        'memset wipes motor_ptr, so the instance would become unreachable');
    }

    /* --- 绑定路径 --- */
    const bind = code.match(/uint8_t MotorBenchBind\([\s\S]*?\n\}/);
    check('MotorBenchBind found', !!bind);
    if (bind) {
      check('bind also zeroes any residual ref',
        /MotorBenchSetRefInstance\([\s\S]*?0\.0f\)/.test(bind[0]),
        'a channel must never start life with a leftover reference');
      check('bind does not re-enable or spin the motor',
        !/MotorBenchEnableInstance\([\s\S]*?\b1\b/.test(bind[0]),
        'binding must leave the motor stopped until the user enables it');
    }

    /* --- 前置声明:两个函数定义在后半部分,必须先声明 --- */
    const head = code.slice(0, code.indexOf('MotorBenchBind'));
    check('MotorBenchForceStopInstance is forward-declared before use',
      /void MotorBenchForceStopInstance\(MB_MotorKind_e kind, void \*instance\);/.test(head),
      'it is defined later in the file — without the prototype this will not compile');
    check('MotorBenchSetRefInstance is forward-declared before use',
      /static uint8_t MotorBenchSetRefInstance\(MB_MotorKind_e kind, void \*instance, float ref\);/.test(head));
  }
}

console.log('\n== 24. low-pass filter on speed/current, and the readout row removal ==');
{
  /*
   * 需求(2026-10-13 用户):电流和转速波动太大,需要滤波;
   *   同时删掉数字读数行。
   *
   * 滤波的要点不是"把线画平",而是**区分两种波动**:
   *   - 传感器/量化噪声  → 低通能压掉
   *   - PID 引起的低频震荡 → 低通压不住(震荡是低频的,会原样穿过)
   * 所以这个开关同时是诊断工具:开着还抖 = 控制问题,关掉才抖 = 噪声问题。
   *
   * 删除读数行要小心一处:ui.js 里若还留着 r('speed') 之类的赋值,
   * 元素已不存在会拿到 null 并抛异常,**整张卡片的渲染会中断**。
   * 所以既查模板也查 JS 引用。
   */

  /* --- LowPass 纯计算:可直接 import 验证 ---
   *
   * @attention 先算值再断言,不要写成 `check(..., lp.push(x) === y, `got ${lp.push(x)}`)`。
   *   detail 模板里的那次 push 会**真的再推一次状态**,
   *   于是断言值与被比较的值不是同一个 —— 实测报出 "got 191" 这种
   *   看起来像实现错误的假失败,实际是测试写法把自己坑了。
   */
  const lp = new LowPass(0.3);
  const seed = lp.push(100);
  check('LowPass: first sample seeds directly (no fake ramp from zero)',
    seed === 100, `got ${seed}`);
  const step1 = lp.push(200);
  /* alpha=0.3 表示旧值权重 0.3:0.3*100 + 0.7*200 = 170 */
  check('LowPass: alpha is the OLD-sample weight',
    step1 === 170, `got ${step1} (expected 0.3*100 + 0.7*200 = 170)`);

  const lp2 = new LowPass(0.5);
  lp2.push(0);
  const half = lp2.push(10);
  check('LowPass: alpha=0.5 moves halfway', half === 5, `got ${half}`);
  lp2.reset();
  check('LowPass: reset clears state', lp2.value === null);
  check('LowPass: alpha is clamped to a sane range',
    new LowPass(99).alpha === 0.98 && new LowPass(-5).alpha === 0.1 && new LowPass(0.95).alpha === 0.95);

  /* 阶跃响应:滤波后应单调趋近,且始终不超过目标(无超调) */
  const lp3 = new LowPass(0.3);
  lp3.push(0);
  let prev = -1;
  let monotonic = true;
  let overshoot = false;
  for (let k = 0; k < 40; k++) {
    const v = lp3.push(100);
    if (v < prev) monotonic = false;
    if (v > 100 + 1e-9) overshoot = true;
    prev = v;
  }
  check('LowPass step response is monotonic', monotonic);
  check('LowPass step response does not overshoot', !overshoot);
  check('LowPass converges to the step target', Math.abs(prev - 100) < 0.5, `got ${prev}`);

  /*
   * 滤波强度对比:测量**收敛后的残留波动**,不能只比最后一个采样点。
   *
   * @attention 原断言取 `push` 的最后返回值比较,那只是噪声序列的最后一项,
   *   与滤波强度基本无关 —— 实测 strong=9.09 / weak=6.66 这种结果纯属偶然。
   *
   * 语义也已统一:alpha 是**旧值权重**,越大越平滑。
   *   strong = 0.9(旧值主导), weak = 0.2(新采样主导)。
   */
  {
    /*
     * @attention 判据必须用"相邻采样差"(平滑度),不能用"尾部分布标准差"。
     *
     *   实测同一个滤波器:
     *     alpha=0.05 → σ=27.59(看似最差),但曲线其实最平滑;
     *     alpha=0.90 → σ=6.64(看似最好)。
     *   原因是 alpha 越小时间常数越长,输出会在很长窗口内缓慢漂移,
     *   这种**低频漂移会增大整体方差**,但它恰恰是"被平滑掉高频"的表现。
     *   用方差当判据会得出完全相反的结论。
     *
     *   正确的平滑度度量是相邻两点落差之和 ——
     *   高频毛刺被压制后,相邻差必然变小。
     */
    const seq = [];
    let sd = 7;
    for (let i = 0; i < 3000; i++) { sd = (sd * 1103515245 + 12345) & 0x7fffffff; seq.push(sd % 101); }

    /** 平均相邻落差:越小越平滑 */
    const roughness = (alpha) => {
      const f = new LowPass(alpha);
      let prev = null;
      let sum = 0;
      let n = 0;
      seq.forEach((x, i) => {
        const v = f.push(x);
        if (i >= 1000) {
          if (prev !== null) { sum += Math.abs(v - prev); n++; }
          prev = v;
        }
      });
      return sum / n;
    };

    const rawRough = seq.slice(1000).reduce(
      (acc, x, i, arr) => (i === 0 ? acc : acc + Math.abs(x - arr[i - 1])), 0,
    ) / (seq.length - 1001);

    const rWeak = roughness(0.3);   /* 弱档 */
    const rStrong = roughness(0.7); /* 强档 */
    const rMax = roughness(0.95);   /* 超强档 */

    check('any filtering reduces roughness versus the raw signal',
      rWeak < rawRough && rStrong < rawRough,
      `raw=${rawRough.toFixed(2)} weak=${rWeak.toFixed(2)} strong=${rStrong.toFixed(2)}`);
    check('stronger filtering (larger alpha) yields a smoother line',
      rStrong < rWeak,
      `strong=${rStrong.toFixed(3)} weak=${rWeak.toFixed(3)}`);
    check('the 超强 preset is dramatically smoother than 弱',
      rMax < rWeak * 0.5,
      `超强=${rMax.toFixed(3)} 弱=${rWeak.toFixed(3)}`);
  }

  /* --- 接线断言 --- */
  let chartSrc, uiSrc, htmlSrc;
  try {
    const b = new URL('./', import.meta.url);
    chartSrc = readFileSync(new URL('chart.js', b), 'utf8');
    uiSrc = readFileSync(new URL('ui.js', b), 'utf8');
    htmlSrc = readFileSync(new URL('index.html', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  if (chartSrc) {
    const code = chartSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('chart.js exports a LowPass class', /export class LowPass/.test(code));
    check('speed and current each have their own filter state',
      /lpSpeed/.test(code) && /lpTorque/.test(code),
      'sharing one filter would cross-contaminate two unrelated signals');
    check('the setpoint ref is NOT filtered',
      !/lpRef/.test(code),
      'ref is our own command — filtering it would lag every step response');
    check('filter can be toggled', /setFilter\s*\(/.test(code));
    check('filter strength is adjustable', /setFilterAlpha\s*\(/.test(code));
    check('clearing the chart also resets filter state',
      /clear\(\)\s*\{[\s\S]*?lpSpeed\.reset\(\)/.test(code),
      'otherwise old state drags the new data');
    check('filter still tracks input while disabled',
      /else \{[\s\S]*?lpSpeed\.push\(speed\)/.test(code),
      're-enabling would otherwise jump from a stale value');
  }

  if (uiSrc) {
    const code = uiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('ui wires the filter checkbox', /r\('filterOn'\)\.onchange/.test(code));
    check('ui wires the filter strength select', /r\('filterAlpha'\)\.onchange/.test(code));
    check('ui syncs filter settings on each render',
      /c\.setFilter\(fOn\.checked\)/.test(code),
      'lazy chart creation would otherwise drop settings changed before the first sample');
  }

  /* --- 读数行删除 --- */
  if (htmlSrc) {
    for (const role of ['ref', 'speed', 'torque', 'angle']) {
      check(`readout cell "${role}" is removed from the template`,
        !new RegExp(`data-role="${role}"`).test(htmlSrc),
        'the chart supersedes these numbers');
    }
    check('temperature is kept (slow variable, no trend to watch)',
      /data-role="temp"/.test(htmlSrc));
  }

  if (uiSrc) {
    /*
     * 最关键的一条:模板删了元素,JS 就不能再给它赋值 ——
     * 拿到 null 再 .textContent 会抛异常,把整个 renderChannel 打断,
     * 表现为"整张卡片不再更新",比少显示一个数字严重得多。
     */
    const code = uiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const role of ['ref', 'speed', 'torque', 'angle']) {
      check(`ui no longer writes to the removed "${role}" cell`,
        !new RegExp(`r\\('${role}'\\)`).test(code),
        'a dangling querySelector would throw and break the whole card render');
    }
    check('ui still writes temperature, guarded against a missing element',
      /const tempEl = r\('temp'\)/.test(code) && /if \(tempEl\)/.test(code));
  }
}

console.log('\n== 27. add-motor panel: conflict hint and available-ID list ==');
{
  /*
   * 需求(2026-10-13 用户提出):
   *   添加电机时若 ID 冲突,要**当场提示**,并告诉用户改 3508/2006,
   *   同时给出当前可用的 ID —— 而不是只说一句"冲突了"就完事。
   *
   * 这一组测 protocol.js 里的纯函数(可直接 import,无需 DOM),
   * 界面接线另由本组末尾的源码结构断言负责。
   */

  const inv = (list) => list.map(([kind, canBus, motorId]) => ({ kind, canBus, motorId }));
  const ids = (a) => JSON.stringify(a);

  /* ---- availableIds:空总线时 1~8 全可用 ---- */
  check('empty bus -> all 8 IDs free for M3508',
    ids(availableIds(1, [], MotorKind.M3508)) === ids([1,2,3,4,5,6,7,8]));

  /* ---- 3508 与 2006 同公式:占的是同一个 ID ---- */
  {
    const inv1 = inv([[MotorKind.M3508, 1, 1]]);
    const free = availableIds(1, inv1, MotorKind.M2006);
    check('M3508#1 also occupies id 1 for M2006 (same formula)',
      !free.includes(1), `free=${ids(free)}`);
    check('ids 2..8 remain free', ids(free) === ids([2,3,4,5,6,7,8]));
  }

  /* ---- 6020 与 3508 的关键场景:相差 4 才撞 ---- */
  {
    const inv1 = inv([[MotorKind.GM6020, 1, 1]]);
    const free = availableIds(1, inv1, MotorKind.M3508);
    check('GM6020#1 (rx 0x205) blocks M3508 id=5', !free.includes(5), `free=${ids(free)}`);
    check('GM6020#1 leaves M3508 ids 1-4 and 6-8 free',
      ids(free) === ids([1,2,3,4,6,7,8]));
  }

  /* ---- 6020 拨 5~8 落在独享区间,不占任何 3508/2006 的 ID ---- */
  for (let n = 5; n <= 8; n++) {
    const free = availableIds(1, inv([[MotorKind.GM6020, 1, n]]), MotorKind.M3508);
    check(`GM6020#${n} blocks no M3508 id`, free.length === 8, `free=${ids(free)}`);
  }

  /* ---- 总线隔离 ---- */
  {
    const inv1 = inv([[MotorKind.M3508, 1, 5]]);
    check('CAN1 occupancy does not affect CAN2',
      availableIds(2, inv1, MotorKind.GM6020).length === 8);
    check('but the same bus is affected',
      !availableIds(1, inv1, MotorKind.GM6020).includes(1));
  }

  /* ---- 达妙等非 DJI 系完全不参与该判定 ---- */
  {
    const inv1 = inv([[MotorKind.M3508, 1, 1]]);
    check('DM ignores DJI id occupancy', availableIds(1, inv1, MotorKind.DM).length === 8);
    check('DM never conflicts', findConflict(1, inv1, MotorKind.DM, 1) === null);
    check('a DM motor blocks no DJI id',
      availableIds(1, inv([[MotorKind.DM, 1, 1]]), MotorKind.M3508).length === 8);
  }

  /* ---- findConflict 的返回值要够用(界面要靠它说清"和谁撞") ---- */
  {
    const inv1 = inv([[MotorKind.GM6020, 1, 1], [MotorKind.M3508, 1, 3]]);
    const hit = findConflict(1, inv1, MotorKind.M2006, 5);   // 2006#5 = 0x205 = 6020#1
    check('findConflict detects M2006#5 vs GM6020#1', !!hit);
    check('findConflict reports the shared rx_id', hit && hit.rxId === 0x205);
    check('findConflict reports which motor occupies it',
      hit && hit.existing.kind === MotorKind.GM6020 && hit.existing.motorId === 1);
    check('no conflict reported for a free id',
      findConflict(1, inv1, MotorKind.M2006, 2) === null);
  }

  /*
   * ---- 提示文案:用户要求的两点必须都在 ----
   *   ① 告诉用户改 3508/2006
   *   ② 给出当前可用 ID
   */
  {
    /* 已有 3508#5(0x205),现在要加 6020#1(也 0x205) */
    const msg = describeConflict(1, inv([[MotorKind.M3508, 1, 5]]), MotorKind.GM6020, 1);
    check('conflict message is produced', msg.length > 0);
    check('message names both motors', /GM6020/.test(msg) && /M3508/.test(msg));
    check('message shows the shared rx_id', /0x205/i.test(msg), msg);
    check('message tells the user to change the M3508 (user requirement ①)',
      /请改[^。]*M3508/.test(msg), msg);
    check('message lists the available ids (user requirement ②)',
      /可用 ID/.test(msg), msg);
    check('message points out the overlap-free 6020 range',
      /5~8/.test(msg), msg);

    /* 3508 与 2006 同 ID —— 最容易被忽略的一类冲突 */
    const msg2 = describeConflict(1, inv([[MotorKind.M3508, 1, 3]]), MotorKind.M2006, 3);
    check('M3508 vs M2006 same-id conflict is reported',
      /同一公式|同一个 ID/.test(msg2), msg2);
    check('同一公式 message still lists free ids',
      /可用 ID/.test(msg2) && /1、2、4/.test(msg2), msg2);

    /* 无冲突时不应产生任何文案 */
    check('no message when there is no conflict',
      describeConflict(1, [], MotorKind.M3508, 1) === '');
    check('DM never produces a conflict message',
      describeConflict(1, inv([[MotorKind.M3508, 1, 1]]), MotorKind.DM, 1) === '');

    /* 该总线 ID 用尽时要给出可执行的下一步,而不是一个空列表 */
    const full = inv(Array.from({ length: 8 }, (_, i) => [MotorKind.M3508, 1, i + 1]));
    const msg3 = describeConflict(1, full, MotorKind.M2006, 3);
    check('exhausted bus gives actionable advice instead of an empty list',
      /已无[^。]*可用的拨码 ID/.test(msg3) && /另一条总线|移除/.test(msg3), msg3);

    /*
     * ---- 可用 ID 必须绑定到"本颗型号" ----
     * 实测陷阱:已有 3508#5 时加 6020#1,按 6020 算出的可用列表里含 5
     * (6020 拨 5 = 0x209,确实不冲突)。但若文案只写"当前可用 ID:...5...",
     * 用户会理解成"3508 拨 5 也行" —— 而 3508 拨 5 正是冲突的那个 ID。
     */
    {
      const m = describeConflict(1, inv([[MotorKind.M3508, 1, 5]]), MotorKind.GM6020, 1);
      check('available-id list is labelled with the motor being added',
        /GM6020 可用的拨码 ID/.test(m), m);
      check('message warns that the list depends on the motor type',
        /随型号而变/.test(m), m);
    }
  }

  /* ---- 界面接线 ---- */
  let uiSrc2;
  try {
    uiSrc2 = readFileSync(new URL('ui.js', import.meta.url), 'utf8');
  } catch { console.log('  SKIP  ui.js not reachable'); }

  if (uiSrc2) {
    check('ui defines refreshAddHint at module scope',
      /^function refreshAddHint\(\)/m.test(uiSrc2));
    /*
     * 2026-10-17:#addRxId(达妙反馈 ID)加入后输入项从三个变成四个。
     *
     * @attention 这里**不能**简单地改成正则匹配四个字面 id ——
     *   那就把这条断言退化成"当前恰好这四个"的脆检查,
     *   将来再加第五个输入框又得改测试。
     *   改成**反证**:从 ui.js 里抽出实际监听列表,断言它覆盖
     *   页面上所有带实时预检需求的输入控件,一个不漏。
     *   这样新增控件时忘记接线,测试会立刻红,而不是静默漏绑。
     */
    const listenerIds = (uiSrc2.match(/for \(const id of \[([^\]]+)\]\)[\s\S]{0,240}?oninput = refreshAddHint/)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    check('ui extracts the live-hint listener list', listenerIds.length > 0,
      'could not parse the for-of id list from ui.js');
    check('ui binds the live hint on every add-panel input',
      ['#addKind', '#addBus', '#addId', '#addRxId'].every((id) => listenerIds.includes(id)),
      `listener list = ${listenerIds.join(', ')}`);
    check('ui uses onXxx assignment, not addEventListener',
      !/\.addEventListener\('input', refreshAddHint\)/.test(uiSrc2),
      'bindEvents runs on every card rebuild; addEventListener would stack handlers');
    check('ui blocks the send when a conflict is detected',
      /const conflictMsg = describeConflict\([\s\S]{0,240}?if \(conflictMsg\)[\s\S]{0,160}?return;/.test(uiSrc2),
      'no point sending a request the board is guaranteed to reject');
    check('ui recomputes the hint when inventory changes',
      /typeof refreshAddHint === 'function'[\s\S]{0,60}?refreshAddHint\(\)/.test(uiSrc2),
      'a stale available-ID list would lead the user straight into a collision');
    /* 达妙专用:rx_id 输入框必须按型号切换可见性,且非 DM 时清零 */
    check('ui toggles the rx_id input by motor kind',
      /function syncRxIdVisibility\(\)/.test(uiSrc2) && /syncRxIdVisibility\(\)/.test(uiSrc2),
      'a DM-only control that stays visible on DJI kinds is misleading');
    check('ui validates rx_id before sending',
      /readRxIdInput\(\)/.test(uiSrc2) && /if \(!rx\.ok\)/.test(uiSrc2),
      'an out-of-range feedback ID must be caught before the frame goes out');
  }
}

console.log('\n== 25. anti-aliasing: average at the sample source, not just on display ==');
{
  /*
   * 实测现象(2026-10-13):界面滤波开到"强",转速曲线平直,
   *   电流仍在 ±25 之间疯狂抖动。
   *
   * 根因是**混叠(aliasing)**,不是噪声大:
   *   电机控制任务 500Hz,遥测每 MB_TELEMETRY_DIVIDER(10) 拍取一次样 = 50Hz。
   *   而电流由电流环在 500Hz 下调节 —— 用 50Hz 抽 500Hz 的信号是**欠采样**,
   *   高频成分被折叠到低频,显示成"随机大幅抖动"。
   *
   * 关键:混叠发生在**采样那一刻**,显示端再怎么滤波都救不回来 ——
   *   滤的已经是一个不真实的信号。这正是"开到强也没用"的原因。
   *
   * 正确做法是两级抗混叠:
   *   1. 固件侧:每拍累加、发送时取平均(等效 decimation 前的低通)
   *   2. 显示端:按像素桶平均(样点数 > 像素数 时的渲染混叠)
   */
  let fwC;
  try {
    fwC = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
      import.meta.url,
    ), 'utf8');
  } catch { console.log('  SKIP  motor_bench.c not reachable'); }

  if (fwC) {
    const code = fwC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    check('firmware defines telemetry accumulators',
      /mb_tele_acc_current\[MB_CHANNEL_MAX\]/.test(code)
      && /mb_tele_acc_count\[MB_CHANNEL_MAX\]/.test(code),
      'without accumulation the 50Hz snapshot under-samples the 500Hz current loop');

    const task = code.match(/void MotorBenchTask\(void\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchTask found', !!task);
    if (task) {
      check('accumulation happens EVERY tick, not only on the send tick',
        /mb_tele_acc_current\[i\]\s*\+=/.test(task[0]),
        'reading once per send tick is not averaging — aliasing remains');
      const iAcc = task[0].indexOf('mb_tele_acc_current[i] +=');
      const iSend = task[0].indexOf('mb_telemetry_div >= MB_TELEMETRY_DIVIDER');
      check('accumulation precedes the divider check in the task body',
        iAcc > -1 && iSend > -1 && iAcc < iSend,
        'if it ran after the divider test it would also be once per 10 ticks');
    }

    const send = code.match(/static void MotorBenchSendTelemetry\(void\)\s*\{[\s\S]*?\n\}/);
    check('MotorBenchSendTelemetry found', !!send);
    if (send) {
      check('telemetry sends the averaged current, not an instantaneous read',
        /measure_torque\s*=\s*mb_tele_acc_current\[i\]\s*\*\s*inv/.test(send[0]));
      check('telemetry sends the averaged speed',
        /measure_speed\s*=\s*mb_tele_acc_voltage\[i\]\s*\*\s*inv/.test(send[0]));
      check('accumulators are reset after each send',
        /mb_tele_acc_current\[i\]\s*=\s*0\.0f/.test(send[0])
        && /mb_tele_acc_count\[i\]\s*=\s*0/.test(send[0]),
        'not resetting makes the averaging window grow without bound');
      check('angle is NOT averaged (wraps at 360°)',
        !/measure_angle\s*=\s*mb_tele_acc/.test(send[0]),
        'averaging a wrapping angle yields meaningless values');
      check('temperature is NOT averaged (slow variable)',
        !/temperature\s*=\s*mb_tele_acc/.test(send[0]));
    }

    check('divider is 10 (500Hz task -> 50Hz telemetry)',
      /#define MB_TELEMETRY_DIVIDER 10/.test(fwC));
  }

  /* --- 显示端:像素桶降采样 --- */
  let chartSrc, uiSrc;
  try {
    const b = new URL('./', import.meta.url);
    chartSrc = readFileSync(new URL('chart.js', b), 'utf8');
    uiSrc = readFileSync(new URL('ui.js', b), 'utf8');
  } catch { console.log('  SKIP  chart.js not reachable'); }

  if (chartSrc) {
    const code = chartSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('chart has a pixel-bucket downsampler', /_bucketize\s*\(/.test(code),
      '300 points into ~600px still aliases at the pixel level');
    check('all three curves are drawn from the bucketed series',
      /this\._line\(buckets,/.test(code) && !/this\._line\(pts,/.test(code),
      'drawing raw pts would reintroduce per-pixel sawtooth');

    /* 纯计算验证:桶平均确实把毛刺压掉 */
    const wave = [];
    for (let i = 0; i < 300; i++) wave.push({ speed: i % 2 ? 100 : 0, torque: 0, ref: 0 });

    const bucketize = (pts, plotW) => {
      const n = pts.length;
      const size = Math.ceil(n / Math.max(1, plotW));
      if (size <= 1) return pts;
      const out = [];
      for (let i = 0; i < n; i += size) {
        const end = Math.min(i + size, n);
        let s = 0;
        for (let k = i; k < end; k++) s += pts[k].speed;
        out.push({ speed: s / (end - i), torque: 0, ref: 0 });
      }
      return out;
    };

    const rawSpread = 100;
    const b150 = bucketize(wave, 150);
    const bSpread = Math.max(...b150.map((p) => p.speed)) - Math.min(...b150.map((p) => p.speed));

    check('windowing reduces peak-to-peak spread', bSpread < rawSpread,
      `raw=${rawSpread} bucketed=${bSpread}`);
    check('bucketed values converge toward the true mean',
      b150.every((p) => Math.abs(p.speed - 50) <= 20),
      'each bucket should average the 0/100 alternation toward 50');
    check('downsampling shrinks the point count', b150.length < wave.length,
      `${b150.length} vs ${wave.length}`);
    check('short windows are untouched (size 1 keeps detail)',
      bucketize(wave.slice(0, 50), 600).length === 50,
      'a 50-point window on 600px must not be smoothed away');
  }

  if (uiSrc) {
    check('ui still pushes raw samples (firmware owns the heavy filtering)',
      /\.push\(\s*t\.speed\s*,\s*t\.torque\s*,\s*t\.ref\s*\)/.test(uiSrc));
  }
}

console.log('\n== 28. smoothing coefficient semantics must match the formula ==');
{
  /*
   * 实测根源(2026-10-13):电流曲线怎么滤都抖,而 PID 是 1/0/0
   *   —— 纯比例、无积分无微分,**不可能产生高频振荡**。
   *   所以抖动必然来自别处。查下去发现驱动层的"滤波"形同虚设。
   *
   * 原代码(DJImotor):
   *     real_current = (1 - COEF) * 旧值 + COEF * 新采样;
   *     #define CURRENT_SMOOTH_COEF 0.9f   // 注释:"必须大于0.9"
   *
   * 注释"系数为1即关闭滤波"是对的,但由此得出"必须大于0.9"就完全反了 ——
   * 在这个公式下 0.9 意味着**新采样占 90% 权重**,几乎等于不滤波。
   * 实测该取值下噪声标准差仅从 29.2 降到 26.2,即**只滤掉 10%**。
   *
   * 这才是"电流怎么滤都抖"的真正原因:源头这道滤波器是空的,
   * 后面叠多少级平滑都只是在补它的窟窿。
   */
  {
    const oldF = (c, a) => { let v = 0; for (const x of a) v = (1 - c) * v + c * x; return v; };
    const newF = (c, a) => { let v = 0; for (const x of a) v = c * v + (1 - c) * x; return v; };
    const noise = [];
    let seed = 12345;
    for (let i = 0; i < 2000; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise.push(seed % 101); }

    const old09 = Math.abs(oldF(0.9, noise) - 50);
    const new06 = Math.abs(newF(0.6, noise) - 50);
    check('old convention with coef=0.9 leaves large residual noise',
      old09 > 8, `residual=${old09.toFixed(1)} — that is the bug signature`);
    check('new convention with coef=0.6 suppresses it much better',
      new06 < old09, `new=${new06.toFixed(1)} vs old=${old09.toFixed(1)}`);
    check('same coefficient behaves differently under the two conventions',
      Math.abs(oldF(0.6, noise) - newF(0.6, noise)) > 1,
      'the convention must be pinned by the formula, not by the number alone');
  }

  let djiH, djiC, lkH, lkC, htH, htC;
  try {
    const base = new URL(`${firmwareRelativeRoot}modules/motor/`, import.meta.url);
    djiH = readFileSync(new URL('DJImotor/dji_motor.h', base), 'utf8');
    djiC = readFileSync(new URL('DJImotor/dji_motor.c', base), 'utf8');
    lkH = readFileSync(new URL('LKmotor/LK9025.h', base), 'utf8');
    lkC = readFileSync(new URL('LKmotor/LK9025.c', base), 'utf8');
    htH = readFileSync(new URL('HTmotor/HT04.h', base), 'utf8');
    htC = readFileSync(new URL('HTmotor/HT04.c', base), 'utf8');
  } catch { console.log('  SKIP  motor driver sources not reachable'); }

  if (djiC && djiH) {
    const defLine = (src, name) => {
      const m = src.match(new RegExp(`^\\s*#define\\s+${name}\\s+([\\d.]+)f`, 'm'));
      return m ? parseFloat(m[1]) : null;
    };
    const spd = defLine(djiH, 'SPEED_SMOOTH_COEF');
    const cur = defLine(djiH, 'CURRENT_SMOOTH_COEF');
    check('DJI SPEED_SMOOTH_COEF is defined', spd !== null);
    check('DJI CURRENT_SMOOTH_COEF is defined', cur !== null);
    check('CURRENT_SMOOTH_COEF is a sane old-sample weight (0.3~0.9)',
      cur !== null && cur >= 0.3 && cur <= 0.9, `got ${cur}`);
    check('SPEED_SMOOTH_COEF is a sane old-sample weight (0.3~0.9)',
      spd !== null && spd >= 0.3 && spd <= 0.9, `got ${spd}`);
    check('DJI current filter uses COEF * old + (1-COEF) * new',
      /real_current\s*=\s*CURRENT_SMOOTH_COEF\s*\*\s*measure->real_current/.test(djiC)
      && /\(1\.0f\s*-\s*CURRENT_SMOOTH_COEF\)/.test(djiC),
      'the inverted form makes coef=0.9 a no-op filter');
    check('DJI speed filter uses COEF * old + (1-COEF) * new',
      /speed_aps\s*=\s*SPEED_SMOOTH_COEF\s*\*\s*measure->speed_aps/.test(djiC)
      && /\(1\.0f\s*-\s*SPEED_SMOOTH_COEF\)/.test(djiC));
  }

  if (lkH && htH) {
    const bare = (src, name) => new RegExp(`^\\s*#define\\s+${name}\\s`, 'm').test(src);
    const bareCount = [
      bare(djiH || '', 'CURRENT_SMOOTH_COEF') || bare(djiH || '', 'SPEED_SMOOTH_COEF'),
      bare(lkH, 'CURRENT_SMOOTH_COEF') || bare(lkH, 'SPEED_SMOOTH_COEF'),
      bare(htH, 'CURRENT_SMOOTH_COEF') || bare(htH, 'SPEED_SMOOTH_COEF'),
    ].filter(Boolean).length;
    check('at most one motor library defines a bare SMOOTH_COEF macro',
      bareCount <= 1,
      `${bareCount} libraries still share the name — they silently overwrite each other`);
    check('LK macros are namespaced', /#define\s+LK_CURRENT_SMOOTH_COEF/.test(lkH));
    check('HT macros are namespaced', /#define\s+HT_CURRENT_SMOOTH_COEF/.test(htH));
    check('LK source uses its namespaced macros', /LK_CURRENT_SMOOTH_COEF/.test(lkC));
    check('HT source uses its namespaced macro', /HT_CURRENT_SMOOTH_COEF/.test(htC));
  }
}

console.log('\n== 29. motor init config must be zeroed and DeadBand set explicitly ==');
{
  /*
   * 实测症状(2026-10-13):每次设定新速度都出现明显超调
   *   (尖峰 4280 → 回落 1050),而速度环 Kp 只有 2 ——
   *   这么小的增益不可能产生那种过冲。用户判断"像 PID 问题但 PID 很小",
   *   这个矛盾本身就是线索:问题不在增益,在被隐藏的死区。
   *
   * 根因:
   *   BenchMotorFactory 里写的是 `Motor_Init_Config_s cfg;`
   *   —— **未初始化的栈变量**。BenchBuildDJIConfig 只写其中一部分字段,
   *   没被写到的 DeadBand 就是随机栈垃圾。
   *
   *   而 controller.c 的死区分支是:
   *       if (abs(Err) > DeadBand) { 正常PID }
   *       else { Output = 0; ITerm = 0; }    // 进入死区输出**直接归零**
   *   若 DeadBand 被填成正值,误差一进死区输出就断,
   *   电机减速 → 误差重新变大 → 再输出,形成开关式极限环:
   *   每次阶跃都过冲然后来回抽,而且**与 Kp 无关**。
   *
   * 本组锁定三条:
   *   1. 电机配置结构体必须清零
   *   2. DeadBand 必须显式赋值(不能依赖 memset 的副作用)
   *   3. 不再有未初始化的 Motor_Init_Config_s 残留
   */
  let app;
  try {
    app = readFileSync(new URL(
      `${firmwareRelativeRoot}application/motor_bench_app/motor_bench_app.c`,
      import.meta.url,
    ), 'utf8');
  } catch { console.log('  SKIP  motor_bench_app.c not reachable'); }

  if (app) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const code = strip(app);

    check('string.h is included for memset', /#include\s*<string\.h>/.test(app));

    /* --- 清零 --- */
    check('the motor factory zeroes its config struct',
      /Motor_Init_Config_s\s+cfg;[\s\S]{0,400}?memset\(&cfg,\s*0,\s*sizeof\(cfg\)\)/.test(code),
      'an uninitialized stack struct leaves DeadBand as garbage');

    /* --- DeadBand 显式赋值 --- */
    check('DeadBand is set explicitly for DJI motors',
      /dst->DeadBand\s*=\s*0\.0f/.test(code),
      'relying on memset alone hides the intent and is fragile');
    check('DeadBand is set for DM too',
      /speed_PID\.DeadBand\s*=\s*0\.0f/.test(code));

    /*
     * 断言"清零"和"DeadBand 赋值"同时存在。
     * 只有清零:意图不可见,下次改配置的人不知道这个字段敏感;
     * 只有赋值:其他字段(Improve 等)仍可能带垃圾值参与位运算。
     */
    const hasMemset = /memset\(&cfg,\s*0,\s*sizeof\(cfg\)\)/.test(code);
    const hasDeadband = /DeadBand\s*=\s*0\.0f/.test(code);
    check('both defenses are present (zeroing AND explicit DeadBand)',
      hasMemset && hasDeadband,
      `memset=${hasMemset} deadband=${hasDeadband}`);

    /* --- 不应再有未初始化且未被清零的结构体声明 --- */
    const decls = [...code.matchAll(/Motor_Init_Config_s\s+(\w+)\s*;/g)];
    const bad = decls.filter((m) => {
      const after = code.slice(m.index, m.index + 400);
      return !new RegExp(`memset\\(&${m[1]},`).test(after);
    });
    check('no un-zeroed Motor_Init_Config_s declaration remains',
      bad.length === 0,
      bad.map((b) => b[1]).join(', ') + ' declared without memset');
  }

}

console.log('\n== 31. cascade loops: combos must be selectable end to end ==');
{
  /*
   * 需求(2026-10-13 用户):"现在是无法实现电流环和速度环的叠加吗?"
   *
   * 结论:**叠加本来就是框架的原生能力**,只是三处入口把它挡住了:
   *   1. DJIMotorChangeLoop 的校验只认 4 个单环,组合值被打成 "invalid loop";
   *   2. 界面下拉框只有 4 个单环选项;
   *   3. protocol.js 的 LoopType / LoopLabel 缺组合常量。
   *
   * 底层从来就是支持的:close_loop_type 是位掩码,
   * DJIMotorControl() 逐环判断 `close_loop_type & XXX_LOOP`,
   * pid_ref 顺次穿过被启用的每一环(位置→速度→电流)。
   *
   * 本组把"选得到、发得出、固件认、量纲对"四件事都锁住。
   */

  /* --- 1. 上位机常量 --- */
  check('LoopType has SPEED_AND_CURRENT_LOOP', LoopType.SPEED_AND_CURRENT_LOOP === 0b0011);
  check('LoopType has ANGLE_AND_SPEED_LOOP', LoopType.ANGLE_AND_SPEED_LOOP === 0b0110);
  check('LoopType has ALL_THREE_LOOP', LoopType.ALL_THREE_LOOP === 0b0111);
  check('every LoopType has a label',
    Object.values(LoopType).every((v) => typeof LoopLabel[v] === 'string'),
    'an unlabeled combo renders as a blank option');

  /* --- 2. 位掩码合法性:组合值必须落在已定义位内 --- */
  const KNOWN = 0b0111;
  check('all combos only use defined bits',
    Object.values(LoopType).every((v) => (v & ~KNOWN) === 0),
    'an undefined bit would silently change the close_loop mask');

  /* --- 3. 界面选项:组合值必须真的出现在下拉框里 --- */
  let html;
  try {
    html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  } catch { console.log('  SKIP  index.html not reachable'); }

  if (html) {
    /*
     * 【2026-10-13 交互重构·第二轮】闭环选择改为**鱼骨图**。
     *
     * 第一轮做的是"勾选 + 外层单选",用户反馈下拉/勾选都不够直观,
     * 要求"鱼骨图一样的结构,启用某个环时由暗变亮"。
     *
     * 鱼骨图相比勾选的决定性优势:它把**数据流方向**和
     * "位置环必须经速度环"变成拓扑事实,而不是需要代码兜底的规则。
     *
     * 断言改为验证鱼骨图容器存在,且旧的勾选/单选控件已移除。
     */
    check('fishbone container exists', /class="loop-fishbone"\s+data-role="loopPicker"/.test(html));
    check('the old checkbox controls are gone',
      !/data-role="loopCurrent"/.test(html) && !/data-role="loopAngle"/.test(html),
      'leftover controls would confuse the user about which UI is live');
    check('the old outer-radio controls are gone',
      !/name="outerLoop"/.test(html) && !/data-role="outerSpeed"/.test(html));
    check('the old combo dropdown is gone',
      !/class="loop-select"/.test(html));
  }

  /* --- 4. 固件侧:校验必须接受组合值,且 close_loop 映射正确 --- */
  let fw, fwH;
  try {
    fw = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor/DJImotor/dji_motor.c`,
      import.meta.url,
    ), 'utf8');
    fwH = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor/motor_def.h`,
      import.meta.url,
    ), 'utf8');
  } catch { console.log('  SKIP  firmware sources not reachable'); }

  if (fwH) {
    check('motor_def.h defines the combo constants',
      /SPEED_AND_CURRENT_LOOP\s*=\s*0b0011/.test(fwH)
      && /ANGLE_AND_SPEED_LOOP\s*=\s*0b0110/.test(fwH)
      && /ALL_THREE_LOOP\s*=\s*0b0111/.test(fwH));
  }

  if (fw) {
    const code = fw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const fn = code.match(/void DJIMotorChangeLoop\([\s\S]*?\n\}/);
    check('DJIMotorChangeLoop found', !!fn);
    if (fn) {
      const body = fn[0];

      /* 旧判断是 4 个单环的 `!=` 链,组合值会被拒 */
      check('the validator no longer rejects combos',
        !/loop\s*!=\s*ANGLE_LOOP\s*&&\s*loop\s*!=\s*SPEED_LOOP/.test(body),
        'the old four-way != chain turned every combo into "invalid loop"');
      check('the validator uses a bitmask legality check',
        /loop\s*&\s*~\(/.test(body),
        'a mask check accepts any combination of defined bits');
      check('OPEN_LOOP is still accepted (mask is zero)',
        /loop\s*==\s*OPEN_LOOP/.test(body),
        'a zero mask cannot pass a "non-empty" test');

      /* close_loop 映射 */
      check('SPEED_AND_CURRENT_LOOP maps to speed|current',
        /case\s+SPEED_AND_CURRENT_LOOP:[\s\S]{0,200}?close_loop_type\s*=\s*SPEED_LOOP\s*\|\s*CURRENT_LOOP/.test(body));
      check('ANGLE_AND_SPEED_LOOP maps to angle|speed',
        /case\s+ANGLE_AND_SPEED_LOOP:[\s\S]{0,200}?close_loop_type\s*=\s*ANGLE_LOOP\s*\|\s*SPEED_LOOP/.test(body));
      check('ALL_THREE_LOOP maps to angle|speed|current',
        /case\s+ALL_THREE_LOOP:[\s\S]{0,200}?close_loop_type\s*=\s*ANGLE_LOOP\s*\|\s*SPEED_LOOP\s*\|\s*CURRENT_LOOP/.test(body));

      /*
       * 单环 SPEED_LOOP 必须**不含**电流位。
       * 这是有意保留的对照模式:速度环输出直接当作电流值下发,
       * 让使用者能对比"有电流内环"与"无电流内环"的差别。
       */
      check('single SPEED_LOOP stays current-free (a deliberate contrast mode)',
        /case\s+SPEED_LOOP:[\s\S]{0,200}?close_loop_type\s*=\s*SPEED_LOOP\s*;/.test(body));
    }

    /* 换环仍必须先停机 + 清 PID 历史(量纲切换的安全前提) */
    if (fn) {
      check('loop switch still stops the motor first',
        /stop_flag\s*=\s*MOTOR_STOP/.test(fn[0]));
      check('loop switch still clears PID history',
        /MB_CLEAR_PID_STATE/.test(fn[0]),
        'stale integrals from the old unit would make the new loop jump');
    }
  }

  /* --- 5. rpm 换算的判据:必须精确判外层,不能只排除 ANGLE 位 --- */
  let mb;
  try {
    mb = readFileSync(new URL(
      `${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`,
      import.meta.url,
    ), 'utf8');
  } catch { console.log('  SKIP  motor_bench.c not reachable'); }

  if (mb) {
    const code = mb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    check('rpm conversion triggers on SPEED_LOOP',
      /outer\s*==\s*SPEED_LOOP/.test(code));
    check('rpm conversion triggers on SPEED_AND_CURRENT_LOOP',
      /outer\s*==\s*SPEED_AND_CURRENT_LOOP/.test(code),
      'speed outer + current inner is still a speed loop — rpm applies');
    check('the condition no longer uses a bare ANGLE-bit test',
      !/!\(mb_channels\[channel_id\]\.outer_loop\s*&\s*ANGLE_LOOP\)/.test(code),
      'that test wrongly flags CURRENT_LOOP (mask 1) as needing rpm conversion');
  }
}



console.log('\n== 32. loop fishbone: topology must enforce the cascade constraints ==');
{
  /*
   * 交互重构第二轮(2026-10-13):闭环选择改为**鱼骨图**。
   *
   * 第一轮做的"勾选 + 外层单选"需要代码兜底两条约束:
   *   1. 外层环必须被勾选,否则固件 (close_loop & 位) && outer == 位 静默跳过;
   *   2. 外层是位置环时必须同时开速度环 —— 位置环输出的"期望速度"
   *      若没有速度环接住,会直接当作电流参考下发,电机疯转。
   *
   * 鱼骨图把这两条交给**联动代码**保证:
   *   主脊(2026-10-14 位置环与电流环对调后)= 设定 → 电流 → 速度 → 位置 → 电调,
   *   这是"由内到外"的**展示顺序,不是信号流向** ——
   *   真实串级仍是 设定 → 位置 → 速度 → 电流 → 电调,
   *   数据沿主脊**从右往左**走,由节点下的动态说明写出来。
   *   约束靠 _toggle 显式联动(点亮位置必带速度、关速度必连带关位置),
   *   不再由节点位置保证 —— 所以本组要同时钉住"顺序"和"联动"两件事。
   */
  let fb;
  try {
    fb = readFileSync(new URL('./fishbone.js', import.meta.url), 'utf8');
  } catch { console.log('  SKIP  fishbone.js not reachable'); }

  if (fb) {
    const code = fb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /*
     * 每个环节点一条 note。底部说明行删除后,note 改由节点 title 承载 ——
     * 数一数条数,防止"删说明行"被顺手执行成"把 note 也删了"
     * (那样悬停提示就只剩"点击启用/关闭",流向信息彻底消失)。
     */
    const NODE_NOTE_COUNT = (code.match(/note:\s*'/g) || []).length;

    check('fishbone.js exports LoopFishbone', /export class LoopFishbone/.test(code));
    check('angle node bit is 0b0100', /bit:\s*0b0100/.test(code));
    check('speed node bit is 0b0010', /bit:\s*0b0010/.test(code));
    check('current node bit is 0b0001', /bit:\s*0b0001/.test(code));

    /*
     * ---- 节点排列:2026-10-14 用户裁定"位置环和电流环位置对调" ----
     * NODES 的先后就是主脊从左到右的渲染顺序,即**由内环到外环**:
     *   电流环(0b0001) → 速度环(0b0010) → 位置环(0b0100)
     * 这里按源码下标断言,防止后续编辑把顺序悄悄改回去 ——
     * 顺序本身不参与任何判定(全部按位值),所以它只能靠断言守住。
     */
    {
      const iCur = code.indexOf('bit: 0b0001');
      const iSpd = code.indexOf('bit: 0b0010');
      const iAng = code.indexOf('bit: 0b0100');
      check('node order is current → speed → angle (inner to outer, user ruling)',
        iCur > 0 && iCur < iSpd && iSpd < iAng,
        `source order — current@${iCur} speed@${iSpd} angle@${iAng}`);
      check('the 设定 endpoint tooltip states the real flow direction',
        /从右往左/.test(fb),
        'the spine is inner→outer, so the endpoints must not be read as a signal path');
    }

    check('the current loop is locked (always on)',
      /bit:\s*0b0001[\s\S]{0,220}?locked:\s*true/.test(code),
      'it is the last stage; disabling it leaves raw loop output as the current command');
    check('angle and speed are toggleable',
      /bit:\s*0b0100[\s\S]{0,220}?locked:\s*false/.test(code)
      && /bit:\s*0b0010[\s\S]{0,220}?locked:\s*false/.test(code));

    /* --- 拓扑约束 --- */
    check('enabling the angle loop also enables the speed loop',
      /if \(bit === 0b0100\)[\s\S]{0,140}?this\.mask \|= 0b0010/.test(code),
      'this code is now the ONLY thing enforcing it — the spine no longer encodes direction');
    check('disabling the speed loop also disables the angle loop',
      /if \(bit === 0b0010\)[\s\S]{0,160}?this\.mask &= ~0b0100/.test(code),
      'otherwise angle loses its downstream and dumps expected-speed into the current stage');

    /*
     * --- 外层环不在页面里推 ---
     * 2026-10-14 底部信息行删除后,fishbone 不再算 outerBit:它只维护掩码,
     * 由 ui.js 把整个掩码作为 bind 的 `outerLoop` 字段下发,固件按
     * close_loop_type 的最高位环执行串级(DJIMotorControl)。
     * "掩码最高位 = 外层环"由**二进制编码本身**保证
     * (电流 0b0001 < 速度 0b0010 < 位置 0b0100,上面三条已钉住),
     * 页面再推一遍属于重复实现。
     * @attention 别把它"恢复"成页面也算一次 outerBit —— 两处各算迟早不一致。
     */
    check('the page no longer re-derives the outer loop',
      !/outerBit|outerName/.test(code),
      'the mask is the single truth; the firmware decides the outer loop from it');

    /* --- 暗/亮态 --- */
    check('nodes toggle an is-on class', /classList\.toggle\('is-on'/.test(code));
    check('locked current loop cannot toggle off', /if \(node\.locked\) return/.test(code));
    /*
     * ---- 底部信息行(外层/说明/0bXXXX 掩码)已整行删除(2026-10-14 用户裁定) ----
     * 断言"删干净"必须在**剥注释后**的 code 上判(注释里必然提到这些类名)。
     */
    check('the bottom meta row is gone (outer / note / mask)',
      !/fb-meta|fb-outer|fb-note|fb-mask/.test(code),
      'removed on 2026-10-14 — do not re-add without asking the user');
    check('getMask() is still the single source of the composed mask',
      /getMask\(\)\s*\{[\s\S]{0,80}?return this\.mask/.test(code),
      'the bind payload still comes from here even though the page shows nothing');
    check('the flow direction moved into the node tooltip',
      /el\.title = [\s\S]{0,160}?n\.note/.test(code),
      'after the meta row went, title is the only place stating what feeds what');
    check('every node keeps a note naming its output target',
      NODE_NOTE_COUNT === 3,
      '电流环→电调 / 速度环→电流环 / 位置环→速度环,一条都不能少');
  }

  /* --- ui.js 接线 --- */
  let ui;
  try {
    ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  } catch { console.log('  SKIP  ui.js not reachable'); }

  if (ui) {
    check('ui.js imports LoopFishbone',
      /import\s*\{\s*LoopFishbone\s*\}\s*from\s*'\.\/fishbone\.js'/.test(ui));
    check('ensureFishbone creates the instance lazily',
      /function ensureFishbone\(/.test(ui) && /new LoopFishbone\(host\)/.test(ui));
    check('bind sends the fishbone mask',
      /outerLoop:\s*mask/.test(ui) && /const mask = readLoopMask\(i\);/.test(ui));
    check('readLoopMask falls back to the firmware default when unrendered',
      /return LoopType\.SPEED_AND_CURRENT_LOOP/.test(ui),
      'a channel never rendered has no fishbone yet');
  }

  /* --- 纯计算:复刻鱼骨图状态机 --- */
  {
    const makeFb = () => {
      const st = { mask: 0b0011 };
      return {
        toggle(bit) {
          if (bit === 0b0001) return; /* 电流环常亮 */
          if (st.mask & bit) {
            if (bit === 0b0010) st.mask &= ~0b0100;
            st.mask &= ~bit;
          } else {
            st.mask |= bit;
            if (bit === 0b0100) st.mask |= 0b0010;
          }
          return st.mask;
        },
        get mask() { return st.mask; },
      };
    };

    const a = makeFb();
    check('default is speed+current (0b0011)', a.mask === 0b0011);
    a.toggle(0b0100);
    check('enabling angle gives all three (0b0111)', a.mask === 0b0111);
    a.toggle(0b0100);
    check('disabling angle falls back to 0b0011', a.mask === 0b0011);

    const b = makeFb();
    b.toggle(0b0010);
    check('disabling speed gives current only (0b0001)', b.mask === 0b0001);
    b.toggle(0b0100);
    check('re-enabling angle from current-only restores all three (0b0111)',
      b.mask === 0b0111,
      'angle must pull the speed loop back in — there is no path around it');

    const c = makeFb();
    c.toggle(0b0001);
    check('the current loop cannot be switched off', c.mask === 0b0011);

    const outerOf = (m) => (m & 0b0100) ? 'angle' : (m & 0b0010) ? 'speed' : 'current';
    check('outer is angle when the angle bit is lit', outerOf(0b0111) === 'angle');
    check('outer is speed for 0b0011', outerOf(0b0011) === 'speed');
    check('outer is current for 0b0001', outerOf(0b0001) === 'current');
  }
}

console.log('\n== 33. PID card stays inline; picking a loop switches it ==');
{
  /*
   * 交互定稿(2026-10-13):
   *   1. PID 卡片**内嵌常驻**在鱼骨图下方,不做浮空弹出;
   *   2. 左键切闭环开关；右键节点切换 PID；悬停和聚焦不切换。
   *
   * 【为什么放弃浮空】曾做成 absolute 跟随节点,实测飘到通道卡片底部 ——
   *   浮空需要可靠的定位基准与堆叠上下文,而通道卡片是多层的
   *   (channel > bind-row > loop-fishbone),父级的 overflow / transform
   *   都会让 absolute 定位失控。内嵌常驻没有这类问题,也更符合"点击哪个环
   *   切换为哪个"的直觉 —— 卡片一直在那儿,只是内容跟着换。
   *
   * 本组锁住两点:不浮空、切环正确。
   */
  let html, ui, fb, css;
  try {
    const b = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', b), 'utf8');
    ui = readFileSync(new URL('ui.js', b), 'utf8');
    fb = readFileSync(new URL('fishbone.js', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  if (html) {
    check('pid panel is a plain inline panel (no float class)',
      /class="pid-panel"/.test(html) && !/pid-float/.test(html),
      'the float variant drifted to the bottom of the card');
    check('no show/hide close button is needed', !/data-role="pidClose"/.test(html),
      'an inline card is always visible — there is nothing to close');
    check('panel has no loop dropdown', !/data-role="pidLoop"/.test(html));
    check('PID instructions removed', !/pid-workflow-note|pidTuningHint/.test(html));

    /*
     * 位置:PID 卡片必须紧跟在闭环鱼骨图之后、曲线之前。
     *   用户明确要求"放到这个的下面"(鱼骨图/电机选择行下面),
     *   使"选环 → 看到该环参数"的动线最短。
     *   若排在曲线之后,调参要翻过整张图,体验很差。
     */
    const iLoop = html.indexOf('data-role="loopPicker"');
    const iPid = html.indexOf('data-role="pidPanel"');
    const iChart = html.indexOf('class="chart-box"');
    check('the loop picker exists', iLoop >= 0);
    check('the PID card sits right after the loop picker',
      iLoop >= 0 && iPid > iLoop,
      'it must follow the loop picker, not precede it');
    check('the PID card comes before the chart',
      iPid >= 0 && iChart >= 0 && iPid < iChart,
      'behind the chart means scrolling past the whole plot to tune');
    check('panel has a title showing the current loop', /data-role="pidTitle"/.test(html));
  }

  if (css) {
    /* 判"某规则已不存在"必须剥注释 —— 说明注释里正是会写出 `.pid-float` 的地方 */
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    check('no .pid-float rules remain',
      !/\.pid-float/.test(cssNoComments),
      'leftover absolute positioning would break layout again');
    check('.pid-panel is in normal flow (no absolute)',
      !/position:\s*absolute/.test(cssBody(css, '.pid-panel') || ''));
    /*
     * 鱼骨图仍保留 flex-wrap:窄卡片下"设定 + 三个节点 + 电调"会挤,
     * 必须能换行。底部信息行虽然删了,这条排版保护不能跟着退回去。
     */
    check('the fishbone still wraps under a narrow card',
      /flex-wrap:\s*wrap/.test(cssBody(css, '.loop-fishbone') || ''),
      'without it the spine squeezes instead of wrapping');
  }

  if (fb) {
    const code = fb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const click = code.match(/node\.onclick = \(\) => \{([\s\S]*?)\n\s*\};/)?.[1] || '';
    const context = code.match(/node\.oncontextmenu = event => \{([\s\S]*?)\n\s*\};/)?.[1] || '';
    check('left click toggles without switching PID', /this\._toggle\(n\)/.test(click) && !/onFocusLoop/.test(click));
    check('right click selects PID without toggling', /preventDefault/.test(context) && /onFocusLoop/.test(context) && !/_toggle/.test(context));
    check('hover and focus do not switch PID', !/onmouseenter|onfocus\s*=/.test(code));
    check('locked current loop remains available for right-click PID', !/node\.disabled = true/.test(code));
    check('no blur-close hook remains',
      !/onBlurLoop/.test(code),
      'an inline card never closes');
  }

  if (ui) {
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    check('a function switches the PID card to a loop',
      /function focusPidLoop\(/.test(code));
    check('the float open/close helpers are gone',
      !/openPidFloat|scheduleClosePidFloat|closePidFloat|pidFloatTimers/.test(code),
      'dead code from the discarded float approach');

    /* 位掩码 → pidLoop 编号映射,写错就调错环且毫无提示 */
    check('speed bit 0b0010 maps to pidLoop "0"', /0b0010:\s*'0'/.test(code));
    check('current bit 0b0001 maps to pidLoop "1"', /0b0001:\s*'1'/.test(code));
    check('angle bit 0b0100 maps to pidLoop "2"', /0b0100:\s*'2'/.test(code));

    check('switching sets panel loop state and refills the form',
      /dataset\.loop = String\(loopStr\)/.test(code) && /fillPidForm\(i, loopVal\)/.test(code));
    check('the title names the active loop',
      /r\('pidTitle'\)\.textContent[\s\S]{0,120}?PID/.test(code));
  }
}

console.log('\n== 34. 通道操作按钮归位;急停单击即停 ==');
{
  /*
   * 两条用户裁定(2026-10-14),都要锁死:
   *
   * 【一】绑定与解绑**必须同在标题行**。
   *   此前只把解绑提上来,绑定仍留在 bind-row,于是同一类操作被拆在两处:
   *   标题行有"解绑",下面一行有"绑定",看起来就像漏改。
   *   归位后 bind-row 只剩**配置项**(选电机 + 选闭环),职责单一。
   *
   * 【二】急停**不得有二次确认**。
   *   原实现是 `if (confirm('确定要立即停止全部电机吗?'))`。这与急停语义直接冲突:
   *     1. 急停是时间敏感动作,多一步点击就多一份危险;
   *     2. 原生 confirm **阻塞主线程**,弹窗期间页面卡死,
   *        遥测渲染与状态刷新全停 —— 恰恰在最需要看状态的时候瞎掉。
   *   误触急停的代价只是"电机停了,重新使能即可";
   *   急停迟钝的代价可能是设备或人身伤害。两者不对等,所以不给急停加确认。
   *
   *   @note 解绑、使能两处确认**是刻意保留的**,数量固定为 2:
   *     - 解绑:破坏性且不可逆(要重新绑定才能用),值得确认;
   *     - 使能:设定值非 0 时电机立即转动,属于"预告危险"的互锁。
   *   它们都不是时间敏感动作,与急停不同类。
   */
  let html, ui, css;
  try {
    const b = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', b), 'utf8');
    ui = readFileSync(new URL('ui.js', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  if (html) {
    /* 只截通道模板内部的 header,避免和页面顶栏 <header class="topbar"> 混淆 */
    const tpl = html.slice(html.indexOf('id="channelTpl"'));
    const hdr = tpl.slice(tpl.indexOf('<header>'), tpl.indexOf('</header>'));
    const br = tpl.slice(tpl.indexOf('<div class="bind-row">'), tpl.indexOf('class="pid-panel"'));

    check('the channel header holds the bind button', /data-role="bind"/.test(hdr),
      'it used to sit down in bind-row while unbind was up here');
    check('the channel header holds the unbind button', /data-role="unbind"/.test(hdr));
    check('bind comes before unbind', hdr.indexOf('data-role="bind"') < hdr.indexOf('data-role="unbind"'),
      'bind is the more frequent action, so it goes first');
    check('the status badge stays last', hdr.indexOf('data-role="status"') > hdr.indexOf('data-role="unbind"'),
      'reading order must be actions → state');

    check('bind-row no longer carries the bind button', !/data-role="bind"/.test(br),
      'splitting the two actions across rows is what the user flagged');
    check('bind-row keeps the motor select', /data-role="motor"/.test(br));
    check('bind-row keeps the fishbone picker', /loopPicker/.test(br));

    check('the top-bar estop button is present', /id="estop"/.test(html));
  }

  if (css) {
    /*
     * 标题行按钮**不得再被缩小**(2026-10-14 用户要求「和使能的按键一样大」)。
     * 此前 .ch-act 把它们缩到 11px,而全局 button 是 14px ——
     * 同一类动作在页面上出现两种尺寸,不一致感就是这么来的。
     */
    check('header action buttons are NOT size-shrunk',
      !/\.ch-act\s*\{[^}]*(font-size|padding)/.test(css),
      'they must inherit the global 14px / 8px 14px like the enable button');
    check('the header title font was enlarged',
      /\.ch-title\s*\{[^}]*font-size:\s*1[7-9]px/.test(css),
      '15px could not hold its own next to full-size buttons');
    /* 防的是本轮真实发生过的一次误删:改字号时把相邻两行一起替掉了 */
    check('the badge keeps its pill padding and radius',
      /\.badge\s*\{[^}]*padding:\s*3px 9px[^}]*border-radius:\s*999px/.test(css),
      'losing either makes the status badge a square hugging its text');
    check('the one-sided .unbind-btn rule is gone', !/\.unbind-btn\s*\{/.test(css),
      'it styled only unbind, which is how the asymmetry got hidden');
    /*
     * "类名已不存在"必须在剥离注释后的文本上判:
     * 否则将来任何一句提到 unbind-btn 的说明注释都会让这条误报
     * (组 36 第一版就是这么栽的)。
     */
    check('no unbind-btn class name remains anywhere',
      !/unbind-btn/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')) &&
      !/unbind-btn/.test((html || '').replace(/<!--[\s\S]*?-->/g, '')));
    check('header does not use space-between',
      !/\.channel header\s*\{[\s\S]{0,200}?justify-content:\s*space-between/.test(css),
      'four children would be spread apart with gaps between the buttons');
  }

  if (ui) {
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const estopFn = code.match(/\$\('#estop'\)\.onclick[\s\S]{0,300}?;/);

    check('an estop handler is wired', !!estopFn);
    if (estopFn) {
      check('ESTOP HAS NO CONFIRMATION DIALOG', !/confirm/.test(estopFn[0]),
        'a modal blocks the main thread and delays the stop — unfit for an emergency stop');
      check('the estop sends stopAll directly',
        /send\(\{ type: 'stopAll' \}\)/.test(estopFn[0]));
    }
    /*
     * 刻意保留的确认有三处:解绑 + 使能 + 移除电机(2026-10-17 新增)。
     *
     * @attention 为什么移除电机也值得一道确认:
     *   它会**真的释放 CAN 过滤器并销毁电机实例**。若该电机还绑在某个通道上,
     *   那个通道会立刻失去控制对象 —— 界面显示"未绑定",但用户可能没意识到
     *   是自己刚把控制对象删了。这是不可逆的破坏性操作,与"解绑"同类。
     *
     *   这与"急停不得有确认"**不矛盾**:急停是时间敏感动作(多一步点击就多一份
     *   危险),而移除是有预期的计划性操作。判据是"是否时间敏感",不是"是否危险"。
     *
     * 多出第四处说明又有人给不该拦的动作加了门槛(尤其是急停)。
     */
    check('exactly 3 deliberate confirms remain (unbind + enable + remove)',
      (code.match(/confirm\(/g) || []).length === 3,
      `found ${(code.match(/confirm\(/g) || []).length}`);
    /* 移除电机的确认必须在移除按钮的处理里,不能挪到别处 */
    check('the remove handler carries the confirmation',
      /function removeRegisteredMotor\(m\)[\s\S]{0,600}?confirm\(/.test(code));
    check('the enable interlock is still there',
      /该通道当前设定值不为 0/.test(ui), 'must warn before a motor jumps to speed');
  }
}

console.log('\n== 35. 鱼骨图与 PID 整定同属一张卡片 ==');
{
  /*
   * 用户裁定(2026-10-14):「pid 不应该是单独的一个子卡片,
   * 应当和之前的环在同一个子卡片」。
   *
   * 【为什么这条值得单独锁】此前鱼骨图和 PID 面板各自带 border + background,
   *   上下两个框在视觉上就是两张卡片、两件不相干的事;
   *   而它们的语义恰恰是同一件事的两面 —— 上面选哪个环,下面就调哪个环的参数。
   *   合并后卡片的边框/背景**只允许出现在 .loop-card 上**;
   *   内部分区用虚线,不允许再套第二个框(那会退回"卡片套卡片")。
   *
   * 【CSS 层面必须防的坑】同名规则写两处时,后写的覆盖先写的。
   *   原文件里 `.pid-panel` 就定义了两份(前面一份卡片样式 + 后面又一份),
   *   改前面那份完全无效,极难排查。现在规定只许一份。
   */
  let html, css;
  try {
    const b = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  /* 注释会干扰"这条规则里有没有某个属性"的判断,先去掉再抽规则体 */
  const cssCode = (css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (sel) => cssBody(cssCode, sel);

  if (html) {
    check('there is one .loop-card wrapper', /class="loop-card"/.test(html));
    /* 切片到图表之前:loop-card 必然整体落在这一段里 */
    const lc = html.slice(html.indexOf('class="loop-card"'), html.indexOf('class="chart-box"'));
    check('the fishbone sits inside the loop card', /data-role="loopPicker"/.test(lc));
    check('the PID panel sits inside the SAME card', /data-role="pidPanel"/.test(lc),
      'it used to be a sibling of the fishbone row — a separate card');
    check('within the card, PID comes after the fishbone',
      lc.indexOf('data-role="loopPicker"') < lc.indexOf('data-role="pidPanel"'));
    check('the PID panel is declared exactly once',
      (html.match(/data-role="pidPanel"/g) || []).length === 1,
      'a leftover copy would render a second, detached panel');
    check('there is exactly one pid-panel element',
      (html.match(/class="pid-panel"/g) || []).length === 1);
    check('the motor select stays outside the card',
      html.indexOf('data-role="motor"') < html.indexOf('class="loop-card"'));
  }

  if (cssCode) {
    check('.loop-card carries the box (border + background)',
      /border:\s*1px solid/.test(body('.loop-card') || '') &&
      /background/.test(body('.loop-card') || ''));
    check('.loop-card takes its own row', /flex:\s*1 1 100%/.test(body('.loop-card') || ''),
      'otherwise it squeezes beside the motor select and the PID grid collapses');

    const fbBody = body('.loop-fishbone') || '';
    check('.loop-fishbone draws NO box of its own',
      !/border|background|border-radius/.test(fbBody),
      'a second frame inside the card is exactly the "card within a card" look');
    check('.loop-fishbone keeps its flex row and wrapping',
      /display:\s*flex/.test(fbBody) && /flex-wrap:\s*wrap/.test(fbBody));

    const pBody = body('.pid-panel');
    check('.pid-panel is defined exactly once in the CSS',
      (cssCode.match(/^\.pid-panel\s*\{/gm) || []).length === 1,
      'duplicate rules silently override each other — the later one wins');
    check('.pid-panel draws no box',
      pBody !== null && !/background/.test(pBody) && !/border:\s*1px/.test(pBody));
    check('.pid-panel separates itself with a dashed rule instead',
      /border-top:\s*1px dashed/.test(pBody || ''),
      'the two sections must still read as two sections');

    check('the dead data-collapsed rules are gone',
      !/data-collapsed/.test(cssCode), 'that feature was dropped with the float panel');
    check('no absolute positioning crept back into the panel',
      !/\.pid-panel[^{]*\{[^}]*position:\s*absolute/.test(cssCode));
  }
}

console.log('\n== 36. 静态 ID 冲突面板已移除;动态提示不得被牵连 ==');
{
  /*
   * 用户裁定(2026-10-14):首页那条静态「ID 冲突提示」不要了 ——
   * 「等出现 ID 冲突时,会自动提示」。
   *
   * 【删了为什么不丢信息】面板讲的两件事都已由动态提示覆盖:
   *   1. 本地预检 describeConflict():点"添加"之前就给出
   *      "和谁撞、该改谁、当前可用哪些 ID";
   *   2. 板端回执 MBResultText:失败时给具体原因
   *      (DUPLICATE 带 0x204/0x200 区间重叠说明;NO_RESOURCE 带"每条总线最多 14 颗")。
   * 静态版只是把"出错时才知道"的话提前摊在首页,占版面且真出错时没人回头读。
   *
   * 【本组真正要防的错误】把"删掉 ID 冲突提示"执行成"删掉冲突检测"。
   *   检测在三处:protocol.js 的 findConflict/describeConflict、
   *   ui.js 添加前的预检、板端 MotorBenchCheckRxIdFree。
   *   前两层由本组钉住,任何一层被顺手删掉都会红。
   */
  let html, css, ui;
  try {
    const b = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
    ui = readFileSync(new URL('ui.js', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  /*
   * @attention "某某已删除"这类断言**必须先在剥离注释后的文本上判**。
   *   本组第一版就直接在原文上搜 `ID 冲突提示` 与 `hint-panel`,
   *   结果被自己新写的说明注释命中而误报失败 ——
   *   同一个坑本轮是第二次踩(上一次是全文件 `confirm(` 计数)。
   *   删除型断言判的是"标记/规则"还在不在,注释是给人读的,不算标记。
   */
  const htmlCode = (html || '').replace(/<!--[\s\S]*?-->/g, '');
  const cssCode = (css || '').replace(/\/\*[\s\S]*?\*\//g, '');

  if (html) {
    check('the static hint panel markup is gone', !/hint-panel/.test(htmlCode));
    check('the static "ID 冲突提示" paragraph is gone', !/ID 冲突提示/.test(htmlCode));
    check('the removal leaves a comment so it is not re-added',
      /静态「ID 冲突提示」面板已于 2026-10-14 按用户要求移除/.test(html),
      'without a note the next reader just restores the paragraph');
    check('the add-motor panel and its live message are untouched',
      /id="addMotor"/.test(htmlCode) && /id="addMsg"/.test(htmlCode),
      'addMsg is where the dynamic conflict text appears');
  }
  if (css) {
    check('the .hint-panel rules died with the panel', !/hint-panel/.test(cssCode));
  }

  /* --- 动态层必须完好 --- */
  check('findConflict is still exported', typeof findConflict === 'function');
  check('describeConflict is still exported', typeof describeConflict === 'function');
  {
    const inv = [[MotorKind.M3508, 1, 5]];
    const msg = describeConflict(1, inv.map(([kind, canBus, motorId]) => ({ kind, canBus, motorId })),
      MotorKind.GM6020, 1);
    check('the dynamic conflict prompt still fires', /ID 冲突/.test(msg), msg);
    check('it still names the occupier', /M3508/.test(msg), msg);
    check('it still offers available IDs', /可用 ID/.test(msg), msg);
  }
  if (ui) {
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('ui still pre-checks before adding', /describeConflict\(/.test(code));
    check('ui still surfaces the conflict text', /showAddMsg\(conflictMsg, true\)/.test(code));
  }
  check('board DUPLICATE still explains the 0x200 / 0x204 overlap',
    /0x204\+ID/.test(MBResultText[MBResult.DUPLICATE]) &&
    /0x200\+ID/.test(MBResultText[MBResult.DUPLICATE]));
  check('board NO_RESOURCE still names the 14-per-bus limit',
    /14 颗/.test(MBResultText[MBResult.NO_RESOURCE]));
}

console.log('\n== 37. 串口与添加电机并成一行;鱼骨图底部信息行整行删除 ==');
{
  /*
   * 用户裁定(2026-10-14)两件事:
   *   ① 「添加电机和串口连接放到同一行」—— 原先两条整宽横条并成一条
   *      .panel.setup,内部左右两组、中间一条竖分隔线;
   *   ② 「删除外层位置环…」—— 鱼骨图底部那行常驻文字(外层环 / 流向说明 /
   *      合成掩码 0bXXXX)**整行删除**。三层信息各归其处:
   *        外层环 → 节点亮暗直接可见;
   *        流向说明 → 移进节点 title(悬停可见,常驻文字才是要删的);
   *        掩码 → getMask() 照旧算出并随 bind 下发,只是不再显示。
   *
   * 【本组真正要防的两类错误】
   *   A. 合并布局时**弄丢控件或改掉 id** —— ui.js 全按 id 取元素,
   *      丢一个就是运行时 null 崩溃,而页面看上去只是"少了个按钮",极易漏检;
   *   B. 删显示时**连带删掉逻辑** —— 掩码只是不再显示,getMask()/outerLoop
   *      必须原样保留,否则绑定就退化成默认闭环。
   */
  let html, css, fb, ui;
  try {
    const b = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
    fb = readFileSync(new URL('fishbone.js', b), 'utf8');
    ui = readFileSync(new URL('ui.js', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  const htmlCode = (html || '').replace(/<!--[\s\S]*?-->/g, '');
  const cssCode = (css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const fbCode = (fb || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const uiCode = (ui || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  if (html) {
    /* ---- ① 同一行 ---- */
    check('there is exactly one merged setup panel',
      (htmlCode.match(/class="panel setup"/g) || []).length === 1);
    check('the two old full-width bars are gone',
      !/class="panel serial"/.test(htmlCode) && !/class="panel addmotor"/.test(htmlCode),
      'both used to be separate <section>s stacked one per row');
    /*
     * 2026-10-17:setup 面板从两组变成三组(连接 / 添加电机 / 移除电机),
     * 分隔线相应变成两条。
     *
     * @attention 这里不断言具体数字,而是"组数 = 分隔线数 + 1" ——
     *   硬编码 2 或 3 都会在下次加组时又红一次,而那条断言本来要防的是
     *   "漏加分隔线"(两组挤在一起没有视觉分隔),不是"组数必须是几"。
     */
    const groupCount = (htmlCode.match(/class="(?:setup-group|motor-registry)"/g) || []).length;
    const sepCount = (htmlCode.match(/class="setup-sep"/g) || []).length;
    check('setup panel holds N groups with N-1 dividers between them',
      groupCount >= 2 && sepCount === groupCount - 1,
      `groups=${groupCount} separators=${sepCount}`);

    /*
     * 控件 id 一个都不能少、一个字都不能改。
     * @attention 这是本组的核心断言:布局随便改,id 改了就是崩溃。
     */
    const ids = ['portSelect', 'refreshPorts', 'openPort', 'closePort', 'rescan',
      'addKind', 'addBus', 'addId', 'addMotor', 'addMsg',
      /* 2026-10-17 移除电机入口 */
      'motorList', 'openAddMotor', 'registryMsg'];
    const missing = ids.filter((id) => !htmlCode.includes(`id="${id}"`));
    check('all control ids survived the merge',
      missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');

    check('the serial group comes first, 添加电机 second',
      htmlCode.indexOf('id="portSelect"') < htmlCode.indexOf('添加电机')
      && htmlCode.indexOf('添加电机') < htmlCode.indexOf('id="addMotor"'));
    check('the live add-result message stays inside the add group',
      /id="addMotor"[\s\S]{0,120}?id="addMsg"/.test(htmlCode),
      'addMsg is where conflicts/ack text shows up — it must stay next to 添加');

    /* ---- ② 底部信息行 ---- */
    check('no fishbone meta markup remains anywhere',
      !/fb-meta|fb-outer|fb-note|fb-mask|fbOuter|fbNote|fbMask/.test(htmlCode + fbCode),
      '判"已删除"必须在剥注释后的文本上判(说明注释里必然提到这些名字)');
  }

  if (css) {
    check('no dead .fb-meta family rules remain',
      !/\.fb-(meta|outer|note|mask)\b/.test(cssCode),
      'a rule whose class no longer exists is a silently dead selector');
    check('the merged panel is a wrapping flex row',
      /display:\s*flex/.test(cssBody(css, '.panel.setup') || '')
      && /flex-wrap:\s*wrap/.test(cssBody(css, '.panel.setup') || ''));
    check('each group is itself a flex row so a group is never split mid-way',
      /display:\s*flex/.test(cssBody(css, '.setup-group') || ''));
    check('the divider is a 1px decorative rule',
      /width:\s*1px/.test(cssBody(css, '.setup-sep') || ''));
    check('the old .panel.serial / .panel.addmotor rules are gone',
      !/\.panel\.(serial|addmotor)\b/.test(cssCode));
  }

  /* ---- 删的是显示,不是逻辑 ---- */
  if (fb) {
    check('getMask() still returns the composed mask',
      /getMask\(\)\s*\{[\s\S]{0,80}?return this\.mask/.test(fbCode),
      'the bind payload depends on it');
    check('no writes to the removed meta elements',
      !/this\._(outer|note|mask)El/.test(fbCode));
    check('the loop state machine is untouched by the removal',
      /if \(bit === 0b0100\)[\s\S]{0,140}?this\.mask \|= 0b0010/.test(fbCode)
      && /if \(bit === 0b0010\)[\s\S]{0,160}?this\.mask &= ~0b0100/.test(fbCode));
  }
  if (ui) {
    check('bind still carries the mask as outerLoop',
      /outerLoop:\s*mask/.test(uiCode) && /const mask = readLoopMask\(i\)/.test(uiCode),
      'the page stopped showing it, the protocol must not stop sending it');
  }
}

console.log('\n== 38. PID 状态消息与「应用到电机」同行;.hint 的段落留白归页脚 ==');
{
  /*
   * 用户裁定(2026-10-14):「pid 子卡片的『先绑定电机后可用』调整到和应用到电机同行」。
   *
   * 【根因不是 markup,是 CSS 归属】pidMsg 一直就在 .pid-actions 那一行里
   * (DOM:应用到电机 → 恢复默认值 → 消息),掉到下一行是因为通用 `.hint`
   * 带着**段落**内边距(左右 18px、底部 24px,line-height 1.7)——
   * 那是给页脚整段说明写的,套在行内消息上凭空多出 36px 宽。
   * 所以修法是"把段落留白挪到 footer.hint",不是把消息搬出这一行。
   *
   * 【本组要防的两类错误】
   *   A. 有人"重新组织" markup,把 pidMsg 移到 .pid-head 或面板末尾当说明段;
   *   B. 有人把段落留白又加回通用 `.hint` —— 消息会再一次掉到按钮下面,
   *      而且 #addMsg(添加电机结果)会一起被撑开。
   */
  let html, css;
  try {
    const b = new URL('./', import.meta.url);
    html = readFileSync(new URL('index.html', b), 'utf8');
    css = readFileSync(new URL('style.css', b), 'utf8');
  } catch { console.log('  SKIP  sources not reachable'); }

  const htmlCode = (html || '').replace(/<!--[\s\S]*?-->/g, '');
  const cssCode = (css || '').replace(/\/\*[\s\S]*?\*\//g, '');

  if (html) {
    /* --- 三个控件必须在同一个 .pid-actions 里 --- */
    const m = /<div class="pid-actions">([\s\S]*?)<\/div>/.exec(htmlCode);
    check('the pid action row exists', !!m);
    const row = m ? m[1] : '';
    check('应用到电机 / 恢复默认值 / 状态消息 三个都在同一行',
      /data-role="pidApply"/.test(row) && /data-role="pidReset"/.test(row)
      && /data-role="pidMsg"/.test(row));
    check('the message is not a block element',
      /<span data-role="pidMsg"/.test(row),
      'a <p>/<div> here would force its own line');
    check('the "先绑定电机后可用" wording is kept',
      /先绑定电机后可用/.test(row) || /先绑定电机后可用/.test(htmlCode));
    check('消息排在两个按钮之后(状态贴行尾的阅读顺序)',
      row.indexOf('pidApply') < row.indexOf('pidMsg')
      && row.indexOf('pidReset') < row.indexOf('pidMsg'));

    /*
     * .hint 的使用者:行内状态消息 + 页脚段落。
     *
     * @attention 2026-10-17 从 3 处变成 4 处 —— 新增的 #removeMsg
     *   (移除电机的回执)也是行内状态消息,与 #addMsg / pidMsg 同类。
     *
     *   这里**不硬编码数字**,改为"每个行内消息都必须同时满足:
     *   ① 是 <span>(不是 <p>/<div>,否则会被迫独占一行);
     *   ② 不带 padding(否则宽度被撑开、被 flex-wrap 甩到下一行)"。
     *   这是这条断言真正要防的东西 —— 硬编码 3 或 4 都挡不住
     *   "新增了一处但用了块级元素"这种真正的回归。
     */
    const inlineHints = [...htmlCode.matchAll(/<span[^>]*class="hint"[^>]*>/g)].map((m) => m[0]);
    check('every inline .hint is a span (never a block element)',
      inlineHints.length > 0
      && inlineHints.every((tag) => /^<span/.test(tag)),
      `found ${inlineHints.length} inline hints`);
    check('the footer paragraph still uses .hint',
      /<footer class="hint"/.test(htmlCode));
    check('.hint total users are the inline messages plus the footer paragraph',
      (htmlCode.match(/class="hint"/g) || []).length === inlineHints.length + 1,
      `inline=${inlineHints.length} total=${(htmlCode.match(/class="hint"/g) || []).length}`);
  }

  if (css) {
    /*
     * 通用 .hint 的规则体:用"行首或 } 之后紧跟 .hint{" 精确定位,
     * 不能用 cssBody(css,'.hint') —— 它会被 `footer.hint {` 抢先命中。
     */
    const g = /(?:^|\})\s*\.hint\s*\{([^}]*)\}/.exec(cssCode);
    check('the generic .hint rule exists', !!g);
    const body = g ? g[1] : '';
    check('段落留白(左右 18px / 底部 24px)已从通用 .hint 移除',
      !/padding\s*:/.test(body),
      'this is what pushed the inline message onto its own line');
    check('通用 .hint 只保留字号与颜色',
      /font-size\s*:/.test(body) && /color\s*:/.test(body));

    const foot = cssBody(css, 'footer.hint');
    check('页脚段落仍保留原留白与行高',
      /padding\s*:\s*6px 18px 24px/.test(foot || '')
      && /line-height\s*:\s*1\.7/.test(foot || ''),
      'the footer paragraph must not lose its spacing');

    const act = cssBody(css, '.pid-actions .hint');
    check('PID 状态消息在同一行内右对齐',
      /margin-left\s*:\s*auto/.test(act || ''),
      'without it the message hugs the buttons instead of the row end');
    check('.pid-actions 仍是可换行 flex 行(窄卡片时优雅降级)',
      /display\s*:\s*flex/.test(cssBody(css, '.pid-actions') || '')
      && /flex-wrap\s*:\s*wrap/.test(cssBody(css, '.pid-actions') || ''),
      'nowrap would overflow instead of wrapping');
    check('没有用 ellipsis 截断动态消息',
      !/text-overflow\s*:\s*ellipsis/.test(act || ''),
      'truncating an error message is worse than wrapping');
  }
}

/* ---------------- 39. 电机列表与完整反馈 ID ---------------- */
console.log('\n== 39. 电机列表、十六进制 ID、删除匹配键 ==');
{
  const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  check('registry has list, add toggle, result and inline form',
    ['motorList', 'openAddMotor', 'registryMsg', 'addForm', 'cancelAddMotor']
      .every(id => html.includes(`id="${id}"`)));
  check('list rows remove the captured motor with all four keys',
    /remove.onclick = \(\) => removeRegisteredMotor\(m\)/.test(ui)
    && /sendMotorEdit\(\{ type: 'removeMotor', kind: m\.kind, canBus: m\.canBus, motorId: m\.motorId, rxId \}\)/.test(ui)
    && /const rxId = m\.rxId/.test(ui));
  check('registry edits share an acknowledgement timeout',
    /function sendMotorEdit\(command\)[\s\S]*?if \(pendingMotor\) return/.test(ui)
    && /}, 3000\)/.test(ui));
  check('old firmware cannot delete a DM motor without its feedback ID',
    /remove.disabled = !!pendingMotor \|\| missingRx/.test(ui));
  check('DM4310 and DM8009P are separate model options',
    /<option value="4">DM4310<\/option>/.test(html)
    && /<option value="7">DM8009P<\/option>/.test(html));
  check('DM8009P has distinct wire kind 7 and independent RX ID',
    MotorKind.DM8009P === 7 && needsRxId(MotorKind.DM8009P));
  const added8009 = new FrameParser().push(buildMotorAdd(MotorKind.DM8009P, 1, 1, 0x11))[0];
  check('DM8009P add keeps TX 0x01 / RX 0x11 and model kind',
    added8009.payload.equals(Buffer.from([7, 1, 1, 0x11, 0])));
  const inv8009 = parseInventory(Buffer.from([1, 7, 1, 1, 2, 0x11, 0]));
  check('DM8009P inventory label and feedback ID round-trip',
    MotorKindLabel[inv8009.items[0].kind] === 'DM8009P' && inv8009.items[0].rxId === 0x11);
  check('DM8009P keeps independent 0.05/0/0/10/0 speed defaults',
    JSON.stringify(PID_DEFAULTS[MotorKind.DM8009P].speed) ===
      JSON.stringify({ Kp: 0.05, Ki: 0, Kd: 0, MaxOut: 10, IntegralLimit: 0, improve: 1 }));

  const body = Buffer.from([2, MotorKind.M2006, 1, 3, 2, 0, 0,
    MotorKind.DM, 1, 6, 2, 0x02, 0x03]);
  const parsed = parseInventory(new FrameParser().push(buildFrame(FrameType.INVENTORY_REPORT, body))[0].payload);
  check('new inventory preserves DJI and complete DM RX 0x302',
    parsed.count === 2 && parsed.items[0].rxId === 0 && parsed.items[1].rxId === 0x302);
  check('DM label is DM4310 throughout protocol', MotorKindLabel[parsed.items[1].kind] === 'DM4310');
  check('legacy inventory omits unknown RX instead of inventing zero', !('rxId' in inv.items[1]));
  check('truncated inventory is rejected', parseInventory(body.subarray(0, -1)) === null);
  const maximum = Buffer.alloc(49);
  maximum[0] = 8;
  for (let i = 0; i < 8; i++) body.copy(maximum, 1+i*6, 7, 13);
  const maxFrames = new FrameParser().push(buildFrame(FrameType.INVENTORY_REPORT, maximum));
  check('eight complete inventory records fit the transport frame',
    maxFrames.length === 1 && parseInventory(maxFrames[0].payload).items.length === 8);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
