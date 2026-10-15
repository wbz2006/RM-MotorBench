/** Bounded, independent telemetry histories. Times are monotonic receive times in ms. */
export class SpeedHistory {
  constructor({ retentionMs = 60000, maxPoints = 6000 } = {}) {
    this.retentionMs = retentionMs;
    this.maxPoints = maxPoints;
    this.channels = new Map();
  }

  append(id, item, time) {
    const points = this.channels.get(id) ?? [];
    if (!Number.isFinite(time) || (points.length && time < points.at(-1).time)) return false;
    const valid = item.online && Number.isFinite(item.ref) && Number.isFinite(item.speed);
    points.push({ time, ref: valid ? item.ref : null, speed: valid ? item.speed : null });
    let expired = 0;
    while (expired < points.length && points[expired].time < time - this.retentionMs) expired++;
    points.splice(0, Math.max(expired, points.length - this.maxPoints));
    this.channels.set(id, points);
    return true;
  }

  view(id, end, windowMs) {
    return (this.channels.get(id) ?? []).filter(p => p.time >= end - windowMs && p.time <= end);
  }

  snapshot() {
    return new Map([...this.channels].map(([id, points]) => [id, points.slice()]));
  }

  clear(id) { this.channels.delete(id); }
  remove(id) { this.channels.delete(id); }

  break(time) {
    for (const id of this.channels.keys()) this.append(id, { online: false }, time);
  }
}

