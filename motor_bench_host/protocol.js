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
  LOOP_SET: 0x0d,
  TELEMETRY: 0x81,
  INVENTORY_REPORT: 0x82,
  MOTOR_ADD_ACK: 0x8a,
  PID_REPORT: 0x8b,
  PID_SET_ACK: 0x8c,
  UNBIND_ACK: 0x8d,
  LOOP_SET_ACK: 0x8e,
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
  DM8009P: 7,
};

/*
 * 电机种类显示名称。
 *
 * @attention 统一为「厂商 + 型号」格式(2026-10-19 用户要求"与大疆系保持一致")。
 *   DJI 三型原本就带"大疆 "前缀,而达妙/岭芯/海泰是裸型号 ——
 *   混排会让下拉列表读起来一半正式一半潦草。现在全部带厂商前缀。
 *
 * @note 前缀用品牌常用中文名,不写英文厂商全称:
 *   "达妙"而非 "DM-robots",与实验室口头叫法一致。
 */
export const MotorKindLabel = {
  [MotorKind.GM6020]: '大疆 GM6020',
  [MotorKind.M3508]: '大疆 M3508',
  [MotorKind.M2006]: '大疆 M2006',
  [MotorKind.DM]: '达妙 DM4310',
  [MotorKind.DM8009P]: '达妙 DM8009P',
  [MotorKind.LK]: '岭芯 LK9025',
  [MotorKind.HT]: '海泰 HT04',
};

/* ============================================================
 * CAN ID 冲突预检
 *
 * 与固件 modules/motor_bench/motor_bench.c 的 MotorBenchPredictRxId()
 * 使用**完全相同**的公式(该公式又来自 DJI 库 dji_motor.c 的 MotorSenderGrouping)。
 * 三处必须一致 —— 这里只是把固件的预检提前到"用户还没点添加"的时刻,
 * 让用户当场看到冲突,而不是等板子拒绝。
 *
 * 公式:
 *   GM6020      : rx_id = 0x204 + id  → 0x205 ~ 0x20C
 *   M3508/M2006 : rx_id = 0x200 + id  → 0x201 ~ 0x208
 *   重叠区 0x205 ~ 0x208
 *
 * 关键:M3508 与 M2006 用**同一个公式**,所以它们之间"同 ID 必撞"。
 * 这一点最容易被忽略 —— 用户往往只想到 6020 与 3508 之间会冲突。
 * ============================================================ */

/** 该型号是否占用 DJI 的 0x200 ID 段(DM/LK/HT 走另一套,不参与冲突判定) */
export function usesDjiIdSegment(kind) {
  return kind === MotorKind.GM6020
    || kind === MotorKind.M3508
    || kind === MotorKind.M2006;
}

/**
 * 该型号是否需要上位机显式指定 rx_id(反馈 ID)
 *
 * @note 2026-10-19 起包含 HT04 —— 它的 HTMotorInit() 直接拿
 *   can_init_config.rx_id 建 CAN 过滤器,不做内部改写,与 DM 一样
 *   必须显式给(多颗 HT 靠它区分)。
 *
 *   DJI 三型与 LK9025 不需要:rx_id 由驱动内部算出,传了也会被忽略。
 *
 * @returns {boolean} true = 界面上要给 rx_id 输入框
 */
export function needsRxId(kind) {
  return kind === MotorKind.DM
    || kind === MotorKind.DM8009P
    || kind === MotorKind.HT;
}

/**
 * rx_id 的合法范围(CAN 标准帧 11 位 ID)
 * @note 电调的反馈 ID 由电调侧配置决定,常见 0x00~0x0F 一小段,
 *   但协议层不替用户猜范围,只保证不越出 CAN 标准帧上限。
 */
export const RX_ID_MIN = 0;
export const RX_ID_MAX = 0x7ff;

