/**
 * ui.js —— 浏览器端界面逻辑
 *
 * 通过 WebSocket 与 server.js 通信:
 *   下行: hello / ports / serial / heartbeat / telemetry / error
 *   上行: listPorts / openSerial / closeSerial / bind / setRef / enable / stopAll / query
 */
import {
  MotorKindLabel,
  MotorKind,
  MBResult,
  MBResultText,
  PID_DEFAULTS,
  availableIds,
  describeConflict,
  findConflict,
  usesDjiIdSegment,
  MOTOR_ID_MIN,
  MOTOR_ID_MAX,
  LoopType,
} from './protocol.js';
import { ensureChart, getChartIfExists, dropChart } from './chart.js';
import { LoopFishbone } from './fishbone.js';

/**
 * 当前渲染的通道卡片数
 *
 * @note 早期是常量 4,导致板上只有 1 颗电机时页面上仍有 3 张空卡片
 *       (未绑定、读数全是 --),既占地方又容易被误认为功能异常。
 *       现在改为跟随板端清单动态调整,由 buildChannels(count) 赋值。
 */
let CHANNEL_COUNT = 1;

/** 各电机种类的参考值限幅与单位(与固件 MB_REF_LIMIT_* 及驱动量程对应) */
const MOTOR_SPEC = {
  [MotorKindLabel[1]]: { unit: 'rpm', range: 6000 }, // GM6020
  [MotorKindLabel[2]]: { unit: 'rpm', range: 6000 }, // M3508
  [MotorKindLabel[3]]: { unit: 'rpm', range: 7000 }, // M2006
  [MotorKindLabel[4]]: { unit: 'rad/s', range: 40 }, // DM
  [MotorKindLabel[5]]: { unit: 'rad/s', range: 40 }, // LK
  [MotorKindLabel[6]]: { unit: 'rad/s', range: 40 }, // HT
};

/** PID 面板每通道的当前环(用于收到 PID 报表时知道该往哪个输入框填) */
const pidStateByChannel = new Map(); // ch -> {loop, kind}

const $ = (sel) => document.querySelector(sel);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const ws = new WebSocket(wsUrl);

/** 板端上报的电机清单(来自心跳应答的 inventoryCount,随后由遥测确认) */
let inventory = [];
const telemetryByChannel = new Map();

/** 在"添加电机"面板上显示一行结果提示 */
function showAddMsg(text, isError) {
  const el = $('#addMsg');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

/**
 * 添加电机面板的实时预检 —— 在"添加"面板上给出冲突说明与可用 ID
 *
 * 放在模块作用域(bindEvents 之外)是为了让 ws.onmessage 里的清单刷新
 * 也能调它:清单一变,"可用 ID"就要重算,否则提示会停留在一个过期列表上,
 * 用户照着填反而必撞。
 *
 * @note 三个输入项与清单变化都会调它,所以函数体必须**幂等且无副作用** ——
 *   它只读当前 DOM 值 + inventory,然后写一行提示。
 */
function refreshAddHint() {
  const kindEl = $('#addKind');
  const busEl = $('#addBus');
  const idEl = $('#addId');
  if (!kindEl || !busEl || !idEl) return;

  const kind = Number(kindEl.value);
  const canBus = Number(busEl.value);
  const motorId = Number(idEl.value);

  if (!Number.isInteger(motorId) || motorId < MOTOR_ID_MIN || motorId > MOTOR_ID_MAX) {
    showAddMsg(`ID 需填 ${MOTOR_ID_MIN}~${MOTOR_ID_MAX} 的整数`, true);
    return;
  }

  /* 冲突优先:直接给出"和谁撞、该改谁、能用哪些" */
  const conflictMsg = describeConflict(canBus, inventory, kind, motorId);
  if (conflictMsg) {
    showAddMsg(conflictMsg, true);
    return;
  }

  /*
   * 无冲突时,若该总线上已有占用 ID 的电机,顺带列出可用 ID ——
   * 用户接下来多半要接着加第二、第三颗,提前给候选省得反复试错。
   * 该总线还是空的就不显示,避免多余的噪音。
   */
  if (usesDjiIdSegment(kind) && inventory.some((m) => m && m.canBus === canBus)) {
    const free = availableIds(canBus, inventory, kind);
    showAddMsg(`CAN${canBus} 当前可用 ID:${free.length ? free.join('、') : '(无)'}`, false);
  } else {
    showAddMsg('', false);
  }
}

/** 添加/移除的待应答计时器:超时则提示"没收到板子应答",避免永久卡住 */
let addPendingTimer = null;
let addPendingLabel = '添加电机';

/* ---------------- 建卡片 ---------------- */

/**
 * 按板上实际电机数量生成通道卡片
 *
 * @note 早期固定生成 4 张卡片,导致板上只有 1 颗电机时,
 *   另外 3 张全是空卡片(未绑定、全是 --),既占地方又让人误以为功能异常。
 *
 * @attention 【重要·2026-10-12 修复】卡片数曾跟随"电机数"变化,
 *   导致三个实测故障:
 *     1. 添加第二颗电机后,通道 0 的电机下拉选择被清空(要重新选),
 *        但通道 0 控制的其实还是原来那颗;
 *     2. 设好的 rpm 值自动归零;
 *     3. 先 6020 后 3508 时,两个通道被一起清空,且之后无法二次绑定。
 *   根因是 buildChannels() 里那行 `host.innerHTML = ''` ——
 *   它把**所有**卡片连同已选下拉值、rpm 滑块值一起销毁。
 *   而触发重建的条件 `CHANNEL_COUNT !== inventory.length`
 *   本身就建立在错误假设上:"电机数 == 通道数"。
 *   实际上通道是独立的控制位(最多 MB_CHANNEL_MAX = 8),
 *   一颗电机绑到哪个通道都行,与电机总数无关。
 *
 *   正确做法:卡片数**只增不减**,且只在"用户明显需要更多通道"时增长
 *   (即电机数超过当前卡片数),增长时**保留既有卡片的全部状态**。
 *   这样加电机不会碰已有通道的任何界面状态。
 */
function buildChannels(count = null) {
  const host = $('#channels');
  const tpl = $('#channelTpl');

  /*
   * 只增不减:目标数量取"当前已有"与"新请求"的较大者。
   * @note 传 null 表示"按现有电机数补足",但绝不缩回 ——
   *       删掉一张用户正在用的卡片,等于凭空丢失该通道的绑定与参数。
   */
  const want = Number.isInteger(count) && count > 0 ? count : 0;
  const have = host.querySelectorAll('.channel').length;
  const n = Math.max(have, want, 1);

  if (have === n) {
    CHANNEL_COUNT = n;
    return; /* 数量没变,不要碰 DOM —— 碰了就会丢用户已填的状态 */
  }

  for (let i = have; i < n; i++) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.ch = String(i);
    node.querySelector('.ch-title').textContent = `通道 ${i}`;
    host.appendChild(node);
  }
  CHANNEL_COUNT = n;

  /*
   * @attention 只给**新增**的卡片绑事件,不要重新绑定全部。
   *   bindEvents() 内部是 `for (let i = 0; i < CHANNEL_COUNT; i++)`,
   *   会把已有卡片的 onclick 也重写一遍。
   *   用 onclick 赋值(而非 addEventListener)所以不会叠加,
   *   但重写时闭包捕获的 i 若与实际通道不一致,就会出现"点通道1发的是通道0"。
   */
  bindEvents();
}

