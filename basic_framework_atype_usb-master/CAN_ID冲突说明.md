# CAN ID 冲突 · 完整说明与排障

> 症状:网页点「添加电机」失败,或板子直接停机只能复位。
> 本文说明 CAN ID 冲突是什么、为什么官方库会停机、测试台如何提前拦截。

---

## 一、一句话结论

> **同一条 CAN 总线上,GM6020 拨 N、M3508/M2006 拨 N+4(N ∈ 1~4)时反馈 ID 相同,两颗电机共用一个 rx_id。**

推荐接法:**CAN1 只放 6020, CAN2 只放 3508/2006** —— 不同总线是独立 ID 空间,永不冲突。

---

## 二、CAN ID 是什么,为什么必须有

CAN 是**广播**总线:所有节点都能收到所有报文,每个节点只处理"发给自己的"。

电调的 ID **不是电调自己决定的**,而是由电调上的**拨码开关**设定(1~8)。拨码决定一个 ID,电调据此算出两个值:

| | 方向 | 作用 |
| --- | --- | --- |
| **tx_id**(发送 ID) | 主控 → 电调 | 下发电流值 |
| **rx_id**(接收 ID) | 电调 → 主控 | 回传转速/电流/温度 |

主控区分"哪颗电机的反馈"的**唯一依据就是 rx_id**。两颗电机 rx_id 相同,主控就无法区分它们 —— 这就是冲突的本质。

---

## 三、本库的 ID 分配规则

代码位置:`modules/motor/DJImotor/dji_motor.c:47` `MotorSenderGrouping()`

```c
uint8_t motor_id = config->tx_id - 1;   // 下标归零

case M2006:
case M3508:
    config->rx_id = 0x200 + motor_id + 1;   // 展开后 = 0x200 + tx_id
    break;

case GM6020:
    config->rx_id = 0x204 + motor_id + 1;   // 展开后 = 0x204 + tx_id
    break;
```

`-1` 与 `+1` 抵消,净效果如下表:

| 电机 | 公式 | ID=1 | ID=2 | ID=3 | ID=4 | ID=5 | ID=6 | ID=7 | ID=8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M2006 / M3508 | `0x200 + id` | 0x201 | 0x202 | 0x203 | 0x204 | **0x205** | **0x206** | **0x207** | **0x208** |
| GM6020 | `0x204 + id` | **0x205** | **0x206** | **0x207** | **0x208** | 0x209 | 0x20A | 0x20B | 0x20C |
| 达妙 DM/LK/HT | 另一套 ID 段 | — 不参与本判定 — | | | | | | | |

> 库注释里写的 `C610/C620` 是 **M2006/M3508 的电调型号**,与电机型号指的是同一批东西,不是两类不同电机。

### 区间重叠

```
        0x200 ──────────── 0x20C
M2006/M3508  ████████████████  0x201 ~ 0x208
GM6020              ████████████████  0x205 ~ 0x20C
                        ▲▲▲▲
                   重叠区 0x205 ~ 0x208
```

**重叠区恰好 4 个 ID**。但冲突**不止跨型号一种**,完整清单见下节。

### 不会冲突的情况

- **不同 CAN 总线** —— CAN1 与 CAN2 是两套独立的 ID 空间,永不冲突
- **6020 拨 5~8** —— 落在 0x209~0x20C,与 3508/2006 全段不重叠
- **达妙系列** —— 走另一套 ID 段,不参与本判定
- **M3508 拨 1 与 M3508 拨 2** —— 同型号不同 ID 互不冲突

---

## 三之二、全部冲突组合(16 组)

### 按 rx_id 分组(最直观)

| rx_id | 会被哪些「型号 + 拨码ID」占用 |
| --- | --- |
| 0x201 | M3508 #1 · M2006 #1 |
| 0x202 | M3508 #2 · M2006 #2 |
| 0x203 | M3508 #3 · M2006 #3 |
| 0x204 | M3508 #4 · M2006 #4 |
| **0x205** | **GM6020 #1** · M3508 #5 · M2006 #5 |
| **0x206** | **GM6020 #2** · M3508 #6 · M2006 #6 |
| **0x207** | **GM6020 #3** · M3508 #7 · M2006 #7 |
| **0x208** | **GM6020 #4** · M3508 #8 · M2006 #8 |
| 0x209 | GM6020 #5(独享) |
| 0x20A | GM6020 #6(独享) |
| 0x20B | GM6020 #7(独享) |
| 0x20C | GM6020 #8(独享) |

