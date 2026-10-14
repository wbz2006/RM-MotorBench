/**
 * 闭环鱼骨图 —— 原生 DOM 实现,零依赖
 *
 * 【为什么用鱼骨图】2026-10-13 用户提出:
 *   "使用一个鱼骨图一样的结构,当启用某个环时,那个环由暗色变为亮色;
 *    电流环一直启用,启用位置环一定经速度环,某个环被点亮后显示卡片可以调整参数"
 *
 * 这个设计比"勾选 + 外层单选"更贴近本质,原因有三:
 *
 * 1. **三个环的层级关系一眼可见**。
 *    勾选框是平的,看不出这三个环是**串级嵌套**的;
 *    鱼骨图把它们排成一条主脊,启用了哪几级、外层是哪级,一眼可见。
 *
 * 2. **"位置环必须经速度环"不再是需要解释的规则**。
 *    位置环的输出只能交给速度环,想只启用位置环而跳过速度环
 *    在交互上**走不通** —— 由 _toggle() 的联动保证(见下)。
 *    (这正是上一轮踩过的坑:位置环输出是期望速度,
 *     没有速度环接住会直接当电流参考下发,量纲完全不同导致电机疯转。)
 *
 * 3. **点亮即参数卡**,让"启用了什么"和"调什么参数"在同一处。
 *
 * 【结构 —— 2026-10-14 用户裁定:位置环与电流环位置对调】
 *   主脊从左到右按**由内环到外环**排列:
 *     用户设定 ──▶ [电流环] ──▶ [速度环] ──▶ [位置环] ──▶ 电调
 *   每个环节点 = 一个可点击的方块,暗色=未启用,亮色=已启用。
 *
 * @attention 【主脊顺序 ≠ 信号流向】这是**展示顺序**,不是数据流方向。
 *   实际串级始终是:
 *     设定 → 位置环(输出"期望速度") → 速度环(输出"期望电流") → 电流环 → 电调
 *   所以箭头只代表"由内到外的层级展开",不代表命令传递方向。
 *   数据此刻真正流到哪一级、输出交给谁,写在**节点的悬停提示**里
 *   (title 里的 note 字段,见 NODES) —— 不靠主脊方向暗示。
 *
 * @attention 底部那行常驻文字(外层环 / 流向说明 / 合成掩码 0bXXXX)
 *   已于 2026-10-14 按用户要求**整行删除**,不要加回来。
 *   - 外层环:看哪个节点亮着就行,不必再用文字重复;
 *   - 掩码:getMask() 照旧算出并随 bind 下发,只是不再显示;
 *   - 说明:常驻文字才是用户要删的东西,改成悬停可见。
 *
 * 【约束】
 *   - 电流环常亮(不可关闭):它是串级的**最后一级**,关掉就没有任何闭环;
 *     且电流环始终参与串级(驱动的判定是只要 close_loop 有 CURRENT 位就算)。
 *     对调后它位于主脊**最左端**。
 *   - 点亮位置环会自动点亮速度环(由 _toggle() 联动保证)。
 *   - 外层环 = 掩码中**最高位**的亮节点(位置 0b0100 > 速度 0b0010 > 电流 0b0001),
 *     由位值直接得出,不必再单选。
 *     @attention 该判定按**位值**而非 DOM 顺序,所以调整节点排列不会算错外层环。
 */

/**
 * 环节点在鱼骨图上的定义
 *
 * 【顺序】2026-10-14 用户裁定:位置环与电流环**位置对调** ——
 *   数组顺序就是主脊从左到右的顺序,即**由内环到外环**:
 *     [电流环] ──▶ [速度环] ──▶ [位置环]
 *
 * @attention 顺序只是渲染顺序。所有判定都按 **bit** 走,不按数组下标走:
 *   - 外层环 = 掩码中最高位的亮节点(bit > outerBit,与位置无关)
 *   - 联动约束 = 按 bit 值特判(bit === 0b0100 / 0b0010)
 *   - PID 卡片切环 = onFocusLoop 上报 bit,ui.js 用 bit→option 映射
 *   所以对调数组不改变任何行为,改的只有视觉。
 *
 * @param {number} bit   close_loop_type 中的位
 * @param {string} role  data-role 前缀,如 'loopAngle'
 * @param {string} name  显示名
 * @param {string} unit  ref 的单位(点亮后显示在卡片上)
 * @param {boolean} locked true = 常亮不可关闭(电流环)
 * @param {string} note  点亮条件下显示的说明。
 *   —— 箭头已不再代表信号流向,所以 note 必须把真实方向讲清楚:
 *   数据是**从右往左**穿过各环的(位置 → 速度 → 电流 → 电调)。
 */
