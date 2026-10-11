# USB 枚举失败 · RTT 诊断指南

> 症状:烧录后插 USB,电脑报"无法识别的USB设备"。
> 本固件已内置 RTT 探针,**一次烧录即可定位卡在哪一步**。

## 一、怎么看

### 硬件连接

| 用途 | 接法 |
| --- | --- |
| 烧录 + 调试 | J-Link 接 SWD(接口 14:`PA13 SWDIO` / `PA14 SWCLK`),**全程不要断** |
| 被测 USB 通道 | USB 线接 Micro-USB(接口 17)—— 这正是要测的那条通道 |
| 供电 | XT30 接 15~24V(接口 21) |

> J-Link 必须保持连接:RTT 是通过调试器读内存的,拔掉就看不到输出了。

### 软件操作

1. VSCode 打开工程,用工程自带任务启动 **Ozone 调试**(或 J-Link + RTT Viewer)
2. RTT Viewer 里选对通道:**Channel 0**,地址 `0x20000000`(up buffer)
3. **先打开 RTT Viewer,再复位板子**(或按一下复位键)——
   开机那几行日志只打印一次,晚了就看不到了

### 正常输出应该长这样

```
[P] === main() entered ===
[P] HAL_Init done
[P] SystemClock_Config done
[P] all MX_*_Init done
[P] entering RobotInit()...
[P] RobotInit() done
[P] entering MX_FREERTOS_Init()...
[P] entering MX_USB_DEVICE_Init   <- 来自 usb_device.c
[P] RTT pending bytes: 0
[P] ---- USB OTG FS registers (live) ----
[P] RCC->AHB2ENR=0x00000000 OTGFSCLEN=1
[P] CID=0x0000xxxx (expect non-zero)
[P] GOTGCTL=0x80000000 SCNE=0 SRST=0 DEV=1
...
[P] AFTER_USBD_Init
[P] AFTER_RegisterClass_CDC
[P] AFTER_USBD_Start
[P] DONE | USBD_Start OK
[P] MX_FREERTOS_Init done (USB inited)
[P] starting scheduler
[P] motor task alive        <- 每约 2 秒一条,持续刷
```

## 二、按输出查表

### 卡在哪一步 —— 看最后一条日志停在哪

| 最后一条日志 | 说明卡在 | 原因方向 |
| --- | --- | --- |
| 没有 `main() entered` | 没进 `main()` | BOOT0/BOOT1 设置、烧录地址、供电 |
| `SystemClock_Config done` | 卡在 `SystemClock_Config()` | HSE 晶振未起振(`HAL_RCC_OscConfig` 返回错误会进 `Error_Handler`) |
| `all MX_*_Init done` | 卡在 `RobotInit()` | **电机配置表 rx_id 冲突** —— `dji_motor.c` 的 `MotorSenderGrouping()` 检测到冲突会 `while(1)` 死等 |
| `entering MX_FREERTOS_Init` | 卡在 USB 初始化 | 见下表 |
| `starting scheduler` 但无 `motor task alive` | 调度器没跑起来 | FreeRTOS 配置、中断优先级 |

> `RobotInit` 卡死这一条特别值得留意:框架里 6020 与 3508/2006 若在同一总线上
> ID 冲突,就会停在 `while(1)` 里反复打日志。此时 RTT 会疯狂刷
> `[dji_motor] id [...] can_bus [...]`。

### USB 寄存器怎么读

| 观测 | 期望 | 不符合时说明 |
| --- | --- | --- |
| `RCC->AHB2ENR ... OTGFSCLEN` | `1` | `0` → USB 时钟没开,外设完全没工作 |
| `CID` | 非 `0x00000000` | 全 0 → 总线访问不到外设(时钟/型号/供电) |
| `GAHBCFG HBEN(bit7)` | `1` | `0` → AHB 访问未使能,设备模式无法工作 |
| `GUSBCFG PHYULPI(bit9)` | `0` | `1` → 配成了外置 PHY,但本板是板载 PHY |
| `GCCFG PWRDWN(bit2)` | `0` | `1` → 外设还在省电模式,`USBD_Start` 没真正唤醒 |
| `GOTGCTL SCNE(bit0)` | 启动后变 `1` | 一直 `0` → 从未发起 USB 会话,主机看不到设备 |
| `DCFG DSPHSET(bit0)` | `1` | `0` → 配成了低速 |

