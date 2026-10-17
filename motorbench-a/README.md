# MotorBench A 板固件

本目录是当前固件主工程，基于 STM32F427IIH6、CubeMX 和 CMake/Ninja。旧的
`../basic_framework_atype_usb-master` 保留为实机可用的 Makefile 参考工程。

## 编译与烧录（推荐：VS Code + ST 官方插件）

**不需要命令行。** 用 VS Code 打开本目录 `motorbench-a`，装好
**STM32CubeIDE for Visual Studio Code** 扩展（STMicroelectronics 出品），
编译、烧录、调试都能在界面里完成：

| 想做什么 | 怎么做 |
|---|---|
| 编译 | 左下角状态栏点 `Build`，或命令面板搜 `STM32Cube: Build`；也可 `Ctrl+Shift+B` 走项目自带的 `Build Debug` 任务 |
| 烧录 + 调试 | 接好 A 板电源、SWD 和调试器，左侧「运行和调试」选 `STM32Cube: MotorBench ST-Link` 或 `STM32Cube: MotorBench J-Link`，按 F5 |
| 只烧录不调试 | 用调试配置旁的「下载」入口；也可另用 STM32CubeProgrammer 烧 `build/` 下已有的 HEX/BIN |

调试启动会**先自动编译，再下载 ELF，然后停在 `main`**——所以平时只按 F5 即可，
不必先手动构建。继续运行（F5 之后再按一次）才能使用 USB 测试台。

扩展首次使用时，在它的工具管理界面里安装所需的构建与调试工具
（CMake、Ninja、ARM GCC、ST-Link/J-Link GDB Server）。本机已装
STM32CubeCLT 1.21.0 与 SEGGER J-Link V9.48，插件通常能直接识别。

`.vscode/launch.json` 使用 ST 官方调试组件声明的
`stlinkgdbtarget` / `jlinkgdbtarget` 类型，以及官方的构建与 ELF 选择命令
（`preBuild` 与 `get-projects-binary-from-context1`）。它们不依赖 Cortex-Debug。
RTT 日志后端保持 SEGGER RTT；**调试器连接成功不等于已打开 RTT 日志窗口**，
看日志需要手动打开 RTT View。

### 调试配置中的设备名

`deviceName` 使用 CMSIS 设备库的 `STM32F427IIH6`，`deviceCore` 为 `Cortex-M4`。
CubeMX 的 `STM32F427IIHx` 是带占位符的型号表示，**不能**直接用于官方插件的
设备名称校验，否则会在烧录前报 `Device not found: No matching device`。
J-Link 的 `serverDevice` 则使用 SEGGER 的型号名称 `STM32F427II`。

## 命令行构建（可选，用于 CI 或脚本化）

日常开发不必用命令行；仅在需要脚本化/CI 构建时使用。

需要 CMake 3.22+、Ninja、ARM GNU 工具链（STM32CubeCLT 已包含，加入 PATH 即可）。
项目不绑定机器绝对路径。

```powershell
cmake --preset Debug
cmake --build --preset Debug --parallel

cmake --preset Release
cmake --build --preset Release --parallel
```

生成 `build/Debug/basic_framework_ATYPE.elf`、`.hex`、`.bin`、`.map`，
Release 产物在 `build/Release`。保留 CubeMX 的原项目名和产物名，目录名为 `motorbench-a`。
Debug 使用与旧工程一致的 `-Og` 优化，Release 使用 `-Os`；浮点 ABI 为 Cortex-M4F hard-float。

## 迁移范围与执行顺序

- 保留动态添加/移除电机、绑定通道、启停、三环 PID 配置、遥测、USB CDC 和 UART7 备用链路。
- 电机测试台当前接入 DJI M3508/M2006/GM6020 与 DM4310；原有 LK、HT、舵机等通用驱动源码也保留，尚未因此新增上位机支持。
- 保留 CAN、DWT、USB、串口、PWM、PID、守护和 RTT。整车底盘、云台、发射、遥控器、裁判系统及 IMU 应用留在旧工程，本工程不创建机器人或 INS 任务。
- 保留原有外设初始化、时钟、USB VID/PID、PID 数值及心跳超时参数。

启动顺序为 `MX_*` 外设初始化 → `RobotInit()`（DWT、日志和测试台回调）→
`MX_FREERTOS_Init()` 中的 USB 初始化 → 调度器。USB 底层保留旧工程的 DWT 延时处理。
CubeMX 默认任务仍会调用 USB 初始化，因此在 `usb_device.c` 的用户代码区增加了初始化保护，避免重复启动 USB。

电机任务每 2 ms 运行一次，独占测试台解析与遥测调用，遥测按原有 10 次分频约 50 Hz 上报。
旧工程同时由机器人任务和电机任务调用测试台，新工程移除了重复调度。电机任务栈为 1024 words，
沿用旧应用任务的预算；守护任务每 10 ms 运行，150 次超时对应约 1.5 秒。
默认任务在启动后自行删除，FreeRTOS heap 保持 30000 字节。

## 以后增加固定电机组合