/**
 * 预估某配置算出的反馈 ID(rx_id)
 *
 * @note 必须与固件 motor_bench.c 的 MotorBenchPredictRxId() 一致:
 *   GM6020      : 0x204 + id
 *   M3508/M2006 : 0x200 + id
 *   LK9025      : 0x140 + id   ← 2026-10-19 补入;LK 驱动内部改写,
 *                                与用户填的 ID 不同,此前预检完全跳过它
 *   DM / HT     : 0 —— rx_id 由请求显式指定,不按 motor_id 推导
 *
 * @returns {number} rx_id;0 表示不按 motor_id 推导(跳过预检)
 */
export function predictRxId(kind, motorId) {
  if (kind === MotorKind.GM6020) return 0x204 + motorId;
  if (kind === MotorKind.M3508 || kind === MotorKind.M2006) return 0x200 + motorId;
  if (kind === MotorKind.LK) return 0x140 + motorId;
  return 0;
}

/** ID 上限(MB_CHANNEL_MAX / 电调拨码范围) */
export const MOTOR_ID_MIN = 1;
export const MOTOR_ID_MAX = 8;

/**
 * 计算某总线上哪些电调 ID 还可安全使用
 *
 * @param {number} canBus        要检查的总线(1 或 2)
 * @param {Array}  inventory     已添加的电机清单,每项含 {kind, canBus, motorId}
 * @param {number} kind          打算添加的型号
 * @returns {number[]} 可用 ID 升序数组
 *
 * @note 只在**同一条总线**上比对 —— 不同 CAN 总线是独立 ID 空间,互不影响。
 *       达妙等非 DJI 系不占用 0x200 段,任何 ID 都不与它们冲突。
 */
export function availableIds(canBus, inventory, kind) {
  if (!usesDjiIdSegment(kind)) {
    /* 非 DJI 系不参与该段判定,1~8 全可用 */
    return Array.from({ length: MOTOR_ID_MAX }, (_, i) => i + MOTOR_ID_MIN);
  }

  const taken = new Set();
  for (const m of inventory) {
    if (!m || m.canBus !== canBus) continue;       // 不同总线,跳过
    if (!usesDjiIdSegment(m.kind)) continue;       // 非 DJI 系不占该段
    taken.add(predictRxId(m.kind, m.motorId));
  }

  const free = [];
  for (let id = MOTOR_ID_MIN; id <= MOTOR_ID_MAX; id++) {
    if (!taken.has(predictRxId(kind, id))) free.push(id);
  }
  return free;
}

/**
 * 检查一个待添加的电机是否与已有电机冲突
 *
 * @returns {null|{existing:object, rxId:number}} 冲突时返回占用者;无冲突返回 null
 */
export function findConflict(canBus, inventory, kind, motorId) {
  if (!usesDjiIdSegment(kind)) return null;

  const rx = predictRxId(kind, motorId);
  for (const m of inventory) {
    if (!m || m.canBus !== canBus) continue;
    if (!usesDjiIdSegment(m.kind)) continue;
    if (predictRxId(m.kind, m.motorId) === rx) {
      return { existing: m, rxId: rx };
    }
  }
  return null;
}

/**
 * 生成给用户看的冲突提示文案
 *
 * 设计要点(2026-10-13 用户要求):
 *   1. **说清改谁** —— 用户首先要知道调哪颗电机的拨码。
 *      6020 与 3508/2006 冲突时,建议改 3508/2006,因为 6020 常用的
 *      ID 1~4 与 3508 的 5~8 才冲突,而 6020 换到 5~8 会挤占更多;
 *      更重要的原因:3508/2006 通常成组(底盘 4 颗、拨弹 1 颗),
 *      改动它们其中一个的代价比动云台 6020 小。
 *   2. **给出可用 ID** —— 只说"冲突了"没用,用户下一步必然是问"那我填几"。
 *   3. 说明冲突的硬件原因(共用 rx_id),让用户下次能自己判断。
 *
 * @returns {string} 面向用户的中文提示
 */