### 全部 16 组两两冲突

**A 组:GM6020 与 3508/2006 跨型号(8 组)—— ID 相差 4 时撞**

| # | 冲突对 | 共用 rx_id |
| --- | --- | --- |
| 1 | GM6020 #1 ↔ M3508 #5 | 0x205 |
| 2 | GM6020 #1 ↔ M2006 #5 | 0x205 |
| 3 | GM6020 #2 ↔ M3508 #6 | 0x206 |
| 4 | GM6020 #2 ↔ M2006 #6 | 0x206 |
| 5 | GM6020 #3 ↔ M3508 #7 | 0x207 |
| 6 | GM6020 #3 ↔ M2006 #7 | 0x207 |
| 7 | GM6020 #4 ↔ M3508 #8 | 0x208 |
| 8 | GM6020 #4 ↔ M2006 #8 | 0x208 |

**B 组:M3508 与 M2006 之间(8 组)—— 同 ID 必撞**

| # | 冲突对 | 共用 rx_id |
| --- | --- | --- |
| 9 | M3508 #1 ↔ M2006 #1 | 0x201 |
| 10 | M3508 #2 ↔ M2006 #2 | 0x202 |
| 11 | M3508 #3 ↔ M2006 #3 | 0x203 |
| 12 | M3508 #4 ↔ M2006 #4 | 0x204 |
| 13 | M3508 #5 ↔ M2006 #5 | 0x205 |
| 14 | M3508 #6 ↔ M2006 #6 | 0x206 |
| 15 | M3508 #7 ↔ M2006 #7 | 0x207 |
| 16 | M3508 #8 ↔ M2006 #8 | 0x208 |

> ⚠️ **B 组最容易被忽略** —— 多数人只想到"6020 和 3508 会撞",
> 不知道 M3508 与 M2006 用**同一个公式**,所以同 ID 也必撞。
> 实测中这类冲突比 A 组更常见(拨弹盘用 M2006、摩擦轮用 M3508,很容易拨成同一个 ID)。

### 一句话规律

> **M3508 和 M2006 用同一套公式(`0x200+ID`),它们之间「同 ID 必撞」;
> GM6020 偏移 4(`0x204+ID`),与 3508/2006 在 ID 相差 4 时撞。**

### 安全分配

| 方案 | 做法 |
| --- | --- |
| **推荐** | CAN1 全放 6020,CAN2 全放 3508/2006 —— 不同总线独立 ID 空间,16 组冲突全部不存在 |
| 同总线 | 6020 只用 **5~8**(0x209~0x20C 独享),3508 与 2006 各自 ID 不重复 |
| 同总线备选 | 6020 用 1~4 也行,但此时 3508/2006 只能拨 1~4 且两者互不重复 |

> 「6020 用 1~4、3508 用 5~8」是**不可行**的 —— 那正是 A 组的 4 个冲突点。
> 网上流传的这个说法是错的。

---

## 三之三、界面的实时提示(2026-10-13 新增)

添加电机时,选完**型号 / 总线 / 电调 ID** 的当下,面板就显示结果,
不必等点「添加」再被板子拒绝。

### 冲突时

以"已有 M3508#5,准备加 GM6020 ID1"为例:

```
ID 冲突:大疆 GM6020(CAN1 ID1)与已添加的 大疆 M3508(CAN1 ID5)共用反馈 ID 0x205。
请改 大疆 M3508(CAN1 拨码 ID5)的拨码,或把本颗 6020 拨到 5~8(0x209~0x20C 与它们不重叠)。
当前 CAN1 上 大疆 GM6020 可用的拨码 ID:2、3、4、5、6、7、8(可用 ID 随型号而变,以本颗型号为准)
```

提示包含四件事:

1. **和谁撞** —— 具体到型号、总线、拨码 ID
2. **共用哪个 rx_id** —— 让用户理解硬件层面发生了什么
3. **该改谁** —— 6020 与 3508/2006 冲突时建议改 3508/2006(它们通常成组,改动代价小)
4. **当前可用 ID** —— 直接给出能用的拨码号

### 无冲突时

若该总线上已有电机,面板会列出**本颗型号**的可用 ID:

```
CAN1 当前可用 ID:2、3、4、5、6、7、8
```

> ⚠️ 可用 ID 列表**随型号而变**。例如已有 3508#5 时,
> 6020 的可用 ID 含 5(6020 拨 5 = 0x209,不冲突),
> 但 M3508 的可用 ID **不含** 5。所以界面把型号写进了这句话里,
> 避免用户把"6020 能用 5"误读成"3508 也能用 5"。

