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
} from './protocol.js';
import { SpeedWaveform } from './waveform.js';

/** 固件通道上限。卡片删除后保留其他卡片原有的通道号。 */
const CHANNEL_MAX = 8;

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
const pidStateByChannel = new Map(); // ch -> {loop, kind, storageKey}
const PID_FORM_FIELDS = { Kp: 'pKp', Ki: 'pKi', Kd: 'pKd', MaxOut: 'pMaxOut', IntegralLimit: 'pIntLim' };

const $ = (sel) => document.querySelector(sel);
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const ws = new WebSocket(wsUrl);
const waveform = new SpeedWaveform($('#waveformPanel'));

/** 板端上报的电机清单(来自心跳应答的 inventoryCount,随后由遥测确认) */
let inventory = [];
// 独立保留上次清单的身份,避免重新拉取清单时补回已解绑的卡片。
let channelInventoryKeys = null;
let inventoryReceived = false;
let serialOpen = false;
let lastBoardReplyAt = 0;
let boardUnresponsive = false;
const telemetryByChannel = new Map();
const channelBindings = new Map();
let controlState = { source: 0, channelId: 0xff, online: false, ready: false };
let sourceEditing = false;
let sourcePending = null;
let sourceTimer = null;
let controlError = '';

function updateRemoteSpec() {
  const id = Number($('#remoteChannel').value);
  const el = ch(id);
  const index = el ? Number(el.querySelector('[data-role="motor"]').value) : -1;
  const kind = inventory[index]?.kind ?? MotorKind.M3508;
  const spec = MOTOR_SPEC[MotorKindLabel[kind]];
  $('#remoteUnit').textContent = spec.unit;
  $('#remoteMaxRef').max = spec.range;
  if (Number($('#remoteMaxRef').value) > spec.range) $('#remoteMaxRef').value = spec.range;
}

function refreshRemoteChannels() {
  const select = $('#remoteChannel');
  const value = select.value;
  select.replaceChildren();
  for (const i of channelIds()) {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `通道 ${i}`;
    select.appendChild(option);
  }
  select.value = value || '0';
  if (!select.value) select.value = select.options[0]?.value ?? '';
  $('#addChannel').disabled = channelIds().length >= CHANNEL_MAX;
  waveform.setChannels(channelIds());
  const ids = channelIds();
  document.querySelectorAll('[data-wheel]').forEach((select, position) => {
    const previous = select.value;
    select.innerHTML = '<option value="">选择通道</option>';
    for (const id of ids) {
      const option = document.createElement('option'); option.value = String(id); option.textContent = `通道 ${id}`;
      select.appendChild(option);
    }
    select.value = previous && ids.includes(Number(previous)) ? previous : previous ? '' : String(ids[position] ?? '');
  });
  updateControlFields();
  updateRemoteSpec();
}

function chassisChannels() {
  return [...document.querySelectorAll('[data-wheel]')].map(select => select.value === '' ? -1 : Number(select.value));
}

function updateControlFields() {
  const chassis = Number($('#controlSource').value) >= 2;
  $('#chassisFields').hidden = !chassis;
  document.querySelectorAll('[data-single-remote]').forEach(el => { el.hidden = chassis; });
  $('#chassisMaxRef').max = currentChannelKind(chassisChannels()[0]) === MotorKind.M2006 ? 7000 : 6000;
  const active = controlState.source >= 2;
  const running = controlState.channels?.some(id => telemetryByChannel.get(id)?.enabled);
  const online = controlState.channels?.every(id => telemetryByChannel.get(id)?.online);
  $('#chassisEnable').disabled = !active || !controlState.ready || !online || running || !!sourcePending || sourceEditing;
  $('#chassisStop').disabled = !active;
}

function refreshControlLocks() {
  updateControlFields();
  for (const id of channelIds()) renderChannel(id);
}

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

/** 补足卡片,复用空闲通道号,不重建已有卡片。返回新增的通道号。 */
function buildChannels(count = 1) {
  const host = $('#channels');

  const want = Number.isInteger(count) && count > 0 ? count : 0;
  const have = host.querySelectorAll('.channel').length;
  const n = Math.min(CHANNEL_MAX, Math.max(have, want));

  if (have === n) {
    return []; // 数量没变时保留全部卡片和输入状态。
  }

  const added = [];
  for (let i = 0; i < CHANNEL_MAX && have + added.length < n; i++) {
    if (ch(i)) continue;
    createChannel(i);
    added.push(i);
  }
  refreshRemoteChannels();
  bindEvents();
  return added;
}