const NODES = [
  {
    bit: 0b0001,
    role: 'loopCurrent',
    name: '电流环',
    unit: 'A',
    locked: true, // 常亮
    note: '最内层:输出直接作为 CAN 电流值下发给电调',
  },
  {
    bit: 0b0010,
    role: 'loopSpeed',
    name: '速度环',
    unit: 'rpm',
    locked: false,
    note: '速度环输出"期望电流",交给左边的电流环',
  },
  {
    bit: 0b0100,
    role: 'loopAngle',
    name: '位置环',
    unit: 'deg',
    locked: false,
    note: '位置环输出"期望速度",必须经速度环才能到电流环',
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

    /*
     * ---- 左端:用户设定 ----
     * @attention 对调后主脊是"由内到外",所以左端紧邻的是**最内层(电流环)**,
     *   右端紧邻的是**最外层(位置环)** —— 与信号从左流到右的直觉相反。
     *   为此给两端各挂一个 title,悬停即可看到真实流向,避免图被误读。
     */
    const src = document.createElement('div');
    src.className = 'fb-src';
    src.title = '用户设定值。主脊按"由内到外"排列,真实串级为:'
      + ' 设定 → 位置环 → 速度环 → 电流环 → 电调(即沿主脊从右往左)';
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
      }
      /*
       * title(悬停提示)**统一由 _apply() 写**,这里不写。
       *   底部说明行删掉后,悬停提示是唯一讲清"输出交给谁"的地方,
       *   而它必须跟着点亮/关闭状态变文案 —— 放在 _apply 里一次到位,
       *   两处各写一份迟早会互相覆盖(与 .pid-panel 重复定义同类的坑)。
       */
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

    /* ---- 右端:电调(位置环在它旁边,但真正下发给电调的是电流环) ---- */
    const dst = document.createElement('div');
    dst.className = 'fb-dst';
    dst.title = '电调(ESC)。真正直接下发 CAN 电流帧的是电流环 —— 主脊最左端那个常亮节点';
    dst.innerHTML = '<span class="fb-dst-label">电调</span>';
    h.appendChild(dst);

    /*
     * ---- 底部信息行(外层环 / 流向说明 / 合成掩码)已删除 ----
     *
     * 2026-10-14 用户裁定整行不要了。三层信息各有归处,不需要常驻文字:
     *   - 外层环 → 图上亮到第几级直接看得见(且外层环 = 掩码最高位,
     *     由 ui.js 随 bind 下发给板端,页面显示与否不影响协议);
     *   - 流向说明 → 改写进**每个节点的 title**,悬停即见;
     *   - 合成掩码 → getMask() 照旧算出,只是不再显示。
     *
     * @attention 别因为"页面上看不到当前掩码/外层环"就把这行加回来。
     */
  }

  /**
   * 切换一个环节点
   *
   * @attention 位置环点亮时**必须**同时点亮速度环。
   *   旧版靠鱼骨图的**拓扑**(位置节点挂在速度节点上游)天然保证;
   *   2026-10-14 位置环与电流环对调后,主脊不再表示信号方向,
   *   所以这条约束**由下面的代码显式保证** —— 千万别因为"图上看着是并列的"
   *   就把联动删掉。
   *   后果:若关掉速度环而留着位置环,位置环算出的"期望速度"
   *   会直接当作电流参考下发(量纲完全不同),电机必然疯转。
   */
  _toggle(node) {
    if (node.locked) return;

    const bit = node.bit;
    if (this.mask & bit) {
      /* ---- 关闭 ----
       * 关位置环(信号的最上游):单独关即可,下游不受影响。
       * 关速度环:必须连带关掉位置环 —— 否则位置环失去下游,输出无处可去。
       */
      if (bit === 0b0010) {
        this.mask &= ~0b0100; // 连带关闭位置环
      }
      this.mask &= ~bit;
    } else {
      /* ---- 点亮 ---- */
      this.mask |= bit;
      /* 点亮位置环时,速度环作为其下游(信号往左走一级)必须一并点亮 */
      if (bit === 0b0100) {
        this.mask |= 0b0010;
      }
    }

    this._apply();
    this.onChange?.(this.mask);
  }

  /**
   * 把 mask 同步到 DOM(亮/暗 + 悬停提示)
   *
   * @attention 这里**不再**推外层环、也不再显示合成掩码 ——
   *   底部信息行已于 2026-10-14 整行删除。
   *   外层环这个概念仍然存在,但它归另外两处:
   *     - ui.js 把 `outerLoop` 字段(值就是本掩码)随 bind 下发板端;
   *     - 固件按"掩码里最高位的那个环"判定外层环。
   *   页面上显示与否都不影响这条链路 —— 别为了"想看见"就在这儿加回来。
   */
  _apply() {
    const nodes = this.host.querySelectorAll('.fb-node');

    for (const el of nodes) {
      const bit = Number(el.dataset.bit);
      const on = (this.mask & bit) !== 0;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    /*
     * 悬停提示 = 状态文案 + 该环的 note。
     *
     * @attention 主脊箭头已不代表信号方向,note 是**唯一**讲清
     *   "这一级输出交给谁"的地方,所以每条 note 都必须写明去向。
     *   常亮节点也写:它 disabled 不接受点击,但悬停仍能看到 title。
     */
    for (const el of nodes) {
      const bit = Number(el.dataset.bit);
      const n = NODES.find((x) => x.bit === bit);
      const state = el.classList.contains('is-locked')
        ? '常亮,不可关闭'
        : `点击${this.mask & bit ? '关闭' : '启用'}`;
      el.title = `${n.name} — ${state}。${n.note}`;
    }
  }

  /** 读取当前掩码 */
  getMask() {
    return this.mask;
  }
}
