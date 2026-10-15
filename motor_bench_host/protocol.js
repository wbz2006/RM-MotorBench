/**
 * protocol.js —— 电机测试台上位机与 A 板之间的协议实现(Node.js 侧)
 *
 * 与固件 modules/motor_bench/motor_bench.h 严格对应,改协议必须同时改两边。
 *
 * 帧格式(小端):
 *   | 0xA5 | type | len | payload[len] | crc8 | 0x5A |
 *   CRC 覆盖 type + len + payload(不含帧头、crc、帧尾)
 */

/** 帧头/帧尾,需与固件 MB_FRAME_HEAD / MB_FRAME_TAIL 一致 */
export const FRAME_HEAD = 0xa5;
export const FRAME_TAIL = 0x5a;

/** 单帧最大负载长度,需与固件 MB_PAYLOAD_MAX 一致(越界即判为假帧头) */
export const MAX_PAYLOAD = 64;

/** 帧类型,需与固件 MB_FrameType_e 一致 */
export const FrameType = {
  HEARTBEAT: 0x01,
  MOTOR_BIND: 0x02,
  MOTOR_SET: 0x03,
  MOTOR_ENABLE: 0x04,
  ALL_STOP: 0x05,
  QUERY: 0x06,
  INVENTORY_QUERY: 0x07,
  MOTOR_ADD: 0x08,
  MOTOR_REMOVE: 0x09,
  PID_SET: 0x0a,
  PID_QUERY: 0x0b,
  MOTOR_UNBIND: 0x0c,
  CONTROL_SOURCE: 0x0d,
  CHASSIS_ENABLE: 0x0e,
  TELEMETRY: 0x81,
  INVENTORY_REPORT: 0x82,
  MOTOR_ADD_ACK: 0x8a,
  PID_REPORT: 0x8b,
  PID_SET_ACK: 0x8c,
  UNBIND_ACK: 0x8d,
  CONTROL_REPORT: 0x8e,
};

/** 电机种类,需与固件 MB_MotorKind_e 一致 */
export const MotorKind = {
  NONE: 0,
  GM6020: 1,
  M3508: 2,
  M2006: 3,
  DM: 4,
  LK: 5,
  HT: 6,
};

export const MotorKindLabel = {
  [MotorKind.GM6020]: '大疆 GM6020',
  [MotorKind.M3508]: '大疆 M3508',
  [MotorKind.M2006]: '大疆 M2006',
  [MotorKind.DM]: '达妙 DM 系列',
  [MotorKind.LK]: 'LK9025',
  [MotorKind.HT]: 'HT04',
};

/** 闭环类型,需与固件 Closeloop_Type_e 一致 */
export const LoopType = {
  OPEN_LOOP: 0b0000,
  CURRENT_LOOP: 0b0001,
  SPEED_LOOP: 0b0010,
  ANGLE_LOOP: 0b0100,
};

export const LoopLabel = {
  [LoopType.OPEN_LOOP]: '开环',
  [LoopType.CURRENT_LOOP]: '电流环',
  [LoopType.SPEED_LOOP]: '速度环',
  [LoopType.ANGLE_LOOP]: '角度环',
};

/**
 * 单通道遥测的字节数,需与固件 MB_TelemetryItem_s 的 sizeof 一致。
 * 结构:u16 channel_id + u16 status + f32 ref + f32 speed + f32 torque + f32 angle + i8 temp
 *     = 2+2+4+4+4+4+1 = 21 字节(pack(1) 对齐后仍为 21)
 */
export const TELEMETRY_ITEM_BYTES = 21;

/**
 * CRC8 查找表 —— 逐字节取自固件 modules/algorithm/crc8.c 的 sht75_crc_table。
 *
 * @note 不要用"标准 CRC-8 多项式"去生成这张表:固件里这张表是由 SHT75 算法
 *       生成的,并且更新式为 crc = table[byte ^ crc](异或后查表),
 *       与常见的反射式实现不一致。直接原样内联可保证两端逐位一致。
 */
const crc8Table = Uint8Array.from([
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
]);

