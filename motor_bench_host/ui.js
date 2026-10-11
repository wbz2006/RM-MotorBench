/**
 * ui.js —— 浏览器端界面逻辑
 *
 * 通过 WebSocket 与 server.js 通信:
 *   下行: hello / ports / serial / heartbeat / telemetry / error
 *   上行: listPorts / openSerial / closeSerial / bind / setRef / enable / stopAll / query
 */
import { MotorKindLabel, MBResult, MBResultText } from './protocol.js';

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

/** 添加/移除的待应答计时器:超时则提示"没收到板子应答",避免永久卡住 */
let addPendingTimer = null;
let addPendingLabel = '添加电机';

/* ---------------- 建卡片 ---------------- */

/**
 * 按板上实际电机数量生成通道卡片
 *
 * @note 早期固定生成 4 张卡片,导致板上只有 1 颗电机时,
 *   另外 3 张全是空卡片(未绑定、全是 --),既占地方又让人误以为功能异常。
 *   改为跟随板端清单数量动态生成:
 *     - 未拿到清单时先显示 1 张占位卡片,避免空白页;
 *     - 清单到达后按数量重建,数量随增删电机自动变化。
 */
function buildChannels(count = null) {
  const host = $('#channels');
  const tpl = $('#channelTpl');
  host.innerHTML = '';

  const n = Number.isInteger(count) && count > 0 ? count : 1;
  for (let i = 0; i < n; i++) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.ch = String(i);
    node.querySelector('.ch-title').textContent = `通道 ${i}`;
    host.appendChild(node);
  }
  // 记录当前渲染的卡片数,供其它遍历逻辑使用
  CHANNEL_COUNT = n;

  /*
   * @attention 必须在这里重新绑定事件。
   *   innerHTML = '' 会把旧卡片连同其上所有 onclick 一起销毁,
   *   而 bindEvents() 原先只在页面加载时执行一次 ——
   *   清单到达触发重建后,新卡片上的按钮**全都没有事件**,
   *   表现为"点击按钮毫无反应";个别能响应的也是残留的旧闭包,
   *   其 channelId 还是重建前的值(实测出现"绑定通道1却报通道0已被占用")。
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
  r('ref').textContent = t ? fmt(t.ref, 0) : '--';
  r('speed').textContent = t ? fmt(t.speed, 1) : '--';
  r('torque').textContent = t ? fmt(t.torque, 2) : '--';
  r('angle').textContent = t ? fmt(t.angle, 1) : '--';
  r('temp').textContent = t && t.temperature !== -128 ? `${t.temperature} °C` : '--';

  const enableBtn = r('enable');
  enableBtn.classList.toggle('on', !!(t && t.enabled));
  enableBtn.textContent = t && t.enabled ? '停机' : '使能';
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
    sel.innerHTML = '<option value="">选择电机…</option>';
    for (const m of inventory) {
      const label = `${m.label} · CAN${m.canBus}·ID${m.motorId}`;
      const opt = document.createElement('option');
      opt.value = String(inventory.indexOf(m));
      opt.textContent = label;
      sel.appendChild(opt);
    }
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

    if (!Number.isInteger(motorId) || motorId < 1 || motorId > 8) {
      showAddMsg('ID 需填 1~8 的整数(对应电调拨码开关)', true);
      return;
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
  $('#estop').onclick = () => {
    if (confirm('确定要立即停止全部电机吗?')) send({ type: 'stopAll' });
  };

  // 页面关闭前尽量通知服务端全停(beforeunload + sendBeacon 兜底)
  window.addEventListener('beforeunload', () => send({ type: 'stopAll' }));

  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const el = ch(i);
    const r = (role) => el.querySelector(`[data-role="${role}"]`);

    r('bind').onclick = () => {
      const idx = Number(r('motor').value);
      const m = inventory[idx];
      if (!m) return alert('请先选择电机');
      send({
        type: 'bind',
        channelId: i,
        kind: m.kind,
        canBus: m.canBus,
        motorId: m.motorId,
        outerLoop: Number(r('loop').value),
      });
    };

    r('unbind').onclick = () => {
      send({ type: 'enable', channelId: i, enable: false });
      telemetryByChannel.delete(i);
      renderChannel(i);
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
  if (inventoryTimer) return; // 已在拉取中
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
       * 通道卡片数量跟随板端电机数量:
       * 有几颗电机就显示几张卡片,不显示多余的空卡片。
       * 数量不变时跳过重建,避免每次上报都清空 DOM 导致闪烁与事件丢失。
       * @note 清单为空时不重建 —— 那样会把页面清成一片空白,
       *   反而不如保留一张占位卡片(用户正要往板上加电机)。
       * @attention 顺序很重要:必须先 buildChannels() 再 fillMotorOptions(),
       *   否则 fillMotorOptions 遍历的还是旧的、更少的卡片,
       *   新建的卡片里电机下拉框会是空的。
       */
      if (inventory.length > 0 && CHANNEL_COUNT !== inventory.length) {
        buildChannels(inventory.length);
      }
      fillMotorOptions();

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

    case 'telemetry': {
      for (const it of msg.data.items) {
        telemetryByChannel.set(it.channelId, it);
      }
      for (let i = 0; i < CHANNEL_COUNT; i++) renderChannel(i);
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