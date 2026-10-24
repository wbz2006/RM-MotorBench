# MotorBench C 型开发板固件

## 当前固件 1.26：固化 M2006 位置环参数

当前 C 板已补齐 A 板的通用速度过渡、快速归零、DM 零速积分保持与异常保护、DM 默认 PID 和量程限制、
LK／HT 驱动修复，以及 DWT 调试器断开恢复。位置控制、输出轴角度和单／双发功能已同步到 A、C、MC02 三套工程。
心跳新增 `MB_CAP_SPEED_RAMP`（`0x10`），网页按能力识别快速归零。
1.24 使用心跳 `board_flags` 的 bits 5-6 明确上报板型，C 板为 `0x40`，新版网页据此显示“C 板在线”；旧固件显示通用“控制板在线”。
1.26 将用户实机确认的 M2006 位置环参数设为默认：Kp=4、Ki=5、Kd=0、MaxOut=6000 deg/s、IntegralLimit=1000 deg/s，保留积分限幅。网页初始值和“恢复默认值”同步；新建电机实例自动采用，后续仍可整定。
1.25 新增步进容差能力位 `0x80`：网页与固件共用容差，DJI 进入容差时停止微小追位、保留速度环制动，下一组从原目标累计。内置减速比由网页复选框显式选择，协议角度仍为输出轴度；普通手动位置控制不使用拨弹死区。
完整对照、验证方法和保留的硬件差异见 [固件功能对照](../docs/FIRMWARE_PARITY.md)。
引脚、时钟、USB、FreeRTOS、链接与启动配置仍使用 F407 C 板配置；固件版本统一为 **1.26**。

## 初次迁移记录（历史）

本目录是 2026-10-18 从 `../motorbench-a` **当前工作区最新源码**迁入的独立快照，
包括尚未提交的修复，固件协议版本为 **1.6**。本次不建立 A/C 自动同步或共用业务源码目录；
A 板继续作为后续开发来源，有阶段性成果后再显式迁移到 C 板。

迁入了动态添加/删除、八通道绑定、启停、速度/相对位置控制、PID 读写、
绑定后闭环切换、遥测及心跳断链停机。控制参数和协议处理沿用此次 A 板源码。
固定电机组合的扩展基础保留，但没有新增“2×3508＋1×2006”等联动模式。

## VS Code 编译、烧录与调试

1. 在 VS Code **打开本目录 `motorbench-c`**。
2. 安装 ST 官方 **STM32CubeIDE for Visual Studio Code** 扩展，使用其工具管理功能配置
   CMake、Ninja、ARM GNU、ST-Link/J-Link 调试工具。
3. 选择 `Debug` CMake preset。状态栏 Build 或 `Ctrl+Shift+B` 可编译。
4. 接好 C 板供电和 SWD，在“运行和调试”选择
   `STM32Cube: MotorBench C ST-Link` 或 `STM32Cube: MotorBench C J-Link`，按 F5。
   官方插件会先编译、下载当前工程 ELF，然后停在 `main`；继续运行才能使用 USB。

调试型号为 `STM32F407IGH6` / `Cortex-M4`，J-Link 使用 `STM32F407IG`。
配置使用 ST 官方 `stlinkgdbtarget` / `jlinkgdbtarget` 适配器，不依赖 Cortex-Debug。
J-Link 需要可用的 SEGGER 软件包。日志仍通过 SEGGER RTT 输出，需另行打开 RTT 查看工具。

本工程保持 CubeMX 项目名 `basic_framework`，产物为：

```text
build/Debug/basic_framework.elf
build/Debug/basic_framework.hex
build/Debug/basic_framework.bin
build/Debug/basic_framework.map
```

这些是 **F407 C 板固件**，不要与 A 板 `basic_framework_ATYPE` 产物混用。

可选命令行构建（在本目录执行）：

```powershell
cmake --preset Debug
cmake --build --preset Debug --parallel
cmake --preset Release
cmake --build --preset Release --parallel
```

## 硬件和外设

| 项目 | 本工程配置 |
|---|---|
| 开发板 / MCU | 大疆标准 C 型开发板，STM32F407IGH6 |
| 时钟 | HSE 12MHz，主频 168MHz，USB 48MHz |
| CAN1 | PD0 RX / PD1 TX，1Mbps |
| CAN2 | PB5 RX / PB6 TX，1Mbps |
| 主机链路 | 板载 USB OTG FS CDC，PA11 DM / PA12 DP |
| USB 标识 | VID:PID `0483:00CA`，产品名 `Motor Bench CDC` |
| Flash / 普通 SRAM / CCM | 1MiB / 128KiB / 64KiB |

