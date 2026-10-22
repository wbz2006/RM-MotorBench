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
  needsRxId,
  RX_ID_MAX,
  MOTOR_ID_MIN,
  MOTOR_ID_MAX,
  LoopType,
} from './protocol.js';
import { ensureChart, getChartIfExists, dropChart } from './chart.js';
import { LoopFishbone } from './fishbone.js';
import { createSetpointProgram, sampleSetpoint } from './setpoint.js';
import { initCalculator } from './calculator-ui.js';

/** 各电机种类的参考值限幅与单位；工作转速上限与 MIT 编解码量程独立。 */
const MOTOR_SPEC = {
  [MotorKindLabel[1]]: { unit: 'rpm', range: 6000, feedbackLabel: '原始电流', feedbackUnit: 'raw' }, // GM6020
  [MotorKindLabel[2]]: { unit: 'rpm', range: 6000, feedbackLabel: '原始电流', feedbackUnit: 'raw' }, // M3508
  [MotorKindLabel[3]]: { unit: 'rpm', range: 7000, feedbackLabel: '原始电流', feedbackUnit: 'raw' }, // M2006
  [MotorKindLabel[4]]: { unit: 'rad/s', range: 20.94, feedbackLabel: '转矩', feedbackUnit: 'N·m', speedLimitHint: '24 V 空载转速上限：±20.94 rad/s（200 rpm）；带载可达转速更低。' }, // MIT VMAX stays 30.
  // Official DM-J8009P-2EC manual V1.3, p.7: 168 rpm at 24 V = 17.59 rad/s (rounded to 17.6).
  [MotorKindLabel[MotorKind.DM8009P]]: { unit: 'rad/s', range: 17.6, feedbackLabel: '转矩', feedbackUnit: 'N·m', speedLimitHint: '24 V 空载转速上限：±17.6 rad/s（168 rpm）；带载可达转速更低。' },
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
let boardOnline = false;
let boardLastSeen = null;
let serialConnected = false;
let serialPath = null;
let inventoryReceived = false;
let channelsReady = false;
let channelResetPending = null;
let channelResetTimer = null;
let channelResetAttempts = 0;
let serverSupportsReset = false;
let serverSupportsLoop = false;
let firmwareSupportsLoop = false;
let firmwareVersion = null;
let channelResetError = '';
// A fresh page must never adopt telemetry from an earlier test session.
const sessionChannels = new Set();
const pendingUnbindChannels = new Set();
const setpointPrograms = new Map();
const boundLoopMasks = new Map();
const pendingLoopChanges = new Map();
const pendingPidApplies = new Map();
const channelCalculators = new Map();

function cancelPidResume(i) {
  const pending = pendingPidApplies.get(i);
  if (pending) pending.resume = false;
}

function clearPendingPid(i) {
  clearTimeout(pendingPidApplies.get(i)?.timer);
  pendingPidApplies.delete(i);
}

function clearTestChannels() {
  stopAllPrograms('测试通道已清空');
  for (const i of pendingPidApplies.keys()) clearPendingPid(i);
  for (const i of pendingLoopChanges.keys()) clearPendingLoop(i);
  boundLoopMasks.clear();
  channelsReady = false;
  sessionChannels.clear();
  pendingUnbindChannels.clear();
  telemetryByChannel.clear();
  for (const i of channelIds()) {
    const el = ch(i);
    if (!el) continue;
    el.querySelector('[data-role="motor"]').value = '';
    el.querySelector('[data-role="num"]').value = '0';
    el.querySelector('[data-role="slider"]').value = '0';
    getChartIfExists(i)?.clear();
    renderChannel(i);
    initPidPanel(i);
  }
}

function resetTestChannels() {
  if (!serialConnected || channelResetPending) return;
  clearTestChannels();
  if (!serverSupportsReset) {
    channelResetError = '后台版本过旧 · 请重启上位机服务';
    showRegistryMsg(channelResetError, true);
    setLink(false, channelResetError);
    return;
  }
  channelResetError = '';
  channelResetPending = new Set(Array.from({ length: 8 }, (_, i) => i));
  channelResetAttempts = 0;
  setLink(true, '正在清理旧测试通道…');
  sendResetChannel(true);
}

function sendResetChannel(start = false) {
  clearTimeout(channelResetTimer);
  if (!channelResetPending?.size) return;
  if (channelResetAttempts >= 3) {
    const missing = [...channelResetPending].join('、');
    channelResetPending = null;
    channelResetTimer = null;
    channelResetError = `通道 ${missing} 清理超时 · 点击同步清单重试`;
    showRegistryMsg(channelResetError, true);
    setLink(false, channelResetError);
    return;
  }
  channelResetAttempts++;
  channelResetTimer = setTimeout(() => sendResetChannel(), 400);
  const channelId = channelResetPending.values().next().value;
  send(start ? { type: 'resetChannels' } : { type: 'unbind', channelId });
}

function hasFreshTelemetry(i) {
  const t = telemetryByChannel.get(i);
  return !!t && performance.now() - t.receivedAt < 2000;
}

function canControlChannel(i) {
  return ws.readyState === 1 && serialConnected && boardOnline && channelsReady &&
    sessionChannels.has(i) && hasFreshTelemetry(i) && !pendingLoopChanges.has(i) && !pendingUnbindChannels.has(i);
}

function clearPendingLoop(i) {
  clearTimeout(pendingLoopChanges.get(i)?.timer);
  pendingLoopChanges.delete(i);
}

function noteBoardResponse() {
  boardLastSeen = Date.now();
  boardOnline = true;
}

// The server can remain connected while the board is stuck or stops responding.
setInterval(() => {
  for (const i of channelIds()) {
    if (telemetryByChannel.has(i) && !hasFreshTelemetry(i)) renderChannel(i);
  }
  updateWorkspaceStatus();
  if (!boardOnline || boardLastSeen === null || Date.now() - boardLastSeen < 2000) return;
  boardOnline = false;
  for (const i of pendingPidApplies.keys()) cancelPidResume(i);
  setLink(false, 'A 板无响应 · 数据已中断');
  for (const i of channelIds()) renderChannel(i);
}, 500);

/** 在"添加电机"面板上显示一行结果提示 */
function showAddMsg(text, isError) {
  const el = $('#addMsg');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

/** Damiao IDs are entered and displayed as hexadecimal; wire values remain numbers. */
function readHexId(value, max, label) {
  const raw = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return { ok: false, value: 0, msg: `${label} 请填写十六进制 ID` };
  const id = Number.parseInt(raw, 16);
  if (id < 1 || id > max) return { ok: false, value: 0, msg: `${label} 范围为 0x01~0x${max.toString(16).toUpperCase()}` };
  return { ok: true, value: id };
}

function readMotorIdInput() {
  const kind = Number($('#addKind').value);
  if (needsRxId(kind)) return readHexId($('#addId').value, 0xff, '发送 ID');
  const raw = $('#addId').value.trim();
  const value = Number(raw);
  return /^\d+$/.test(raw) && value >= MOTOR_ID_MIN && value <= MOTOR_ID_MAX
    ? { ok: true, value }
    : { ok: false, value: 0, msg: `ID 需填 ${MOTOR_ID_MIN}~${MOTOR_ID_MAX} 的整数` };
}

function readRxIdInput() {
  if (!needsRxId(Number($('#addKind').value))) return { ok: true, value: 0 };
  return readHexId($('#addRxId').value, RX_ID_MAX, '反馈 ID');
}

function syncRxIdVisibility() {
  const dm = needsRxId(Number($('#addKind').value));
  $('#addRxIdWrap').hidden = !dm;
  $('#addIdPrefix').hidden = !dm;
  $('#addIdLabel').textContent = dm ? '发送 ID / TX' : '电调 ID';
  $('#addId').inputMode = dm ? 'text' : 'numeric';
  $('#addId').setAttribute('aria-label', dm ? '发送 ID 十六进制' : '电调 ID');
  $('#addIdHelp').textContent = dm
    ? 'CAN 按实际接线选择。TX 对应电调 CAN ID，RX 对应 Master ID；两项均按十六进制填写，0x 前缀已提供。'
    : 'CAN 总线按实际接线选择，电调 ID 填 1～8，与电调上的实际设置一致。';
}

function formatMotorId(m) {
  return needsRxId(m.kind) ? `0x${m.motorId.toString(16).toUpperCase().padStart(2, '0')}` : String(m.motorId);
}

function showRegistryMsg(text, isError = false) {
  const el = $('#registryMsg');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setAddFormOpen(open) {
  $('#addForm').hidden = !open;
  $('#openAddMotor').setAttribute('aria-expanded', String(open));
  if (open) {
    showRegistryMsg('');
    refreshAddHint();
    $('#addKind').focus();
  } else $('#openAddMotor').focus();
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
  const id = readMotorIdInput();
  const motorId = id.value;

  if (!id.ok) {
    showAddMsg(id.msg, true);
    return;
  }

  /* DM 的 rx_id 先校验:填错就没有必要再算冲突 */
  const rx = readRxIdInput();
  if (!rx.ok) {
    showAddMsg(rx.msg, true);
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

/** Serialize registry edits: add/remove share the same firmware acknowledgement. */
let addPendingTimer = null;
let pendingMotor = null;

function renderMotorList() {
  const list = $('#motorList');
  list.replaceChildren();
  $('#registryCount').textContent = String(inventory.length).padStart(2, '0');
  $('#motorListEmpty').hidden = inventory.length > 0;
  $('#openAddMotor').disabled = !!pendingMotor;
  $('#addMotor').disabled = !!pendingMotor;
  inventory.forEach((m, index) => {
    const row = document.createElement('li');
    row.className = 'motor-row';
    const number = document.createElement('span');
    number.className = 'motor-row-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const info = document.createElement('div');
    info.className = 'motor-row-info';
    const name = document.createElement('strong');
    name.textContent = m.label;
    const details = document.createElement('span');
    details.className = 'motor-row-details';
    details.textContent = `CAN${m.canBus} · ${needsRxId(m.kind) ? 'TX' : 'ID'} ${formatMotorId(m)}`;
    if (needsRxId(m.kind)) details.textContent += Number.isInteger(m.rxId)
      ? ` · RX 0x${m.rxId.toString(16).toUpperCase().padStart(3, '0')}` : ' · RX 未上报，请更新固件至 1.2';
    info.append(name, details);
    const remove = document.createElement('button');
    remove.className = 'motor-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `删除 ${m.label} CAN${m.canBus} ID ${formatMotorId(m)}`);
    const missingRx = needsRxId(m.kind) && !Number.isInteger(m.rxId);
    remove.disabled = !!pendingMotor || missingRx;
    remove.title = missingRx ? '请更新固件至 1.2,同步反馈 ID 后再删除' : `删除 ${m.label}`;
    remove.onclick = () => removeRegisteredMotor(m);
    row.append(number, info, remove);
    list.appendChild(row);
  });
  renderGuidance();
}

function sendMotorEdit(command) {
  if (pendingMotor) return;
  pendingMotor = command;
  renderMotorList();
  addPendingTimer = setTimeout(() => {
    const adding = pendingMotor.type === 'addMotor';
    pendingMotor = null;
    addPendingTimer = null;
    const text = '3 秒内未收到板端应答,请同步清单后重试';
    showRegistryMsg(text, true);
    if (adding) showAddMsg(text, true);
    renderMotorList();
  }, 3000);
  send(command);
}

function removeRegisteredMotor(m) {
  if (pendingMotor) return;
  if (!confirm(`确定删除 ${m.label} · CAN${m.canBus} · ID ${formatMotorId(m)}？已绑定的通道将停机并解绑。`)) return;
  for (const i of [...setpointPrograms.keys()]) {
    const selectedKey = ch(i)?.querySelector('[data-role="motor"]').selectedOptions[0]?.dataset.motorKey;
    if (selectedKey === `${m.kind}:${m.canBus}:${m.motorId}`) stopProgram(i, '电机删除 · 自动输出已停止');
  }
  const rxId = m.rxId ?? 0;
  showRegistryMsg('正在删除…');
  sendMotorEdit({ type: 'removeMotor', kind: m.kind, canBus: m.canBus, motorId: m.motorId, rxId });
}

/* ---------------- 建卡片 ---------------- */

/** Match the motor inventory while retaining surviving cards and firmware IDs. */
function buildChannels(count = inventory.length) {
  const host = $('#channels');
  const tpl = $('#channelTpl');
  const cards = [...host.querySelectorAll('.channel')];
  const n = Math.min(8, Math.max(0, count));
  const validKeys = new Set(inventory.map(m => `${m.kind}:${m.canBus}:${m.motorId}`));
  const priority = node => {
    const key = node.querySelector('[data-role="motor"]').selectedOptions[0]?.dataset.motorKey;
    return validKeys.has(key) ? (sessionChannels.has(Number(node.dataset.ch)) ? 3 : 2) : (key ? 0 : 1);
  };
  // Drop removed motors first, then unused cards. Never renumber a live channel.
  const surplus = cards.sort((a, b) => priority(a) - priority(b) || Number(b.dataset.ch) - Number(a.dataset.ch)).slice(0, Math.max(0, cards.length - n));
  for (const node of surplus) {
    const i = Number(node.dataset.ch);
    clearPendingPid(i);
    clearPendingLoop(i);
    stopProgram(i, '电机已删除');
    sessionChannels.delete(i);
    pendingUnbindChannels.delete(i);
    boundLoopMasks.delete(i);
    telemetryByChannel.delete(i);
    pidStateByChannel.delete(i);
    channelCalculators.delete(i);
    dropChart(i);
    dropFishbone(i);
    node.remove();
  }
  const added = [];
  while (host.querySelectorAll('.channel').length < n) {
    const used = new Set(channelIds());
    let i = 0;
    while (used.has(i)) i++;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.ch = String(i);
    node.querySelector('[data-role="channelIndex"]').textContent = String(i).padStart(2, '0');
    node.querySelector('.ch-title').textContent = `通道 ${i}`;
    const next = [...host.children].find(card => Number(card.dataset.ch) > i);
    host.insertBefore(node, next ?? null);
    const r = role => node.querySelector(`[data-role="${role}"]`);
    for (const name of ['preset', 'calculator']) {
      r(`${name}Tab`).id = `ch${i}-${name}-tab`;
      r(`${name}Panel`).id = `ch${i}-${name}-panel`;
      r(`${name}Tab`).setAttribute('aria-controls', r(`${name}Panel`).id);
      r(`${name}Panel`).setAttribute('aria-labelledby', r(`${name}Tab`).id);
    }
    channelCalculators.set(i, initCalculator(r('calculatorContent'), `ch${i}`, (result, write) => fillCalculatedTarget(i, result, write)));
    added.push(i);
  }
  $('#channelsEmpty').hidden = n !== 0;
  bindEvents();
  for (const i of added) renderChannel(i);
}

function channelIds() {
  return [...document.querySelectorAll('#channels > .channel')].map(node => Number(node.dataset.ch));
}

function ch(i) {
  return document.querySelector(`.channel[data-ch="${i}"]`);
}

/* ---------------- 指令发送 ---------------- */

function send(obj) {
  if (obj.type === 'stopAll' || obj.type === 'resetChannels' || obj.type === 'closeSerial') {
    for (const i of pendingPidApplies.keys()) cancelPidResume(i);
  }
  if (obj.type === 'unbind' || obj.type === 'setLoop' || obj.type === 'removeMotor' ||
      (obj.type === 'enable' && !obj.enable)) {
    if (obj.type === 'removeMotor') {
      for (const i of pendingPidApplies.keys()) cancelPidResume(i);
    } else cancelPidResume(obj.channelId);
  }
  if (pendingPidApplies.has(obj.channelId) &&
      (obj.type === 'setRef' || obj.type === 'pidSet' || (obj.type === 'enable' && obj.enable))) return;
  if (pendingLoopChanges.has(obj.channelId) &&
      (obj.type === 'setRef' || obj.type === 'pidSet' || (obj.type === 'enable' && obj.enable))) return;
  // Number inputs do not enforce HTML min/max when sending commands.
  // Cover manual targets, enable-with-target, and automatic outputs at the same boundary.
  if ((obj.type === 'setRef' || (obj.type === 'enable' && obj.enable)) && obj.ref !== undefined &&
      [MotorKind.DM, MotorKind.DM8009P].includes(currentChannelKind(obj.channelId)) &&
      !((boundLoopMasks.get(obj.channelId) ?? readLoopMask(obj.channelId)) & LoopType.ANGLE_LOOP)) {
    const ref = Number(obj.ref);
    if (!Number.isFinite(ref)) return;
    const limit = MOTOR_SPEC[MotorKindLabel[currentChannelKind(obj.channelId)]].range;
    obj = { ...obj, ref: Math.max(-limit, Math.min(limit, ref)) };
    setDisplayedRef(obj.channelId, obj.ref);
  }
  // Cancel timers before issuing a stop, so later ticks cannot restore a target.
  if (obj.type === 'stopAll' || obj.type === 'resetChannels') stopAllPrograms('已停止');
  if (obj.type === 'unbind' || (obj.type === 'enable' && !obj.enable)) stopProgram(obj.channelId, '已停机');
  if (obj.type === 'pidSet') stopProgram(obj.channelId, 'PID 整定 · 自动输出已停止');
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  else alert('与服务端未建立连接');
}

/* ---------------- 自动转速输出 ---------------- */

function canRunProgram(i) {
  const t = telemetryByChannel.get(i);
  const mask = boundLoopMasks.get(i) || 0;
  return canControlChannel(i) && serialConnected && boardOnline && ws.readyState === 1 &&
    t?.online && t.enabled && performance.now() - t.receivedAt < 500 &&
    !!(mask & LoopType.SPEED_LOOP) && !(mask & LoopType.ANGLE_LOOP) &&
    !pendingUnbindChannels.has(i) && !pendingPidApplies.has(i) && !document.hidden;
}

function programMessage(i, message, error = false) {
  const el = ch(i)?.querySelector('[data-role="presetStatus"]');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', error);
}

function setDisplayedRef(i, value) {
  const el = ch(i);
  if (!el) return;
  el.querySelector('[data-role="num"]').value = String(Number(value.toFixed(3)));
  el.querySelector('[data-role="slider"]').value = String(value);
}

function fillCalculatedTarget(i, result, write) {
  const el = ch(i);
  const status = el.querySelector('[data-role="calculatorWriteStatus"]');
  status.classList.remove('error');
  if (!result) { status.textContent = ''; return; }
  const spec = MOTOR_SPEC[MotorKindLabel[currentChannelKind(i)]];
  const mask = boundLoopMasks.get(i) ?? readLoopMask(i);
  if (!spec) { status.textContent = '选择电机后，计算结果可自动填入上方转速框'; return; }
  if (!(mask & LoopType.SPEED_LOOP) || (mask & LoopType.ANGLE_LOOP)) {
    status.textContent = '当前为位置或电流模式，仅显示计算结果'; return;
  }
  if (setpointPrograms.has(i)) { status.textContent = '自动输出运行中，暂停写入转速框'; return; }
  const value = spec.unit === 'rad/s' ? result.rotorRad : result.rotorRpm;
  if (Math.abs(value) > spec.range) {
    status.textContent = `计算结果超出 ${spec.range} ${spec.unit} 限幅，未写入`;
    status.classList.add('error');
    return;
  }
  if (write) setDisplayedRef(i, value);
  const displayed = Number(el.querySelector('[data-role="num"]').value);
  status.textContent = Math.abs(displayed - value) < 0.00051
    ? `已填入上方转速框：${displayed} ${spec.unit} · 按 Enter 下发，或点击使能执行`
    : '修改计算参数，结果将自动填入上方转速框';
}

function selectChannelTool(i, name) {
  const el = ch(i);
  el.dataset.tool = name;
  renderChannel(i);
  if (name === 'calculator') channelCalculators.get(i)?.fill();
}

function renderChannelTools(i, positionMode) {
  const el = ch(i);
  const selected = el.dataset.tool || 'preset';
  for (const name of ['preset', 'calculator']) {
    const tab = el.querySelector(`[data-role="${name}Tab"]`);
    tab.setAttribute('aria-selected', String(selected === name));
    tab.tabIndex = selected === name ? 0 : -1;
    el.querySelector(`[data-role="${name}Panel"]`).hidden = selected !== name;
  }
  el.querySelector('[data-role="presetBlocker"]').hidden = !positionMode;
  el.querySelector('[data-role="presetContent"]').inert = positionMode;
  channelCalculators.get(i)?.refresh();
}

function renderProgram(i) {
  const el = ch(i);
  if (!el) return;
  const running = setpointPrograms.has(i);
  const positionMode = !!((boundLoopMasks.get(i) ?? readLoopMask(i)) & LoopType.ANGLE_LOOP);
  const mode = el.querySelector('[data-role="presetMode"]').value;
  el.querySelector('[data-role="presetPanel"]').dataset.running = String(running);
  el.querySelector('[data-role="presetSine"]').hidden = mode !== 'sine';
  el.querySelector('[data-role="presetSteps"]').hidden = mode !== 'steps';
  const infinite = el.querySelector('[data-role="presetInfinite"]').checked;
  el.querySelector('[data-role="presetCycleCount"]').hidden = infinite;
  for (const input of el.querySelectorAll('.setpoint-program input, .setpoint-program select')) input.disabled = running || positionMode;
  el.querySelector('[data-role="presetCycles"]').disabled = running || positionMode || infinite;
  el.querySelector('[data-role="presetStart"]').disabled = running || !canRunProgram(i);
  el.querySelector('[data-role="presetStart"]').textContent = running ? '正在输出…' : '▶ 启动预设';
  el.querySelector('[data-role="presetStop"]').disabled = !running;
  for (const role of ['num', 'slider']) el.querySelector(`[data-role="${role}"]`).disabled = running || !canControlChannel(i) || pendingPidApplies.has(i);
}

function stopProgram(i, message, zero = false) {
  const state = setpointPrograms.get(i);
  if (!state) return;
  clearInterval(state.timer);
  setpointPrograms.delete(i);
  setDisplayedRef(i, 0);
  if (zero && ws.readyState === 1 && canControlChannel(i)) send({ type: 'setRef', channelId: i, ref: 0 });
  programMessage(i, message);
  renderProgram(i);
}

function stopAllPrograms(message, disable = false) {
  for (const i of [...setpointPrograms.keys()]) {
    stopProgram(i, message);
    if (disable && ws.readyState === 1) send({ type: 'enable', channelId: i, enable: false });
  }
}

function tickProgram(i) {
  const state = setpointPrograms.get(i);
  if (!state) return;
  const now = performance.now();
  if (!canRunProgram(i) || now - state.lastTick > 250 || (ws.bufferedAmount || 0) > 1024) {
    stopProgram(i, '输出已中止 · 请检查连接与电机状态后重新启动');
    if (ws.readyState === 1) send({ type: 'enable', channelId: i, enable: false });
    return;
  }
  state.lastTick = now;
  const elapsed = (now - state.startedAt) / 1000;
  const point = sampleSetpoint(state.program, elapsed);
  if (point.done) return stopProgram(i, '预设已完成 · 目标已归零', true);
  // Steps only need a new command at a transition; sine is sampled at 20 Hz.
  if (state.lastRef === undefined || state.program.mode === 'sine' || point.ref !== state.lastRef) {
    send({ type: 'setRef', channelId: i, ref: point.ref });
    state.lastRef = point.ref;
    setDisplayedRef(i, point.ref);
  }
  const step = point.step ? ` · 第 ${point.step}/${state.program.steps.length} 级` : '';
  const progress = state.program.cycles === 0
    ? `第 ${point.cycle} 轮 · 无限循环${step} · ${elapsed.toFixed(1)} s`
    : `第 ${point.cycle}/${state.program.cycles} 轮${step} · ${elapsed.toFixed(1)} / ${state.program.duration.toFixed(1)} s`;
  programMessage(i, progress);
}

function startProgram(i) {
  if (setpointPrograms.has(i)) return;
  if (!canRunProgram(i)) return programMessage(i, '请先绑定并使能速度环电机，等待最新反馈', true);
  const el = ch(i);
  const r = (role) => el.querySelector(`[data-role="${role}"]`);
  const spec = MOTOR_SPEC[MotorKindLabel[currentChannelKind(i)]];
  try {
    const program = createSetpointProgram({
      mode: r('presetMode').value,
      cycles: r('presetInfinite').checked ? 0 : r('presetCycles').valueAsNumber,
      amplitude: r('presetAmplitude').valueAsNumber,
      period: r('presetPeriod').valueAsNumber,
      steps: r('presetValues').value,
      dwell: r('presetDwell').valueAsNumber,
    }, spec.range);
    const now = performance.now();
    const state = { program, startedAt: now, lastTick: now, timer: null };
    setpointPrograms.set(i, state);
    state.timer = setInterval(() => tickProgram(i), 50);
    renderProgram(i);
    tickProgram(i);
  } catch (error) {
    programMessage(i, error.message, true);
  }
}

// Browsers throttle background timers. End the test instead of extending a step.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const i of pendingPidApplies.keys()) cancelPidResume(i);
    stopAllPrograms('页面已转入后台 · 自动输出已停止', true);
  }
});

// Capture Space even in inputs; suppress button activation on both key edges.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) send({ type: 'stopAll' });
}, true);
document.addEventListener('keyup', event => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

/* ---------------- 渲染 ---------------- */

function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return v.toFixed(digits);
}