### 如果四个步骤全过但电脑仍认不出

说明**固件侧已经正常**,问题在物理层,按这个顺序查:

1. **供电**:板子 LED(PF14 绿 / PE7 红)是否亮?不亮就是没上电
2. **ID 引脚(PA10)**:手册标注 A 板为 **Device_Only**,从机模式下 ID 应固定接低;
   而 `usbd_conf.c` 目前把 PA10 与 PA11/PA12 一起配成了 `GPIO_AF10_OTG_FS`。
   这是下一步最该试的改动 —— 把 PA10 改为普通输出并拉低。
3. **VBUS**:手册 USB 原理图显示 VBUS 直连 Micro-USB 座,中间没有供电选择电路。
   用万用表量一下 USB 座 VBUS 与板子 GND 之间的电压,确认 PC 侧有 5V 输出。
4. **USB 线**:必须是数据线,有些充电线没有 D+/D-。
5. **换电脑口 / 换线**,排除主机侧问题。

## 三、日志刷屏问题(已解决)

### 现象

RTT Viewer 里疯狂刷：

```
W[dji_motor] Motor lost, can bus [2] , id [1]
E[motor_bench] host link lost, all motors stopped
```

几秒内把 RTT 写满,真正的启动日志全被冲掉。

### 原因

`modules/daemon/daemon.c` 的 `DaemonTask()` 以 100Hz 运行:

```c
if (dins->temp_count > 0)
    dins->temp_count--;
else if (dins->callback)
    dins->callback(dins->owner_id);   // ← 离线时每周期都调用
```

**没有"已告警"的状态记忆**,所以只要没接电机(实验室常态),
离线回调每秒被调 10 次,日志自然刷屏。这是测试台场景与框架
"离线即告警"设计之间的固有矛盾,不是 bug。

### 已做的处理

| 项 | 处理 |
| --- | --- |
| `dji_motor` 离线告警 | 由宏 `MOTOR_BENCH_QUIET_LOG` 控制,测试台模式下静音 |
| `motor_bench` 链路断开告警 | 加状态记忆,只在"由在线变为离线"时打**一次** |
| 离线判定阈值 | 由 `MOTOR_BENCH_DAEMON_RELOAD_COUNT` 控制,2(≈20ms) → 10(≈100ms) |

安全动作(全停)不受日志开关影响,始终执行。

### 想临时看离线日志

注释掉 `application/robot_def.h` 里的:

```c
// #define MOTOR_BENCH_QUIET_LOG
```

但注意会重新刷屏,建议只在确认电机确实接上时临时开启。

### 这三个宏在哪

`application/robot_def.h`:

```c
#define USB_PROBE_ENABLED                    // USB 诊断打点(排查完关掉)
#define MOTOR_BENCH_QUIET_LOG                // 静音电机离线刷屏
#define MOTOR_BENCH_DAEMON_RELOAD_COUNT 10   // 离线判定 ≈100ms
```

> ⚠️ **踩过的坑**:`modules/motor/DJImotor/dji_motor.c` 与 `modules/motor/motor_task.c`
> 都需要 `#include "robot_def.h"` 才能拿到这些宏。
> 不包含时条件编译**静默为假**,表现为"改了开关完全没效果"。
> 本工程已因此踩坑两次,改这两个文件时务必确认 include 存在。

## 四、关闭 USB 探针

定位完成后,把 `application/robot_def.h` 里的这一行注释掉:

```c
// #define USB_PROBE_ENABLED
```

否则 `[P] motor task alive` 会每 2 秒占用一次 RTT 上行缓冲
(整个缓冲只有 1024 字节),影响其他日志输出。

`modules/motor_bench/usb_probe.c/.h` 与 `Core/Src/main.c` 里的
`SEGGER_RTT_WriteString` 调用也可以一并删除。

## 五、当前固件状态

| 项 | 值 |
| --- | --- |
| 编译 | ARM GCC 14.3.1,零错误零新增警告 |
| text | 68836 B |
| USB 探针 | 开(`USB_PROBE_ENABLED`) |
| 离线告警 | 静音(`MOTOR_BENCH_QUIET_LOG`) |
| 离线阈值 | 10(≈100ms) |