function ch(i) {
  return document.querySelector(`.channel[data-ch="${i}"]`);
}

/* ---------------- 指令发送 ---------------- */

function send(obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  else alert('与服务端未建立连接');
}

/* ---------------- 渲染 ---------------- */

function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return v.toFixed(digits);
}

function renderChannel(i) {
  const el = ch(i);
  if (!el) return;
  const t = telemetryByChannel.get(i);

  const badge = el.querySelector('[data-role="status"]');
  if (!t) {
    badge.textContent = '未绑定';
    badge.className = 'badge';
  } else if (!t.online) {
    badge.textContent = '离线';
    badge.className = 'badge offline';
  } else if (t.enabled) {
    badge.textContent = '运行中';
    badge.className = 'badge running';
  } else {
    badge.textContent = '已绑定';
    badge.className = 'badge bound';
  }

  const r = (role) => el.querySelector(`[data-role="${role}"]`);

  /*
   * 数字读数行已于 2026-10-13 移除 —— 曲线已呈现这些量的走势,
   * 数字在波动大的场合反而干扰判读(用户明确要求)。
   * 温度是慢变量,不具备"看趋势"的必要,仍以数字显示。
   *
   * @attention 其余读数(设定/转速/电流/角度)的元素**已从模板删除**,
   *   这里绝不能再 querySelector 后直接赋值 —— 会拿到 null 而抛异常,
   *   把整个渲染打断(表现为整张卡片不再更新)。温度是唯一保留项。
   */
  const tempEl = r('temp');
  if (tempEl) {
    tempEl.textContent = t && t.temperature !== -128 ? `${t.temperature} °C` : '--';
  }

  const enableBtn = r('enable');
  enableBtn.classList.toggle('on', !!(t && t.enabled));
  enableBtn.textContent = t && t.enabled ? '停机' : '使能';

  /*
   * 把本次遥测喂给曲线(2026-10-12 新增)。
   *
   * 为什么在 renderChannel 里 push 而不是单独开定时器:
   *   采样频率天然与遥测到达一致(固件约 10Hz),不需要额外轮询,
   *   也不会画出板端根本没上报的假点。
   *
   * 曲线放在 renderChannel 末尾而非仅在 telemetry 事件里,
   *   是因为 renderChannel 还会在解绑、断连时以 t=null 被调用,
   *   此时不喂点、只重绘,曲线会自然停住而不是被 0 值拉一条直线到底。
   */
  if (t) {
    const canvas = el.querySelector('[data-role="chart"]');
    if (canvas) {
      const c = ensureChart(i, canvas);
      /*
       * 把界面上的滤波设置同步到实例。
       *
       * @attention 必须在这里同步,不能只在 onchange 里设:
       *   曲线实例是**懒创建**的 —— 用户在通道还没收到遥测时改了滤波档位,
       *   那一刻 getChartIfExists 返回 null,设置被静默丢弃;
       *   等实例真正建出来时就会用默认值,与界面显示不一致。
       *   每次 push 前对齐一次,代价可忽略(几个比较),却消除了这类漂移。
       */
      const fOn = r('filterOn');
      const fAlpha = r('filterAlpha');
      if (fOn) c.setFilter(fOn.checked);
      if (fAlpha) c.setFilterAlpha(fAlpha.value);

      c.push(t.speed, t.torque, t.ref);
    }
  }
}

/* ---------------- 闭环鱼骨图 ---------------- */

/**
 * 鱼骨图实例表:通道号 → LoopFishbone
 *
 * @note 懒创建:只有真正渲染过的通道才建实例。
 *   鱼骨图只在 bind 时需要它的掩码,建了不用会白占 DOM 与事件。
 */
const fishbones = new Map();