// Keep live-region text stable while telemetry arrives at 10 Hz.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setupBlockReason() {
  if (ws.readyState !== 1) return ws.readyState === 0 ? '正在连接上位机服务，请稍候。' : '上位机服务已断开，请确认程序正在运行后重新加载页面。';
  if (!serialConnected) return '请先选择控制板的 USB 串口，点击「连接」。';
  if (!boardOnline) return '串口已打开，但控制板尚未应答。请检查控制板供电、USB 数据线和固件，再同步清单或重新连接。';
  if (!channelsReady) return channelResetError || '正在清理旧测试通道，请等待板端确认。';
  if (!inventoryReceived) return '控制板已应答，正在同步电机清单；若长时间未更新，请点击「同步清单」。';
  return '';
}

function renderGuidance() {
  const service = ws.readyState === 1;
  const blocked = setupBlockReason();
  const confirmed = channelIds().filter(i => sessionChannels.has(i) && telemetryByChannel.has(i));
  const online = confirmed.filter(i => telemetryByChannel.get(i).online && hasFreshTelemetry(i));
  const active = online.filter(i => telemetryByChannel.get(i).enabled);
  const state = (id, text, ok) => {
    const el = $(id);
    setText(el, text);
    el.classList.toggle('is-ready', ok);
  };
  state('#serviceState', service ? '服务 · 已连接' : ws.readyState === 0 ? '服务 · 连接中' : '服务 · 已断开', service);
  state('#boardState', boardOnline ? '控制板 · 已应答' : serialConnected ? '控制板 · 等待应答' : '控制板 · 未连接', service && serialConnected && boardOnline);
  state('#feedbackState', !boardOnline || !confirmed.length ? '电机反馈 · 未就绪' : `电机反馈 · ${online.length}/${confirmed.length} 在线`, boardOnline && online.length > 0);
  setText($('#connectionMessage'), blocked || '控制板与清单已就绪。登记成功不代表电机在线，绑定后会检查实际反馈。');
  $('#refreshPorts').disabled = !service;
  $('#portSelect').disabled = !service || serialConnected;
  $('#openPort').disabled = !service || serialConnected || !$('#portSelect').value;
  $('#closePort').disabled = !service || !serialConnected;
  $('#rescan').disabled = !service || !serialConnected || !!channelResetPending;
  const addReason = blocked || (pendingMotor ? '正在等待电机增删应答，请稍候。' : '');
  $('#addMotor').disabled = !!addReason;
  $('#addFirstMotor').disabled = !!addReason;
  $('#openAddMotor').disabled = !!addReason;
  $('#addMotor').title = addReason || '按实际型号与 ID 向控制板登记电机';
  $('#openAddMotor').title = addReason || '添加电机';
  setText($('#addAvailability'), blocked ? '请先完成控制板连接与清单同步，才能添加电机。' : addReason);
  $('#addAvailability').hidden = !addReason;
  setText($('#motorEmptyText'), !serialConnected ? '连接后读取电机清单' : !inventoryReceived ? '等待同步电机清单' : '尚未登记电机');

  let step = 0;
  let title = '连接控制板，开始测试';
  let message = blocked;
  let action = '选择串口';
  let target = '#portSelect';
  if (!service) {
    title = ws.readyState === 0 ? '正在连接上位机服务' : '上位机服务已断开';
    action = ws.readyState === 0 ? '请稍候' : '重新加载';
    target = 'reload';
  } else if (!serialConnected) {
    const hasPorts = !!$('#portSelect').value;
    message = hasPorts ? '选择控制板对应的 USB 串口，然后点击「连接」。串口打开后还需等待控制板应答。'
      : '未发现可用串口时，请检查控制板供电和 USB 数据线，再刷新串口列表。';
    action = hasPorts ? '选择串口' : '刷新串口';
    target = hasPorts ? '#portSelect' : '#refreshPorts';
  } else if (blocked) {
    title = channelResetError ? '连接尚未就绪' : !boardOnline ? '等待控制板应答' : '正在准备测试通道';
    action = '查看连接状态';
    target = '#connectionMessage';
  } else if (!inventory.length) {
    step = 1;
    title = pendingMotor ? '正在等待电机登记结果' : '添加第一颗电机';
    message = '按电机铭牌选择型号，CAN 总线和电调 ID 按实际设置填写。添加只登记配置，不会使电机转动。';
    action = pendingMotor ? '等待应答' : '添加电机';
    target = 'add';
  } else if (!confirmed.length) {
    step = 2;
    const waiting = channelIds().find(i => sessionChannels.has(i));
    title = waiting === undefined ? '电机已登记，接下来绑定通道' : '正在等待绑定后的反馈';
    message = waiting === undefined ? '在通道中选择要控制的电机，点击标题行的「绑定」。绑定用于指定这个通道控制哪颗电机。'
      : '尚未收到本通道遥测，暂不能使能。请等待反馈；长时间无应答时，可解绑重试或重新连接。';
    action = '前往通道';
    target = ch(waiting ?? channelIds()[0]);
  } else {
    step = 3;
    const i = active[0] ?? online[0] ?? confirmed[0];
    const stale = !online.length && confirmed.some(id => !hasFreshTelemetry(id));
    title = active.length ? '电机已使能，观察实际响应' : online.length ? '反馈已就绪，可以开始测试'
      : stale ? '通道反馈中断，等待最新遥测' : '通道已绑定，电机反馈离线';
    message = active.length ? '在曲线中对比目标与实测反馈。测试结束点击通道「停机」；顶部急停可立即停止全部电机。'
      : online.length ? '首次测试可保持目标为 0，点击「使能」，再手动设置适合当前负载的小目标。非零目标下使能会立即执行该目标。'
      : stale ? '通道遥测未更新，当前运行状态无法确认。请检查通信；需要停止全部电机时，点击顶部急停。'
      : '暂时无法使能。请检查电机供电、CAN 接线、所选总线及电调 ID；反馈恢复后，需手动使能。';
    action = active.length ? '查看运行通道' : online.length ? '前往测试' : '查看离线通道';
    target = ch(i);
  }
  for (const [i, el] of [...document.querySelectorAll('.workflow-steps li')].entries()) {
    el.dataset.state = i < step || (i === 3 && active.length && !blocked) ? 'done' : i === step ? 'current' : 'pending';
    if (i === step && el.dataset.state !== 'done') el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    setText(el.querySelector('small'), i === 0 ? step > 0 ? '连接已确认' : serialConnected ? '等待板端应答' : '选择 USB 串口'
      : i === 1 ? step > 1 ? '清单已同步' : '型号与 ID'
      : i === 2 ? step > 2 ? '绑定已确认' : '选择控制对象'
      : el.dataset.state === 'done' ? '输出已使能' : '观察实际反馈');
  }
  setText($('#guideTitle'), title);
  setText($('#guideMessage'), message);
  const button = $('#guideAction');
  setText(button, action);
  button.disabled = ws.readyState === 0 || (!!pendingMotor && target === 'add');
  button.onclick = () => {
    if (target === 'reload') return location.reload();
    if (target === 'add') return setAddFormOpen(true);
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    const focus = el.matches('.channel') ? el.querySelector('[data-role="motor"]:enabled')
      ?? el.querySelector('[data-role="enable"]:enabled') ?? el.querySelector('[data-role="channelHint"]') : el;
    if (focus && !focus.matches('button, input, select')) focus.tabIndex = -1;
    focus?.focus({ preventScroll: true });
    if (target === '#refreshPorts') el.click();
  };
}