/**
 * 计算 CRC8,与固件 crc_8() 完全一致
 * @param {Buffer|Uint8Array} bytes
 */
export function crc8(bytes) {
  let crc = 0x00; // CRC_START_8
  for (const b of bytes) {
    crc = crc8Table[(b ^ crc) & 0xff];
  }
  return crc;
}

/** 把若干片段拼成一个 Buffer */
function concat(parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

/**
 * 组装一帧
 * @param {number} type 帧类型
 * @param {Buffer|Uint8Array} payload 负载
 * @returns {Buffer}
 */
export function buildFrame(type, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const checked = concat([Buffer.from([type, body.length]), body]);
  const crc = crc8(checked);
  return concat([
    Buffer.from([FRAME_HEAD]),
    checked,
    Buffer.from([crc, FRAME_TAIL]),
  ]);
}

/* ---------------- 各类命令帧 ---------------- */

export function buildHeartbeat() {
  return buildFrame(FrameType.HEARTBEAT, Buffer.alloc(0));
}

/**
 * 绑定:把固件清单中的某颗电机绑到通道
 * @param {number} channelId 0~7
 * @param {{kind:number,canBus:number,motorId:number,outerLoop:number}} motor
 */
export function buildBind(channelId, motor) {
  const payload = Buffer.from([
    channelId,
    motor.kind,
    motor.canBus,
    motor.motorId,
    motor.outerLoop,
  ]);
  return buildFrame(FrameType.MOTOR_BIND, payload);
}

/**
 * 设置参考值
 * @param {number} channelId
 * @param {number} ref 参考值(速度环 rpm / 电流环 A / 角度环 deg)
 */
export function buildSetRef(channelId, ref) {
  const payload = Buffer.alloc(5);
  payload.writeUInt8(channelId, 0);
  payload.writeFloatLE(ref, 1);
  return buildFrame(FrameType.MOTOR_SET, payload);
}

/**
 * 使能/停止
 * @param {number} channelId
 * @param {boolean} enable
 */
export function buildEnable(channelId, enable) {
  return buildFrame(FrameType.MOTOR_ENABLE, Buffer.from([channelId, enable ? 1 : 0]));
}

export function buildControlSource(source, channelId = 0, maxRef = 0) {
  if (![0, 1].includes(source) || !Number.isInteger(channelId) || channelId < 0 || channelId >= 8 ||
      !Number.isFinite(maxRef) || (source === 1 && (maxRef <= 0 || maxRef > 12000)))
    throw new RangeError('控制来源、通道或遥控最大转速不合法');
  const body = Buffer.alloc(6);
  body[0] = source;
  body[1] = channelId;
  body.writeFloatLE(maxRef, 2);
  return buildFrame(FrameType.CONTROL_SOURCE, body);
}

export function parseControlReport(body) {
  if (body.length !== 12 && body.length !== 21) return null;
  if (body[1] >= 2 && body.length !== 21) return null;
  const report = {
    result: body[0], source: body[1], channelId: body[2], online: !!body[3],
    switchRight: body[4], ready: !!body[5], rocker: body.readInt16LE(6),
    maxRef: body.readFloatLE(8),
  };
  if (body.length === 21) Object.assign(report, {
    channels: [...body.subarray(12, 16)], reverseMask: body[16],
    lateral: body.readInt16LE(17), yaw: body.readInt16LE(19),
  });
  return report;
}

export function buildChassisControl(source, channels, maxRef, reverseMask = 0) {
  if (![2, 3].includes(source) || !Array.isArray(channels) || channels.length !== 4 ||
      new Set(channels).size !== 4 || channels.some(id => !Number.isInteger(id) || id < 0 || id >= 8) ||
      !Number.isInteger(reverseMask) || reverseMask < 0 || reverseMask > 15 ||
      !Number.isFinite(maxRef) || maxRef <= 0 || maxRef > 12000)
    throw new RangeError('底盘类型、四轮通道、反向或最大转速不合法');
  const body = Buffer.alloc(10);
  body[0] = source;
  channels.forEach((id, i) => { body[1 + i] = id; });
  body[5] = reverseMask;
  body.writeFloatLE(maxRef, 6);
  return buildFrame(FrameType.CONTROL_SOURCE, body);
}

export function buildChassisEnable(enable) {
  if (typeof enable !== 'boolean') throw new RangeError('底盘使能需为布尔值');
  return buildFrame(FrameType.CHASSIS_ENABLE, Buffer.from([enable ? 1 : 0]));
}

export function buildAllStop() {
  return buildFrame(FrameType.ALL_STOP, Buffer.alloc(0));
}

export function buildQuery() {
  return buildFrame(FrameType.QUERY, Buffer.alloc(0));
}

/** 询问板端登记了哪些电机 */
export function buildInventoryQuery() {
  return buildFrame(FrameType.INVENTORY_QUERY, Buffer.alloc(0));
}

/**
 * 解析电机清单应答
 * 布局:head(1) type(1) len(1) count(1) items[count*4] crc(1) tail(1)
 *       每项:kind(1) can_bus(1) motor_id(1) outer_loop(1)
 * @param {Buffer} payload 帧负载
 */
export function parseInventory(payload) {
  if (payload.length < 1) return null;
  const count = payload[0];
  const items = [];
  for (let i = 0; i < count; i++) {
    const off = 1 + i * 4;
    if (off + 4 > payload.length) break;
    items.push({
      kind: payload[off],
      canBus: payload[off + 1],
      motorId: payload[off + 2],
      outerLoop: payload[off + 3],
    });
  }
  return { count, items };
}

/** 板端返回码,需与固件 MB_Result_e 一致 */
export const MBResult = {
  OK: 0,
  BAD_PARAM: 1,
  DUPLICATE: 2,
  NOT_PROVISIONED: 3,
  NOT_ENABLED: 4,
  UNSUPPORTED: 5,
  NO_RESOURCE: 6,
};

/** 返回码 → 给人看的原因(直接用于界面提示) */
export const MBResultText = {
  [MBResult.OK]: '成功',
  [MBResult.BAD_PARAM]: '参数不合法(总线只能填 1 或 2,ID 不能为 0)',
  [MBResult.DUPLICATE]:
    '冲突:该总线上已有电机占用同一 ID。' +
    '注意 6020 用 0x204+ID、3508/2006 用 0x200+ID,两者区间重叠,必须分开挂在不同 CAN 总线上',
  [MBResult.NOT_PROVISIONED]: '板端没有这颗电机,请先刷新清单',
  [MBResult.NOT_ENABLED]: '通道未使能',
  [MBResult.UNSUPPORTED]: '该电机种类尚未接入测试台',
  [MBResult.NO_RESOURCE]: '资源不足:该 CAN 总线的滤波器已用完(每条总线最多 14 颗)',
};

/**
 * 构造"创建电机"帧
 *
 * 负载布局:kind(1) can_bus(1) motor_id(1) reserved(1)
 *
 * @param {number} kind     MotorKind 枚举
 * @param {number} canBus   1=CAN1 2=CAN2
 * @param {number} motorId  电调拨码 ID
 */
export function buildMotorAdd(kind, canBus, motorId) {
  const b = Buffer.alloc(4);
  b[0] = kind;
  b[1] = canBus;
  b[2] = motorId;
  b[3] = 0; // reserved
  return buildFrame(FrameType.MOTOR_ADD, b);
}

/**
 * 构造"移除电机"帧
 * 负载布局与创建请求相同(复用 MB_MotorAddReq_s)
 */
export function buildMotorRemove(kind, canBus, motorId) {
  const b = Buffer.alloc(4);
  b[0] = kind;
  b[1] = canBus;
  b[2] = motorId;
  b[3] = 0;
  return buildFrame(FrameType.MOTOR_REMOVE, b);
}

/**
 * 解析建/拆电机应答
 * 负载布局:result(1) kind(1) can_bus(1) motor_id(1) channel_id(1) detail(1)
 * @param {Buffer} payload 帧负载
 * @returns {{result:number, kind:number, canBus:number, motorId:number,
 *            channelId:number, detail:number}|null}
 */
export function parseMotorAddAck(payload) {
  if (payload.length < 6) return null;
  return {
    result: payload[0],
    kind: payload[1],
    canBus: payload[2],
    motorId: payload[3],
    channelId: payload[4],
    detail: payload[5], // 该总线剩余过滤器个数
  };
}

/* ---------------- PID 运行期整定 ---------------- */

/**
 * PID 参数的目标环 —— 与固件 MB_PidLoop_e 一致
 *
 * @note 定点方案(为什么不是全 u16 x100):
 *   Kp/Ki/Kd 是小系数(u16×100 够用),但
 *   MaxOut / IntegralLimit 是电流量级(M3508 达 15000,GM6020 达 20000),
 *   ×100 后是 1500000/2000000,远超 u16 的 65535。
 *   整定迁移当天就踩到这个坑:直接用 u16×100 传 MaxOut=15000
 *   会让 Buffer.writeUInt16LE 抛 ERR_OUT_OF_RANGE。
 *   故采用混合方案 —— 小系数 u16×100,大限幅 s32 整数值。
 */
export const PidLoop = {
  SPEED: 0,
  CURRENT: 1,
  ANGLE: 2,
};

export const PidLoopLabel = {
  [PidLoop.SPEED]: '速度环',
  [PidLoop.CURRENT]: '电流环',
  [PidLoop.ANGLE]: '位置环',
};

/**
 * PID 默认参数 —— 与固件 motor_bench_app.c 的 bench_dji_*_pid[] 逐项对应。
 *
 * 来源:gimbal-fed infantry 工程实机整定值(2026-10-12 迁移)。
 *   M3508  -> shoot.c   摩擦轮 friction_config
 *   M2006  -> shoot.c   拨弹盘 loader_config (速度环部分)
 *   GM6020 -> gimbal.c  yaw 轴
 *
 * @note 放在 protocol.js 而非 ui.js:这是**协议层数据**,不是界面状态。
 *   ui.js 要在页面里显示默认值,selftest.js 要校验与固件一致,
 *   两边都 import 同一份就消除了"页面显示一套、固件生效另一套"的风险。
 */
export const PID_DEFAULTS = {
  // 大疆 M3508 —— 摩擦轮实参(close_loop = SPEED|CURRENT)
  [MotorKind.M3508]: {
    speed: { Kp: 20, Ki: 1, Kd: 0, MaxOut: 15000, IntegralLimit: 10000, improve: 0 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 15000, IntegralLimit: 10000, improve: 0 },
    angle: { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, improve: 0 },
  },
  // 大疆 M2006 —— 拨弹盘速度环实参
  [MotorKind.M2006]: {
    speed: { Kp: 10, Ki: 1, Kd: 0, MaxOut: 5000, IntegralLimit: 5000, improve: 0 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 5000, IntegralLimit: 5000, improve: 0 },
    angle: { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, improve: 0 },
  },
  // 大疆 GM6020 —— yaw 轴实参
  [MotorKind.GM6020]: {
    speed: { Kp: 50, Ki: 200, Kd: 0, MaxOut: 20000, IntegralLimit: 3000, improve: 5 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 20000, IntegralLimit: 3000, improve: 0 },
    angle: { Kp: 8, Ki: 0, Kd: 0, MaxOut: 500, IntegralLimit: 100, improve: 5 },
  },
  // 达妙 DM —— 暂不引入,延用原测试台配置(用户明确要求"达妙暂时不变")
  [MotorKind.DM]: {
    speed: { Kp: 5, Ki: 0, Kd: 0, MaxOut: 10, IntegralLimit: 8, improve: 0 },
    current: { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, improve: 0 },
    angle: { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, improve: 0 },
  },
};

/**
 * 构造"设置 PID"帧 —— 对单个通道的单个环写入一套参数
 *
 * 负载布局(20 字节):
 *   channel_id(1) loop(1) improve_flags(1) reserved(1)
 *   Kp(2) Ki(2) Kd(2)              u16 LE 定点 x100
 *   MaxOut(4) IntegralLimit(4)     s32 LE 整数值
 *   tail_pad(2)
 *
 * @param {number} channelId 通道号
 * @param {number} loop       PidLoop 枚举
 * @param {{Kp:number,Ki:number,Kd:number,MaxOut:number,IntegralLimit:number,improve?:number}} pid
 * @returns {Buffer}
 */
export function buildSetPid(channelId, loop, pid) {
  /*
   * 直接按 MB_PidSetReq_s 的内存布局写一个 20 字节 payload,不做"头+体"拼接。
   *
   * @attention 曾把 payload 拆成 6 字节 head + 15 字节 body 两段再 concat,
   *   结果 head 多了 2 字节导致所有字段整体错位 ——
   *   Kp 读出来是 0、Ki 读出来是 Kp 的值,而且**自测没抓到**,
   *   因为测试里也照抄了同样的错偏移。
   *   教训:协议字段偏移必须与固件 _Static_assert 的数字一致,
   *   测试要用**固件那份偏移表**做基准,而不是"看代码数出来的"。
   *
   *   固件侧结构体加了 __attribute__((packed)),布局 = 声明顺序,
   *   所以这里照声明顺序逐字节写即可,无需考虑对齐。
   */
  const b = Buffer.alloc(20);
  b[0] = channelId & 0xff;
  b[1] = loop & 0xff;
  b[2] = (pid.improve ?? 0) & 0xff;  /* improve 只用低 8 位 */
  b[3] = 0;                           /* reserved */
  b.writeUInt16LE(Math.round((pid.Kp ?? 0) * 100), 4);
  b.writeUInt16LE(Math.round((pid.Ki ?? 0) * 100), 6);
  b.writeUInt16LE(Math.round((pid.Kd ?? 0) * 100), 8);
  b.writeInt32LE(Math.round(pid.MaxOut ?? 0), 10);
  b.writeInt32LE(Math.round(pid.IntegralLimit ?? 0), 14);
  b.fill(0, 18); // tail_pad

  return buildFrame(FrameType.PID_SET, b);
}

/**
 * 构造"查询 PID"帧 —— 请求上报指定通道的三套参数
 *
 * 负载布局(4 字节):
 *   reserved(1) reserved(1) reserved(1) channel_id(1)
 *
 * @param {number} channelId 通道号
 * @returns {Buffer}
 */
export function buildPidQuery(channelId) {
  const b = Buffer.alloc(4);
  b[3] = channelId & 0xff;
  return buildFrame(FrameType.PID_QUERY, b);
}

/**
 * 解析 PID 上报 —— 固件把三套参数一次性回传
 *
 * 负载 49 字节,与固件 MB_PidReport_s 逐字节对应(固件已 _Static_assert 锁定):
 *   channel_id(1) kind(1) reserved(2)
 *   kp[3]      u16 LE 各 x100
 *   ki[3]      u16 LE 各 x100
 *   kd[3]      u16 LE 各 x100
 *   maxout[3]  s32 LE 各整数值
 *   intlim[3]  s32 LE 各整数值
 *   improve[3] u8    各 1 字节
 *
 * @attention 固件侧用五个并列数组而非三个嵌套结构体,原因是 CMSIS 默认
 *   4 字节对齐会让嵌套结构体产生填充,偏移就对不上了。
 *   所以"某环的 MaxOut"不在"该环 Kp 后面",而在独立的 maxout 数组里。
 */
export function parsePidReport(payload) {
  if (payload.length < 49) return null;

  // 数组基址:kp@4, ki@10, kd@16(各 6 字节), maxout@22, intlim@34(各 12 字节), improve@46
  const q16 = (arr, li) => payload.readUInt16LE(4 + arr * 6 + li * 2) / 100;
  const q32 = (arr, li) => payload.readInt32LE(22 + arr * 12 + li * 4);
  const imp = (li) => payload[46 + li];

  return {
    channelId: payload[0],
    kind: payload[1],
    speed: { Kp: q16(0, 0), Ki: q16(1, 0), Kd: q16(2, 0), MaxOut: q32(0, 0), IntegralLimit: q32(1, 0), improve: imp(0) },
    current: { Kp: q16(0, 1), Ki: q16(1, 1), Kd: q16(2, 1), MaxOut: q32(0, 1), IntegralLimit: q32(1, 1), improve: imp(1) },
    angle: { Kp: q16(0, 2), Ki: q16(1, 2), Kd: q16(2, 2), MaxOut: q32(0, 2), IntegralLimit: q32(1, 2), improve: imp(2) },
  };
}

/**
 * 解析 PID 设置应答
 * 负载布局:channel_id(1) loop(1) result(1) detail(1)
 * @returns {{channelId:number, loop:number, result:number, detail:number}|null}
 */
export function parsePidSetAck(payload) {
  if (payload.length < 4) return null;
  return {
    channelId: payload[0],
    loop: payload[1],
    result: payload[2],
    detail: payload[3],
  };
}

/**
 * 构造"解绑通道"帧
 *
 * @attention 这个帧**必须存在**,否则界面上的"解绑"按钮名不副实:
 *   只下发 enable=0 的话,固件侧 mb_channels[ch].is_used 仍为 1,
 *   通道还指着原来那颗电机 —— 于是紧接着绑定另一颗会被
 *   MB_ERR_DUPLICATE 拒绝,而界面以为已经解绑成功。
 *   实测症状:换电机后"全部电机都不转了",因为绑定被静默拒绝。
 *
 * 负载布局(2 字节):reserved(1) channel_id(1)
 */
export function buildUnbind(channelId) {
  const b = Buffer.alloc(2);
  b[0] = 0;
  b[1] = channelId & 0xff;
  return buildFrame(FrameType.MOTOR_UNBIND, b);
}

/**
 * 解析解绑应答
 * 负载布局:channel_id(1) result(1)
 */
export function parseUnbindAck(payload) {
  if (payload.length < 2) return null;
  return { channelId: payload[0], result: payload[1] };
}

/* ---------------- 上报帧构造(用于自测与上位机模拟) ---------------- */

/**
 * 组装心跳应答帧
 *
 * @note 与固件 MB_HeartbeatAck_s 一致的统一格式:
 *         head type len body(len) crc tail
 *       body = fw_major fw_minor inventory flags uptime(2) seq(2) = 9 字节
 *
 * @param {{fwMajor?:number,fwMinor?:number,inventory?:number,flags?:number,uptime?:number,seq?:number}} f
 * @returns {Buffer}
 */
export function buildHeartbeatAck(f = {}) {
  const body = Buffer.alloc(9);
  body[0] = f.fwMajor ?? 1;
  body[1] = f.fwMinor ?? 0;
  body[2] = f.inventory ?? 0;
  body[3] = f.flags ?? 0;
  body.writeUInt16LE(f.uptime ?? 0, 4);
  body.writeUInt16LE(f.seq ?? 0, 6);

  return buildFrame(FrameType.HEARTBEAT, body);
}

/**
 * 组装遥测帧
 *
 * 格式与固件一致:head type len body(len) crc tail,
 * body = count(1) + seq(2) + items[count*21]
 *
 * @param {Array<{channelId:number,online?:boolean,enabled?:boolean,ref?:number,speed?:number,torque?:number,angle?:number,temperature?:number}>} items
 * @param {number} seq
 * @returns {Buffer}
 */
export function buildTelemetry(items, seq = 0) {
  const body = Buffer.alloc(3 + items.length * TELEMETRY_ITEM_BYTES);
  body[0] = items.length;
  body.writeUInt16LE(seq, 1);

  items.forEach((it, i) => {
    const off = 3 + i * TELEMETRY_ITEM_BYTES;
    body.writeUInt16LE(it.channelId, off);
    body.writeUInt16LE((it.online ? 1 : 0) | (it.enabled ? 2 : 0), off + 2);
    body.writeFloatLE(it.ref ?? 0, off + 4);
    body.writeFloatLE(it.speed ?? 0, off + 8);
    body.writeFloatLE(it.torque ?? 0, off + 12);
    body.writeFloatLE(it.angle ?? 0, off + 16);
    body.writeInt8(it.temperature ?? -128, off + 20);
  });

  return buildFrame(FrameType.TELEMETRY, body);
}

/* ---------------- 解析 ---------------- */

/**
 * 心跳应答解析
 * 布局:head(1) type(1) len(1) body(9) crc(1) tail(1)
 *       body = fw_major fw_minor inventory flags uptime(2) seq(2)
 * @param {Buffer} payload 帧负载(由 FrameParser 给出)
 */
export function parseHeartbeatAck(payload) {
  if (payload.length < 9) return null;
  return {
    fwVersion: `${payload[0]}.${payload[1]}`,
    inventoryCount: payload[2],
    boardFlags: payload[3],
    anyMotorOnline: (payload[3] & 0x01) !== 0,
    uptimeS: payload.readUInt16LE(4),
    seq: payload.readUInt16LE(6),
  };
}

/**
 * 遥测帧解析
 * 布局:head(1) type(1) len(1) body(len) crc(1) tail(1)
 *       body = count(1) + seq(2) + items[count*21]
 * @param {Buffer} payload 帧负载(由 FrameParser 给出)
 */
export function parseTelemetry(payload) {
  if (payload.length < 3) return null;
  const count = payload[0];
  const seq = payload.readUInt16LE(1);
  const items = [];
  for (let i = 0; i < count; i++) {
    const off = 3 + i * TELEMETRY_ITEM_BYTES;
    if (off + TELEMETRY_ITEM_BYTES > payload.length) break;
    items.push({
      channelId: payload.readUInt16LE(off),
      status: payload.readUInt16LE(off + 2),
      online: (payload.readUInt16LE(off + 2) & 0x01) !== 0,
      enabled: (payload.readUInt16LE(off + 2) & 0x02) !== 0,
      ref: payload.readFloatLE(off + 4),
      speed: payload.readFloatLE(off + 8),
      torque: payload.readFloatLE(off + 12),
      angle: payload.readFloatLE(off + 16),
      temperature: payload.readInt8(off + 20),
    });
  }
  return { count, seq, items };
}

/**
 * 流式解包器:喂入任意长度的字节流,吐出解析成功的完整帧
 * @note  串口是字节流,一次 read 可能拿到半帧或多帧,必须做重同步
 */
export class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk 新收到的字节
   * @returns {Array<{type:number,payload:Buffer}>} 完整帧列表
   */
  push(chunk) {
    this.buffer = concat([this.buffer, chunk]);
    const frames = [];
    let i = 0;

    while (i < this.buffer.length) {
      // 1. 对齐帧头
      if (this.buffer[i] !== FRAME_HEAD) {
        i += 1;
        continue;
      }
      // 2. 长度是否够读出头部
      if (this.buffer.length - i < 3) break;

      const type = this.buffer[i + 1];
      const payloadLen = this.buffer[i + 2];

      // 负载长度越界 => 该帧一定不是真帧头(多半是数据里恰好出现 0xA5)。
      // 必须立刻右移重找帧头,否则会一直等一帧永远不会到来的数据,导致整条流卡死。
      if (payloadLen > MAX_PAYLOAD) {
        i += 1;
        continue;
      }

      const frameLen = 5 + payloadLen;
      if (this.buffer.length - i < frameLen) break; // 半帧,等下次

      // 3. CRC 与帧尾校验
      const crc = crc8(this.buffer.subarray(i + 1, i + 3 + payloadLen));
      if (crc !== this.buffer[i + 3 + payloadLen] || this.buffer[i + 4 + payloadLen] !== FRAME_TAIL) {
        i += 1; // 坏帧,右移重找帧头
        continue;
      }

      frames.push({
        type,
        frame: Buffer.from(this.buffer.subarray(i, i + frameLen)), // 完整帧
        payload: this.buffer.subarray(i + 3, i + 3 + payloadLen), // 纯负载
      });
      i += frameLen;
    }

    this.buffer = this.buffer.subarray(i);
    return frames;
  }
}
