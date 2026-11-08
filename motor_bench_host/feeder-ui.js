import { calculateLoaderSpeed } from './calculator.js';
import { FeederController } from './feeder.js';

const format = value => String(Number(value.toFixed(3)));

export function initFeederMode(host, adapter) {
  host.appendChild(document.getElementById('feederModeTpl').content.cloneNode(true));
  const root = host.querySelector('.feeder-mode');
  const get = name => root.querySelector(`[data-feeder="${name}"]`);
  const settings = [...root.querySelectorAll('input, select')];
  let baseline = null;
  let capture = null;
  let controller = null;
  let lastSample = null;
  let message = '';
  let error = false;
  let identity = null;
  let finalController = null;
  let finalSamplePending = false;

  function updateStats(source) {
    get('jams').value = String(source.jams);
    get('jamRate').value = source.shots > 0 ? (source.jams / source.shots * 100).toFixed(2) + '%' : '—';
    get('jamRatio').value = source.jams + ' / ' + source.shots + ' 发';
  }

  function parameters(state, requireThreshold = false) {
    const reduction = get('drive').value === 'direct' ? 1 : get('ratio').valueAsNumber;
    const speed = calculateLoaderSpeed(get('rate').valueAsNumber, reduction, get('rounds').valueAsNumber);
    const target = Number(get('direction').value) * (state.unit === 'rpm' ? speed.rotorRpm : speed.rotorRad);
    const number = (name, label, min, max) => {
      const value = get(name).valueAsNumber;
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}需在 ${min}～${max} 之间`);
      return value;
    };
    if (target === 0 || Math.abs(target) > state.limit) throw new Error(`目标转速需大于 0 且不超过 ${state.limit} ${state.unit}`);
    const factor = number('factor', '基准峰值倍数', 1.01, 10);
    const lowSpeed = number('lowSpeed', '低速判据（目标 %）', 1, 79) / 100;
    const detectMs = number('detectMs', '判定持续时间（ms）', 100, 5000);
    const reverseAngle = number('reverseAngle', '拨弹盘回退角度（°）', 0.1, 360);
    const reverseRpm = number('reverseRpm', '拨弹盘回退转速（rpm）', 0.1, 600);
    const reverseSpeed = reverseRpm * reduction * (state.unit === 'rpm' ? 1 : Math.PI / 30);
    if (reverseSpeed > state.limit) throw new Error('回退转速超出电机转速限幅');
    const maxRetries = number('retries', '连续解卡次数', 1, 10);
    if (!Number.isInteger(maxRetries)) throw new Error('连续解卡次数需为整数');
    const reverseTimeout = number('reverseTimeout', '回退超时（秒）', 0.5, 30) * 1000;
    const threshold = requireThreshold ? number('threshold', '负载阈值', Number.MIN_VALUE, Number.MAX_VALUE) : null;
    return { target, reduction, roundsPerTurn: get('rounds').valueAsNumber, factor, lowSpeed, detectMs, reverseAngle, reverseSpeed, maxRetries, reverseTimeout, threshold,
      anglePeriod: state.anglePeriod / reduction };
  }

  function stop(reason = '已停止 · 基准已保留', disable = true) {
    const wasLocked = !!capture || !!controller;
    if (controller) {
      const state = adapter.getState();
      if (Number.isFinite(state.rotorAngle)) controller.recordAngle(state.rotorAngle / controller.options.reduction);
      finalController = controller;
      finalSamplePending = true;
      lastSample = state.receivedAt;
      updateStats(controller);
    }
    capture = null;
    controller = null;
    message = reason;
    if (wasLocked && disable) adapter.disable();
    if (wasLocked) adapter.displayTarget(0);
    if (wasLocked) adapter.onLockChange();
    refresh();
  }

  function startController(options, at) {
    controller = new FeederController(options, at, adapter.getState().rotorAngle / options.reduction);
    finalController = null;
    finalSamplePending = false;
    capture = null;
    error = false;
    get('jams').value = '0';
    get('jamRate').value = '—';
    get('jamRatio').value = '0 / 0 发';
    adapter.onLockChange();
    adapter.setSpeed(options.target);
    adapter.displayTarget(options.target);
  }

  function startCapture(enable = false) {
    const state = adapter.getState();
    if (state.reason || (!enable && !state.enabled) || capture || controller) return;
    finalController = null;
    finalSamplePending = false;
    let options;
    try { options = parameters(state); } catch (e) { message = e.message; error = true; return refresh(); }
    baseline = null;
    get('threshold').value = '';
    capture = { options, started: performance.now(), waitingEnable: enable, stableMs: 0, previousStable: false, count: 0, peak: 0 };
    lastSample = state.receivedAt;
    error = false;
    adapter.onLockChange();
    adapter.displayTarget(options.target);
    if (enable) adapter.enable(options.target);
    else adapter.setSpeed(options.target);
    refresh();
  }

  function refresh() {
    const state = adapter.getState();
    if (identity !== state.identity || state.reason) {
      if (baseline) message = '正常基准已失效，请重新采集';
      baseline = null;
      get('threshold').value = '';
      identity = state.identity;
    }
    if ((capture || controller) && (state.reason || (!state.enabled && !capture?.waitingEnable))) {
      error = true;
      return stop(`拨弹已中止：${state.reason || '电机已停机'}`);
    }
    let options = capture?.options || controller?.options || null;
    let invalid = '';
    if (!options) {
      try { options = parameters(state, !!baseline); } catch (e) { invalid = e.message; }
    }
    const now = performance.now();
    if (capture?.waitingEnable) {
      if (state.enabled && state.receivedAt !== lastSample) capture.waitingEnable = false;
      else if (now - capture.started > 1500) {
        error = true;
        return stop('使能未在 1.5 秒内确认 · 已取消自动采样');
      }
    }
    if (capture && now - capture.started > 15000) {
      error = true;
      return stop('15 秒内未能累计 3 秒有效采样，请检查转速与负载后重试');
    }
    if ((capture || controller) && !capture?.waitingEnable && state.receivedAt !== lastSample) {
      const sampleMs = state.receivedAt - lastSample;
      lastSample = state.receivedAt;
      const sample = { at: state.receivedAt, speed: state.speed, load: Math.abs(state.load), angle: state.rotorAngle / options.reduction };
      if (capture) {
        const settled = Math.abs(state.ref - options.target) <= Math.max(0.001, Math.abs(options.target) * 0.01) &&
          sample.speed / options.target >= 0.8 && sample.speed / options.target <= 1.2;
        if (settled) {
          if (capture.previousStable) capture.stableMs += sampleMs;
          capture.count++;
          capture.peak = Math.max(capture.peak, sample.load);
          if (capture.stableMs >= 3000 && capture.count >= 20) {
            if (capture.peak === 0) { error = true; return stop('负载反馈始终为 0，无法建立正常基准'); }
            baseline = { peak: capture.peak, count: capture.count };
            get('threshold').value = String(Number((baseline.peak * options.factor).toPrecision(6)));
            startController({ ...options, threshold: Number(get('threshold').value) }, sample.at);
          }
        }
        if (capture) capture.previousStable = settled;
      } else {
        const command = controller.sample(sample);
        updateStats(controller);
        if (controller.phase === 'stopped') { error = true; return stop(controller.reason + ' · 已停机'); }
        if (command !== null) { adapter.setSpeed(command); adapter.displayTarget(command); }
      }
    }
    if (!capture && !controller && finalController && finalSamplePending && state.receivedAt !== lastSample) {
      if (Number.isFinite(state.rotorAngle)) finalController.recordAngle(state.rotorAngle / finalController.options.reduction);
      updateStats(finalController);
      lastSample = state.receivedAt;
      finalSamplePending = false;
    }
    const locked = !!capture || !!controller;
    for (const input of settings) input.disabled = locked;
    get('threshold').disabled = locked || !baseline;
    get('ratioWrap').hidden = get('drive').value === 'direct';
    get('target').value = options ? `${format(options.target)} ${state.unit}` : '—';
    get('loadUnit').textContent = state.loadUnit;
    get('load').value = Number.isFinite(state.load) ? `${format(Math.abs(state.load))} ${state.loadUnit}` : '—';
    get('baseline').value = baseline ? `${format(baseline.peak)} ${state.loadUnit} / ${baseline.count} 帧` : '未采集';
    get('phase').value = capture ? '采集正常基准' : controller?.phase === 'reversing' ? '回退解卡' : controller ? '正常拨弹' : '未接管';
    get('capture').disabled = locked || !!state.reason || !state.enabled || !!invalid;
    get('start').disabled = locked || !!state.reason || !state.enabled || !baseline || !!invalid;
    get('stop').disabled = !locked && !state.enabled;
    get('status').classList.toggle('error', error || !!invalid);
    get('status').textContent = state.reason || invalid || (capture
      ? capture.waitingEnable ? '正在等待电机使能确认…' : `正在采集正常基准 · 有效 ${format(capture.stableMs / 1000)} / 3 秒（${capture.count} 帧）· 采集完成自动启动防卡弹；15 秒内未完成则停机。`
      : controller ? `防卡弹运行中 · ${controller.phase === 'reversing' ? '按反馈角度回退' : '监测负载与转速'} · 连续解卡 ${controller.attempts}/${options.maxRetries}`
      : message || '填写拨弹参数后点击上方使能，自动采集正常基准，完成后自动启动防卡弹。');
  }

  get('capture').onclick = () => startCapture();
  get('start').onclick = () => {
    const state = adapter.getState();
    if (state.reason || !state.enabled || !baseline || capture || controller) return;
    let options;
    try { options = parameters(state, true); } catch (e) { message = e.message; error = true; return refresh(); }
    lastSample = state.receivedAt;
    startController(options, performance.now());
    refresh();
  };
  get('stop').onclick = () => {
    if (!capture && !controller) adapter.disable();
    stop();
  };
  for (const input of settings) input.addEventListener('input', () => {
    message = ''; error = false;
    if (['rate', 'rounds', 'drive', 'ratio', 'direction'].includes(input.dataset.feeder)) {
      baseline = null; get('threshold').value = '';
    }
    if (input === get('factor') && baseline) get('threshold').value = String(Number((baseline.peak * input.valueAsNumber).toPrecision(6)));
    refresh();
  });
  const timer = setInterval(() => { if (!root.hidden || capture || controller) refresh(); }, 50);
  refresh();
  return {
    get locked() { return !!capture || !!controller; },
    enable: () => startCapture(true),
    refresh, stop,
    show(visible) { if (!visible && (capture || controller)) stop('已切换模式 · 拨弹已停机'); root.hidden = !visible; refresh(); },
    destroy() { stop('测试通道已移除'); clearInterval(timer); },
  };
}