### 与固件的关系

界面这道是**提前告知**;固件的 `MotorBenchCheckRxIdFree()` 仍是**最终权威**。
两者用同一套公式。界面判定冲突时**不会**把请求发给板子 ——
明知会被拒绝,没有必要浪费一次往返。

---

## 四、CAN 过滤器:为什么撞车后果严重

代码位置:`bsp/can/bsp_can.c:115` `CANAddFilter()`

```c
can_filter_conf.FilterMode  = CAN_FILTERMODE_IDLIST;  // 只有加入列表的 ID 才收
can_filter_conf.FilterIdLow = _instance->rx_id << 5;  // 精确匹配单个 ID
can_filter_conf.FilterBank  = (*pool)++;              // 每个电机独占一个 bank
```

过滤器采用 **IDLIST 模式**,每颗电机**独占一个 filter bank**:

| 总线 | 可用 bank |
| --- | --- |
| CAN1 | 0 ~ 13(14 个) |
| CAN2 | 14 ~ 27(14 个) |

两颗电机 rx_id 相同时:

1. **过滤器无法区分** —— 两者会匹配到同一个 bank
2. **回调找不到归属** —— 库用 rx_id 反查电机实例,两颗都匹配 → 数据被错误分配
3. **控制指令可能发到错误的电机** —— 这是实打实的硬件风险

**结论:这不只是"读数不准",而是 CAN 收发可能指向错误的电机。**

> 顺带一提:`CANReleaseFilter()`(`bsp_can.c:54`)支持回收 bank。
> 正因为有回收能力,测试台才能在运行期"拆掉一台电机、再换一台"——
> 否则 bank 只增不减,加几次就耗尽了。

---

## 五、官方库的处理方式:停机

代码位置:`dji_motor.c:75`(3508/2006 分支)与 `dji_motor.c:116`(6020 分支)

```c
for (size_t i = 0; i < idx; ++i)
{
    if (同一条总线 && rx_id 相同)
    {
        LOGERROR("[dji_motor] rx_id crash! rx_id=0x%03X(%d) can_bus=%d, tx_id=%d", ...);
        LOGERROR("[dji_motor] 6020(0x204+id) and 3508/2006(0x200+id) ranges overlap.");
        LOGERROR("[dji_motor] Put them on DIFFERENT CAN buses. HALT.");
        while (1) { __WFI(); }   // 停机等待人工复位
    }
}
```

库注释里给出的理由(`dji_motor.c:128`):

> 这里必须停在这里,否则会继续往下注册出错误配置。
> 配置错误会导致 CAN 收发指向错误电机,继续运行有风险。
> 仅保持空转等待人工复位,不再重复打印。

### 为什么这样设计是合理的

对 RoboMaster 机器人而言,电机配置是**出厂固化的**:

| | RoboMaster 机器人 | 电机测试台 |
| --- | --- | --- |
| 配置时机 | 编译期,一次烧好 | **运行期,随时点「添加」** |
| 接线 | 固定,按规范接好 | **用户临时决定** |
| ID | 出厂设定 | **由电调拨码决定,软件无权约束** |
| 出错代价 | 停机,人去查接线 | **停机,只能复位,界面无任何反馈** |

官方场景下停机 = "接线错了,去查",完全合理。

**但测试台场景下,停机 = "我不知道刚才点的那一下把板子搞死了,也不知道为什么"。**

这直接违背了测试台的核心价值 —— 让机械组自己就能操作设备。

---

## 六、测试台的增强:把"何时拒绝"提前

代码位置:`modules/motor_bench/motor_bench.c:501` / `:524`