export function describeConflict(canBus, inventory, kind, motorId) {
  const hit = findConflict(canBus, inventory, kind, motorId);
  if (!hit) return '';

  const me = MotorKindLabel[kind] ?? `类型${kind}`;
  const other = MotorKindLabel[hit.existing.kind] ?? `类型${hit.existing.kind}`;
  const rx = `0x${hit.rxId.toString(16).toUpperCase().padStart(3, '0')}`;

  const free = availableIds(canBus, inventory, kind);

  /*
   * @attention 可用 ID 必须注明是"**本颗**该型号的可选项"。
   *
   * 原始文案只写"当前 CAN1 可用 ID:2、3、4、5…",而其中的 5 是按
   * **本颗 6020** 算出来的(6020 拨 5 = 0x209,确实不冲突)。
   * 但用户看到列表里有 5,极易理解成"3508 拨 5 也行"——
   * 而 3508 拨 5 恰恰就是发生冲突的那个 ID,等于把人往坑里带。
   * 所以把型号写进这句,并说明列表随型号而变。
   */
  const freeLine = free.length
    ? `当前 CAN${canBus} 上 ${me} 可用的拨码 ID:${free.join('、')}`
    : `当前 CAN${canBus} 已无 ${me} 可用的拨码 ID(请改接另一条总线,或先移除一颗电机)`;

  /* 建议改谁:若对方是 3508/2006,优先建议改对方 —— 见函数注释 */
  const otherIsDji3xxx = hit.existing.kind === MotorKind.M3508
    || hit.existing.kind === MotorKind.M2006;
  const meIsDji3xxx = kind === MotorKind.M3508 || kind === MotorKind.M2006;

  let advice;
  if (otherIsDji3xxx && !meIsDji3xxx) {
    /* 我要加的是 6020,占位的是 3508/2006 → 建议改 3508/2006 */
    advice = `请改 ${other}(CAN${canBus} 拨码 ID${hit.existing.motorId})的拨码,`
      + `或把本颗 6020 拨到 5~8(0x209~0x20C 与它们不重叠)`;
  } else if (meIsDji3xxx && !otherIsDji3xxx) {
    advice = `本颗 ${me} 与已是 6020 的 ${other} 冲突。`
      + `6020 与 3508/2006 的 ID 区间只在"相差 4"时重叠,`
      + `请把本颗 ${me} 拨到上面的可用 ID`;
  } else if (meIsDji3xxx && otherIsDji3xxx) {
    /* 3508 与 2006 同 ID —— 这是最容易被忽略的一类 */
    advice = `M3508 与 M2006 的反馈 ID 用同一公式(0x200+ID),`
      + `所以同一个 ID 只能有一个。请把本颗 ${me} 或 ${other} 改成可用 ID`;
  } else {
    advice = `请把本颗 ${me} 拨到上面的可用 ID`;
  }

  return `ID 冲突:${me}(CAN${canBus} ID${motorId})与已添加的 `
    + `${other}(CAN${canBus} ID${hit.existing.motorId})共用反馈 ID ${rx}。`
    + `${advice}。${freeLine}(可用 ID 随型号而变,以本颗型号为准)`;
}

/**
 * 闭环类型,需与固件 Closeloop_Type_e 一致。
 *
 * @attention 【2026-10-13】补上组合值。
 *   此前只有 4 个单环,于是"速度环 + 电流环"这个**最常用的配置**
 *   在上位机根本表达不出来 —— 界面上选不到,协议里也没有对应常量。
 *   而串级叠加是框架的原生能力(close_loop_type 是位掩码),
 *   缺的只是上层入口。
 *
 * @note 位掩码里"有速度位"不代表外层就是速度环:
 *   外层只能有**一个**环,组合值中的速度位表示"速度环被启用"。
 *   SPEED_AND_CURRENT_LOOP(0b0011) 的外层是速度环、电流是内环;
 *   ANGLE_AND_SPEED_LOOP(0b0110) 的外层是位置环、速度是内环。
 *   固件据此决定 rpm 换算,判外层必须精确匹配。
 */
export const LoopType = {
  OPEN_LOOP: 0b0000,
  CURRENT_LOOP: 0b0001,
  SPEED_LOOP: 0b0010,
  ANGLE_LOOP: 0b0100,
  SPEED_AND_CURRENT_LOOP: 0b0011,
  ANGLE_AND_SPEED_LOOP: 0b0110,
  ALL_THREE_LOOP: 0b0111,
};