`application/motor_bench_app` 继续负责电机实例装配，`modules/motor` 保留多电机与串级 PID 能力。
后续可以在应用层加入“2×M3508 摩擦轮 + 1×M2006 拨弹盘”等组合，由现有 500 Hz 任务统一调度，
并复用测试台的停止、链路超时和遥测机制。

本次迁移保留这些基础能力；组合模式、联动时序和对应上位机入口需要后续实现。
原机器人 `application/shoot` 可以作为逻辑参考，不在新固件中直接启用。

## CubeMX 再生成

继续使用本目录的 `basic_framework_ATYPE.ioc`，工具链保持 CMake，启用保留 USER CODE。

- `cmake/stm32cubemx/CMakeLists.txt` 由 CubeMX 管理，本次未手工修改。
- 用户源码与路径在 `cmake/motorbench.cmake`，由根 `CMakeLists.txt` 引入。
- `main.c`、`freertos.c`、`tim.c` 和 USB 接入代码均放在 USER CODE 区。
- `cmake/gcc-arm-none-eabi.cmake` 中的 `-mthumb`、Debug `-Og` 是手工对齐旧构建的设置，再生成后需检查差异。

## 验证

在仓库的 `motor_bench_host` 中运行：

```powershell
npm test
npm run test:integration
npm run test:motor-state
```

这些测试读取本目录源码，CRC 交叉校验会用本机原生 C 编译器编译固件的 `crc8.c`。
2026-10-15 已用 ARM GCC 14.3.1 完成 Debug、Release 构建，均无编译/链接警告；
现有 590 项自测全部通过、无跳过，固件 CRC 交叉校验通过。Debug 的 Flash 占用为 64472 字节，
RAM 静态分配及链接预留合计 78624 字节（包含最小 C heap/主栈预留，不代表运行期峰值）。
构建和协议测试无法代替实机验证：首次下载后仍需确认 USB 枚举、心跳、动态添加、启停、遥测与断链停机。

2026-10-17 修复多电机停机/再次使能：停机清零目标和 PID 历史，停机期间不再计算 DJI PID；
使能先从零启动，再下发当前卡片显示的目标值，同一实例禁止绑定多个通道。
DM 的速度目标现在实际经过速度 PID（沿用界面单位 rad/s），停止发送 MIT 失能命令，
未收到反馈或反馈超过 100 ms 未更新时输出零扭矩，并按真实反馈报告在线状态。
建/拆电机协议的 RX ID 改为 16 位小端，负载由 4 字节变为 5 字节，支持 `0x302` 等标准 CAN ID；
固件版本为 1.1，须同时更新固件并重启上位机服务、刷新页面。
`test:motor-state` 使用原生 GCC/Clang 编译实际固件源码，覆盖启停、积分残留、重复绑定、
CAN 分组隔离、M2006 ID3 与 DM4310 TX6/RX0x302 双向切换，以及完整 RX ID 的收包到 CAN 配置路径。
实机复测时两路目标先设零，交替执行“一路运行后停机 → 另一路零速使能”；检查目标与反馈，
再断开 DM 反馈确认显示离线，最后检查全停及主机断链停机。新增速度闭环仍需按实际负载验证整定参数。

2026-10-17 DM4310 零速使能振动排查：接通速度闭环后，原 `Kp=5` 与 `MaxOut=10`
直接对应 N·m，不能作为空载台架的默认参数。DM 初始速度环改为 `Kp=0.05`、
`Ki=Kd=0`、`MaxOut=0.5 N·m`、积分限幅为零，网页默认显示同步；MIT 编解码量程保持原配置。
原生回归使用实际工厂配置，增加 500 Hz、1～2 拍反馈延迟、不同惯量的零速扰动模型。
模型验证不能替代实机整定，尤其不能证明所有负载和电调量程配置都稳定。

2026-10-17 电机管理改为统一列表：右上角 `＋` 展开添加表单，板端登记成功后自动入表，
每行末尾 `×` 确认删除。DM 型号当前只显示 DM4310；TX／RX 输入框固定显示 `0x`，
直接填写十六进制 ID，例如 TX `06`、RX `302`，无需换算十进制。DJI 电调 ID 仍为 1～8。
固件版本升为 1.2，清单每项由 4 字节扩为 6 字节，末尾追加小端 `uint16_t rx_id`，
让页面刷新后仍能显示完整反馈 ID，并带齐删除匹配键。上位机兼容旧清单，但旧固件缺少
DM 反馈 ID 时会提示更新并禁用该行删除。使用完整功能需烧录 1.2 固件、重启上位机服务并刷新页面。

网页刷新或重新连接串口后，保留电机清单，清空测试通道、目标与曲线。后台先发全停，
再逐个解绑板端全部 8 个通道，缺少应答会自动重试；收到全部解绑应答后才开放重新绑定。旧通道的 USB 遥测不会
自动进入新页面，必须显式绑定后才显示对应通道曲线。清理超时可点击“同步清单”重试。
此刷新行为修复仅修改上位机，重启服务并刷新网页即可，无需额外更新固件。
