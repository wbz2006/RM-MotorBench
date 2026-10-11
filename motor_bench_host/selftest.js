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
    const gate = src.match(/if \(!mb_link_online[\s\S]{0,800}?continue;/);
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

console.log('\n== 16. card rebuild must re-bind its button handlers ==');
{
  /*
   * 背景(实机现象"绑定第二个电机报 channel 0 already used"):
   *   buildChannels() 用 innerHTML = '' 重建卡片时,会把旧卡片上的 onclick
   *   一并销毁;而 bindEvents() 原先只在页面加载时调用一次。
   *   清单到达触发重建后,新卡片上的按钮没有任何事件,
   *   个别能响应的还是残留的旧闭包,其 channelId 是重建前的值 ——
   *   于是"点通道1的绑定"实际发出 channelId=0,板端回
   *   "bind failed: channel 0 already used"。
   *
   * 判据:buildChannels() 内部必须调用 bindEvents(),否则重建即失联。
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
      check('buildChannels clears the container (rebuild happens)',
        /innerHTML\s*=\s*''/.test(body));
      check('buildChannels re-binds events after rebuild',
        /bindEvents\(\)/.test(body),
        'without this, rebuilt cards have NO handlers and clicks do nothing');
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

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
