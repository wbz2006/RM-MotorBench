/**
 * 实时曲线 —— 原生 Canvas 实现,零依赖
 *
 * 【为什么需要它】2026-10-12 用户提出:电机电流与转速实时波动较大,
 *   数字读数只能显示"此刻是多少",无法呈现"抖不抖"。
 *   把一段时间的走势摊开成曲线,振荡一眼可见。
 *
 * 【设计取舍】
 *   - 不引图表库:本工程刻意保持零运行时依赖,一个 canvas + 2D 上下文足够。
 *   - 双 Y 轴:转速(rpm)与电流(A)量纲差两个数量级,共用一个轴电流会被压平。
 *   - 采样在遥测到达时 push:与真实数据率一致,不另开定时器。
 *   - 环形缓冲:固定长度,超出即覆盖最旧点,内存不随时间增长。
 *
 * @attention 本文件曾在一次 PowerShell 批量替换中被写成 GBK 编码,
 *   全部中文注释损坏、换行被折叠。已用 Node 以 UTF-8 重写。
 *   **教训:不要用 PowerShell 的 Set-Content 改写含中文的源码文件**,
 *   它对编码的处理随参数变化,且损坏是静默的。
 */

/** 每通道最多保留的采样点数(实际显示点数由用户选择) */
const CHART_MAX_POINTS = 300;

/** 画布 CSS 高度(与 style.css 中 canvas 的高度保持一致) */
const CHART_CSS_H = 170;

/**
 * 一阶低通滤波器(指数移动平均)
 *
 * 【语义】value = alpha * 旧值 + (1 - alpha) * 新值
 *   alpha 是**旧值权重**,越大越平滑。实测相邻落差(roughness):
 *     alpha=0.10 → 28.6(几乎直通)
 *     alpha=0.50 → 13.9
 *     alpha=0.85 →  3.6
 *     alpha=0.95 →  1.3(基本拉直)
 *
 * @attention 判断滤波强弱必须用"相邻落差",不能用"输出方差":
 *   强滤波会让输出在长窗口内缓慢漂移,这种低频成分会**增大方差**,
 *   却恰恰是"高频被压掉"的表现。用方差会得出完全相反的结论 ——
 *   实测 alpha=0.05 方差 27.6 反而大于 alpha=0.9 的 6.6,
 *   但前者(几乎直通)远不如后者平滑。这个坑踩过两次,务必记住。
 *
 * 【为什么用一阶而不是滑动平均】
 *   只保存一个状态量、O(1) 更新,不需要环形缓冲;
 *   而滑动平均的旁瓣会让阶跃响应出现振铃,对看趋势反而有害。
 *
 * 【滤波的实际用途】
 *   波动有两个来源,低通只能压掉其中一个:
 *     1. 传感器/量化噪声 —— 能压掉;
 *     2. 真实控制震荡 —— 压不掉(震荡是低频的,会原样穿过)。
 *   所以开关同时是诊断工具:开着还抖 = 控制问题,关掉才抖 = 噪声问题。
 */
export class LowPass {
  constructor(alpha = 0.85) {
    /*
     * @attention 构造时也要钳制,不能只在 setAlpha 里做。
     *   两条入口必须收敛到同一规则,否则传 99 或 -5 都能建出对象。
     */
    this.setAlpha(alpha);
    this.value = null;
  }

  setAlpha(a) {
    /* 下界 0.1:再小就接近直通;上界 0.98:时间常数约 50 采样,已到可视极限 */
    this.alpha = Math.max(0.1, Math.min(0.98, Number(a) || 0.85));
  }

  /**
   * 送入一个原始采样
   * @param {number} x
   * @returns {number} 滤波后的值
   */
  push(x) {
    if (this.value === null || !Number.isFinite(x)) {
      /* 首个样本直接作初值,避免从 0 慢慢爬上来画出一条假斜坡 */
      this.value = Number.isFinite(x) ? x : 0;
    } else {
      this.value = this.alpha * this.value + (1 - this.alpha) * x;
    }
    return this.value;
  }

  /** 清空状态:清空曲线时必须一并重置,否则新数据会被旧状态拖拽 */
  reset() {
    this.value = null;
  }
}

/**
 * 单通道曲线实例
 *
 * @param {HTMLCanvasElement} canvas
 */
