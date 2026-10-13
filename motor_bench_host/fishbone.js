/**
 * 闭环鱼骨图 —— 原生 DOM 实现,零依赖
 *
 * 【为什么用鱼骨图】2026-10-13 用户提出:
 *   "使用一个鱼骨图一样的结构,当启用某个环时,那个环由暗色变为亮色;
 *    电流环一直启用,启用位置环一定经速度环,某个环被点亮后显示卡片可以调整参数"
 *
 * 这个设计比"勾选 + 外层单选"更贴近本质,原因有三:
 *
 * 1. **数据流方向变成视觉事实**。
 *    勾选框是平的,看不出 pid_ref 是"顺次穿过"各环的;
 *    鱼骨图的主脊就是数据流,一眼看出 位置 → 速度 → 电流。
 *
 * 2. **"位置环必须经速度环"不再是需要解释的规则**。
 *    位置环节点只挂在速度环下游,想不经过它而启用位置环
 *    在图上**无路可走** —— 约束由拓扑保证,不靠文字说明。
 *    (这正是上一轮踩过的坑:位置环输出是期望速度,
 *     没有速度环接住会直接当电流参考下发,量纲完全不同导致电机疯转。)
 *
 * 3. **点亮即参数卡**,让"启用了什么"和"调什么参数"在同一处。
 *
 * 【结构】
 *   主脊(数据流)  用户设定 ──▶ [位置环] ──▶ [速度环] ──▶ [电流环] ──▶ 电调
 *   每个环节点 = 一个可点击的方块,暗色=未启用,亮色=已启用。
 *
 * 【约束】
 *   - 电流环常亮(不可关闭):它是最后一级,关掉就没有任何闭环;
 *     且电流环始终参与串级(驱动的判定是只要 close_loop 有 CURRENT 位就算)。
 *   - 点亮位置环会自动点亮速度环(拓扑决定,无需额外校验)。
 *   - 最右端的亮节点即"外层环",由拓扑直接得出,不必再单选。
 */

/**
 * 环节点在鱼骨图上的定义
 *
 * @param {number} bit   close_loop_type 中的位
 * @param {string} role  data-role 前缀,如 'loopAngle'
 * @param {string} name  显示名
 * @param {string} unit  ref 的单位(点亮后显示在卡片上)
 * @param {boolean} locked true = 常亮不可关闭(电流环)
 * @param {string} note  点亮条件下显示的说明
 */
const NODES = [
  {
    bit: 0b0100,
    role: 'loopAngle',
    name: '位置环',
    unit: 'deg',
    locked: false,
    note: '位置环输出"期望速度",必须经速度环才能到电流环',
  },
  {
    bit: 0b0010,
    role: 'loopSpeed',
    name: '速度环',
    unit: 'rpm',
    locked: false,
    note: '速度环输出"期望电流"',
  },
  {
    bit: 0b0001,
    role: 'loopCurrent',
    name: '电流环',
    unit: 'A',
    locked: true, // 常亮
    note: '最后一级,输出直接作为 CAN 电流值下发',
  },
];

/**
 * 鱼骨图实例
 *
 * @param {HTMLElement} host 容器元素
 */
export class LoopFishbone {
  constructor(host) {
    this.host = host;
    this.mask = 0b0011; // 默认 电流+速度
    this.onChange = null; // 外部回调(mask) => void
    /*
     * 焦点回调:用户悬停/点击了某个环节点。
     *   onFocusLoop(bit, nodeEl) —— 请求外部把 PID 卡片切到对应环
     */
    this.onFocusLoop = null;

    this._render();
    this._apply();
  }

  /** 构建 DOM 骨架 */
  _render() {
    const h = this.host;
    h.classList.add('fishbone');
    h.innerHTML = '';

    /* ---- 左端:用户设定 ---- */
    const src = document.createElement('div');
    src.className = 'fb-src';
    src.innerHTML = '<span class="fb-src-label">设定</span>';
    h.appendChild(src);

    /* ---- 主脊 ---- */
    const spine = document.createElement('div');
    spine.className = 'fb-spine';
    h.appendChild(spine);

    /* ---- 环节点 ---- */
    for (const n of NODES) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'fb-node';
      node.dataset.role = n.role;
      node.dataset.bit = String(n.bit);
      if (n.locked) {
        node.classList.add('is-locked');
        node.disabled = true; /* 常亮节点不接受点击 */
        node.title = `${n.name} — 常亮,不可关闭`;
      } else {
        node.title = `${n.name} — 点击${this.mask & n.bit ? '关闭' : '启用'}`;
      }
      node.innerHTML =
        `<span class="fb-node-name">${n.name}</span>` +
        `<span class="fb-node-bit">0b${n.bit.toString(2).padStart(3, '0')}</span>`;
      node.onclick = () => {
        this._toggle(n);
        /*
         * 点击后也切一次卡片。
         * @attention 必须放在 _toggle **之后**:
         *   用户点节点是为了改变启用状态,顺带把 PID 卡片切到这个环 ——
         *   若放在之前,卡片会按"点击前"的状态切换,与实际点亮结果不符。
         */
        this.onFocusLoop?.(n.bit, node);
      };

      /*
       * 悬停/聚焦时请求外部打开 PID 浮空卡片(2026-10-13 用户要求:
       * "某个环被点亮后显示卡片可以调整参数")。
       *
       * @attention 只"请求",不自己管显示 —— 卡片在 ui.js 里,
       *   鱼骨图只负责上报"用户现在关注哪个环"(bit)与节点位置。
       *   这样鱼骨图不需要知道 PID 面板的任何内部结构。
       */
      node.onmouseenter = () => this.onFocusLoop?.(n.bit, node);
      node.onfocus = () => this.onFocusLoop?.(n.bit, node);

      spine.appendChild(node);
    }