```c
/** 预估某配置会产生的 rx_id —— 与 DJI 库公式完全一致 */
static uint16_t MotorBenchPredictRxId(MB_MotorKind_e kind, uint8_t motor_id)
{
    switch (kind)
    {
    case MB_MOTOR_GM6020:      return (uint16_t)(0x204 + motor_id);
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:       return (uint16_t)(0x200 + motor_id);
    default:                   return 0;   /* DM / LK / HT 不占 DJI 的 0x200 段 */
    }
}

static uint8_t MotorBenchCheckRxIdFree(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id)
{
    uint16_t new_rx = MotorBenchPredictRxId(kind, motor_id);
    if (new_rx == 0)
        return MB_OK;   /* 非 DJI 系,不参与该段冲突判定 */

    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        if (!mb_inventory[i].is_used || mb_inventory[i].can_bus != can_bus)
            continue;   /* ← 不同总线,直接跳过 */

        uint16_t exist_rx = MotorBenchPredictRxId(mb_inventory[i].kind,
                                                  mb_inventory[i].motor_id);
        if (exist_rx == new_rx)
        {
            LOGERROR("[motor_bench] add rejected: bus%d rx_id 0x%03X conflicts "
                     "(existing: kind=%d id=%d | new: kind=%d id=%d)", ...);
            LOGERROR("[motor_bench] rule: 6020 rx=0x204+id, 3508/2006 rx=0x200+id; "
                     "ranges overlap -> put them on DIFFERENT CAN buses");
            return MB_ERR_DUPLICATE;
        }
    }
    return MB_OK;
}
```

在 `MotorBenchAddMotor()` 中,它于 `DJIMotorInit()` **之前**调用:

```
用户点「添加」
   ↓
CheckRxIdFree() 预判 → 冲突 → 返回 MB_ERR_DUPLICATE
   ↓
页面提示失败 + RTT 打印 ASCII 原因
   ↓
板子继续正常运行,无需复位
```

---

## 七、两种方案对照

| 方面 | 官方 DJI 库 | 本测试台 |
| --- | --- | --- |
| 是否检测冲突 | ✅ 检测 | ✅ 检测 |
| 检测时机 | `DJIMotorInit()` 内部(创建**中**) | 创建**之前** |
| 处理方式 | `__WFI()` 停机等复位 | 返回 `MB_ERR_DUPLICATE` |
| 错误反馈 | 仅 RTT 日志 | **RTT 日志 + 页面提示** |
| 板子状态 | **挂死,需复位** | **正常运行** |
| 过滤器占用 | 已占用,**无法回滚** | 未占用 |

**这是必要的增强,不是重复造轮子。**

公式沿用库的实现,判断逻辑也一样,区别**只在于"在什么时候拒绝"**。

> ⚠️ 正因为差异只在时机,公式必须与库**逐字一致**。
> 若两边公式漂移(哪怕只差一个常量),这道防线形同虚设。

---

## 八、怎么确认自己没踩到

### 方法一:查网页顶部提示

页面顶部那条黄色横幅就是为此写的:

> 6020 的反馈 ID 是 `0x204+ID`(0x205~0x20C),3508/2006 是 `0x200+ID`(0x201~0x208),
> 两段区间重叠 → 6020 不能与 3508/2006 挂同一条总线上。

### 方法二:自己算一遍

把已添加的电机逐个代入公式,检查同一总线上有没有重复:

```
M3508  拨 3  →  0x200 + 3 = 0x203
M2006  拨 3  →  0x200 + 3 = 0x203   ← 同型号同 ID 也冲突!
GM6020 拨 1  →  0x204 + 1 = 0x205
GM6020 拨 5  →  0x204 + 5 = 0x209   ← 与上面所有都不冲突
```

> 注意最后两条:**同型号拨同一个 ID 同样会冲突**,不只是 6020 与 3508 之间的跨型号冲突。
> 判定标准是"同一总线上 rx_id 是否重复",与型号无关。

### 方法三:实测触发

想亲眼看它拒绝,可以故意试:

1. 先添加 **GM6020, CAN1, ID=1**
2. 再添加 **M3508, CAN1, ID=5**

页面会提示添加失败,RTT 打印:

```
[motor_bench] add rejected: bus1 rx_id 0x205 conflicts (existing: kind=1 id=1 | new: kind=2 id=5)
[motor_bench] rule: 6020 rx=0x204+id, 3508/2006 rx=0x200+id; ranges overlap -> put them on DIFFERENT CAN buses
```

**板子会正常拒绝、继续运行,不会挂死。**

> 这两行日志刻意用纯 ASCII:RTT Viewer 按本机代码页解码,中文会变乱码,
> 而这恰恰是最需要看清的一行。

---

## 九、容易踩的坑

### 1. "我拨的 ID 都不一样,怎么还冲突"

检查是不是**同型号拨了同一个 ID**。比如 CAN1 上先加 M3508 拨 3,再加 M2006 拨 3 —— rx_id 都是 0x203。

### 2. "官方库不是已经处理了吗"

处理了,但方式是**停机**。对机器人合理(配置出错就该停),对测试台不可接受(用户随时在配置)。

### 3. "换个 CAN 口行不行"