function renderChannelGuidance(i) {
  const el = ch(i);
  if (!el) return;
  const r = role => el.querySelector(`[data-role="${role}"]`);
  const t = telemetryByChannel.get(i);
  let message = setupBlockReason();
  if (!message) {
    message = pendingUnbindChannels.has(i) ? '正在解绑，等待板端确认；本通道控制暂不可用。'
      : pendingLoopChanges.has(i) ? '正在确认闭环切换；确认前控制已锁定，超时后请解绑重试。'
      : pendingPidApplies.has(i) ? 'PID 应答尚未确认，暂不能设置目标或重新使能；请查看参数区的应用结果。'
      : !sessionChannels.has(i) ? (r('motor').value === '' ? '先选择要控制的电机，再点击标题行的「绑定」。' : '已选择电机，点击标题行的「绑定」后等待实际反馈。')
      : !t ? '已发送绑定请求，等待板端遥测；尚不能使能。长时间无应答时，请解绑重试或重新连接。'
      : !hasFreshTelemetry(i) ? '通道反馈已中断，当前运行状态无法确认，暂不能使能或设置目标。请检查通信；需要停止时点击顶部急停。'
      : !t.online ? '使能不可用：未收到电机反馈。请核对电机供电、CAN 接线、总线和电调 ID；恢复后需手动使能。'
      : t.enabled ? '电机已使能。观察目标与实测曲线，测试结束点击「停机」。'
      : Number(r('num').value) !== 0 ? `当前未使能。点击「使能」后将立即执行 ${r('num').value} ${r('unit').textContent} 的目标，请先确认。`
      : '反馈已就绪，当前未使能。首次可先以零目标使能，再手动设置小目标观察响应。';
  }
  setText(r('channelHint'), message);
  r('channelHint').classList.toggle('is-blocked', !!setupBlockReason() || !!(t && (!t.online || !hasFreshTelemetry(i))));
  r('bind').title = r('bind').disabled ? message : '把所选电机指定给本通道；绑定后仍需使能';
  r('enable').title = r('enable').disabled ? message : t?.enabled ? '停止本通道电机并取消自动输出' : '使能后立即执行目标框中的数值';
  setText(r('chartEmptyText'), sessionChannels.has(i) ? '已请求绑定，等待板端遥测' : '选择电机并绑定后显示实际反馈');
}