    /* ---- 右端:电调 ---- */
    const dst = document.createElement('div');
    dst.className = 'fb-dst';
    dst.innerHTML = '<span class="fb-dst-label">电调</span>';
    h.appendChild(dst);

    /* ---- 外层标记 + 说明 ---- */
    const meta = document.createElement('div');
    meta.className = 'fb-meta';
    meta.innerHTML =
      '<span class="fb-outer">外层:<b data-role="fbOuter">--</b></span>' +
      '<span class="fb-note" data-role="fbNote"></span>' +
      '<span class="fb-mask" data-role="fbMask" title="合成后的 close_loop_type,可与固件 RTT 日志对照">0b0011</span>';
    h.appendChild(meta);

    this._outerEl = meta.querySelector('[data-role="fbOuter"]');
    this._noteEl = meta.querySelector('[data-role="fbNote"]');
    this._maskEl = meta.querySelector('[data-role="fbMask"]');
  }

  /**
   * 切换一个环节点
   *
   * @attention 位置环点亮时**必须**同时点亮速度环 ——
   *   这不是额外的校验规则,而是鱼骨图的拓扑本身:
   *   位置环在速度环上游,它的输出只能交给速度环。
   *   若关掉速度环而留着位置环,位置环算出的"期望速度"
   *   会直接当作电流参考下发(量纲完全不同),电机必然疯转。
   */
  _toggle(node) {
    if (node.locked) return;

    const bit = node.bit;
    if (this.mask & bit) {
      /* ---- 关闭 ----
       * 关位置环:单独关即可(它在上游,不影响下游)。
       * 关速度环:必须连带关掉位置环 —— 否则位置环失去下游,输出无处可去。
       */
      if (bit === 0b0010) {
        this.mask &= ~0b0100; // 连带关闭位置环
      }
      this.mask &= ~bit;
    } else {
      /* ---- 点亮 ---- */
      this.mask |= bit;
      /* 点亮位置环时,速度环作为其下游必须一并点亮 */
      if (bit === 0b0100) {
        this.mask |= 0b0010;
      }
    }

    this._apply();
    this.onChange?.(this.mask);
  }

  /** 把 mask 同步到 DOM(亮/暗、外层标记、说明) */
  _apply() {
    const nodes = this.host.querySelectorAll('.fb-node');
    let outerName = '--';
    let outerBit = 0;

    for (const el of nodes) {
      const bit = Number(el.dataset.bit);
      const on = (this.mask & bit) !== 0;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      /*
       * 外层环 = 掩码中**最高位**的亮节点。
       * 鱼骨图自上而下是 位置 → 速度 → 电流,
       * 所以最上游的亮节点就是最外层的环 —— 由拓扑直接得出,无需单选。
       */
      if (on && bit > outerBit) {
        outerBit = bit;
        outerName = el.querySelector('.fb-node-name').textContent;
      }
    }

    this._outerEl.textContent = outerName;

    /* 说明:显示最上游亮节点的提示,解释数据此刻流到哪里 */
    const top = NODES.find((n) => n.bit === outerBit);
    this._noteEl.textContent = top ? top.note : '';

    this._maskEl.textContent = `0b${this.mask.toString(2).padStart(4, '0')}`;

    /* 更新可点击节点的 title(启用/关闭文案) */
    for (const el of nodes) {
      if (el.classList.contains('is-locked')) continue;
      const bit = Number(el.dataset.bit);
      const n = NODES.find((x) => x.bit === bit);
      el.title = `${n.name} — 点击${this.mask & bit ? '关闭' : '启用'}`;
    }
  }

  /** 读取当前掩码 */
  getMask() {
    return this.mask;
  }
}