/** One shared speed chart. Display controls never send commands to the board. */
export class SpeedWaveform {
  constructor(root) {
    this.root = root;
    const q = id => root.querySelector(`#${id}`);
    this.select = q('waveChannel');
    this.window = q('waveWindow');
    this.pauseButton = q('wavePause');
    this.canvas = q('waveCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.status = q('waveStatus');
    this.target = q('waveTarget');
    this.actual = q('waveActual');
    this.error = q('waveError');
    this.history = new SpeedHistory();
    this.configs = new Map();
    this.ids = [];
    this.states = new Map();
    this.frozen = null;
    this.reason = '';
    this.select.onchange = this.window.onchange = () => this.draw();
    this.pauseButton.onclick = () => {
      if (this.frozen) {
        this.frozen = null;
      } else {
        this.frozen = { time: performance.now(), data: this.history.snapshot() };
      }
      this.pauseButton.textContent = this.frozen ? '继续显示' : '暂停显示';
      this.pauseButton.setAttribute('aria-pressed', String(!!this.frozen));
      this.draw();
    };
    q('waveClear').onclick = () => {
      const id = this.selectedId();
      this.history.clear(id);
      this.frozen?.data.delete(id);
      this.states.delete(id);
      this.draw();
    };
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.canvas);
    let lastDraw = 0;
    const frame = now => {
      if (!this.frozen && now - lastDraw >= 50) {
        this.draw(now);
        lastDraw = now;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  selectedId() { return this.select.value === '' ? null : Number(this.select.value); }

  setChannels(ids) {
    const value = this.select.value;
    for (const id of this.ids) {
      if (ids.includes(id)) continue;
      this.history.remove(id);
      this.configs.delete(id);
      this.states.delete(id);
      this.frozen?.data.delete(id);
    }
    this.ids = ids;
    this.select.replaceChildren();
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = String(id);
      option.textContent = `通道 ${id}`;
      this.select.appendChild(option);
    }
    this.select.value = value;
    if (!this.select.value) this.select.value = this.select.options[0]?.value ?? '';
    this.select.disabled = !ids.length;
    this.draw();
  }

  configureChannel(id, config) {
    const previous = this.configs.get(id);
    this.configs.set(id, config);
    if (previous && previous.unit === config.unit && previous.speedLoop === config.speedLoop && previous.motorKey === config.motorKey) return;
    this.history.clear(id);
    this.states.delete(id);
    this.frozen?.data.delete(id);
    this.draw();
  }

  forgetChannel(id) {
    this.configs.delete(id);
    this.history.clear(id);
    this.states.delete(id);
    this.frozen?.data.delete(id);
    this.draw();
  }

  append(item, time = performance.now()) {
    if (!this.ids.includes(item.channelId)) return;
    this.reason = '';
    this.states.set(item.channelId, item.online ? 'online' : 'offline');
    if (this.configs.get(item.channelId)?.speedLoop) this.history.append(item.channelId, item, time);
  }

  disconnect(reason) {
    this.reason = reason;
    this.history.break(performance.now());
    this.draw();
  }

  resetSession() {
    this.history = new SpeedHistory();
    this.configs.clear();
    this.states.clear();
    this.frozen = null;
    this.reason = '';
    this.pauseButton.textContent = '暂停显示';
    this.pauseButton.setAttribute('aria-pressed', 'false');
    this.draw();
  }

  draw(now = performance.now()) {
    const id = this.selectedId();
    const config = this.configs.get(id);
    const unit = config?.unit ?? 'rpm';
    const end = this.frozen?.time ?? now;
    const windowMs = Number(this.window.value) * 1000;
    const points = config?.speedLoop
      ? (this.frozen ? (this.frozen.data.get(id) ?? []).filter(p => p.time >= end - windowMs && p.time <= end)
        : this.history.view(id, end, windowMs))
      : [];
    const last = points.at(-1);
    const value = number => Number.isFinite(number) ? `${number.toFixed(1)} ${unit}` : '--';
    this.target.textContent = value(last?.ref);
    this.actual.textContent = value(last?.speed);
    this.error.textContent = value(Number.isFinite(last?.ref) && Number.isFinite(last?.speed) ? last.ref - last.speed : null);
    const message = id === null ? '暂无通道,请添加通道并绑定电机'
      : !config ? (this.states.has(id) ? '请选择该通道已绑定的电机及控制环以恢复波形' : '请先选择电机并绑定速度环')
      : !config.speedLoop ? '仅速度环支持转速对比,请切换为速度环并绑定'
      : this.reason || (this.states.get(id) === 'offline' ? '电机离线'
        : !last ? '等待遥测'
        : !this.frozen && now - last.time > 1000 ? '遥测中断'
        : last.ref === null ? '等待有效遥测' : '实时采集中');
    this.status.textContent = this.frozen ? `已暂停显示 · ${message}` : message;
    this.paint(points, end, windowMs, unit);
  }

  paint(points, end, windowMs, unit) {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    const width = rect.width, height = rect.height;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#11151d';
    ctx.fillRect(0, 0, width, height);
    const left = 64, top = 26, right = width - 16, bottom = height - 30;
    const values = points.flatMap(p => [p.ref, p.speed]).filter(Number.isFinite);
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    const pad = Math.max((max - min) * 0.12, unit === 'rpm' ? 10 : 0.1);
    min -= pad;
    max += pad;
    const x = time => left + (time - (end - windowMs)) / windowMs * (right - left);
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (let i = 0; i <= 4; i++) {
      const yy = top + (bottom - top) * i / 4;
      const value = max - (max - min) * i / 4;
      ctx.strokeStyle = '#29313f';
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.fillStyle = '#8b93a5';
      ctx.textAlign = 'right';
      ctx.fillText(value.toFixed(max - min < 10 ? 1 : 0), left - 8, yy + 4);
      const xx = left + (right - left) * i / 4;
      ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bottom); ctx.stroke();
      ctx.textAlign = i === 4 ? 'right' : 'center';
      ctx.fillText(`${-windowMs / 1000 * (1 - i / 4)} s`, xx, height - 9);
    }
    ctx.textAlign = 'left';
    ctx.fillText(unit, 12, 15);
    ctx.strokeStyle = '#506077';
    ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    for (const [key, color] of [['ref', '#4da3ff'], ['speed', '#3ecf8e']]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(key === 'ref' ? [6, 4] : []);
      ctx.beginPath();
      let previous = null;
      for (const point of points) {
        if (!Number.isFinite(point[key])) { previous = null; continue; }
        const xx = x(point.time), yy = y(point[key]);
        if (!previous || point.time - previous.time > 1000) {
          ctx.moveTo(xx, yy);
        } else {
          if (key === 'ref') ctx.lineTo(xx, y(previous[key]));
          ctx.lineTo(xx, yy);
        }
        previous = point;
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