只要是**同一条总线**就不行。CAN1 和 CAN2 是两套独立 ID 空间,把两颗电机分别插到 CAN1、CAN2 上才是真正的隔离。

### 4. 达妙电机会不会也有这个问题

不会。DM/LK/HT 走 `0x100+id` 那一套 ID 段,与 DJI 系完全不重叠,`MotorBenchPredictRxId()` 对它们直接返回 0,跳过判定。

---

## 十、相关代码位置速查

| 内容 | 文件:行 |
| --- | --- |
| rx_id 分配公式 | `modules/motor/DJImotor/dji_motor.c:69`(3508/2006)、`:111`(6020) |
| 库内冲突检测与停机 | `modules/motor/DJImotor/dji_motor.c:75`、`:116` |
| CAN 过滤器分配 | `bsp/can/bsp_can.c:115` `CANAddFilter()` |
| 过滤器回收(支持运行期拆电机) | `bsp/can/bsp_can.c:52` `CANReleaseFilter()` |
| 测试台预检公式 | `modules/motor_bench/motor_bench.c:501` `MotorBenchPredictRxId()` |
| 测试台预检与拒绝 | `modules/motor_bench/motor_bench.c:524` `MotorBenchCheckRxIdFree()` |

---

## 十一、相关测试

自测 `motor_bench_host/selftest.js` 用**两组**覆盖本文规则
(第 26 组验公式与固件一致性,第 27 组验界面提示与可用 ID 计算):

```
== 26. CAN rx_id collision rules (see CAN_ID冲突说明.md) ==
  PASS  GM6020 id=1 -> 0x205
  PASS  M3508 id=8 -> 0x208
  PASS  DM predicts 0 (exempt from the rule)
  PASS  GM6020 id=1 conflicts with M3508 id=5 (same bus)
  PASS  GM6020 id=4 conflicts with M2006 id=8 (same bus)
  PASS  GM6020 id=1 + M3508 id=5 on DIFFERENT buses is fine
  PASS  firmware dji_motor.c was actually read
  PASS  firmware motor_bench.c was actually read
  PASS  DJI library assigns 0x200 + motor_id + 1 to M2006/M3508
  PASS  motor_bench predicts 0x204 + motor_id for GM6020
  PASS  motor_bench pre-check skips different CAN buses
  PASS  motor_bench never calls __WFI in the pre-check

== 27. add-motor panel: conflict hint and available-ID list ==
  PASS  M3508#1 also occupies id 1 for M2006 (same formula)
  PASS  GM6020#1 (rx 0x205) blocks M3508 id=5
  PASS  GM6020#1 leaves M3508 ids 1-4 and 6-8 free
  PASS  GM6020#5 blocks no M3508 id
  PASS  CAN1 occupancy does not affect CAN2
  PASS  DM ignores DJI id occupancy
  PASS  findConflict reports the right rx_id
  PASS  message tells the user to change the M3508 (user requirement ①)
  PASS  message lists the available ids (user requirement ②)
  PASS  available-id list is labelled with the motor being added
  PASS  message warns that the list depends on the motor type
  PASS  ui uses onXxx assignment, not addEventListener
  PASS  ui blocks the send when a conflict is detected
  PASS  ui recomputes the hint when inventory changes
```

第 26 组的存在理由是:**测试台预检与 DJI 库的公式分处两个文件**。
哪天有人改了其中一个而没改另一个,这道"创建前就拦住"的防线会**静默失效** ——
板子不再提前拒绝,而是走进库的 `__WFI()` 停机,用户只知道"点一下板子就死了"。
所以本组除了验证公式本身,还断言两个文件的公式**互相一致**,
并额外断言**两个固件文件确实被读取到了**(防止路径写错被 catch 静默跳过,
那种"跳过伪装成通过"的状态比失败更危险)。

### 注入验证记录

| 注入的错误 | 是否被抓到 |
| --- | --- |
| 测试台 `0x204` 改成 `0x200`(模拟公式漂移) | ✅ `predicts 0x204` 立即失败 |
| 去掉 `can_bus` 隔离判断 | ✅ 对应断言立即失败 |
| 把 M2006 挪出 `0x200` 段(破坏"同公式") | ✅ 第 27 组 8 条断言失败 |
| `availableIds` 不排除已占用 ID | ✅ 6 条断言失败 |
| 提示文案删掉可用 ID 列表 | ✅ 3 条断言失败 |

运行方式:

```powershell
cd D:\Main_Files\RM-MotorBench\motor_bench_host
node selftest.js
```