/**
 * 取出(必要时创建)某通道的鱼骨图
 *
 * @param {number} i 通道号
 * @returns {LoopFishbone|null}
 */
function ensureFishbone(i) {
  if (fishbones.has(i)) return fishbones.get(i);
  const host = ch(i)?.querySelector('[data-role="loopPicker"]');
  if (!host) return null;

  const fb = new LoopFishbone(host);

  /*
   * 悬停/聚焦/点击某个环 → 把下方 PID 卡片切到该环。
   *
   * @note 只切环,不管开合 —— 卡片是内嵌常驻的,不需要显示/隐藏逻辑。
   *   曾经做成浮空(延时开合),在多层嵌套的卡片里定位失控,已回退。
   */
  fb.onFocusLoop = (bit) => focusPidLoop(i, bit);

  fishbones.set(i, fb);
  return fb;
}

/** 移除某通道的鱼骨图(卡片被销毁时调用) */
function dropFishbone(i) {
  fishbones.delete(i);
}

/**
 * 读取某通道当前的闭环掩码
 *
 * @attention 两条约束由 fishbone.js 的 _toggle **联动代码**保证,这里不需要再补齐:
 *   1. 点亮位置环必然同时点亮速度环(关速度会连带关位置);
 *   2. 外层环 = 掩码中最高位的亮节点(按**位值**得出,与节点排列无关)。
 *   2026-10-14 位置环与电流环对调后,主脊只表示"由内到外"的层级、
 *   不再表示信号方向,所以约束**只剩代码这一道保障** ——
 *   不要以为"图上已经保证了"就把 _toggle 的联动删掉。
 *
 * @param {number} i 通道号
 * @returns {number} 位掩码,与固件 Closeloop_Type_e 一致
 */
function readLoopMask(i) {
  const fb = fishbones.get(i);
  if (fb) return fb.getMask();
  /* 鱼骨图还没建(通道未渲染过)时,退回默认值 —— 与固件建电机配置一致 */
  return LoopType.SPEED_AND_CURRENT_LOOP;
}

/*
 * 闭环位 → PID 环选择器下标的映射。
 *
 * @attention 位掩码与 pidLoop 的 <option value> 是两套编号,必须显式对应:
 *   <option value="0">速度环 / "1">电流环 / "2">位置环
 *   而位掩码里 电流=0b0001、速度=0b0010、位置=0b0100。
 *   不映射的话,"点亮位置环"会打开速度环的参数 —— 调错环且毫无提示。
 */
const BIT_TO_PID_LOOP = {
  0b0010: '0', // 速度环
  0b0001: '1', // 电流环
  0b0100: '2', // 位置环
};

/**
 * 把 PID 卡片切到指定环(不负责显示/隐藏 —— 卡片是内嵌常驻的)
 *
 * @param {number} i 通道号
 * @param {number} bit 关注的闭环位
 *
 * @note 之前这里还要管浮空卡片的开合与延时关闭,现在卡片常驻,
 *   只剩"切环 + 填默认值"这一件事,逻辑干净很多。
 */
function focusPidLoop(i, bit) {
  const el = ch(i);
  if (!el) return;

  const loopVal = BIT_TO_PID_LOOP[bit];
  const sel = el.querySelector('[data-role="pidLoop"]');
  if (loopVal === undefined || !sel) return;

  sel.value = loopVal;
  /* 切环后把该环的默认值填进输入框 */
  fillPidForm(i, loopVal);

  /* 标题写明当前是哪个环,避免"调了半天不知道在调哪个" */
  const title = el.querySelector('[data-role="pidTitle"]');
  if (title) {
    const name = { 0b0100: '位置环', 0b0010: '速度环', 0b0001: '电流环' }[bit];
    title.textContent = name ? `${name} PID` : 'PID 整定';
  }
}

/* ---------------- 电机下拉(固件清单) ---------------- */

/**
 * 填充可绑定电机列表。
 * @note 固件登记了几颗电机,上位机就只能选这几颗 —— 这是刻意的设计,
 *       避免上位机下发固件里根本不存在的电机配置。
 */
function fillMotorOptions() {
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const el = ch(i);
    if (!el) continue; // 卡片数量可能刚被重建过,跳过已不存在的卡片
    const sel = el.querySelector('[data-role="motor"]');

    /*
     * 【重要·2026-10-12 修复】记住当前选中的是哪颗电机,重建选项后恢复。
     *
     * 原实现无条件 innerHTML = '' 重建,每次清单刷新都把下拉值打回 ""
     * (空 = 未选择)。实测后果:
     *   - 添加第二颗电机后通道 0 的选择消失、要重新选一遍,
     *     可通道 0 控制的其实还是原来那颗电机(用户以为绑定丢了);
     *   - 两个通道会一起被清空,且之后无法二次绑定。
     *
     * 用 (kind, canBus, motorId) 三元组而非下标记忆:
     * 下标会随电机增删而漂移,不可靠。
     */
    let prevKey = null;
    const prevIdx = Number(sel.value);
    if (sel.value !== '' && Number.isInteger(prevIdx) && inventory[prevIdx]) {
      const p = inventory[prevIdx];
      prevKey = `${p.kind}:${p.canBus}:${p.motorId}`;
    }

    sel.innerHTML = '<option value="">选择电机…</option>';
    let restoredIdx = '';
    inventory.forEach((m, idx) => {
      const label = `${m.label} · CAN${m.canBus}·ID${m.motorId}`;
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = label;
      sel.appendChild(opt);
      if (prevKey && `${m.kind}:${m.canBus}:${m.motorId}` === prevKey) {
        restoredIdx = String(idx);
      }
    });

    /* 电机仍在清单里才恢复选中;被删了才回到未选择 */
    sel.value = restoredIdx;

    sel.onchange = () => {
      const m = inventory[Number(sel.value)];
      const spec = m ? MOTOR_SPEC[m.label] : null;
      // 注意:这里复用外层的 el,不要用 const el 重新声明 ——
      // 那会遮蔽外层变量,虽然当前逻辑上取值相同,但极易在后续改动中出错。
      if (spec && el) {
        el.querySelector('[data-role="unit"]').textContent = spec.unit;
        el.querySelector('[data-role="slider"]').min = String(-spec.range);
        el.querySelector('[data-role="slider"]').max = String(spec.range);
      }
    };
  }
}