function renderChannel(i) {
  const el = ch(i);
  if (!el) return;
  const t = telemetryByChannel.get(i);
  el.dataset.state = !t ? 'idle' : !boardOnline || !t.online || !hasFreshTelemetry(i) ? 'offline' : t.enabled ? 'running' : 'bound';

  const badge = el.querySelector('[data-role="status"]');
  if (!t) {
    badge.textContent = '未绑定';
    badge.className = 'badge';
  } else if (!boardOnline) {
    badge.textContent = '数据中断';
    badge.className = 'badge offline';
  } else if (!hasFreshTelemetry(i)) {
    badge.textContent = '反馈中断';
    badge.className = 'badge offline';
  } else if (!t.online) {
    badge.textContent = '离线 · 自动重连中';
    badge.className = 'badge offline';
  } else if (t.enabled) {
    badge.textContent = '运行中';
    badge.className = 'badge running';
  } else {
    badge.textContent = '已绑定';
    badge.className = 'badge bound';
  }

  const r = (role) => el.querySelector(`[data-role="${role}"]`);
  const spec = MOTOR_SPEC[MotorKindLabel[currentChannelKind(i)]];
  const positionMode = !!((boundLoopMasks.get(i) ?? readLoopMask(i)) & LoopType.ANGLE_LOOP);
  const speedUnit = positionMode ? 'deg' : (spec?.unit || 'rpm');
  const primaryLabel = positionMode ? '实测位置' : '实测转速';
  const feedbackLabel = spec?.feedbackLabel || '反馈';
  const feedbackUnit = spec?.feedbackUnit || 'raw';
  r('speedLegend').textContent = `${primaryLabel}（${speedUnit}）`;
  r('torqueLegend').textContent = `${feedbackLabel}（${feedbackUnit}）`;
  r('chart').setAttribute('aria-label', `${primaryLabel}（${speedUnit}）与${feedbackLabel}（${feedbackUnit}）实时曲线`);
  r('targetTitle').textContent = positionMode ? '目标位置 · 每次使能时当前位置为 0°' : '目标设定';
  r('unit').textContent = speedUnit;
  r('slider').min = String(positionMode ? -360 : -(spec?.range || 6000));
  r('slider').max = String(positionMode ? 360 : (spec?.range || 6000));
  r('num').min = r('slider').min;
  r('num').max = r('slider').max;
  r('slider').step = positionMode ? '0.1' : '0.001';
  r('num').step = positionMode ? '0.1' : '0.001';
  r('num').title = positionMode ? '相对本次使能零点的转子角度（deg），范围 ±360°' : '精确输入目标转速后下发';
  r('num').setAttribute('aria-label', positionMode ? '目标位置角度' : '目标转速数值');
  r('slider').setAttribute('aria-label', positionMode ? '目标位置角度' : '目标转速');
  renderChannelTools(i, positionMode);
  if (!t) r('chart').removeAttribute('title');
  getChartIfExists(i)?.setUnits(speedUnit, feedbackUnit);
  const controllable = canControlChannel(i);
  r('bind').disabled = !!setupBlockReason() || sessionChannels.has(i) || !!t;
  r('motor').disabled = !!setupBlockReason() || sessionChannels.has(i) || !!t;
  r('unbind').disabled = !channelsReady || !sessionChannels.has(i) || pendingUnbindChannels.has(i);
  for (const role of ['enable', 'zero', 'num', 'slider']) r(role).disabled = !controllable;
  const loopLockReason = pendingLoopChanges.has(i) ? '正在确认闭环切换；超时后请解绑重试' :
    pendingUnbindChannels.has(i) ? '正在解绑，等待板端确认' :
    !sessionChannels.has(i) ? '' :
    !channelsReady ? '测试通道未就绪，请等待清理完成或重新连接' :
    !boardOnline || !hasFreshTelemetry(i) ? '未收到最新通道反馈，请检查连接并等待反馈恢复' :
    !serverSupportsLoop ? '后台未支持闭环切换，请重启 Node 服务后刷新网页' :
    !firmwareSupportsLoop ? (firmwareVersion ? `当前固件 ${firmwareVersion} 不支持绑定后切换，请更新到 1.6` :
      '未收到有效固件心跳，闭环切换暂不可用；请确认已烧录 1.6 并重连') : '';
  r('loopStatus').textContent = loopLockReason;
  r('loopStatus').hidden = !loopLockReason;
  for (const node of el.querySelectorAll('.fb-node:not(.is-locked)')) {
    const locked = !!loopLockReason;
    if (locked && !node.disabled) node.dataset.unboundTitle = node.title;
    node.disabled = locked;
    if (locked) node.title = loopLockReason;
    else if (node.dataset.unboundTitle) {
      node.title = node.dataset.unboundTitle;
      delete node.dataset.unboundTitle;
    }
  }
  for (const role of ['pidApply', 'pidQuery', 'pidReset', 'pKp', 'pKi', 'pKd', 'pMaxOut', 'pIntLim'])
    r(role).disabled = !controllable;
  r('pidApply').disabled = !controllable || pendingPidApplies.has(i);
  r('pidQuery').disabled = !controllable || pendingPidApplies.has(i);
  r('enable').disabled = !controllable || !t?.online || (pendingPidApplies.has(i) && !t?.enabled);
  renderProgram(i);
  renderChannelGuidance(i);
  const [fwMajor, fwMinor] = String(firmwareVersion ?? '0.0').split('.').map(Number);
  const speedMode = !!((boundLoopMasks.get(i) ?? readLoopMask(i)) & LoopType.SPEED_LOOP) && !positionMode;
  const sharedRamp = fwMajor > 1 || (fwMajor === 1 && fwMinor >= 18);
  const legacyFastZero = currentChannelKind(i) === MotorKind.DM &&
    (fwMajor > 1 || (fwMajor === 1 && fwMinor >= 17));
  const fastZero = !!spec && speedMode && (sharedRamp || legacyFastZero);
  const accel = spec?.unit === 'rpm' ? 30000 : 100;
  const zeroDecel = accel * 2;
  const accelUnit = spec?.unit === 'rpm' ? 'rpm/s' : 'rad/s²';
  const rampHint = fastZero
    ? `普通变速/反向按 ${accel} ${accelUnit} 过渡，目标为 0 时按 ${zeroDecel} ${accelUnit} 快速制动并保持使能；自动输出同样适用，曲线虚线表示最终目标。「停机」立即撤销使能。 `
    : speedMode && currentChannelKind(i) === MotorKind.DM && fwMajor === 1 && fwMinor === 16
      ? '速度目标按加减速限幅过渡（默认 10 rad/s²），自动输出同样适用；曲线虚线表示最终目标。「归零」平滑减速，「停机」立即执行。 ' : '';
  r('zero').textContent = fastZero ? '快速归零' : '归零';
  r('zero').classList.toggle('quick-zero', fastZero);
  r('zero').title = positionMode ? '将目标设为本次使能的 0°，返回该零点；不重新定义零点'
    : fastZero ? `快速制动至 0 ${spec.unit}，保持速度闭环使能；停机按钮会撤销使能`
    : '把目标设为 0 并下发；电机仍保持当前使能状态';
  setText(r('targetHelp'), positionMode
    ? '每次从停机切换到使能，以当前位置为 0°；「归零」返回本次零点。M2006/M3508 显示转子角度，未换算输出轴角度。'
    : `${spec?.speedLimitHint ? spec.speedLimitHint + ' ' : ''}${rampHint}输入目标后按 Enter 或移开焦点下发；滑块松手时下发。未使能时可预填目标，点击使能执行；非零目标会立即转动。`);

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
   * 曲线空态占位(2026-10-16 视觉重构)。
   *
   * @attention 只切换占位层的 hidden,**绝不隐藏 canvas** ——
   *   隐藏会让 canvas 塌成 0 高度,chart.js 之后读到 0 尺寸就再也画不出曲线
   *   (与下方"懒创建实例"同一个坑的两面)。
   *   有遥测即隐藏占位,断开/解绑(t=null)时回到空态。
   */
  const emptyEl = r('chartEmpty');
  if (emptyEl) emptyEl.hidden = !!t;

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
  if (t?.online && boardOnline && hasFreshTelemetry(i)) {
    const canvas = el.querySelector('[data-role="chart"]');
    if (canvas) {
      const c = ensureChart(i, canvas);
      c.setUnits(speedUnit, feedbackUnit);
      canvas.title = positionMode
        ? `最近遥测：位置 ${fmt(t.angle, 3)} deg；转速 ${fmt(t.speed, 3)} ${spec?.unit || 'rpm'}；${feedbackLabel} ${fmt(t.torque, 3)} ${feedbackUnit}`
        : `最近遥测：转速 ${fmt(t.speed, 3)} ${speedUnit}；${feedbackLabel} ${fmt(t.torque, 3)} ${feedbackUnit}（曲线按当前滤波设置显示）`;
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

      if (positionMode) c.push(t.angle, t.torque, t.ref);
      else c.push(t.speed, t.torque, t.ref);
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
  fb.onChange = mask => {
    if (sessionChannels.has(i)) {
      if (!canControlChannel(i) || !serverSupportsLoop || !firmwareSupportsLoop) {
        fb.setMask(boundLoopMasks.get(i));
        return;
      }
      // DM MIT needs the host speed cascade to produce torque.
      if (needsRxId(currentChannelKind(i)) && !(mask & LoopType.SPEED_LOOP)) {
        fb.setMask(boundLoopMasks.get(i));
        const msg = ch(i).querySelector('[data-role="pidMsg"]');
        msg.className = 'hint error';
        msg.textContent = `${MotorKindLabel[currentChannelKind(i)]} 需保留速度环；可切换速度控制或位置＋速度串级`;
        return;
      }
      stopProgram(i, '闭环切换 · 自动输出已停止');
      send({ type: 'enable', channelId: i, enable: false });
      const timer = setTimeout(() => {
        if (!pendingLoopChanges.has(i)) return;
        const msg = ch(i)?.querySelector('[data-role="pidMsg"]');
        if (msg) {
          msg.className = 'hint error';
          msg.textContent = '闭环切换未确认，控制已锁定；请解绑重试或重新连接';
        }
      }, 2000);
      pendingLoopChanges.set(i, { mask, timer });
      setDisplayedRef(i, 0);
      const msg = ch(i).querySelector('[data-role="pidMsg"]');
      msg.className = 'hint';
      msg.textContent = '正在停机并切换闭环…';
      renderChannel(i);
      send({ type: 'setLoop', channelId: i, mask });
      return;
    }
    setDisplayedRef(i, 0);
    getChartIfExists(i)?.clear();
    renderChannel(i);
  };

  /*
   * 右键某个环 → 把下方 PID 卡片切到该环，不改变闭环状态。
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
 * 闭环位 → PID 协议环编号的映射。
 *
 * @attention 位掩码与 PID 协议环编号是两套编号,必须显式对应:
 *   0=速度环 / 1=电流环 / 2=位置环
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
  if (needsRxId(currentChannelKind(i)) && bit === LoopType.CURRENT_LOOP) return;

  const loopVal = BIT_TO_PID_LOOP[bit];
  const panel = el.querySelector('[data-role="pidPanel"]');
  if (loopVal === undefined || !panel) return;

  if (panel.dataset.loop === loopVal && pidStateByChannel.get(i)?.loop === Number(loopVal)) return;

  /* 切环后把该环的默认值填进输入框 */
  fillPidForm(i, loopVal);
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
     * 用 (kind, canBus, motorId) 三元组而非下标记忆:
     * 下标会随电机增删而漂移,不可靠。
     */
    const prevKey = sel.selectedOptions[0]?.dataset.motorKey ?? null;

    sel.innerHTML = '<option value="">选择电机…</option>';
    let restoredIdx = '';
    inventory.forEach((m, idx) => {
      const label = `${m.label} · CAN${m.canBus}·ID${formatMotorId(m)}`;
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.dataset.motorKey = `${m.kind}:${m.canBus}:${m.motorId}`;
      opt.textContent = label;
      sel.appendChild(opt);
      if (prevKey && `${m.kind}:${m.canBus}:${m.motorId}` === prevKey) {
        restoredIdx = String(idx);
      }
    });

    /* 电机仍在清单里才恢复选中;被删了才回到未选择 */
    sel.value = restoredIdx;
    if (prevKey && restoredIdx === '') {
      clearPendingPid(i);
      clearPendingLoop(i);
      stopProgram(i, '电机已删除');
      sessionChannels.delete(i);
      pendingUnbindChannels.delete(i);
      telemetryByChannel.delete(i);
      getChartIfExists(i)?.clear();
      boundLoopMasks.delete(i);
      el.querySelector('[data-role="num"]').value = '0';
      el.querySelector('[data-role="slider"]').value = '0';
      renderChannel(i);
    }

    sel.onchange = () => {
      const m = sel.value === '' ? null : inventory[Number(sel.value)];
      const spec = m ? MOTOR_SPEC[m.label] : null;
      // 注意:这里复用外层的 el,不要用 const el 重新声明 ——
      // 那会遮蔽外层变量,虽然当前逻辑上取值相同,但极易在后续改动中出错。
      if (spec && el) {
        el.querySelector('[data-role="unit"]').textContent = spec.unit;
        el.querySelector('[data-role="slider"]').min = String(-spec.range);
        el.querySelector('[data-role="slider"]').max = String(spec.range);
        for (const unit of el.querySelectorAll('[data-role="presetUnit"]')) unit.textContent = spec.unit;
        const amplitude = spec.unit === 'rad/s' ? 1 : 500;
        el.querySelector('[data-role="presetAmplitude"]').value = String(amplitude);
        el.querySelector('[data-role="presetValues"]').value = `0, ${amplitude}, ${amplitude * 2}, ${amplitude}, 0`;
      }
      renderChannel(i);
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
  const selection = el.querySelector('[data-role="motor"]').value;
  if (selection === '') return 0;
  const idx = Number(selection);
  const m = inventory[idx];
  return m ? m.kind : 0;
}

function pidOutputSpec(kind, loop) {
  if (needsRxId(kind)) {
    if (loop === 0) return { unit: 'N·m', max: kind === MotorKind.DM8009P ? 54 : 7 };
    if (loop === 2) return { unit: 'rad/s', max: [MotorKind.DM, MotorKind.DM8009P].includes(kind) ? MOTOR_SPEC[MotorKindLabel[kind]].range : 30 };
    return { unit: '', max: null };
  }
  return { unit: kind ? (loop === 2 ? 'deg/s' : 'raw') : '', max: null };
}

function updatePidUnits(i, kind, loop) {
  const el = ch(i);
  const spec = pidOutputSpec(kind, loop);
  for (const role of ['pMaxOut', 'pIntLim']) {
    el.querySelector(`[data-role="${role}Unit"]`).textContent = spec.unit;
    el.querySelector(`[data-role="${role}"]`).step = needsRxId(kind) ? '0.001' : '1';
  }
  const output = el.querySelector('[data-role="pMaxOut"]');
  if (spec.max === null) output.removeAttribute('max');
  else output.max = String(spec.max);
  output.title = kind === MotorKind.DM && loop === 0
    ? '额定转矩 3 N·m，峰值 7 N·m；峰值不能作为持续工作转矩'
    : [MotorKind.DM, MotorKind.DM8009P].includes(kind) && loop === 2
    ? `位置环输出目标速度，允许范围 0～${spec.max} rad/s；按 24 V 空载转速上限设置`
    : spec.max === null ? `PID 输出的绝对值上限${spec.unit ? `（${spec.unit}）` : ''}`
    : `允许范围 0～${spec.max} ${spec.unit}（当前 MIT 协议量程上限，非建议工作值）`;
  const help = el.querySelector('[data-role="pidOutputHelp"]');
  help.hidden = !kind || loop !== 2;
  help.textContent = loop === 2
    ? `位置环输出的是目标速度（${spec.unit}），目标位置使用 deg。${[MotorKind.DM, MotorKind.DM8009P].includes(kind) ? `24 V 下最大追踪速度限幅为 ${spec.max} rad/s，与速度模式上限一致；带载可达转速更低。` : ''}`
    : '';
}

/**
 * 把某 kind + 某环的 PID 填入输入框
 * @param i           通道号
 * @param loopStr     PID 协议环编号('0'速度 '1'电流 '2'位置)
 * @param kindOverride 可选,指定 kind(默认取该通道绑定的电机)
 */
function fillPidForm(i, loopStr, kindOverride) {
  const el = ch(i);
  if (!el) return;
  const kind = kindOverride || currentChannelKind(i);
  const r = (role) => el.querySelector(`[data-role="${role}"]`);

  const preset = PID_DEFAULTS[kind];
  r('pidPanel').dataset.loop = String(loopStr);
  r('pidTitle').textContent = `${['速度环', '电流环', '位置环'][Number(loopStr)]} PID`;
  const loopName = ['speed', 'current', 'angle'][Number(loopStr)] || 'speed';
  const p = preset ? preset[loopName] : null;

  r('pKp').value = p ? p.Kp : 0;
  r('pKi').value = p ? p.Ki : 0;
  r('pKd').value = p ? p.Kd : 0;
  r('pMaxOut').value = p ? p.MaxOut : 0;
  r('pIntLim').value = p ? p.IntegralLimit : 0;
  updatePidUnits(i, kind, Number(loopStr));

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

  const kind = channelsReady && sessionChannels.has(i) && telemetryByChannel.has(i) ? currentChannelKind(i) : 0;
  const panel = el.querySelector('[data-role="pidPanel"]');
  const msg = el.querySelector('[data-role="pidMsg"]');
  if (needsRxId(kind) && panel.dataset.loop === '1') panel.dataset.loop = '0';
  updatePidUnits(i, kind, Number(panel.dataset.loop));

  /* 未绑定或闭环切换待确认时，禁止编辑和下发。 */
  const ctrls = [
    'pKp', 'pKi', 'pKd', 'pMaxOut', 'pIntLim',
    'pidApply', 'pidQuery', 'pidReset',
  ].map((role) => el.querySelector(`[data-role="${role}"]`));

  for (const c of ctrls) {
    if (c) c.disabled = !kind || pendingLoopChanges.has(i);
  }
  for (const role of ['pidApply', 'pidQuery'])
    el.querySelector(`[data-role="${role}"]`).disabled ||= pendingPidApplies.has(i);

  if (kind) {
    const previous = pidStateByChannel.get(i);
    if (previous?.kind !== kind || previous.loop !== Number(panel.dataset.loop))
      fillPidForm(i, panel.dataset.loop, kind);
    if (msg && msg.textContent === '先绑定电机后可用') msg.textContent = '';
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
  $('#portSelect').onchange = () => renderGuidance();
  $('#openPort').onclick = () => {
    const path = $('#portSelect').value;
    if (!path) return alert('请先选择串口');
    $('#connectionError').hidden = true;
    send({ type: 'openSerial', path, baud: 115200 });
  };
  $('#closePort').onclick = () => send({ type: 'closeSerial' });
  $('#rescan').onclick = () => {
    if (!channelsReady) resetTestChannels();
    send({ type: 'scanMotors' });
  };

  $('#openAddMotor').onclick = () => setAddFormOpen($('#addForm').hidden);
  $('#addFirstMotor').onclick = () => {
    setAddFormOpen(true);
    $('#addForm').scrollIntoView({ block: 'center' });
  };
  $('#cancelAddMotor').onclick = () => setAddFormOpen(false);
  $('#addForm').onkeydown = (event) => {
    if (event.key === 'Escape') setAddFormOpen(false);
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      $('#addMotor').click();
    }
  };
  $('#addMotor').onclick = () => {
    const kind = Number($('#addKind').value);
    const canBus = Number($('#addBus').value);
    if (pendingMotor) return;
    if (kind === MotorKind.DM8009P) {
      const [major, minor] = String(firmwareVersion ?? '').split('.').map(Number);
      if (!(major > 1 || (major === 1 && minor >= 7))) {
        showAddMsg('DM8009P 需要固件 1.7 或更新版本，请先烧录并重新连接', true);
        return;
      }
    }
    const id = readMotorIdInput();
    if (!id.ok) {
      showAddMsg(id.msg, true);
      return;
    }
    const motorId = id.value;

    /* DM 的反馈 ID 单独校验(2026-10-17 新增,达妙需要 tx/rx 两个 ID) */
    const rx = readRxIdInput();
    if (!rx.ok) {
      showAddMsg(rx.msg, true);
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
    sendMotorEdit({ type: 'addMotor', kind, canBus, motorId, rxId: rx.value });
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
   *
   * @note #addRxId 也在列表里(2026-10-17):达妙的反馈 ID 改一个字
   *   都要重新校验一遍,免得用户填了个越界值还不知道。
   */
  for (const id of ['#addKind', '#addBus', '#addId', '#addRxId']) {
    $(id).oninput = refreshAddHint;
    $(id).onchange = refreshAddHint;
  }

  /* 型号一变,rx_id 输入框的可见性就要跟着变(只有达妙需要它) */
  $('#addKind').onchange = () => {
    syncRxIdVisibility();
    refreshAddHint();
  };
  syncRxIdVisibility();

  // 页面关闭前尽量通知服务端全停(beforeunload + sendBeacon 兜底)
  window.onbeforeunload = () => send({ type: 'stopAll' });

  for (const i of channelIds()) {
    const el = ch(i);
    const r = (role) => el.querySelector(`[data-role="${role}"]`);

    r('bind').onclick = () => {
      if (setupBlockReason() || sessionChannels.has(i)) return;
      if (r('motor').value === '') return alert('请先选择电机');
      const idx = Number(r('motor').value);
      const m = inventory[idx];
      if (!m) return alert('请先选择电机');
      if ([...sessionChannels].some((id) => id !== i &&
        ch(id)?.querySelector('[data-role="motor"]').selectedOptions[0]?.dataset.motorKey === `${m.kind}:${m.canBus}:${m.motorId}`)) {
        return alert('这颗电机已绑定其他通道，请先解绑');
      }

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
      boundLoopMasks.set(i, mask);
      sessionChannels.add(i);
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
      renderChannel(i);
      renderGuidance();
    };

    /*
     * @attention 换选电机后必须刷新 PID 面板。
     *   currentChannelKind() 读的是下拉框当前值,而 PID 默认值按型号不同
     *   (M3508 Kp=20 / M2006 Kp=10 / 6020 Kp=50)。不跟着换,
     *   会出现"下拉框选了 M2006,面板里却还摆着 M3508 的参数"。
     */
    r('motor').onchange = () => {
      initPidPanel(i);
      renderChannel(i);
    };

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
      if (pendingUnbindChannels.has(i)) return;
      if (!confirm('解绑后该通道将不再控制任何电机,需重新绑定。确认继续?')) return;
      pendingUnbindChannels.add(i);
      /* 先停机:安全动作不依赖解绑帧是否被接受 */
      send({ type: 'enable', channelId: i, enable: false });
      send({ type: 'unbind', channelId: i });
      renderChannel(i);
      /* 界面状态等 unbindAck 到达后再清,见 ws.onmessage 的 'unbindAck' */
    };

    const slider = r('slider');
    const num = r('num');
    for (const name of ['preset', 'calculator']) {
      const tab = r(`${name}Tab`);
      tab.onclick = () => selectChannelTool(i, name);
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'preset' : event.key === 'End' ? 'calculator' : (name === 'preset' ? 'calculator' : 'preset');
        if (r(`${next}Tab`).disabled) return;
        selectChannelTool(i, next);
        r(`${next}Tab`).focus();
      };
    }
    r('presetMode').onchange = () => renderProgram(i);
    r('presetInfinite').onchange = () => renderProgram(i);
    r('presetStart').onclick = () => startProgram(i);
    r('presetStop').onclick = () => stopProgram(i, '已停止 · 目标已归零', true);
    slider.oninput = () => {
      num.value = slider.value;
      renderChannelGuidance(i);
    };
    num.oninput = () => renderChannelGuidance(i);
    // 松手时才下发,避免拖动时刷屏
    slider.onchange = () => send({ type: 'setRef', channelId: i, ref: Number(slider.value) });
    num.onchange = () => {
      slider.value = num.value;
      send({ type: 'setRef', channelId: i, ref: Number(num.value) });
    };
    num.onkeydown = event => {
      if (event.key !== 'Enter' || !canControlChannel(i) || setpointPrograms.has(i)) return;
      event.preventDefault();
      num.onchange();
    };

    r('enable').onclick = () => {
      if (!canControlChannel(i)) return;
      const t = telemetryByChannel.get(i);
      const enable = !(t && t.enabled);
      if (enable && Number(num.value) !== 0) {
        if (!confirm('该通道当前设定值不为 0,使能后电机会立即转动。确认继续?')) return;
      }
      send({ type: 'enable', channelId: i, enable, ref: Number(num.value) });
    };

    r('zero').onclick = () => {
      cancelPidResume(i);
      stopProgram(i, '已停止 · 目标已归零');
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
    const pidPanel = r('pidPanel');
    const pidMsg = r('pidMsg');

    const stopForPidEdit = () => {
      if (!canControlChannel(i)) return;
      send({ type: 'enable', channelId: i, enable: false });
      setDisplayedRef(i, 0);
      send({ type: 'setRef', channelId: i, ref: 0 });
      pidMsg.className = 'hint';
      pidMsg.textContent = pendingPidApplies.has(i)
        ? '参数再次修改，保持停机；本次回执不再自动使能，请确认后重新应用'
        : '已请求停机 · 目标已归零';
    };
    for (const role of ['pKp', 'pKi', 'pKd', 'pMaxOut', 'pIntLim'])
      r(role).oninput = stopForPidEdit;

    // 右键鱼骨图节点选择要整定的环，左键仅改变闭环状态。

    r('pidReset').onclick = () => {
      const kind = currentChannelKind(i);
      fillPidForm(i, pidPanel.dataset.loop, kind);
      stopForPidEdit();
      pidMsg.className = 'hint';
      pidMsg.textContent = kind ? '已恢复默认值 · 已请求停机归零' : '请先绑定电机';
    };

    r('pidQuery').onclick = () => {
      send({ type: 'pidQuery', channelId: i });
      pidMsg.className = 'hint';
      pidMsg.textContent = '正在读取板端参数…';
    };

    r('pidApply').onclick = () => {
      if (!canControlChannel(i) || pendingUnbindChannels.has(i) || pendingPidApplies.has(i)) return;
      const kind = currentChannelKind(i);
      if (!kind) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = '请先绑定电机';
        return;
      }
      stopForPidEdit();
      const Kp = r('pKp').valueAsNumber;
      const Ki = r('pKi').valueAsNumber;
      const Kd = r('pKd').valueAsNumber;
      const MaxOut = r('pMaxOut').valueAsNumber;
      const IntegralLimit = r('pIntLim').valueAsNumber;
      if (![Kp, Ki, Kd, MaxOut, IntegralLimit].every(value => Number.isFinite(value) && value >= 0)) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = 'PID 参数及限幅必须为非负有限数值，不能留空';
        return;
      }
      if ([Kp, Ki, Kd].some(value => value > 655.35)) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = 'Kp/Ki/Kd 不能超过协议上限 655.35';
        return;
      }
      const loop = Number(pidPanel.dataset.loop);
      const spec = pidOutputSpec(kind, loop);
      if (needsRxId(kind) && loop === 1) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = `${MotorKindLabel[kind]} 电流环由电调内部控制，测试台仅支持速度环和位置环 PID`;
        return;
      }
      if (spec.max !== null && MaxOut > spec.max) {
        pidMsg.className = 'hint error';
        pidMsg.textContent = `${MotorKindLabel[kind]} ${loop === 0 ? '速度' : '位置'}环输出限幅须为 0～${spec.max} ${spec.unit}${kind === MotorKind.DM8009P && loop === 2 ? '（24 V 空载转速上限）' : ''}；当前填写 ${MaxOut} ${spec.unit}，未下发`;
        return;
      }
      send({ type: 'pidSet', channelId: i, loop, pid: { Kp, Ki, Kd, MaxOut, IntegralLimit, scaledLimits: needsRxId(kind) } });
      if (ws.readyState !== 1 || !serialConnected || !boardOnline) return;
      const pending = { loop, resume: true, timer: null };
      pending.timer = setTimeout(() => {
        if (pendingPidApplies.get(i) !== pending) return;
        pending.resume = false;
        pidMsg.className = 'hint error';
        pidMsg.textContent = 'PID 应用未收到确认，保持停机；请等待回执或解绑重连后重试';
        send({ type: 'enable', channelId: i, enable: false });
      }, 2000);
      pendingPidApplies.set(i, pending);
      pidMsg.className = 'hint';
      pidMsg.textContent = '正在应用 PID；确认成功后自动零目标使能…';
      renderChannel(i);
    };
  }
}

