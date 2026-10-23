import { calculateLoaderStep } from './calculator.js';
import { MBResultText } from './protocol.js';

let nextRequestId = 0;
const format = value => String(Number(value.toFixed(3)));

/** One accepted pointer-down owns one bounded move until feedback settles. */
export function initLoaderTest(host, adapter) {
  host.appendChild(document.getElementById('loaderTestTpl').content.cloneNode(true));
  const root = host.querySelector('.loader-test');
  const get = name => root.querySelector(`[data-test="${name}"]`);
  let armed = false;
  let held = false;
  let move = null;
  let requested = 0;
  let completed = 0;
  let message = '';
  let error = false;
  let target = null;

  function parameters() {
    const step = calculateLoaderStep(get('drive').value === 'direct' ? 1 : get('ratio').valueAsNumber,
      get('rounds').valueAsNumber, Number(get('shots').value), Number(get('direction').value));
    const tolerance = get('tolerance').valueAsNumber;
    if (!Number.isFinite(tolerance) || tolerance < 0.001 || tolerance > 1)
      throw new Error('到位容差需为 0.001～1° 输出轴角度');
    return { ...step, tolerance: Math.min(tolerance, Math.abs(step.delta) / 10) };
  }

  function stop(reason = '测试已退出', disable = true) {
    const wasArmed = armed;
    armed = false;
    held = false;
    move = null;
    message = reason;
    get('pad').dataset.held = 'false';
    if (wasArmed && disable) adapter.disable();
    if (wasArmed) adapter.displayTarget(0);
    if (wasArmed) adapter.onLockChange();
    refresh();
  }

  function refresh() {
    const state = adapter.getState();
    if (armed && (state.reason || !state.positionMode || !state.enabled)) {
      stop(`测试已中止：${state.reason || '位置环未使能'}`);
      return;
    }
    let step = null;
    let invalid = '';
    try { step = parameters(); } catch (e) { invalid = e.message; }
    if (move) {
      const now = performance.now();
      if ((!move.ack && now - move.started > 1500) || now - move.started > 60000) {
        error = true;
        stop(move.ack ? '位置未在 60 秒内到位 · 已停机，请检查负载与位置 PID' : '步进回执超时 · 已停机，请检查固件与连接');
        return;
      }
      if (move.ack && state.receivedAt !== move.lastSample) {
        move.lastSample = state.receivedAt;
        const atTarget = Math.abs(state.ref - move.target) < 0.1 &&
          Math.abs(state.angle - move.target) <= move.tolerance;
        move.settled = atTarget ? move.settled + 1 : 0;
        if (move.settled >= 3) {
          completed += move.shots;
          move = null;
          message = '本组已到位 · 松开后可再次按下';
        }
      }
    }
    get('ratioWrap').hidden = get('drive').value === 'direct';
    const repeatedGearbox = get('drive').value === 'reduction' && state.builtInRatio > 1 &&
      get('ratio').valueAsNumber === state.builtInRatio;
    get('ratioHint').hidden = !repeatedGearbox;
    get('ratioHint').textContent = repeatedGearbox
      ? `请确认：这里填的是额外 ${state.builtInRatio}:1 机械传动。电机内置 ${state.builtInRatio}:1 已自动换算；若拨盘直接接输出轴，请选“输出轴直连”。` : '';
    for (const name of ['rounds', 'drive', 'ratio', 'direction', 'tolerance']) get(name).disabled = armed;
    get('shots').disabled = !!move || held;
    get('perShot').value = step ? format(step.perShot) : '—';
    get('delta').value = step ? format(step.delta) : '—';
    get('target').value = target === null ? '—' : format(target);
    get('angle').value = Number.isFinite(state.angle) ? format(state.angle) : '—';
    const positionError = target === null || !Number.isFinite(state.angle) ? null : Math.abs(target - state.angle);
    get('positionError').value = positionError === null ? '—' : format(positionError);
    get('effectiveTolerance').value = step ? format(step.tolerance) : '—';
    get('requested').value = String(requested);
    get('completed').value = String(completed);
    const moving = state.positionMode && state.enabled && Number.isFinite(state.angle) && Math.abs(state.angle - state.ref) > state.tolerance;
    get('start').disabled = armed || !!state.reason || !!invalid || moving;
    get('start').textContent = armed ? '测试已启动 · 下方按下触发' : !state.positionMode ? '① 切换为位置环' : !state.enabled ? '② 使能位置环 · 当前位置置零' : '③ 开始测试 · 锁定角度目标';
    get('stop').disabled = !armed;
    // Keep the pad enabled during a move so pointer capture can receive release.
    get('pad').disabled = !armed;
    get('pad').setAttribute('aria-busy', String(!!move));
    get('padLabel').textContent = !armed ? '请先点击上方按钮准备并开始测试' : move ? (move.ack ? '正在执行 · 等待位置到位' : '等待板端确认…')
      : held ? '请先松开鼠标' : moving ? '位置偏离目标 · 等待回稳' : `鼠标左键按下 · ${get('shots').value === '2' ? '双发' : '单发'}`;
    get('status').classList.toggle('error', error || (!armed && !!invalid));
    get('status').textContent = armed ? (move?.ack && positionError !== null
      ? `等待到位 · 剩余 ${format(positionError)}° / 容差 ${format(move.tolerance)}° · 到位后松开并再次按下；如持续不收敛，请检查位置/速度 PID 与负载`
      : moving ? `位置偏离上一目标 ${format(Math.abs(state.angle - state.ref))}° · 请等待回稳后再按下，不会排队或自动重发` : message) : (invalid || state.reason || message ||
      (moving ? '请等待当前位置目标到位，再开始测试' : !state.positionMode ? '点击上方按钮切换位置环；确认后可在此使能并开始测试' :
        !state.enabled ? '点击上方按钮使能电机并保持当前位置，随后点击开始测试' : '参数已就绪 · 点击开始测试，再按下方触发区执行'));
  }

  get('start').onclick = () => {
    if (adapter.getState().reason) return refresh();
    try { parameters(); } catch { return refresh(); }
    const state = adapter.getState();
    message = ''; error = false;
    if (!state.positionMode) { adapter.selectPosition(); return refresh(); }
    if (!state.enabled) { adapter.enable(); return refresh(); }
    if (Math.abs(state.angle - state.ref) > state.tolerance) return refresh();
    armed = true;
    requested = completed = 0;
    target = null;
    message = '已接管位置目标 · 在下方区域按下鼠标触发';
    error = false;
    adapter.onLockChange();
    refresh();
  };
  get('stop').onclick = () => stop('测试已退出并停机 · 计数已保留');
  for (const name of ['rounds', 'drive', 'ratio', 'shots', 'direction', 'tolerance']) {
    get(name).addEventListener('input', () => { message = ''; error = false; refresh(); });
  }
  const pad = get('pad');
  function trigger() {
    const state = adapter.getState();
    if (move || state.reason || !state.positionMode || !state.enabled ||
        Math.abs(state.angle - state.ref) > state.tolerance) return refresh();
    const step = parameters();
    move = { ...step, requestId: nextRequestId++ & 0xffff, started: performance.now(), ack: false, settled: 0 };
    error = false;
    message = '等待板端确认本次位置步进…';
    adapter.trigger({ requestId: move.requestId, delta: step.delta });
    refresh();
  }
  pad.addEventListener('pointerdown', event => {
    if (event.button !== 0 || held || !armed) return;
    event.preventDefault();
    held = true;
    pad.dataset.held = 'true';
    if (event.isTrusted) pad.setPointerCapture(event.pointerId);
    trigger();
  });
  const release = () => { held = false; pad.dataset.held = 'false'; refresh(); };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);
  pad.addEventListener('lostpointercapture', release);
  // Native mouse clicks already trigger on pointerdown. Enter/accessibility clicks
  // have detail=0 and need their own path; never count the following mouse click twice.
  pad.addEventListener('keydown', event => { if (event.repeat) event.preventDefault(); });
  pad.addEventListener('click', event => {
    event.preventDefault();
    if (event.detail === 0 && armed && !held) trigger();
  });
  const timer = setInterval(() => { if (!root.hidden || armed) refresh(); }, 100);
  refresh();
  return {
    get locked() { return armed; },
    refresh,
    show(visible) { if (!visible && armed) stop('已切换计算器 · 测试已停机'); root.hidden = !visible; refresh(); },
    stop,
    acknowledge(ack) {
      if (!armed || !move || ack.requestId !== move.requestId || move.ack) return;
      if (ack.result !== 0) {
        error = true;
        return stop(`步进未接受：${MBResultText[ack.result] ?? ack.result} · 已停机`);
      }
      move.ack = true;
      target = move.target = ack.target;
      adapter.displayTarget(target);
      requested += move.shots;
      message = `已接受 ${move.shots} 发位置指令 · 等待到位`;
      refresh();
    },
    destroy() { stop('测试通道已移除'); clearInterval(timer); },
  };
}