export class MotorChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = []; // {speed, torque, ref} —— 转速与电流为**滤波后**的值
    this.window = 120; // 实际显示的点数
    this._raf = null;
    this._dpr = 1;
    this.speedUnit = 'rpm';
    this.torqueUnit = 'raw';

    /*
     * 滤波状态。ref(设定值)不过滤 —— 它是我们自己的指令,
     * 本来就没有噪声,滤了反而在看阶跃响应时滞后。
     */
    this.lpSpeed = new LowPass(0.85);
    this.lpTorque = new LowPass(0.85);
    this.filterOn = true;

    /* 读取 CSS 变量作为配色,与界面主题保持一致,避免颜色写死两处 */
    const css = getComputedStyle(document.documentElement);
    this.colors = {
      speed: css.getPropertyValue('--accent').trim() || '#4aa3ff',
      torque: css.getPropertyValue('--warn').trim() || '#ffb454',
      ref: css.getPropertyValue('--muted').trim() || '#7a869a',
      grid: css.getPropertyValue('--line').trim() || '#2a3241',
      text: css.getPropertyValue('--text').trim() || '#e6edf3',
    };

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
  }

  /** 按 CSS 尺寸重设画布像素,并按 devicePixelRatio 放大避免模糊 */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(120, rect.width || 600);
    const h = Math.max(80, rect.height || CHART_CSS_H);
    this.dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.cssW = w;
    this.cssH = h;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  setWindow(n) {
    this.window = Math.max(10, Math.min(CHART_MAX_POINTS, Number(n) || 120));
    this.draw();
  }

  setUnits(speedUnit, torqueUnit) {
    if (this.speedUnit === speedUnit && this.torqueUnit === torqueUnit) return;
    this.speedUnit = speedUnit;
    this.torqueUnit = torqueUnit;
    this.draw();
  }

  clear() {
    this.data = [];
    /* 滤波状态必须一并重置,否则清空后的新数据会被旧状态拖拽 */
    this.lpSpeed.reset();
    this.lpTorque.reset();
    this.draw();
  }

  /** 开关滤波 */
  setFilter(on) {
    this.filterOn = !!on;
    if (!this.filterOn) {
      /* 关闭时重置状态:再开时从当前真实值重新起步,不带历史 */
      this.lpSpeed.reset();
      this.lpTorque.reset();
    }
  }

  /** 设置滤波强度(alpha 越大越平滑) */
  setFilterAlpha(a) {
    this.lpSpeed.setAlpha(a);
    this.lpTorque.setAlpha(a);
  }

  /**
   * 追加一个采样点
   *
   * @param {number} speed 实测转速(原始值)
   * @param {number} torque 电流/转矩(原始值)
   * @param {number} ref    设定值
   *
   * @attention 去重比较用的是**滤波后**的值。
   *   原始值几乎每帧都在跳(那正是要滤掉的东西),拿它去重等于去重失效;
   *   滤波后的值在电机静止时会稳定收敛到同一数字,去重才真正生效。
   */
  push(speed, torque, ref) {
    let s = speed;
    let t = torque;
    if (this.filterOn) {
      s = this.lpSpeed.push(speed);
      t = this.lpTorque.push(torque);
    } else {
      /* 不滤波时仍推进滤波器状态,否则重新开启会从旧值猛跳过来 */
      this.lpSpeed.push(speed);
      this.lpTorque.push(torque);
    }

    const last = this.data[this.data.length - 1];
    if (last && last.speed === s && last.torque === t && last.ref === ref) {
      return;
    }
    this.data.push({ speed: s, torque: t, ref });
    if (this.data.length > CHART_MAX_POINTS) this.data.shift();
    this.schedule();
  }

  /** 用 rAF 合并同一帧内的多次绘制请求 */
  schedule() {
    if (this._raf !== null) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.draw();
    });
  }

  draw() {
    const ctx = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    const padL = 44;
    const padR = 44;
    const padT = 8;
    const padB = 16;
    const plotW = Math.max(10, W - padL - padR);
    const plotH = Math.max(10, H - padT - padB);

    ctx.clearRect(0, 0, W, H);

    const pts = this.data.slice(-this.window);

    /* ---- 无数据时画中线与提示 ---- */
    if (pts.length < 2) {
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, padT + plotH / 2);
      ctx.lineTo(padL + plotW, padT + plotH / 2);
      ctx.stroke();
      ctx.fillStyle = this.colors.ref;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('等待遥测数据…', padL + plotW / 2, padT + plotH / 2 - 8);
      return;
    }

    /* ---- 各轴独立求范围,避免两条量纲不同的曲线互相压扁 ---- */
    const speedVals = pts.map((p) => p.speed);
    const refVals = pts.map((p) => p.ref);
    const torqueVals = pts.map((p) => p.torque);

    const sMin = Math.min(...speedVals, ...refVals, 0);
    const sMax = Math.max(...speedVals, ...refVals, 0);
    const tAbs = Math.max(1, ...torqueVals.map(Math.abs));

    /* 保留真实反馈,但避免将零速量化噪声放大至整幅图。 */
    const sSpan = Math.max(sMax - sMin, this.speedUnit === 'rad/s' ? 1 : 10);
    const sCenter = (sMin + sMax) / 2;
    const sLo = sCenter - sSpan * 0.6;
    const sHi = sCenter + sSpan * 0.6;
    const tickText = (value, step) => {
      const digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step)) + 1));
      return String(Number(value.toFixed(digits)));
    };

    const yOfSpeed = (v) => padT + plotH - ((v - sLo) / (sHi - sLo)) * plotH;
    const yOfTorque = (v) => padT + plotH / 2 - (v / tAbs) * (plotH / 2);

    /* ---- 网格与刻度 ---- */
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = this.colors.ref;
    ctx.font = '10px system-ui, sans-serif';

    for (let g = 0; g <= 4; g++) {
      const y = padT + (plotH * g) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      /* 左轴:转速;右轴:电流原始值或转矩,由电机型号决定。 */
      const sv = sHi - ((sHi - sLo) * g) / 4;
      const tv = tAbs - (tAbs * 2 * g) / 4;
      ctx.textAlign = 'right';
      ctx.fillText(tickText(sv, (sHi - sLo) / 4), padL - 5, y + 3);
      ctx.textAlign = 'left';
      ctx.fillText(tickText(tv, tAbs / 2), padL + plotW + 5, y + 3);
    }

    /* 零线:转速为 0 时加粗,便于判断正反转 */
    if (sLo < 0 && sHi > 0) {
      ctx.strokeStyle = this.colors.ref;
      ctx.beginPath();
      ctx.moveTo(padL, yOfSpeed(0));
      ctx.lineTo(padL + plotW, yOfSpeed(0));
      ctx.stroke();
    }

    const xOf = (i) => padL + (plotW * i) / Math.max(1, this.window - 1);

    /*
     * 显示端降采样:像素桶平均。
     *
     * @attention 这是抗混叠的第二道防线,与固件侧的累加平均互补。
     *   窗口 300 点画在约 600px 宽的画布上 —— 每点只占 2px,
     *   相邻样点被压进同一像素列,直接连点会在像素级产生锯齿。
     *   按像素列分组取均值后,每个像素列只有一个代表值。
     *   点数少于像素数时桶大小为 1,等于不做处理,无副作用。
     */
    const buckets = this._bucketize(pts, Math.max(1, Math.floor(plotW)));

    /* ---- 设定值(参考线,画在最下层)---- */
    this._line(buckets, xOf, (p) => yOfSpeed(p.ref), this.colors.ref, 1, true);

    /* ---- 电流 ---- */
    this._line(buckets, xOf, (p) => yOfTorque(p.torque), this.colors.torque, 1.6, false);

    /* ---- 转速 ---- */
    this._line(buckets, xOf, (p) => yOfSpeed(p.speed), this.colors.speed, 1.8, false);

    /* ---- 轴标题 ---- */
    ctx.fillStyle = this.colors.speed;
    ctx.textAlign = 'left';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(this.speedUnit, 2, padT + 8);
    ctx.fillStyle = this.colors.torque;
    ctx.textAlign = 'right';
    ctx.fillText(this.torqueUnit, W - 2, padT + 8);
  }

  /**
   * 像素桶降采样:把样点按像素列分组求平均
   *
   * @param {Array} pts 样点
   * @param {number} plotW 绘图区宽度(像素)
   * @returns {Array} 降采样后的点列
   *
   * @note 桶大小 = ceil(点数 / 像素数)。点数 <= 像素数时为 1,即原样返回。
   *   短窗口(50 点)完全不受影响,只有长窗口才平滑 ——
   *   正是我们想要的:短窗口看细节,长窗口看趋势。
   */
  _bucketize(pts, plotW) {
    const n = pts.length;
    const size = Math.ceil(n / Math.max(1, plotW));
    if (size <= 1) return pts;

    const out = [];
    for (let i = 0; i < n; i += size) {
      const end = Math.min(i + size, n);
      let s = 0;
      let t = 0;
      let r = 0;
      for (let k = i; k < end; k++) {
        s += pts[k].speed;
        t += pts[k].torque;
        r += pts[k].ref;
      }
      const c = end - i;
      out.push({ speed: s / c, torque: t / c, ref: r / c });
    }
    return out;
  }

  /** 画一条折线 */
  _line(pts, xOf, yFn, color, width, dashed) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(i);
      const y = yFn(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  destroy() {
    this._ro?.disconnect();
    if (this._raf !== null) cancelAnimationFrame(this._raf);
  }
}

/**
 * 曲线注册表:按通道号管理实例
 *
 * @note 通道卡片会被 buildChannels 追加/复用,所以懒加载 ——
 *   只有真正渲染过的通道才创建 canvas 上下文与 ResizeObserver,
 *   避免 8 张卡片里没用的那几张也占着观察者。
 */
const charts = new Map();

/** 取已存在的曲线实例(不创建) */
export function getChartIfExists(channelId) {
  return charts.get(channelId) || null;
}

/** 取出(必要时创建)某通道的曲线实例 */
export function ensureChart(channelId, canvas) {
  let c = charts.get(channelId);
  if (!c) {
    c = new MotorChart(canvas);
    charts.set(channelId, c);
  }
  return c;
}

/** 移除某通道的曲线(卡片被销毁时调用,否则 ResizeObserver 会泄漏) */
export function dropChart(channelId) {
  const c = charts.get(channelId);
  if (c) {
    c.destroy();
    charts.delete(channelId);
  }
}