/* ---------------- WebSocket ---------------- */

ws.onopen = () => {
  setLink(true, '服务已连接');
  send({ type: 'listPorts' });
};

ws.onclose = () => {
  serverSupportsReset = false;
  serverSupportsLoop = false;
  firmwareSupportsLoop = false;
  firmwareVersion = null;
  serialConnected = false;
  serialPath = null;
  inventoryReceived = false;
  clearTimeout(channelResetTimer);
  channelResetPending = null;
  clearInterval(inventoryTimer);
  inventoryTimer = null;
  clearTestChannels();
  boardOnline = false;
  boardLastSeen = null;
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
    case 'hello': {
      serverSupportsReset = msg.capabilities?.includes('resetChannels') === true;
      serverSupportsLoop = msg.capabilities?.includes('setLoop') === true;
      if (!serverSupportsReset) {
        channelResetError = '后台版本过旧 · 请重启上位机服务';
        showRegistryMsg(channelResetError, true);
        setLink(false, channelResetError);
      }
      break;
    }
    case 'ports': {
      const sel = $('#portSelect');
      const selected = sel.value;
      sel.innerHTML = '';
      if (!msg.ports.length) {
        sel.innerHTML = '<option value="">未发现串口</option>';
        break;
      }
      for (const p of msg.ports) {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
        sel.appendChild(opt);
      }
      if ([...sel.options].some(opt => opt.value === selected)) sel.value = selected;
      break;
    }

    case 'serial': {
      const sameConnection = serialConnected && msg.open && serialPath === msg.path;
      serialConnected = !!msg.open;
      serialPath = msg.open ? msg.path : null;
      if (sameConnection) break;
      inventoryReceived = false;
      $('#connectionError').hidden = true;
      $('#fwText').textContent = '';
      firmwareSupportsLoop = false;
      firmwareVersion = null;
      clearTimeout(channelResetTimer);
      channelResetPending = null;
      boardOnline = false;
      boardLastSeen = null;
      setLink(msg.open, msg.open ? `串口 ${msg.path ?? ''}` : '串口已关闭');
      if (msg.open) {
        resetTestChannels();
        startInventoryFetch();
      } else {
        clearInterval(inventoryTimer);
        inventoryTimer = null;
        clearTestChannels();
      }
      break;
    }

    case 'heartbeat': {
      const d = msg.data;
      const versionChanged = firmwareVersion !== d.fwVersion;
      firmwareVersion = d.fwVersion;
      const [major, minor] = String(d.fwVersion).split('.').map(Number);
      const supported = major > 1 || (major === 1 && minor >= 5);
      const changed = versionChanged || firmwareSupportsLoop !== supported || !boardOnline;
      firmwareSupportsLoop = supported;
      noteBoardResponse();
      if (changed) for (const i of channelIds()) renderChannel(i);
      setLink(true, 'A 板在线');
      $('#fwText').textContent = `固件 ${d.fwVersion} · ${Math.round(d.uptimeS / 60)} 分钟`;
      // 收到心跳说明板子已在跑,若清单还没拿到就再要一次(见 startInventoryFetch 注释)
      if (!inventory.length) startInventoryFetch();
      break;
    }

    case 'inventory': {
      noteBoardResponse();
      inventoryReceived = true;
      $('#connectionError').hidden = true;
      // 板端登记的电机清单:界面只能从中选择,不会虚报不存在的电机
      inventory = msg.data.items.map((m) => ({
        ...m,
        label: MotorKindLabel[m.kind] ?? `未知类型(${m.kind})`,
      }));

      // Resize only the surplus/new cards; surviving firmware channel IDs stay fixed.
      buildChannels(inventory.length);

      /*
       * 刷新各通道的电机下拉框。
       * @attention 必须在 buildChannels() 之后 —— 新建的卡片还没有选项。
       *   fillMotorOptions 本身会记住并恢复已有选择(见其内部注释),
       *   所以刷新清单不会夺走用户已选的电机。
       */
      fillMotorOptions();

      /* 登记列表以板端清单为准,增删成功后自动刷新。 */
      renderMotorList();

      /*
       * 拿到清单后初始化各通道的 PID 面板。
       * @attention 必须在 fillMotorOptions() 之后 —— 该函数才把
       *   下拉框的 value 设成实际电机索引,currentChannelKind() 靠它取 kind。
       *   顺序反了会读不到 kind,PID 面板被隐藏。
       */
      for (const i of channelIds()) {
        initPidPanel(i);
        renderChannel(i);
      }

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
      const d = msg.data;
      if (!pendingMotor || d.kind !== pendingMotor.kind || d.canBus !== pendingMotor.canBus || d.motorId !== pendingMotor.motorId) break;
      const adding = pendingMotor.type === 'addMotor';
      pendingMotor = null;
      clearTimeout(addPendingTimer);
      addPendingTimer = null;
      const ok = d.result === MBResult.OK;
      const text = ok
        ? `已${adding ? '添加' : '删除'} ${MotorKindLabel[d.kind]} · CAN${d.canBus} · ID ${formatMotorId(d)}`
        : MBResultText[d.result] ?? `失败(错误码 ${d.result})`;
      showRegistryMsg(text, !ok);
      if (adding) {
        showAddMsg(text, !ok);
        if (ok) setAddFormOpen(false);
      }
      renderMotorList();
      send({ type: 'scanMotors' });
      break;
    }

    case 'unbindAck': {
      if (channelResetPending) {
        const d = msg.data;
        // Ignore duplicate replies from a retry and replies for other channels.
        if (d.channelId !== channelResetPending.values().next().value) break;
        if (d.result !== MBResult.OK && d.result !== MBResult.BAD_PARAM) {
          clearTimeout(channelResetTimer);
          channelResetPending = null;
          channelResetError = '旧通道清理失败 · 点击同步清单重试';
          showRegistryMsg(channelResetError, true);
          setLink(false, channelResetError);
          break;
        }
        clearTimeout(channelResetTimer);
        channelResetPending.delete(d.channelId);
        channelResetAttempts = 0;
        if (!channelResetPending.size) {
          clearTimeout(channelResetTimer);
          channelResetPending = null;
          channelResetTimer = null;
          channelResetError = '';
          showRegistryMsg('');
          channelsReady = true;
          noteBoardResponse();
          for (const i of channelIds()) renderChannel(i);
          setLink(true, 'A 板在线 · 请重新绑定电机');
        } else sendResetChannel();
        break;
      }
      /*
       * 固件确认解绑完成 —— 这时才清界面状态。
       *
       * @attention 之前是"点按钮就本地清空",不等应答。绑定被固件拒绝时
       *   (MB_ERR_DUPLICATE 等)界面与板端就会不一致:
       *   界面显示"未绑定",板子上却还占着通道、电机照转。
       *   改成等应答再清,失败时把真实原因显示出来。
       */
      const d = msg.data;
      // Reset retries can produce late duplicate ACKs. Only a deliberate
      // unbind in this page may clear a channel after reset has finished.
      if (!pendingUnbindChannels.delete(d.channelId)) break;
      if (d.result === MBResult.OK) {
        clearPendingLoop(d.channelId);
        sessionChannels.delete(d.channelId);
        boundLoopMasks.delete(d.channelId);
        telemetryByChannel.delete(d.channelId);
        getChartIfExists(d.channelId)?.clear();
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
        renderChannel(d.channelId);
        setLink(true, `通道 ${d.channelId} 解绑失败: ${MBResultText[d.result] ?? d.result}`);
      }
      break;
    }

    case 'loopAck': {
      const d = msg.data;
      const pending = pendingLoopChanges.get(d.channelId);
      if (!pending || pending.mask !== d.mask || pendingUnbindChannels.has(d.channelId)) break;
      clearPendingLoop(d.channelId);
      const el = ch(d.channelId);
      if (!el) break;
      const ok = d.result === MBResult.OK;
      if (ok) {
        boundLoopMasks.set(d.channelId, d.mask);
        setDisplayedRef(d.channelId, 0);
        const t = telemetryByChannel.get(d.channelId);
        if (t) telemetryByChannel.set(d.channelId, { ...t, enabled: false, ref: 0 });
        getChartIfExists(d.channelId)?.clear();
      }
      for (const node of el.querySelectorAll('.fb-node')) delete node.dataset.unboundTitle;
      fishbones.get(d.channelId)?.setMask(boundLoopMasks.get(d.channelId));
      renderChannel(d.channelId);
      const status = el.querySelector('[data-role="pidMsg"]');
      status.className = ok ? 'hint ok' : 'hint error';
      status.textContent = ok ? '闭环已切换，目标已归零；请重新使能' :
        `闭环切换失败：${MBResultText[d.result] ?? d.result}`;
      if (ok) send({ type: 'pidQuery', channelId: d.channelId });
      break;
    }

    case 'telemetry': {
      noteBoardResponse();
      setLink(true, 'A 板在线');
      for (const it of msg.data.items) {
        if (!channelsReady || !sessionChannels.has(it.channelId)) continue;
        const previous = telemetryByChannel.get(it.channelId);
        const first = !previous;
        telemetryByChannel.set(it.channelId, { ...it, receivedAt: performance.now() });
        if (!it.online) {
          cancelPidResume(it.channelId);
          stopProgram(it.channelId, '电机离线 · 自动重连中，恢复后请手动使能');
          setDisplayedRef(it.channelId, 0);
        } else if (previous && !previous.online) {
          setDisplayedRef(it.channelId, 0);
          getChartIfExists(it.channelId)?.clear();
          programMessage(it.channelId, '电机已重连 · 目标已归零，请手动使能');
        }
        if (first) initPidPanel(it.channelId);
        renderChannel(it.channelId);
      }
      updateWorkspaceStatus();
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
      const pending = pendingPidApplies.get(d.channelId);
      if (pending && pending.loop !== d.loop) break;
      clearPendingPid(d.channelId);
      if (d.result === MBResult.OK) {
        m.className = 'hint ok';
        const t = telemetryByChannel.get(d.channelId);
        const resume = pending?.resume && canControlChannel(d.channelId) &&
          !pendingUnbindChannels.has(d.channelId) && serialConnected && boardOnline &&
          ws.readyState === 1 && !document.hidden && t?.online && performance.now() - t.receivedAt < 500;
        if (resume) {
          setDisplayedRef(d.channelId, 0);
          send({ type: 'enable', channelId: d.channelId, enable: true, ref: 0 });
        }
        m.textContent = resume ? 'PID 已应用；已自动下发零目标使能' : 'PID 已应用；保持停机，未自动使能';
      } else {
        m.className = 'hint error';
        const kind = currentChannelKind(d.channelId);
        const spec = pidOutputSpec(kind, d.loop);
        if (d.result === MBResult.UNSUPPORTED) {
          m.textContent = needsRxId(kind) && d.loop === 1
            ? `${MotorKindLabel[kind]} 电流环由电调内部控制，测试台仅支持速度环和位置环 PID`
            : `板端拒绝该 PID 环或参数范围${spec.max === null ? '' : `；输出限幅须为 0～${spec.max} ${spec.unit}`}，请检查参数与固件支持`;
        } else if (d.result === MBResult.BAD_PARAM) {
          m.textContent = `PID 参数无效、超出范围或通道未就绪${spec.max === null ? '' : `；输出限幅须为 0～${spec.max} ${spec.unit}`}`;
        } else {
          m.textContent = MBResultText[d.result] ?? `下发失败(错误码 ${d.result})`;
        }
      }
      renderChannel(d.channelId);
      break;
    }

    case 'error': {
      for (const i of pendingPidApplies.keys()) cancelPidResume(i);
      stopAllPrograms('通信出错 · 自动输出已停止', true);
      if (channelResetPending) {
        clearTimeout(channelResetTimer);
        channelResetPending = null;
        channelResetTimer = null;
        channelResetError = `通道清理失败: ${msg.message}`;
        showRegistryMsg(channelResetError, true);
        setLink(false, channelResetError);
        break;
      }
      setLink(false, '出错');
      setText($('#connectionError'), `${msg.message}。请检查当前连接与配置后重试。`);
      $('#connectionError').hidden = false;
      break;
    }

    default:
      break;
  }
  renderGuidance();
};