/* ---------------- PID 整定辅助 ---------------- */

/**
 * 取某通道当前绑定电机的 kind(未绑定返回 0)
 */
function currentChannelKind(i) {
  const el = ch(i);
  if (!el) return 0;
  const idx = Number(el.querySelector('[data-role="motor"]').value);
  const m = inventory[idx];
  return m ? m.kind : 0;
}

/**
 * 把某 kind + 某环的 PID 填入输入框
 * @param i           通道号
 * @param loopStr     环选择器的值('0'速度 '1'电流 '2'位置)
 * @param kindOverride 可选,指定 kind(默认取该通道绑定的电机)
 */
function fillPidForm(i, loopStr, kindOverride) {
  const el = ch(i);
  if (!el) return;
  const kind = kindOverride || currentChannelKind(i);
  const r = (role) => el.querySelector(`[data-role="${role}"]`);

  const preset = PID_DEFAULTS[kind];
  const loopName = ['speed', 'current', 'angle'][Number(loopStr)] || 'speed';
  const p = preset ? preset[loopName] : null;

  r('pKp').value = p ? p.Kp : 0;
  r('pKi').value = p ? p.Ki : 0;
  r('pKd').value = p ? p.Kd : 0;
  r('pMaxOut').value = p ? p.MaxOut : 0;
  r('pIntLim').value = p ? p.IntegralLimit : 0;

  // 记录当前环,便于收到 PID 报表时知道该往哪个输入框填
  pidStateByChannel.set(i, { loop: Number(loopStr), kind });
}

/**
 * 根据"该通道是否已绑定电机"启用/禁用 PID 面板
 *
 * @note 面板**始终可见**,只切换 disabled。
 *   之前用 hidden 完全隐藏,实测用户找不到这个功能 ——
 *   而"不用重烧固件就能改 PID"正是本测试台的核心卖点之一,入口藏起来等于没做。
 *   现在未绑定时灰显并提示"先绑定电机后可用",绑定后自动可用。
 *
 * @attention 必须在 fillMotorOptions() 之后调用,
 *   否则 currentChannelKind() 拿不到电机下拉框的实际值,会误判为"未绑定"。
 */