function createChannel(i) {
  const host = $('#channels');
  const node = $('#channelTpl').content.firstElementChild.cloneNode(true);
  node.dataset.ch = String(i);
  node.querySelector('.ch-title').textContent = `通道 ${i}`;
  const next = [...host.children].find(el => Number(el.dataset.ch) > i);
  host.insertBefore(node, next ?? null);
}

/** Restore identities observed by the host, including sparse channel numbers. */
function restoreChannelBindings() {
  if (!inventoryReceived) return;
  let added = false;
  for (const id of channelBindings.keys()) {
    if (!ch(id) && Number.isInteger(id) && id >= 0 && id < CHANNEL_MAX) {
      createChannel(id);
      added = true;
    }
  }
  if (added) {
    refreshRemoteChannels();
    bindEvents();
    fillMotorOptions();
  }
  for (const [id, binding] of channelBindings) {
    const el = ch(id);
    const index = inventory.findIndex(m => m.kind === binding.kind && m.canBus === binding.canBus && m.motorId === binding.motorId);
    if (!el || index < 0) continue;
    const r = role => el.querySelector(`[data-role="${role}"]`);
    const changed = r('motor').value !== String(index);
    r('motor').value = String(index);
    r('loop').value = String(binding.outerLoop);
    const spec = MOTOR_SPEC[MotorKindLabel[binding.kind]];
    r('unit').textContent = spec.unit;
    r('slider').min = String(-spec.range);
    r('slider').max = String(spec.range);
    waveform.configureChannel(id, {
      unit: spec.unit, speedLoop: binding.outerLoop === 2,
      motorKey: `${binding.kind}:${binding.canBus}:${binding.motorId}`,
      identified: !!binding.identified,
    });
    if (changed) initPidPanel(id);
  }
  updateRemoteSpec();
}

/** Older board bindings have no identity query; the user can identify them locally. */
function identifyExistingChannel(i) {
  const el = ch(i);
  if (!telemetryByChannel.has(i) || (channelBindings.has(i) && !channelBindings.get(i).identified) || el?.dataset.bindPending === '1') return;
  const select = el.querySelector('[data-role="motor"]');
  const motor = select.value === '' ? null : inventory[Number(select.value)];
  if (!motor) {
    waveform.forgetChannel(i);
    send({ type: 'identifyChannel', channelId: i, kind: 0 });
    return;
  }
  // Editing a bound channel's selectors must not relabel its existing plot.
  // An unknown identity can be explicitly reset by choosing the empty option first.
  if (waveform.configs.has(i) && !waveform.configs.get(i).identified && !channelBindings.get(i)?.identified) return;
  waveform.configureChannel(i, {
    unit: MOTOR_SPEC[motor.label].unit,
    speedLoop: Number(el.querySelector('[data-role="loop"]').value) === 2,
    motorKey: `${motor.kind}:${motor.canBus}:${motor.motorId}`,
    identified: true,
  });
  send({
    type: 'identifyChannel', channelId: i, kind: motor.kind, canBus: motor.canBus, motorId: motor.motorId,
    outerLoop: Number(el.querySelector('[data-role="loop"]').value),
  });
}

function channelIds() {
  return [...document.querySelectorAll('#channels .channel')].map(el => Number(el.dataset.ch));
}

function ch(i) {
  return document.querySelector(`.channel[data-ch="${i}"]`);
}

/* ---------------- 指令发送 ---------------- */

function showConnectionNotice(message) {
  $('#connectionMessage').textContent = message;
  $('#connectionNotice').hidden = false;
}