**主机通信仅使用 USB。** 本工程不提供 UART7 备用入口；CubeMX 生成的 USART 等外设
初始化保留，未将其注册为测试台通信通道。上位机沿用 `../motor_bench_host`，不需要切换协议或安装第二套服务。
烧录当前产物后重新打开串口；固件版本应显示 1.26。

保留 C 板 `.ioc` 生成的引脚、时钟和定时器设置。TIM5/TIM8 在该工程是 PWM，
没有搬入 A 板的编码器启动代码；不创建整车机器人任务或 INS 任务。
测试台当前支持 DJI M3508/M2006/GM6020 和 DM4310；保留的其它电机驱动不代表上位机已经支持。

## 运行顺序与内存

外设初始化 → `RobotInit()`（DWT、RTT、测试台回调）→ `MX_FREERTOS_Init()` 内 USB 初始化
→ 调度器。USB 保留 A 板用户区的回调和 DWT 延时处理，并用初始化保护兼容 CubeMX 默认任务再次调用初始化。

电机任务每 2ms 执行，独占测试台解析及遥测调用；遥测每 10 拍发送，约 50Hz。
守护任务每 10ms 执行，主机心跳超时计数 150，约 1.5 秒后全停。
电机任务栈为 1024 words，守护任务为 128 words；默认任务启动后自行删除。

沿用 C 工程的 FreeRTOS heap 20000 字节，C heap 和主栈的链接最小预留各 `0x5000` 字节。
CCM 未用于 USB/DMA 缓冲。链接内存占用包含预留，不能代表动态分配与任务栈的运行期峰值。

## 回归与实机验证

2026-10-18 本次迁移已完成 Debug / Release 构建，无编译或链接警告；
C 板源码的 624 项自检、协议 CRC 交叉检查及电机状态回归均通过。
测试路径调整后，默认 A 板自检和电机状态回归也已通过。

| 构建 | Flash 占用 | 普通 SRAM 链接占用 |
|---|---:|---:|
| Debug | 70588 字节 | 76640 字节（58.47%） |
| Release | 61820 字节 | 76552 字节（58.40%） |

SRAM 数字包含链接器预留的 C heap 和主栈，CCM 未使用。

在 `../motor_bench_host` 目录中选择 C 板源码后执行现有回归：

```powershell
$env:MOTORBENCH_FIRMWARE = 'motorbench-c'
npm test
npm run test:integration
npm run test:motor-state
Remove-Item Env:MOTORBENCH_FIRMWARE
```

测试默认仍读取 `motorbench-a`，保持 A 板阶段性开发习惯。设置环境变量只选择测试源码，
不改变上位机运行行为。C 板构建独立使用本目录源码，不依赖 A 板目录。

电机状态回归会使用原生 GCC/Clang 编译实际 CAN、守护、DJI/DM 与协议源码，覆盖启停、
PID 历史、位置级联、闭环切换、完整 DM RX ID、心跳解析、100 轮动态增删和通道资源回收。

**尚未执行 C 板实机烧录和验证。** 首次下载后依次检查 USB 枚举、版本心跳、两路 CAN
添加与反馈、零目标使能、速度/位置控制、动态删除及断链全停。软件回归不能证明实际负载下的 PID 稳定性。

## 后续 CubeMX 再生成与阶段性迁移

- 使用本目录 `basic_framework.ioc`，保持 CMake 工具链和保留 USER CODE。
- `Src/Inc` 及 `cmake/stm32cubemx/CMakeLists.txt` 继续由 CubeMX 管理；生成的 CMake 文件本次未手工修改。
- 用户源码清单在 `cmake/motorbench.cmake`，由根 CMakeLists 引入。
- 接入代码位于 `main.c`、`freertos.c` 和 USB 的 USER CODE 区。
- `.ioc` 与 USB 描述符都已将产品名设置为 `Motor Bench CDC`。
- GNU 工具链中的 `-mthumb`、Debug `-Og` 是迁移对齐设置，再生成后检查是否保留。
- 下次迁移 A 板成果时保留 C 板 F407、引脚和 USB 接入差异，再重新执行构建及上述 C 板回归；不要整体覆盖 C 板生成目录。