function initPidPanel(i) {
  const el = ch(i);
  if (!el) return;

  const kind = currentChannelKind(i);
  const panel = el.querySelector('[data-role="pidPanel"]');
  const msg = el.querySelector('[data-role="pidMsg"]');

  /* 需要联动开关的控件:输入框、环选择器、两个下发/读回按钮。
     收起按钮保持可用 —— 未绑定时也能折叠面板。 */
  const ctrls = [
    'pidLoop', 'pKp', 'pKi', 'pKd', 'pMaxOut', 'pIntLim',
    'pidApply', 'pidQuery', 'pidReset',
  ].map((role) => el.querySelector(`[data-role="${role}"]`));

  for (const c of ctrls) {
    if (c) c.disabled = !kind;
  }

  if (kind) {
    /* 绑定后:填入该型号默认值,并清掉"先绑定"提示。
       improve 不从页面暴露(属于协议细节),沿用默认表里的值。 */
    fillPidForm(i, el.querySelector('[data-role="pidLoop"]').value, kind);
    if (msg && !msg.textContent.trim()) msg.textContent = '';
  } else {
    if (msg) {
      msg.className = 'hint';
      msg.textContent = '先绑定电机后可用';
    }
    pidStateByChannel.delete(i);
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#refreshPorts').onclick = () => send({ type: 'listPorts' });
  $('#openPort').onclick = () => {
    const path = $('#portSelect').value;
    if (!path) return alert('请先选择串口');
    send({ type: 'openSerial', path, baud: 115200 });
  };
  $('#closePort').onclick = () => send({ type: 'closeSerial' });
  $('#rescan').onclick = () => {
    inventory.length = 0; // 清掉旧清单,强制重新拉取
    startInventoryFetch();
  };
  $('#addMotor').onclick = () => {
    const kind = Number($('#addKind').value);
    const canBus = Number($('#addBus').value);
    const motorId = Number($('#addId').value);

    if (!Number.isInteger(motorId) || motorId < MOTOR_ID_MIN || motorId > MOTOR_ID_MAX) {
      showAddMsg(`ID 需填 ${MOTOR_ID_MIN}~${MOTOR_ID_MAX} 的整数(对应电调拨码开关)`, true);
      return;
    }

    /*
     * 本地预检(2026-10-13 新增)。
     *
     * @attention 为什么要在界面再挡一道:
     *   固件已经有 MotorBenchCheckRxIdFree(),会拒绝冲突配置 —— 但那要
     *   一个来回到板子才知道结果,而且提示只出现在 RTT 里(网页上只有一句
     *   错误码文案)。用户真正需要的是**当场知道该把拨码改成几**。
     *   所以这里用同一套公式先算一遍,直接给出可用 ID 列表。
     *
     *   固件那道检查仍然保留 —— 界面可能因为清单还没刷新而与板端不一致,
     *   固件才是最终权威。
     */
    const conflictMsg = describeConflict(canBus, inventory, kind, motorId);
    if (conflictMsg) {
      showAddMsg(conflictMsg, true);
      return; /* 不发给板子 —— 明知会失败,不必浪费一次往返 */
    }

    showAddMsg('正在添加…', false);
    addPendingLabel = '添加电机';
    send({ type: 'addMotor', kind, canBus, motorId });

    /*
     * 超时兜底:若板子没回应答帧,不能一直卡在"正在添加…"。
     * 早期版本没这个兜底,一旦板端因任何原因(门闩拒绝、解析失败、
     * 固件版本旧)不回 0x8A,界面就永久停在"正在添加…",
     * 让人完全无从判断是板子没收到还是收到了没回。
     */
    if (addPendingTimer) clearTimeout(addPendingTimer);
    addPendingTimer = setTimeout(() => {
      showAddMsg(
        `${addPendingLabel} 3 秒内没有收到板子应答。` +
          '可能原因:固件版本较旧不支持动态添加 / USB 帧未送达。' +
          '请查看 RTT 是否有 [add] 日志。',
        true,
      );
    }, 3000);
  };
  /*
   * 急停:**单击立即下发,不得有二次确认**(2026-10-14 用户要求)。
   *
   * @attention 这里原本是 `if (confirm('确定要立即停止全部电机吗?'))` ——
   *   弹窗式确认与急停语义直接冲突:
   *     1. 急停是**时间敏感**动作,弹窗多一步点击就是多一份危险;
   *     2. 浏览器原生 confirm 会**阻塞主线程**,期间页面卡死、
   *        后面的遥测渲染与状态刷新全部停摆,恰恰在最需要看状态的时候瞎掉。
   *
   *   反向思考:误触急停的代价只是"电机停了",再使能即可;
   *   而急停迟钝的代价是设备或人身伤害。两者不对等,所以不该给急停加确认。
   *
   * @note 这里不需要额外兜底:若 WebSocket 未连通,本函数静默不发,
   *   而此时 A 板已因约 1 秒收不到心跳**自行全停**了 ——
   *   链路断了电机本来就是停的,不存在"点了没反应所以电机还在转"的情况。
   */
  $('#estop').onclick = () => send({ type: 'stopAll' });

  /*
   * 添加电机三个输入项的实时预检(2026-10-13 新增)。
   *
   * 不等用户点「添加」再报错 —— 选完型号/总线/ID 的当下就把结果摆出来:
   *   - 冲突 → 红字说明和谁撞、该改谁、以及当前可用 ID
   *   - 无冲突 → 列出该总线当前可用 ID,方便接着加下一颗
   *
   * @attention 用 `oninput` / `onchange` 赋值,**不能用 addEventListener**。
   *   bindEvents() 会在卡片增补时被反复调用,addEventListener 会把同一个
   *   处理函数叠加多次 —— 拖一次数字框就触发 N 次预检,将来若有副作用
   *   就是难查的重复执行。onXxx 赋值天然幂等(覆盖旧的)。
   *
   * @note 同时监听 input 与 change:数字框键盘输入触发 input,
   *   上下箭头/失焦提交在某些浏览器只触发 change。
   */
  for (const id of ['#addKind', '#addBus', '#addId']) {
    $(id).oninput = refreshAddHint;
    $(id).onchange = refreshAddHint;
  }

  // 页面关闭前尽量通知服务端全停(beforeunload + sendBeacon 兜底)
  window.addEventListener('beforeunload', () => send({ type: 'stopAll' }));

  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const el = ch(i);
    const r = (role) => el.querySelector(`[data-role="${role}"]`);

    r('bind').onclick = () => {
      const idx = Number(r('motor').value);
      const m = inventory[idx];
      if (!m) return alert('请先选择电机');

      /*
       * 从鱼骨图读取闭环掩码。
       *
       * @attention 两条约束由 fishbone.js 的 _toggle 联动代码保证,无需额外补齐:
       *   1. 点亮位置环必然同时点亮速度环(关速度会连带关位置);
       *   2. 外层环 = 掩码中最高位的亮节点(按位值,与节点排列无关)。
       *   (2026-10-14 位置环与电流环对调后,主脊不再表示信号方向,
       *    约束不再由节点位置保证 —— 见 fishbone.js 的 _toggle 注释。)
       */
      const mask = readLoopMask(i);
      send({
        type: 'bind',
        channelId: i,
        kind: m.kind,
        canBus: m.canBus,
        motorId: m.motorId,
        outerLoop: mask,
      });
      // 绑定的同时把该型号的默认 PID 填进面板,用户点"应用"即可生效
      initPidPanel(i);
    };

    /*
     * @attention 换选电机后必须刷新 PID 面板。
     *   currentChannelKind() 读的是下拉框当前值,而 PID 默认值按型号不同
     *   (M3508 Kp=20 / M2006 Kp=10 / 6020 Kp=50)。不跟着换,
     *   会出现"下拉框选了 M2006,面板里却还摆着 M3508 的参数"。
     */
    r('motor').onchange = () => initPidPanel(i);

    /* 建鱼骨图(懒创建,只在通道真正渲染时才建实例) */
    ensureFishbone(i);

    /*
     * 【重要·2026-10-12 修复】"解绑"必须下发真正的解绑帧,
     * 原来只发 `enable: false` —— 那是"停机",不是"解绑"。
     *
     * 后果(实测):电机停了,但固件侧 mb_channels[ch].is_used 仍为 1、
     * motor_ptr 仍指着原来那颗电机。用户接着把该通道改绑成另一颗,
     * MotorBenchBind 撞上 is_used 判定直接返回 MB_ERR_DUPLICATE,
     * 绑定被**静默拒绝**;而界面已把本地状态清掉、显示"未绑定"。
     * 表现:换完电机后所有通道都不再响应,且没有任何错误提示。
     *
     * 现在:
     *   1. 先下发 enable=0 保证立刻停机(安全优先,不依赖下一帧)
     *   2. 再下发 unbind 帧释放固件侧的通道占用
     *   3. 收到 unbindAck 后才刷新界面 —— 不再"先斩后奏"
     */
    r('unbind').onclick = () => {
      if (!confirm('解绑后该通道将不再控制任何电机,需重新绑定。确认继续?')) return;
      /* 先停机:安全动作不依赖解绑帧是否被接受 */
      send({ type: 'enable', channelId: i, enable: false });
      send({ type: 'unbind', channelId: i });
      /* 界面状态等 unbindAck 到达后再清,见 ws.onmessage 的 'unbindAck' */
    };

    const slider = r('slider');
    const num = r('num');
    slider.oninput = () => {
      num.value = slider.value;
    };
    // 松手时才下发,避免拖动时刷屏
    slider.onchange = () => send({ type: 'setRef', channelId: i, ref: Number(slider.value) });
    num.onchange = () => {
      slider.value = num.value;
      send({ type: 'setRef', channelId: i, ref: Number(num.value) });
    };

    r('enable').onclick = () => {
      const t = telemetryByChannel.get(i);
      const enable = !(t && t.enabled);
      if (enable && Number(num.value) !== 0) {
        if (!confirm('该通道当前设定值不为 0,使能后电机会立即转动。确认继续?')) return;
      }
      send({ type: 'enable', channelId: i, enable });
    };

    r('zero').onclick = () => {
      slider.value = '0';
      num.value = '0';
      send({ type: 'setRef', channelId: i, ref: 0 });
    };

    /* ---------------- 实时曲线 ---------------- */
    /*
     * 这里**不能**提前 new 曲线实例。
     * 卡片是懒渲染的:某通道还没收到过遥测时 canvas 宽度为 0,
     * 此时 ResizeObserver 量到 0 尺寸、后续不会自动纠正(只在真实 resize 时触发)。
     * 所以实例交给 renderChannel 在首次有数据时创建,尺寸一定是对的。
     */
    r('chartWindow').onchange = () => {
      const c = getChartIfExists(i);
      if (c) c.setWindow(r('chartWindow').value);
    };
    r('chartClear').onclick = () => {
      const c = getChartIfExists(i);
      if (c) c.clear();
    };

    /*
     * 滤波开关与强度(2026-10-13 用户要求:电流和转速波动太大)。
     *
     * @note 开关默认开启。台架上看的是趋势而非每个采样点的毛刺。
     *   但**保留关闭选项**是有意为之:低通只能压传感器噪声,
     *   压不住 PID 引起的低频震荡 —— 所以"开着还抖"就是控制问题,
     *   "关掉才抖"才是噪声问题。这个开关因此也是诊断工具。
     *
     * @attention 与曲线实例一样用 getChartIfExists:
     *   通道还没收到过遥测时,这两个控件操作应是静默无操作,
     *   不能顺手创建一个尺寸为 0 的实例。
     */
    r('filterOn').onchange = () => {
      const c = getChartIfExists(i);
      if (c) c.setFilter(r('filterOn').checked);
    };
    r('filterAlpha').onchange = () => {
      const c = getChartIfExists(i);
      if (c) c.setFilterAlpha(r('filterAlpha').value);
    };

    /* ---------------- PID 整定 ---------------- */
    const pidLoop = r('pidLoop');
    const pidPanel = r('pidPanel');
    const pidMsg = r('pidMsg');

    // 切环时刷新输入框为上一环 / 该型号默认值
    pidLoop.onchange = () => {
      fillPidForm(i, pidLoop.value);
      pidMsg.textContent = '';
    };

    /*
     * 卡片已改为内嵌常驻,不再有"关闭"按钮 —— 显示即展开,无需折叠态。
     * 切换要调的环:点鱼骨图节点,或用上面的 pidLoop 下拉。
     */

    r('pidReset').onclick = () => {
      const kind = currentChannelKind(i);
      fillPidForm(i, pidLoop.value, kind);
      pidMsg.className = 'hint';
      pidMsg.textContent = kind ? '已填入该型号默认值,点"应用到电机"下发' : '请先绑定电机';
    };

    r('pidQuery').onclick = () => {
      send({ type: 'pidQuery', channelId: i });
      pidMsg.className = 'hint';
      pidMsg.textContent = '正在读取板端参数…';
    };

    r('pidApply').onclick = () => {
      const kind = currentChannelKind(i);
      if (!kind) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = '请先绑定电机';
        return;
      }
      const Kp = Number(r('pKp').value) || 0;
      const Ki = Number(r('pKi').value) || 0;
      const Kd = Number(r('pKd').value) || 0;
      const MaxOut = Number(r('pMaxOut').value) || 0;
      const IntegralLimit = Number(r('pIntLim').value) || 0;
      if (Kp < 0 || Ki < 0 || Kd < 0) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = 'Kp/Ki/Kd 不能为负';
        return;
      }
      send({ type: 'pidSet', channelId: i, loop: Number(pidLoop.value), pid: { Kp, Ki, Kd, MaxOut, IntegralLimit } });
    };
  }
}