export const LoopLabel = {
  [LoopType.OPEN_LOOP]: '开环',
  [LoopType.CURRENT_LOOP]: '电流环',
  [LoopType.SPEED_LOOP]: '速度环(单环)',
  [LoopType.ANGLE_LOOP]: '角度环',
  [LoopType.SPEED_AND_CURRENT_LOOP]: '速度+电流环',
  [LoopType.ANGLE_AND_SPEED_LOOP]: '角度+速度环',
  [LoopType.ALL_THREE_LOOP]: '角度+速度+电流环',
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
 * 固件 1.2:每项 kind(1) can_bus(1) motor_id(1) outer_loop(1) rx_id(2, LE)。
 * 兼容旧的 4 字节清单项;旧版不包含 DM 的反馈 ID。
 * @param {Buffer} payload 帧负载
 */
export function parseInventory(payload) {
  if (payload.length < 1) return null;
  const count = payload[0];
  const itemBytes = count && payload.length === 1 + count * 6 ? 6 : 4;
  if (payload.length !== 1 + count * itemBytes) return null;
  const items = [];
  for (let i = 0; i < count; i++) {
    const off = 1 + i * itemBytes;
    items.push({
      kind: payload[off],
      canBus: payload[off + 1],
      motorId: payload[off + 2],
      outerLoop: payload[off + 3],
      ...(itemBytes === 6 ? { rxId: payload.readUInt16LE(off + 4) } : {}),
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
  [MBResult.BAD_PARAM]: '参数无效、超出允许范围或通道未就绪',
  [MBResult.DUPLICATE]:
    '冲突:该总线上已有电机占用同一 ID。' +
    '注意 6020 用 0x204+ID、3508/2006 用 0x200+ID,两者区间重叠,必须分开挂在不同 CAN 总线上',
  [MBResult.NOT_PROVISIONED]: '板端没有这颗电机,请先刷新清单',
  [MBResult.NOT_ENABLED]: '通道未使能',
  [MBResult.UNSUPPORTED]: '当前固件不支持该操作、电机类型或控制环',
  [MBResult.NO_RESOURCE]: '资源不足:该 CAN 总线的滤波器已用完(每条总线最多 14 颗)',
};

/**
 * 构造"创建电机"帧
 *
 * 负载布局(5 字节):kind(1) can_bus(1) motor_id(1) rx_id(2, 小端)
 *
 * @param {number} kind     MotorKind 枚举
 * @param {number} canBus   1=CAN1 2=CAN2
 * @param {number} motorId  DJI 系 = 电调拨码 ID;DM 系 = 发送用 tx_id
 * @param {number} [rxId=0] 反馈 ID(接收用)。
 *   - DM 系:必须传电机实际的反馈 ID(与电调上的拨码/配置一致)
 *   - DJI 系:必须传 0 —— 驱动的 rx_id 由 0x200+id+1 / 0x204+id+1 内部算出,
 *     上位机指定无效
 *
 * @note rx_id 必须占 2 字节,否则 0x302 会被截成 0x02。需配合固件 1.1。
 */
export function buildMotorAdd(kind, canBus, motorId, rxId = 0) {
  if (!Number.isInteger(rxId) || rxId < RX_ID_MIN || rxId > RX_ID_MAX) {
    throw new RangeError('rxId must be an 11-bit CAN identifier');
  }
  const b = Buffer.alloc(5);
  b[0] = kind;
  b[1] = canBus;
  b[2] = motorId;
  b.writeUInt16LE(rxId, 3);
  return buildFrame(FrameType.MOTOR_ADD, b);
}

/**
 * 构造"移除电机"帧
 * 负载布局与创建请求相同(复用同一 5 字节结构)
 * @param rxId 须与添加时一致,否则板端找不到目标
 */
export function buildMotorRemove(kind, canBus, motorId, rxId = 0) {
  if (!Number.isInteger(rxId) || rxId < RX_ID_MIN || rxId > RX_ID_MAX) {
    throw new RangeError('rxId must be an 11-bit CAN identifier');
  }
  const b = Buffer.alloc(5);
  b[0] = kind;
  b[1] = canBus;
  b[2] = motorId;
  b.writeUInt16LE(rxId, 3);
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
 * @attention 【2026-10-13 实测修正】速度环 Kp 由 1 提高到 3 / 2 / 8。
 *
 *   Kp=1 时电机实际**转不起来**。量纲算一下就清楚:
 *     速度环输出 = Kp × 误差(rpm)
 *   裸电机的静摩擦与齿槽转矩要吃掉可观电流。若 Kp=1,
 *   要输出 1000(约相当于 3508 的 6% 电流值)需要 1000rpm 的误差 ——
 *   而电机全速也不过 9000rpm,等于开环都转不动,更别说闭环。
 *
 *   空载台架起点取原实车值的 1/5 ~ 1/7:
 *     M3508  Kp=3  (原 20,摩擦轮)
 *     M2006  Kp=2  (原 10,拨弹盘)
 *     GM6020 Kp=8  (原 50;Ki 由 200 降为 0 —— 先只用比例项判断能否转稳)
 *   Ki 一律 0:先看"能不能转、稳不稳",再由使用者自己加 Ki 消静差。
 *   这三个值只是**能转起来的保守起点**,不是最优,真正整定在网页面板上做。
 *
 * MaxOut 是输出限幅不是增益,仍按型号留足余量:
 *   M3508 约 16000,M2006 约 10000,GM6020 约 30000。
 * 电流环保持 Kp=0.7/Ki=0.1(Ki=0 时速度环输出才不会长期偏离真实电流需求)。
 *
 * @note 放在 protocol.js 而非 ui.js:这是**协议层数据**,不是界面状态。
 *   ui.js 要在页面里显示默认值,selftest.js 要校验与固件一致,
 *   两边都 import 同一份就消除了"页面显示一套、固件生效另一套"的风险。
 */
export const PID_DEFAULTS = {
  // 大疆 M3508 —— Kp=1/0/0 基线(close_loop = SPEED|CURRENT)
  [MotorKind.M3508]: {
    speed: { Kp: 3, Ki: 0, Kd: 0, MaxOut: 15000, IntegralLimit: 10000, improve: 0 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 15000, IntegralLimit: 10000, improve: 0 },
    angle: { Kp: 4, Ki: 0, Kd: 0, MaxOut: 600, IntegralLimit: 0, improve: 1 },
  },
  // 大疆 M2006
  [MotorKind.M2006]: {
    speed: { Kp: 2, Ki: 0, Kd: 0, MaxOut: 5000, IntegralLimit: 5000, improve: 0 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 5000, IntegralLimit: 5000, improve: 0 },
    angle: { Kp: 4, Ki: 0, Kd: 0, MaxOut: 600, IntegralLimit: 0, improve: 1 },
  },
  // 大疆 GM6020
  [MotorKind.GM6020]: {
    speed: { Kp: 8, Ki: 0, Kd: 0, MaxOut: 20000, IntegralLimit: 3000, improve: 5 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 20000, IntegralLimit: 3000, improve: 0 },
    angle: { Kp: 8, Ki: 0, Kd: 0, MaxOut: 500, IntegralLimit: 100, improve: 5 },
  },
  // DM-J4310-2EC V1.1: user-selected 0.55/0/0/7/0 speed defaults.
  [MotorKind.DM]: {
    speed: { Kp: 0.55, Ki: 0, Kd: 0, MaxOut: 7, IntegralLimit: 0, improve: 1 },
    current: { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, improve: 0 },
    angle: { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 2, IntegralLimit: 0, improve: 1 },
  },
  // User-confirmed commissioning ceiling; keep gains gentle, tune for load.
  [MotorKind.DM8009P]: {
    speed: { Kp: 0.05, Ki: 0, Kd: 0, MaxOut: 10, IntegralLimit: 0, improve: 1 },
    current: { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, improve: 0 },
    angle: { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 2, IntegralLimit: 0, improve: 1 },
  },
  /*
   * 岭芯 LK9025 / 海泰 HT04 —— 2026-10-19 接入测试台。
   *
   * @attention 这两组数字是**未经实机验证的保守基线**,目的只是
   *   "能转起来且不立刻振荡",不是整定结论。速度单位都是 rad/s
   *   (与 DM 一致),不是 DJI 的 rpm。真机必须重新整定。
   *
   * @note 与固件 BenchBuildLKConfig/BenchBuildHTConfig 保持一致:
   *   速度环 Kp=0.5/MaxOut=5,电流环 Kp=0.7/Ki=0.1/MaxOut=5,
   *   位置环 Kp=0.1/MaxOut=2。
   */
  [MotorKind.LK]: {
    speed: { Kp: 0.5, Ki: 0, Kd: 0, MaxOut: 5, IntegralLimit: 0, improve: 1 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 5, IntegralLimit: 0, improve: 1 },
    angle: { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 2, IntegralLimit: 0, improve: 1 },
  },
  [MotorKind.HT]: {
    speed: { Kp: 0.5, Ki: 0, Kd: 0, MaxOut: 5, IntegralLimit: 0, improve: 1 },
    current: { Kp: 0.7, Ki: 0.1, Kd: 0, MaxOut: 5, IntegralLimit: 0, improve: 1 },
    angle: { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 2, IntegralLimit: 0, improve: 1 },
  },
};

/**
 * 构造"设置 PID"帧 —— 对单个通道的单个环写入一套参数
 *
 * 负载布局(20 字节):
 *   channel_id(1) loop(1) improve_flags(1) reserved(1)
 *   Kp(2) Ki(2) Kd(2)              u16 LE 定点 x100
 *   MaxOut(4) IntegralLimit(4)     s32 LE，reserved bit0=1 时按 x1000 编码
 *   tail_pad(2)
 *
 * @param {number} channelId 通道号
 * @param {number} loop       PidLoop 枚举
 * @param {{Kp:number,Ki:number,Kd:number,MaxOut:number,IntegralLimit:number,improve?:number,scaledLimits?:boolean}} pid
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
  const limitScale = pid.scaledLimits ? 1000 : 1;
  b[3] = pid.scaledLimits ? 1 : 0;
  b.writeUInt16LE(Math.round((pid.Kp ?? 0) * 100), 4);
  b.writeUInt16LE(Math.round((pid.Ki ?? 0) * 100), 6);
  b.writeUInt16LE(Math.round((pid.Kd ?? 0) * 100), 8);
  b.writeInt32LE(Math.round((pid.MaxOut ?? 0) * limitScale), 10);
  b.writeInt32LE(Math.round((pid.IntegralLimit ?? 0) * limitScale), 14);
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
  const limitScale = (payload[2] & 1) ? 1000 : 1;
  const q32 = (arr, li) => payload.readInt32LE(22 + arr * 12 + li * 4) / limitScale;
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

export function buildSetLoop(channelId, mask) {
  return buildFrame(FrameType.LOOP_SET, Buffer.from([channelId, mask]));
}

export function parseLoopSetAck(payload) {
  if (payload.length < 3) return null;
  return { channelId: payload[0], mask: payload[1], result: payload[2] };
}

/* ---------------- 上报帧构造(用于自测与上位机模拟) ---------------- */

/**
 * 组装心跳应答帧
 *
 * @note 与固件 MB_HeartbeatAck_s 一致的统一格式:
 *         head type len body(len) crc tail
 *       body = fw_major fw_minor inventory flags uptime(2) seq(2) = 8 字节
 *
 * @param {{fwMajor?:number,fwMinor?:number,inventory?:number,flags?:number,uptime?:number,seq?:number}} f
 * @returns {Buffer}
 */
export function buildHeartbeatAck(f = {}) {
  const body = Buffer.alloc(8);
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
 * 布局:head(1) type(1) len(1) body(8) crc(1) tail(1)
 *       body = fw_major fw_minor inventory flags uptime(2) seq(2)
 * @param {Buffer} payload 帧负载(由 FrameParser 给出)
 */
export function parseHeartbeatAck(payload) {
  if (payload.length < 8) return null;
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