function send(obj) {
  if (ws.readyState !== 1) {
    showConnectionNotice('上位机服务未连接,请确认服务正在运行并刷新网页');
    return false;
  }
  // 急停始终尝试发送,包括当前页面尚未收到串口状态的时候。
  if (!serialOpen && !['listPorts', 'openSerial', 'closeSerial', 'stopAll'].includes(obj.type)) {
    showConnectionNotice('串口未连接,请先选择开发板串口并点击「打开」');
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
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
  const remote = controlState.source !== 0;
  r('slider').disabled = remote;
  r('num').disabled = remote;
  r('zero').disabled = remote;
  const selected = controlState.source >= 2 ? controlState.channels?.includes(i) : controlState.channelId === i;
  enableBtn.disabled = !t?.enabled && (sourceEditing || !!sourcePending || (remote && (!selected || !controlState.ready)));
}

/* ---------------- 电机下拉(固件清单) ---------------- */

/**
 * 填充可绑定电机列表。
 * @note 固件登记了几颗电机,上位机就只能选这几颗 —— 这是刻意的设计,
 *       避免上位机下发固件里根本不存在的电机配置。
 */
function fillMotorOptions() {
  for (const i of channelIds()) {
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
     * 从已选 option 读取 (kind, canBus, motorId) 三元组:
     * 此时 inventory 可能已被清空或替换,不能再用旧索引到其中查身份。
     */
    const prevKey = sel.selectedOptions[0]?.dataset.motorKey ?? null;

    sel.innerHTML = '<option value="">选择电机…</option>';
    let restoredIdx = '';
    inventory.forEach((m, idx) => {
      const label = `${m.label} · CAN${m.canBus}·ID${m.motorId}`;
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.dataset.motorKey = `${m.kind}:${m.canBus}:${m.motorId}`;
      opt.textContent = label;
      sel.appendChild(opt);
      if (prevKey && opt.dataset.motorKey === prevKey) {
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
      initPidPanel(i);
      updateRemoteSpec();
      identifyExistingChannel(i);
    };
  }
}

/* ---------------- PID 整定辅助 ---------------- */

/** 保存完整有效的编辑值;清空/输入负数时保留上一次记录。 */
function rememberPidForm(i) {
  const el = ch(i);
  const key = pidStateByChannel.get(i)?.storageKey;
  if (!el || !key) return;
  const values = {};
  for (const [name, role] of Object.entries(PID_FORM_FIELDS)) {
    const raw = el.querySelector(`[data-role="${role}"]`).value;
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < 0) return;
    values[name] = value;
  }
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* 浏览器禁用存储时仍可调参。 */ }
}

function recalledPid(key) {
  if (!key) return null;
  try {
    const values = JSON.parse(localStorage.getItem(key));
    return values && Object.keys(PID_FORM_FIELDS).every(name =>
      typeof values[name] === 'number' && Number.isFinite(values[name]) && values[name] >= 0)
      ? values : null;
  } catch { return null; }
}

/**
 * 取某通道当前绑定电机的 kind(未绑定返回 0)
 */
function currentChannelKind(i) {
  const el = ch(i);
  if (!el) return 0;
  const selection = el.querySelector('[data-role="motor"]').value;
  if (selection === '') return 0;
  const idx = Number(selection);
  const m = inventory[idx];
  return m ? m.kind : 0;
}

/**
 * 把某 kind + 某环的 PID 填入输入框
 * @param i           通道号
 * @param loopStr     环选择器的值('0'速度 '1'电流 '2'位置)
 * @param kindOverride 可选,指定 kind(默认取该通道绑定的电机)
 * @param useSaved 优先恢复上次参数;恢复型号默认值时传 false
 */
function fillPidForm(i, loopStr, kindOverride, useSaved = true) {
  const el = ch(i);
  if (!el) return;
  const kind = kindOverride || currentChannelKind(i);
  const r = (role) => el.querySelector(`[data-role="${role}"]`);

  const preset = PID_DEFAULTS[kind];
  const loopName = ['speed', 'current', 'angle'][Number(loopStr)] || 'speed';
  const motorKey = r('motor').selectedOptions[0]?.dataset.motorKey;
  const storageKey = motorKey ? `motor-bench:pid:v1:${motorKey}:${Number(loopStr)}` : null;
  const p = (useSaved && recalledPid(storageKey)) || preset?.[loopName];

  r('pKp').value = p ? p.Kp : 0;
  r('pKi').value = p ? p.Ki : 0;
  r('pKd').value = p ? p.Kd : 0;
  r('pMaxOut').value = p ? p.MaxOut : 0;
  r('pIntLim').value = p ? p.IntegralLimit : 0;

  // 记录当前环,便于收到 PID 报表时知道该往哪个输入框填
  pidStateByChannel.set(i, { loop: Number(loopStr), kind, storageKey });
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
    /* 绑定后:优先恢复该电机和当前环的上次参数,首次使用才填型号默认值。
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
  $('#addChannel').onclick = () => {
    const added = buildChannels(channelIds().length + 1);
    fillMotorOptions();
    for (const i of added) initPidPanel(i);
  };
  $('#dismissNotice').onclick = () => { $('#connectionNotice').hidden = true; };
  $('#controlSource').onchange = () => { sourceEditing = true; refreshControlLocks(); };
  document.querySelectorAll('[data-wheel], [data-reverse]').forEach(el => {
    el.onchange = () => { sourceEditing = true; refreshControlLocks(); };
  });
  $('#chassisMaxRef').oninput = () => { sourceEditing = true; refreshControlLocks(); };
  $('#chassisEnable').onclick = () => send({ type: 'chassisEnable', enable: true });
  $('#chassisStop').onclick = () => send({ type: 'chassisEnable', enable: false });
  $('#remoteChannel').onchange = () => { sourceEditing = true; updateRemoteSpec(); refreshControlLocks(); };
  $('#remoteMaxRef').oninput = () => { sourceEditing = true; refreshControlLocks(); };
  $('#applySource').onclick = () => {
    controlError = '';
    const source = Number($('#controlSource').value);
    const channelId = Number($('#remoteChannel').value);
    const maxRef = source >= 2 ? Number($('#chassisMaxRef').value) : source ? Number($('#remoteMaxRef').value) : 0;
    const el = ch(channelId);
    if (source === 1 && (!el || !telemetryByChannel.has(channelId) || Number(el.querySelector('[data-role="loop"]').value) !== 2)) {
      $('#remoteStatus').textContent = '请先把遥控通道绑定为速度环';
      return;
    }
    if (source && (!Number.isFinite(maxRef) || maxRef <= 0 || maxRef > Number($(source >= 2 ? '#chassisMaxRef' : '#remoteMaxRef').max))) {
      $('#remoteStatus').textContent = '遥控最大转速超出该型号范围';
      return;
    }
    let pending = { source, channelId, maxRef };
    if (source >= 2) {
      const channels = chassisChannels();
      const kinds = channels.map(currentChannelKind);
      if (channels.some(id => id < 0 || !telemetryByChannel.has(id)) || new Set(channels).size !== 4 ||
          channels.some(id => Number(ch(id)?.querySelector('[data-role="loop"]').value) !== 2) ||
          ![1,2,3].includes(kinds[0]) || kinds.some(kind => kind !== kinds[0])) {
        $('#remoteStatus').textContent = '请选择四个不重复、已绑定速度环的同型号 DJI 电机通道';
        return;
      }
      const reverseMask = [...document.querySelectorAll('[data-reverse]')].reduce((mask, input, i) => mask | (input.checked ? 1 << i : 0), 0);
      pending = { source, channels, reverseMask, maxRef };
    }
    if (!send({ type: 'controlSource', ...pending })) {
      $('#remoteStatus').textContent = $('#connectionMessage').textContent;
      return;
    }
    sourcePending = pending;
    refreshControlLocks();
    $('#remoteStatus').textContent = '正在切换,等待板端确认…';
    clearTimeout(sourceTimer);
    sourceTimer = setTimeout(() => {
      sourcePending = null;
      sourceTimer = null;
      $('#remoteStatus').textContent = '未收到板端切换确认,控制方式尚未确认。请检查开发板通信后重试';
    }, 3000);
  };
  $('#refreshPorts').onclick = () => send({ type: 'listPorts' });
  $('#openPort').onclick = () => {
    const path = $('#portSelect').value;
    if (!path) return showConnectionNotice('请先选择开发板串口');
    send({ type: 'openSerial', path, baud: 115200 });
  };
  $('#closePort').onclick = () => send({ type: 'closeSerial' });
  $('#rescan').onclick = () => {
    if (!serialOpen) return showConnectionNotice('串口未连接,请先选择开发板串口并点击「打开」');
    // 等新清单到达后再替换,避免等待期间补卡清空已有电机选择。
    inventoryReceived = false;
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
    if (!send({ type: 'addMotor', kind, canBus, motorId })) {
      showAddMsg($('#connectionMessage').textContent, true);
      return;
    }
    showAddMsg('正在添加…', false);
    addPendingLabel = '添加电机';

    /*
     * 超时兜底:若板子没回应答帧,不能一直卡在"正在添加…"。
     * 早期版本没这个兜底,一旦板端因任何原因(门闩拒绝、解析失败、
     * 固件版本旧)不回 0x8A,界面就永久停在"正在添加…",
     * 让人完全无从判断是板子没收到还是收到了没回。
     */
    if (addPendingTimer) clearTimeout(addPendingTimer);
    addPendingTimer = setTimeout(() => {
      addPendingTimer = null;
      showAddMsg(
        `${addPendingLabel} 3 秒内没有收到板子应答。` +
          '添加结果尚未确认,请检查开发板通信并重新获取电机清单。',
        true,
      );
    }, 3000);
  };
  $('#estop').onclick = () => {
    send({ type: 'stopAll' });
  };

  // 页面退出时只尝试发送全停,不再显示连接错误。
  window.addEventListener('beforeunload', () => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stopAll' }));
  });

  for (const i of channelIds()) {
    const el = ch(i);
    const r = (role) => el.querySelector(`[data-role="${role}"]`);

    r('bind').onclick = () => {
      // 固件会拒绝重复绑定,不能仅凭请求发出就把波形改成另一种量纲。
      if (telemetryByChannel.has(i) || el.dataset.bindPending === '1') {
        return showConnectionNotice('该通道已绑定或正在绑定。更换电机或控制环前,请先解绑,再添加通道。');
      }
      const idx = Number(r('motor').value);
      const m = inventory[idx];
      if (r('motor').value === '' || !m) return showConnectionNotice('请先选择电机');
      if (!send({
        type: 'bind',
        channelId: i,
        kind: m.kind,
        canBus: m.canBus,
        motorId: m.motorId,
        outerLoop: Number(r('loop').value),
      })) return;
      el.dataset.bindPending = '1';
      waveform.configureChannel(i, {
        unit: MOTOR_SPEC[MotorKindLabel[m.kind]].unit,
        speedLoop: Number(r('loop').value) === 2,
        motorKey: `${m.kind}:${m.canBus}:${m.motorId}`,
      });
      // 绑定时恢复上次 PID(首次使用填默认值),用户点"应用"后生效
      initPidPanel(i);
    };

    /*
     * @attention 换选电机后必须刷新 PID 面板。
     *   currentChannelKind() 读的是下拉框当前值,而 PID 默认值按型号不同
     *   (M3508 Kp=20 / M2006 Kp=10 / 6020 Kp=50)。不跟着换,
     *   会出现"下拉框选了 M2006,面板里却还摆着 M3508 的参数"。
     */
    r('motor').onchange = () => { initPidPanel(i); updateRemoteSpec(); identifyExistingChannel(i); };
    r('loop').onchange = () => identifyExistingChannel(i);

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
    slider.onchange = () => {
      if (controlState.source === 0 && telemetryByChannel.get(i)?.enabled)
        send({ type: 'setRef', channelId: i, ref: Number(slider.value) });
    };
    num.onchange = () => {
      const value = Number(num.value);
      if (!Number.isFinite(value)) return;
      const limited = Math.max(Number(slider.min), Math.min(Number(slider.max), value));
      slider.value = String(limited);
      num.value = String(limited);
      if (controlState.source === 0 && telemetryByChannel.get(i)?.enabled)
        send({ type: 'setRef', channelId: i, ref: limited });
    };

    r('enable').onclick = () => {
      controlError = '';
      if (controlState.source >= 2 && controlState.channels?.includes(i)) {
        const enable = !controlState.channels.some(id => telemetryByChannel.get(id)?.enabled);
        if (enable && (sourceEditing || sourcePending)) return showConnectionNotice('控制配置尚未确认,请先应用控制方式');
        return send({ type: 'chassisEnable', enable });
      }
      const t = telemetryByChannel.get(i);
      const enable = !(t && t.enabled);
      if (enable && (sourceEditing || sourcePending)) return showConnectionNotice('控制配置尚未确认,请先应用控制方式');
      if (enable && controlState.source === 0 && Number(num.value) !== 0) {
        if (!confirm('该通道当前设定值不为 0,使能后电机会立即转动。确认继续?')) return;
      }
      send({ type: 'enable', channelId: i, enable });
      if (enable && controlState.source === 0)
        send({ type: 'setRef', channelId: i, ref: Number(num.value) });
    };

    r('zero').onclick = () => {
      slider.value = '0';
      num.value = '0';
      send({ type: 'setRef', channelId: i, ref: 0 });
    };

    /* ---------------- PID 整定 ---------------- */
    const pidLoop = r('pidLoop');
    const pidPanel = r('pidPanel');
    const pidMsg = r('pidMsg');
    for (const role of Object.values(PID_FORM_FIELDS)) {
      r(role).oninput = () => rememberPidForm(i);
    }

    // 切环时刷新输入框为上一环 / 该型号默认值
    pidLoop.onchange = () => {
      fillPidForm(i, pidLoop.value);
      pidMsg.textContent = '';
    };

    r('pidCollapse').onclick = () => {
      pidPanel.dataset.collapsed = pidPanel.dataset.collapsed === '1' ? '0' : '1';
      r('pidCollapse').textContent = pidPanel.dataset.collapsed === '1' ? '展开' : '收起';
    };

    r('pidReset').onclick = () => {
      const kind = currentChannelKind(i);
      fillPidForm(i, pidLoop.value, kind, false);
      rememberPidForm(i);
      pidMsg.className = 'hint';
      pidMsg.textContent = kind ? '已填入该型号默认值,点"应用到电机"下发' : '请先绑定电机';
    };

    r('pidQuery').onclick = () => {
      const motorKey = r('motor').selectedOptions[0]?.dataset.motorKey;
      if (!motorKey) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = '请先选择电机再读回参数';
        return;
      }
      if (!send({ type: 'pidQuery', channelId: i })) return;
      el.dataset.pidQueryMotorKey = motorKey;
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
  waveform.disconnect('服务已断开');
  serialOpen = false;
  lastBoardReplyAt = 0;
  boardUnresponsive = false;
  inventoryReceived = false;
  stopInventoryFetch();
  clearPendingRequests('连接已断开,请重新打开串口后再操作');
  setLink(false, '服务已断开');
  showConnectionNotice('上位机服务已断开,请确认服务正在运行并刷新网页');
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

function stopInventoryFetch() {
  clearInterval(inventoryTimer);
  inventoryTimer = null;
}

function clearPendingRequests(message) {
  if (addPendingTimer) showAddMsg(message, true);
  clearTimeout(addPendingTimer);
  addPendingTimer = null;
  if (sourcePending) $('#remoteStatus').textContent = message;
  clearTimeout(sourceTimer);
  sourceTimer = null;
  sourcePending = null;
}

// 串口句柄仍打开时,板端也可能已经停止回复。
setInterval(() => {
  if (!serialOpen || boardUnresponsive || Date.now() - lastBoardReplyAt <= 3000) return;
  boardUnresponsive = true;
  waveform.disconnect('开发板无应答');
  stopInventoryFetch();
  clearPendingRequests('开发板无应答,操作结果尚未确认。请检查通信后重试');
  setLink(false, '开发板无应答');
  showConnectionNotice('开发板超过 3 秒未回复,请检查 USB 连接和供电,然后重新打开串口');
}, 1000);

function startInventoryFetch() {
  /*
   * 【2026-10-12 修复】原实现 `if (inventoryTimer) return` 有竞态:
   *   motorAck 到达时会重置 inventoryReceived 再调 startInventoryFetch(),
   *   而此时上一次 startInventoryFetch() 的定时器可能仍在跑
   *   (它每 170ms 才检查一次 inventoryReceived,还没轮到就收到了 ack)。
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
  if (!serialOpen || ws.readyState !== 1) return;
  inventoryTries = 0;
  inventoryTimer = setInterval(() => {
    if (inventoryReceived || !serialOpen || ws.readyState !== 1) {
      stopInventoryFetch();
      return;
    }
    if (!send({ type: 'scanMotors' })) {
      stopInventoryFetch();
      return;
    }
    if (++inventoryTries > 20) {
      stopInventoryFetch();
      showAddMsg('未收到开发板的电机清单,请检查所选串口和开发板供电。', true);
    }
  }, 170);
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (['heartbeat', 'inventory', 'telemetry', 'controlReport'].includes(msg.type)) {
    serialOpen = true;
    lastBoardReplyAt = Date.now();
    if (boardUnresponsive) {
      boardUnresponsive = false;
      $('#connectionNotice').hidden = true;
    }
    setLink(true, '开发板在线');
  }

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
      serialOpen = !!msg.open;
      lastBoardReplyAt = msg.open ? Date.now() : 0;
      boardUnresponsive = false;
      setLink(msg.open, msg.open ? `串口 ${msg.path ?? ''}` : '串口已关闭');
      if (msg.open) {
        // 新串口会话可能连接了另一块板,旧绑定的电机型号和量纲不再可信。
        waveform.resetSession();
        channelBindings.clear();
        telemetryByChannel.clear();
        for (const i of channelIds()) {
          delete ch(i).dataset.bindPending;
          delete ch(i).dataset.pidQueryMotorKey;
          renderChannel(i);
        }
        $('#connectionNotice').hidden = true;
        inventoryReceived = false;
        startInventoryFetch();
      } else {
        waveform.disconnect('串口已关闭');
        inventoryReceived = false;
        stopInventoryFetch();
        clearPendingRequests('串口已关闭,请重新打开串口后再操作');
      }
      break;
    }

    case 'controlReport': {
      const d = msg.data;
      if (d.result !== MBResult.OK) {
        controlError = d.result === MBResult.NOT_ENABLED
          ? '尚不能使能:请把右拨杆拨到上档并将右摇杆回中'
          : '指令未生效:请检查通道绑定、速度环和最大转速;底盘模式需烧录支持四轮控制的新固件';
        sourcePending = null;
        clearTimeout(sourceTimer);
      }
      const changed = controlState.source !== d.source || controlState.channelId !== d.channelId ||
        String(controlState.channels) !== String(d.channels) || controlState.reverseMask !== d.reverseMask;
      controlState = d;
      if (sourcePending && d.result === MBResult.OK && d.source === sourcePending.source &&
          (!d.source || (Math.abs(d.maxRef - sourcePending.maxRef) < 0.01 && (d.source >= 2
            ? String(d.channels) === String(sourcePending.channels) && d.reverseMask === sourcePending.reverseMask
            : d.channelId === sourcePending.channelId)))) {
        sourcePending = null;
        sourceEditing = false;
        clearTimeout(sourceTimer);
      }
      if (!sourceEditing && !sourcePending) {
        $('#controlSource').value = String(d.source);
        if (d.source === 1) {
          $('#remoteChannel').value = String(d.channelId);
          $('#remoteMaxRef').value = String(d.maxRef);
          updateRemoteSpec();
        } else if (d.source >= 2) {
          document.querySelectorAll('[data-wheel]').forEach((select, i) => { select.value = String(d.channels[i]); });
          document.querySelectorAll('[data-reverse]').forEach((input, i) => { input.checked = !!(d.reverseMask & (1 << i)); });
          $('#chassisMaxRef').value = String(d.maxRef);
        }
      }
      if (changed) {
        for (const i of channelIds()) {
          ch(i).querySelector('[data-role="slider"]').value = '0';
          ch(i).querySelector('[data-role="num"]').value = '0';
        }
      }
      if (!sourcePending)
        $('#remoteStatus').textContent = controlError || (sourceEditing ? '控制配置已修改,请先应用控制方式' : d.source
          ? `遥控器${d.online ? '在线' : '离线'} · ${d.source >= 2 ? '平移/旋转' : '右摇杆'} ${d.rocker}${d.source >= 2 ? ` / ${d.lateral} / ${d.yaw}` : ''} · ${d.ready ? '可使能' : '右拨杆上档、摇杆回中后可使能'}`
          : `网页控制 · 遥控器${d.online ? '在线' : '离线'}`);
      for (const i of channelIds()) renderChannel(i);
      updateControlFields();
      break;
    }

    case 'heartbeat': {
      const d = msg.data;
      serialOpen = true;
      setLink(true, '开发板在线');
      $('#fwText').textContent = `固件 ${d.fwVersion} · ${Math.round(d.uptimeS / 60)} 分钟`;
      // 收到心跳说明板子已在跑,若清单还没拿到就再要一次(见 startInventoryFetch 注释)
      if (!inventoryReceived && !inventoryTimer) startInventoryFetch();
      break;
    }

    case 'bindings': {
      const ids = new Set(msg.data.items.map(binding => binding.channelId));
      for (const id of channelBindings.keys()) {
        if (!ids.has(id) && serialOpen) waveform.forgetChannel(id);
      }
      channelBindings.clear();
      for (const binding of msg.data.items) channelBindings.set(binding.channelId, binding);
      restoreChannelBindings();
      break;
    }

    case 'inventory': {
      serialOpen = true;
      inventoryReceived = true;
      // 板端登记的电机清单:界面只能从中选择,不会虚报不存在的电机
      inventory = msg.data.items.map((m) => ({
        ...m,
        label: MotorKindLabel[m.kind] ?? `未知类型(${m.kind})`,
      }));

      // 只有首次清单或新登记的电机需要补卡。重复清单不恢复已解绑的卡片。
      const keys = inventory.map(m => `${m.kind}:${m.canBus}:${m.motorId}`);
      const addedMotors = channelInventoryKeys === null
        ? Math.max(0, inventory.length - channelIds().length)
        : keys.filter(key => !channelInventoryKeys.has(key)).length;
      channelInventoryKeys = new Set(keys);
      if (addedMotors) buildChannels(channelIds().length + addedMotors);

      /*
       * 刷新各通道的电机下拉框。
       * @attention 必须在 buildChannels() 之后 —— 新建的卡片还没有选项。
       *   fillMotorOptions 本身会记住并恢复已有选择(见其内部注释),
       *   所以刷新清单不会夺走用户已选的电机。
       */
      fillMotorOptions();
      restoreChannelBindings();

      /*
       * 只初始化新卡片或型号已改变的 PID 面板,保留其他卡片的用户编辑。
       * @attention 必须在 fillMotorOptions() 之后 —— 该函数才把
       *   下拉框的 value 设成实际电机索引,currentChannelKind() 靠它取 kind。
       *   顺序反了会读不到 kind,PID 面板被隐藏。
       */
      for (const i of channelIds()) {
        if (pidStateByChannel.get(i)?.kind !== currentChannelKind(i)) initPidPanel(i);
      }

      /*
       * 拿到清单即视为握手完成。
       * 注意:清单为空是**正常状态**(预置电机已清空,等用户添加),
       * 所以这里不能用 items.length 判断"是否成功"。
       */
      setLink(true, '开发板在线');
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
      inventoryReceived = false;
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
      // 固件对合法但未绑定的通道也回 BAD_PARAM,确认后同样删除空卡片。
      const alreadyUnbound = d.result === MBResult.BAD_PARAM && d.boardConfirmed !== false && !!ch(d.channelId) &&
        !telemetryByChannel.has(d.channelId);
      if (d.result === MBResult.OK || alreadyUnbound) {
        channelBindings.delete(d.channelId);
        telemetryByChannel.delete(d.channelId);
        pidStateByChannel.delete(d.channelId);
        ch(d.channelId)?.remove();
        refreshRemoteChannels();
        setLink(true, `通道 ${d.channelId} 已解绑`);
      } else {
        /* 失败:界面保持原样,并说明原因,避免"看起来解绑了其实没解" */
        setLink(true, `通道 ${d.channelId} 解绑失败: ${MBResultText[d.result] ?? d.result}`);
      }
      break;
    }

    case 'telemetry': {
      let added = false;
      for (const { channelId } of msg.data.items) {
        if (!ch(channelId) && Number.isInteger(channelId) && channelId >= 0 && channelId < CHANNEL_MAX) {
          createChannel(channelId);
          added = true;
        }
      }
      if (added) {
        refreshRemoteChannels();
        bindEvents();
        fillMotorOptions();
        restoreChannelBindings();
      }
      for (const it of msg.data.items) {
        // Telemetry proves occupancy, even when the old protocol cannot prove identity.
        const el = ch(it.channelId);
        if (el) delete el.dataset.bindPending;
        telemetryByChannel.set(it.channelId, it);
        waveform.append(it);
      }
      for (const i of channelIds()) renderChannel(i);
      updateControlFields();
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
      const queryMotorKey = el.dataset.pidQueryMotorKey;
      delete el.dataset.pidQueryMotorKey;
      if (!queryMotorKey || queryMotorKey !== r('motor').selectedOptions[0]?.dataset.motorKey) break;
      const cur = ['speed', 'current', 'angle'][st.loop];
      const p = d[cur];
      const msg2 = r('pidMsg');
      if (p) {
        r('pKp').value = p.Kp;
        r('pKi').value = p.Ki;
        r('pKd').value = p.Kd;
        r('pMaxOut').value = p.MaxOut;
        r('pIntLim').value = p.IntegralLimit;
        // 读回值只用于查看,避免板端通道身份未知时覆盖另一颗电机的调试记录。
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
      stopInventoryFetch();
      clearPendingRequests(msg.message);
      setLink(false, '出错');
      showConnectionNotice(msg.message);
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
