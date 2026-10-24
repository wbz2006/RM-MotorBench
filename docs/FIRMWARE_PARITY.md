# A / C / MC02 固件功能对照（2026-10-24）

根目录三套工程统一到固件 **1.26**，保留各板自己的 MCU、引脚、外设、USB、FreeRTOS、启动和链接配置。A/C 的完整控制功能及最新 M2006 默认参数已迁入 MC02；MC02 从原 H723 CubeMX 外设骨架补齐电机测试台应用、协议、驱动和底层适配。共用网页继续位于 `motor_bench_host`。

## 当前共同功能

| 功能 | A 板 | C 板 | MC02 |
| --- | --- | --- | --- |
| 动态添加／删除电机、8 通道绑定、资源回收 | 一致 | 一致 | 一致 |
| 速度／位置／电流闭环切换、PID 读写、遥测 | 一致 | 一致 | 一致 |
| M2006 位置 PID 默认 4 / 5 / 0 / 6000 / 1000，积分限幅 | 一致 | 一致 | 一致 |
| 输出轴角度、每次使能建立相对零点 | 一致 | 一致 | 一致 |
| 单／双发累计理论目标、共享容差、DJI 末端死区 | 一致 | 一致 | 一致 |
| 大角度步进、重复触发／忙／离线／停机保护 | 一致 | 一致 | 一致 |
| 速度目标过渡、快速归零、零目标保持使能 | 一致 | 一致 | 一致 |
| DM 零速量化积分保持、PID 非有限数／异常 dt 保护 | 一致 | 一致 | 一致 |
| DM4310 24 V 量程、DM8009P 独立默认 PID | 一致 | 一致 | 一致 |
| 断线停止、恢复发现不自动续跑、CAN 旧发送过期取消 | 一致 | 一致 | 一致 |
| 主机心跳约 1.5 秒断链全停、默认未使能 | 一致 | 一致 | 一致 |
| DWT 在调试器断开后恢复计数使能 | 一致 | 一致 | 一致，另解锁 M7 DWT |

普通变速／反向为 100 rad/s² 或 30,000 rpm/s；显式零目标为 200 rad/s² 或 60,000 rpm/s。快速归零保持使能及已有 PID 补偿；停机／急停撤销使能。以上是内部目标变化率，实际响应取决于负载。LK／HT 保留驱动和回归覆盖，网页仍仅开放已有大疆、达妙型号。

M2006 默认值作用于新建电机实例；原有实例的在线整定不会被刷新网页覆盖。计算器可选择是否计入 M2006/M3508 内置减速比，协议位置仍统一为减速箱输出轴角度。

## 协议和网页

心跳 `board_flags & 0x60` 标识编译目标：A / `STM32F427xx` 为 `0x20`，C / `STM32F407xx` 为 `0x40`，MC02 / `STM32H723xx` 为 `0x60`；旧固件 `0x00` 显示通用“控制板”。网页沿用最新心跳板型，遥测不覆盖它；切换串口或服务断开后清除。心跳帧长不变，不按 COM 编号和固件版本猜测板型。

能力位保留：`0x02` 位置步进、`0x04` 输出轴角度、`0x08` 到位判断、`0x10` 速度过渡／快速归零、`0x80` 共享步进容差。网页兼容旧固件的能力判断。

11 字节位置步进请求在旧 7 字节末尾追加输出轴容差 float，7 字节请求保留旧行为。新请求的容差大于 0 且不超过步进的 10%；重触发按上一动作容差判断，新目标从上一理论目标累计。DJI 仅在拨弹路径使用末端死区，普通设定、停机和再次使能清除死区。

三板共用当前网页 `UI 20261024-loader-control`，包含固定区域单／双发、稳定读数布局、内置减速比复选框、橙色曲线游标读值、串口选择教程、通用标题、版本页脚及空格急停提示。网页功能不需要在三套固件目录重复保存。

## 保留的板级差异