/* ---------------- WebSocket ---------------- */

ws.onopen = () => {
  setLink(true, '服务已连接');
  send({ type: 'listPorts' });
};

ws.onclose = () => {
  setLink(false, '服务已断开');
};

/**
 * 拉取板端电机清单
 *
 * @note 为什么要重试而不是只在打开串口时问一次:
 *   串口"打开"只代表主机端句柄就绪,A 板可能还没完成 USB 枚举与协议栈启动,
 *   此时发过去的询问帧会被丢掉。若只问一次,下拉框就会一直是空的,
 *   且没有任何提示 —— 很难判断是"板子没这电机"还是"没问上"。
 *   这里在收到心跳(确认板子在跑)后继续补问,拿到清单即停。
 */
let inventoryTimer = null;
let inventoryTries = 0;

function startInventoryFetch() {
  /*
   * 【2026-10-12 修复】原实现 `if (inventoryTimer) return` 有竞态:
   *   motorAck 到达时会 `inventory.length = 0` 再调 startInventoryFetch(),
   *   而此时上一次 startInventoryFetch() 的定时器可能仍在跑
   *   (它每 170ms 才检查一次 inventory.length,还没轮到就收到了 ack)。
   *   于是新调用被 `if (inventoryTimer) return` 直接丢弃,
   *   而旧定时器随后可能因为 tries 超限自行退出 ——
   *   结果:清单永远不再刷新,用户表现为"两个通道被清空后无法二次绑定"。
   *
   * 改为:重入时**先清掉旧定时器再开新的**,保证任何时刻只有一个拉取循环,
   * 且最后一次调用总是生效。
   */
  if (inventoryTimer) {
    clearInterval(inventoryTimer);
    inventoryTimer = null;
  }
  inventoryTries = 0;
  inventoryTimer = setInterval(() => {
    if (inventory.length) {
      clearInterval(inventoryTimer);
      inventoryTimer = null;
      return;
    }
    send({ type: 'scanMotors' });
    if (++inventoryTries > 20) {
      /*
       * 约 3.4 秒仍未拿到清单。
       * @attention 不要再报"未收到电机清单" —— 清空预置电机后,
       *   清单为空本来就是正常状态(用户还没添加任何电机),
       *   报成故障会让用户以为板子出了问题,徒增困惑。
       *   此处只提示"可开始添加电机"这一正常引导。
       */
      clearInterval(inventoryTimer);
      inventoryTimer = null;
      showAddMsg('连接正常。当前板上还没有电机,请在下方「添加电机」里按实际电调 ID 添加。', false);
    }
  }, 170);
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);

  switch (msg.type) {
    case 'ports': {
      const sel = $('#portSelect');
      sel.innerHTML = '';
      if (!msg.ports.length) {
        sel.innerHTML = '<option value="">未发现串口</option>';
        return;
      }
      for (const p of msg.ports) {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
        sel.appendChild(opt);
      }
      break;
    }

    case 'serial': {
      setLink(msg.open, msg.open ? `串口 ${msg.path ?? ''}` : '串口已关闭');
      if (msg.open) startInventoryFetch();
      break;
    }

    case 'heartbeat': {
      const d = msg.data;
      setLink(true, 'A 板在线');
      $('#fwText').textContent = `固件 ${d.fwVersion} · ${Math.round(d.uptimeS / 60)} 分钟`;
      // 收到心跳说明板子已在跑,若清单还没拿到就再要一次(见 startInventoryFetch 注释)
      if (!inventory.length) startInventoryFetch();
      break;
    }

    case 'inventory': {
      // 板端登记的电机清单:界面只能从中选择,不会虚报不存在的电机
      inventory = msg.data.items.map((m) => ({
        ...m,
        label: MotorKindLabel[m.kind] ?? `未知类型(${m.kind})`,
      }));

      /*
       * 通道卡片数量:**只增不减**,且只在"电机数超过当前卡片数"时才增长。
       *
       * @attention 【2026-10-12 修复】原判断是
       *   `CHANNEL_COUNT !== inventory.length` —— 任何数量变化都重建卡片。
       *   它建立在错误假设上:"电机数 == 通道数"。
       *   实际通道是独立的控制位(固件 MB_CHANNEL_MAX = 8),
       *   两颗电机完全可以只用一个通道,或者一颗电机换通道。
       *   于是"加一颗电机"这种纯后台操作会摧毁用户正在用的界面状态:
       *   已选电机、已设 rpm 全部归零,多通道时还会一起清空。
       *
       * 现在:数量够就不动 DOM,只在不够时补卡(buildChannels 内部只增不减)。
       * 加电机不再触碰任何已有卡片。
       */
      buildChannels(inventory.length);

      /*
       * 刷新各通道的电机下拉框。
       * @attention 必须在 buildChannels() 之后 —— 新建的卡片还没有选项。
       *   fillMotorOptions 本身会记住并恢复已有选择(见其内部注释),
       *   所以刷新清单不会夺走用户已选的电机。
       */
      fillMotorOptions();

      /*
       * 拿到清单后初始化各通道的 PID 面板。
       * @attention 必须在 fillMotorOptions() 之后 —— 该函数才把
       *   下拉框的 value 设成实际电机索引,currentChannelKind() 靠它取 kind。
       *   顺序反了会读不到 kind,PID 面板被隐藏。
       */
      for (let i = 0; i < CHANNEL_COUNT; i++) initPidPanel(i);

      /*
       * 拿到清单即视为握手完成。
       * 注意:清单为空是**正常状态**(预置电机已清空,等用户添加),
       * 所以这里不能用 items.length 判断"是否成功"。
       */
      setLink(true, 'A 板在线');
      if (inventoryTimer) {
        clearInterval(inventoryTimer);
        inventoryTimer = null;
      }

      /*
       * 清单变了 → 重新算一遍"可用 ID"提示。
       * 否则加完一颗电机后,添加面板上还挂着上一次算出来的可用 ID 列表,
       * 用户照它填就会撞车 —— 提示必须跟着清单走。
       */
      if (typeof refreshAddHint === 'function') refreshAddHint();
      break;
    }

    case 'motorAck': {
      /*
       * 板端对"添加/移除电机"的应答。
       * 失败时必须显示**具体原因**(如 ID 冲突/滤波器耗尽),
       * 否则用户只会看到"没反应",无从下手。
       * detail = 该 CAN 总线剩余的过滤器个数,用于提示还能再接几颗。
       */
      const d = msg.data;
      const ok = d.result === MBResult.OK;

      // 应答到了,清掉"正在添加…"的计时器
      if (addPendingTimer) {
        clearTimeout(addPendingTimer);
        addPendingTimer = null;
      }

      const name = MotorKindLabel[d.kind] ?? `类型${d.kind}`;
      if (ok) {
        showAddMsg(
          `已添加 ${name}(CAN${d.canBus} ID${d.motorId})` +
            (typeof d.detail === 'number' ? `,该总线还剩 ${d.detail} 个位置` : ''),
          false,
        );
        $('#addId').value = Number($('#addId').value) + 1; // 顺手加一,方便连续添加
      } else {
        showAddMsg(MBResultText[d.result] ?? `失败(错误码 ${d.result})`, true);
      }
      inventory.length = 0;
      startInventoryFetch(); // 无论成败都重新拉一次清单
      break;
    }

    case 'unbindAck': {
      /*
       * 固件确认解绑完成 —— 这时才清界面状态。
       *
       * @attention 之前是"点按钮就本地清空",不等应答。绑定被固件拒绝时
       *   (MB_ERR_DUPLICATE 等)界面与板端就会不一致:
       *   界面显示"未绑定",板子上却还占着通道、电机照转。
       *   改成等应答再清,失败时把真实原因显示出来。
       */
      const d = msg.data;
      if (d.result === MBResult.OK) {
        telemetryByChannel.delete(d.channelId);
        const el = ch(d.channelId);
        if (el) {
          /* 下拉回到"选择电机…",滑块归零 —— 此时清状态才是安全的 */
          el.querySelector('[data-role="motor"]').value = '';
          el.querySelector('[data-role="slider"]').value = '0';
          el.querySelector('[data-role="num"]').value = '0';
          renderChannel(d.channelId);
          initPidPanel(d.channelId);
        }
        setLink(true, `通道 ${d.channelId} 已解绑`);
      } else {
        /* 失败:界面保持原样,并说明原因,避免"看起来解绑了其实没解" */
        setLink(true, `通道 ${d.channelId} 解绑失败: ${MBResultText[d.result] ?? d.result}`);
      }
      break;
    }

    case 'telemetry': {
      for (const it of msg.data.items) {
        telemetryByChannel.set(it.channelId, it);
      }
      for (let i = 0; i < CHANNEL_COUNT; i++) renderChannel(i);
      break;
    }

    case 'pidReport': {
      /*
       * 板端回传当前生效的三套 PID。
       * 只填"当前选中的那个环"的输入框 —— 一次性把三套都写进去,
       * 用户切环时会看到数值被改过,容易误以为是自己改过头。
       */
      const d = msg.data;
      const st = pidStateByChannel.get(d.channelId);
      if (!st) break;
      const el = ch(d.channelId);
      if (!el) break;
      const r = (role) => el.querySelector(`[data-role="${role}"]`);
      const cur = ['speed', 'current', 'angle'][st.loop];
      const p = d[cur];
      const msg2 = r('pidMsg');
      if (p) {
        r('pKp').value = p.Kp;
        r('pKi').value = p.Ki;
        r('pKd').value = p.Kd;
        r('pMaxOut').value = p.MaxOut;
        r('pIntLim').value = p.IntegralLimit;
        msg2.className = 'hint';
        msg2.textContent = '已读回板端当前生效值';
      } else {
        msg2.className = 'hint error';
        msg2.textContent = '板端未返回该环参数';
      }
      break;
    }

    case 'pidAck': {
      const d = msg.data;
      const el = ch(d.channelId);
      if (!el) break;
      const m = el.querySelector('[data-role="pidMsg"]');
      if (d.result === MBResult.OK) {
        m.className = 'hint ok';
        m.textContent = '已应用到电机';
      } else {
        m.className = 'hint error';
        m.textContent = MBResultText[d.result] ?? `下发失败(错误码 ${d.result})`;
      }
      break;
    }

    case 'error': {
      setLink(false, '出错');
      alert(msg.message);
      break;
    }

    default:
      break;
  }
};

function setLink(ok, text) {
  $('#linkDot').classList.toggle('online', ok);
  $('#linkText').textContent = text;
}

/**
 * 依据板端上报的清单填充下拉。
 * @note 固件在心跳里给出已登记数量,随后由 MB_FRAME_INVENTORY_REPORT
 *       给出每一项的具体配置,界面据此列出可绑定的电机。
 */

/*
 * 初始只建卡片即可 —— buildChannels() 内部已经会调用 bindEvents(),
 * 外面再调一次会导致所有事件被绑定两遍(同一按钮触发两次指令)。
 * 尤其是 setRef 之类的帧会被重复下发。
 */
buildChannels();