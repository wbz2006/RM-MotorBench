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
  MAX_PAYLOAD,
  buildFrame,
  crc8,
} from './protocol.js';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

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
console.log('\n== 7. dynamic add/remove motor ==');

{
  // 建电机请求:kind=2(M3508) bus=2 id=1
  const f = new FrameParser().push(buildMotorAdd(MotorKind.M3508, 2, 1));
  check('add frame parses', f.length === 1, `got ${f.length}`);
  check('add frame type is MOTOR_ADD', f[0]?.type === FrameType.MOTOR_ADD);
  const p = f[0].payload;
  check('add payload len 4', p.length === 4, `len=${p.length}`);
  check('add kind field', p[0] === MotorKind.M3508, `got ${p[0]}`);
  check('add canBus field', p[1] === 2, `got ${p[1]}`);
  check('add motorId field', p[2] === 1, `got ${p[2]}`);
  check('add reserved must be 0', p[3] === 0, `got ${p[3]}`);
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

/* ---------------- 串口写入返回值(回归测试) ---------------- */
console.log('\n== 8. writeToSerial must return boolean ==');
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

console.log('\n== 9. link gate allow-list covers all read-only frame types ==');
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
    '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
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

console.log('\n== 10. USB TX must not share a reusable staging buffer ==');
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
    '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
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

console.log('\n== 11. RTT diagnostic logs stay ASCII ==');
{
  /*
   * RTT Viewer 按本机代码页解释收到的字节,而固件里的中文是 UTF-8,
   * 于是中文全部显示成乱码,恰好把最关键的信息变得不可读。
   * 诊断日志应使用纯 ASCII(网页 UI 里的中文不受影响,那是浏览器渲染)。
   */
  const fwPath = new URL(
    '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
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

console.log('\n== 12. USB RX callback must stay interrupt-safe ==');
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
    '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
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

console.log('\n== 13. firmware variable-length frames must not use fixed-size arrays ==');
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
    '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
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

console.log('\n== 14. link timeout must outlast the host heartbeat interval ==');
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
      '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
      import.meta.url,
    ), 'utf8');
    const m = fw.match(/#define\s+MB_LINK_TIMEOUT_COUNT\s+(\d+)/);
    if (m) fwCount = Number(m[1]);
  } catch { /* 固件不可达则跳过 */ }

  // daemon 周期:freertos.c 里 StartDAEMONTASK 的 osDelay(10)
  try {
    const fr = readFileSync(new URL(
      '../basic_framework_atype_usb-master/Core/Src/freertos.c',
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

console.log('\n== 15. stream parser minimum-frame check must accept empty payloads ==');
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
      '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c',
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

console.log('\n== 16. new channel cards must get their handlers bound ==');
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
   *   现在 buildChannels 只增不减,不清空已有卡片。
   *
   * 但"新增卡片必须绑上事件"这条依然成立,而且更重要 ——
   *   只增不减意味着旧卡片保留自己的 onclick,新卡片若漏绑就是死按钮。
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

console.log('\n== 17. PID protocol: frame layout, fixed-point, defaults ==');
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
   * 两边必须一致,否则用户会看到页面写 A、实际生效 B。 */
  check('M3508 speed Kp=20 (摩擦轮)', PID_DEFAULTS[MotorKind.M3508].speed.Kp === 20);
  check('M3508 speed MaxOut=15000', PID_DEFAULTS[MotorKind.M3508].speed.MaxOut === 15000);
  check('M2006 speed Kp=10 (拨弹盘)', PID_DEFAULTS[MotorKind.M2006].speed.Kp === 10);
  check('M2006 speed MaxOut=5000', PID_DEFAULTS[MotorKind.M2006].speed.MaxOut === 5000);
  check('GM6020 speed Kp=50 (yaw)', PID_DEFAULTS[MotorKind.GM6020].speed.Kp === 50);
  check('GM6020 speed Ki=200', PID_DEFAULTS[MotorKind.GM6020].speed.Ki === 200);
  check('GM6020 speed MaxOut=20000 (超出 u16×100,验证协议容量)', 
    PID_DEFAULTS[MotorKind.GM6020].speed.MaxOut === 20000);
  /* DJI 三型必须带电流环参数 —— 这三组实参都是在电流内环下整定的,
   * 少了电流环"同样的 Kp/Ki"不会有同样效果。
   * 达妙不在此列:用户明确要求"达妙暂时不变",固件侧也没开电流环。 */
  const djiKinds = [MotorKind.M3508, MotorKind.M2006, MotorKind.GM6020];
  check('DJI 三型都带电流环参数(三环闭环必要条件)',
    djiKinds.every((k) => PID_DEFAULTS[k].current.Kp > 0));
  check('达妙暂不引入电流环(延用原值,用户要求不变)',
    PID_DEFAULTS[MotorKind.DM].current.Kp === 0);
  check('达妙参数暂不引入(延用原值)',
    PID_DEFAULTS[MotorKind.DM].speed.Kp === 5);
}

console.log('\n== 18. PID panel must stay visible (disable, not hide) ==');
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
    const panel = html.match(/<div class="pid-panel"[^>]*>/);
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

console.log('\n== 19. telemetry frame must be split to fit the 64B USB limit ==');
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
      '../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c', import.meta.url,
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

console.log('\n== 20. adding a motor must not destroy channel UI state ==');
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
   *   两者都建立在"电机数 == 通道数"这个错误前提上 ——
   *   实际通道是独立控制位(固件 MB_CHANNEL_MAX = 8),与电机总数无关。
   *
   * 判据(对着源码断言,因为这些是"不该再犯"的结构性约束):
   *   1. buildChannels 里不得再出现 host.innerHTML = ''
   *   2. buildChannels 必须只增不减(Math.max(have, ...))
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
      check('buildChannels is additive (never shrinks)',
        /Math\.max\(/.test(bcode),
        'cards must only grow; shrinking deletes a channel the user is using');
      check('buildChannels appends from the existing count',
        /for\s*\(\s*let i\s*=\s*have\s*;/.test(bcode));
      check('buildChannels returns early when the count is unchanged',
        /have\s*===\s*n/.test(bcode),
        'touching the DOM when nothing changed still loses input state');
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

    /* --- 端到端语义:通道数与电机数解耦 --- */
    check('CHANNEL_COUNT is not derived from inventory length',
      !/CHANNEL_COUNT\s*=\s*inventory\.length/.test(code),
      'channels and motors are independent; MB_CHANNEL_MAX is 8 either way');
  }
}

console.log('\n== 21. "unbind" must really unbind, not just stop ==');
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
    fwC = readFileSync(new URL('../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.c', b), 'utf8');
    fwH = readFileSync(new URL('../basic_framework_atype_usb-master/modules/motor_bench/motor_bench.h', b), 'utf8');
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

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);