| 配置 | A 板 | C 板 | MC02 |
| --- | --- | --- | --- |
| MCU | STM32F427IIH6 | STM32F407IGH6 | STM32H723VGT6 |
| 生成目录 | Core/Inc、Core/Src、USB_DEVICE | Inc、Src | Core/Inc、Core/Src、USB_DEVICE |
| 上位机链路 | USB 默认，可选 UART7 | USB CDC | USB CDC（HS 外设的全速模式，DMA 关闭） |
| 网页 CAN1 / CAN2 | bxCAN1 / bxCAN2 | bxCAN1 / bxCAN2 | FDCAN1 / FDCAN2，经典 CAN 1 Mbps |
| CAN 接口 | 原生 HAL_CAN | 原生 HAL_CAN | can.h + bsp_can_hal.c 适配 FDCAN |
| CAN 过滤器 | 两路各 14 个 bank | 两路各 14 个 bank | 两个独立池，各 14 个标准 ID 过滤器 |
| 总线关闭恢复 | bxCAN 自动恢复 | bxCAN 自动恢复 | 清除旧发送并请求 FDCAN 标准恢复 |
| DWT 时钟 | 168 MHz | 168 MHz | 由 SystemCoreClock 获取，M7 解锁 |
| PWM 时钟选择／USB 诊断 | F4 实现 | F4 实现 | H7 寄存器和时钟实现 |
| 固件产物前缀 | basic_framework_ATYPE | basic_framework | Basic_Framework_MC02 |

MC02 的网页 CAN1 对应 FDCAN1（PD0 RX / PD1 TX），CAN2 对应 FDCAN2（PB5 RX / PB6 TX）。FDCAN3 保留原工程生成配置，本次未开放第三条总线。MC02 测试台不使用 UART DMA 通信。三板固件不可互相烧录。

MC02 FDCAN 每条总线配置 3 个发送 FIFO 槽，匹配共用驱动的发送槽跟踪；适配层保持发送位掩码、10 ms 旧发送取消及有界等待逻辑。拒绝未登记、远程和扩展帧，接收侧拒绝 FD 长载荷，避免写越界。H7 控制器需要软件请求总线关闭恢复，区别于 F4 的自动恢复。

## 软件验证与产物

`npm run test:firmware-parity` 检查三套 `application`、`modules`、`bsp` 全部 C/H 源文件，仅允许明确的 MCU 头文件、上位机初始化、H7 时钟／PWM／USB 诊断及新增 FDCAN 适配差异。共同控制逻辑必须保持一致。

在 `motor_bench_host` 中分别选择三套工程运行行为测试：

```powershell
$env:MOTORBENCH_FIRMWARE = 'motorbench-a' # 或 motorbench-c / motorbench-mc02
npm test
npm run test:motor-state
npm run test:integration
Remove-Item Env:MOTORBENCH_FIRMWARE
npm run test:firmware-parity
npm run test:fdcan
npm run test:mc02-usb
npm run test:guidance
npm run test:loader
```

三板协议自检、真实控制源码行为回归、CRC 交叉验证及源码对照均已通过。MC02 底层测试直接使用实际 H723 HAL／USB 类型，覆盖两路过滤器隔离与复用、经典帧长度、发送位掩码和错误、过期发送取消接口、无效接收缓存保护、FIFO 排空、总线关闭恢复请求，以及 USB 行编码、收发回调和发送就绪保护。网页模拟连接验证三板识别及单双发，未操作真实电机。

| 构建 | Flash 链接使用 | RAM 链接使用 |
| --- | ---: | ---: |
| A Debug | 74,796 B | 78,760 B |
| A Release | 65,740 B | 78,672 B |
| C Debug | 78,212 B | 76,744 B |
| C Release | 68,268 B | 76,656 B |
| MC02 Debug | 155,412 B | 70,072 B（DTCM） |
| MC02 Release | 81,908 B | 69,736 B（DTCM） |

六个构建均成功，分别生成 `.elf`、`.hex`、`.bin`：

- `motorbench-a/build/{Debug,Release}/basic_framework_ATYPE.*`
- `motorbench-c/build/{Debug,Release}/basic_framework.*`
- `motorbench-mc02/build/{Debug,Release}/Basic_Framework_MC02.*`

本次未烧录开发板、未使能真实电机。软件测试中的硬件／时间由测试桩提供，MC02 的 USB 枚举、实际 CAN 收发、板级接线及负载下的稳定性仍需实机验证。固件修改必须烧录才会生效；网页刷新与服务重启不更新板上的固件。