function setLink(ok, text) {
  if (text === 'A 板在线' && serialConnected && !channelsReady) {
    ok = !!channelResetPending;
    text = channelResetPending ? '正在清理旧测试通道…' : channelResetError || '通道未就绪 · 点击同步清单重试';
  }
  document.body.dataset.link = ok ? 'online' : 'offline';
  $('#linkDot').classList.toggle('online', ok);
  $('#linkText').textContent = text;
  updateWorkspaceStatus();
}

function updateWorkspaceStatus() {
  $('#motorCount').textContent = String(inventory.length).padStart(2, '0');
  const active = [...telemetryByChannel].filter(([i, t]) => t.online && t.enabled && hasFreshTelemetry(i)).length;
  $('#activeCount').textContent = boardOnline && document.body.dataset.link === 'online'
    ? String(active).padStart(2, '0') : '--';
  renderGuidance();
}

/**
 * 依据板端上报的清单填充下拉。
 * @note 固件在心跳里给出已登记数量,随后由 MB_FRAME_INVENTORY_REPORT
 *       给出每一项的具体配置,界面据此列出可绑定的电机。
 */

// No motors means no cards; buildChannels also initializes global controls.
buildChannels();

renderMotorList();

document.querySelector('[data-open-calculator]').addEventListener('click', () => {
  const first = channelIds()[0];
  if (first !== undefined) selectChannelTool(first, 'calculator');
});

for (const link of document.querySelectorAll('.rail-link')) {
  link.addEventListener('click', () => {
    for (const item of document.querySelectorAll('.rail-link')) {
      item.classList.toggle('rail-current', item === link);
      if (item === link) item.setAttribute('aria-current', 'location');
      else item.removeAttribute('aria-current');
    }
  });
}
