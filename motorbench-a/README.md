# MotorBench A 板固件

本目录是当前固件主工程，基于 STM32F427IIH6、CubeMX 和 CMake/Ninja。旧的
`../basic_framework_atype_usb-master` 保留为实机可用的 Makefile 参考工程。

## 构建

需要 CMake 3.22+、Ninja、ARM GNU 工具链。本机已经安装 STM32CubeCLT 1.21.0，
其中的 `cmake`、`ninja` 和 `arm-none-eabi-gcc` 已在 PATH 中。项目不绑定机器绝对路径。

```powershell
cmake --preset Debug
cmake --build --preset Debug --parallel

cmake --preset Release
cmake --build --preset Release --parallel
```

生成 `build/Debug/basic_framework_ATYPE.elf`、`.hex`、`.bin`、`.map`，
Release 产物在 `build/Release`。保留 CubeMX 的原项目名和产物名，目录名为 `motorbench-a`。
Debug 使用与旧工程一致的 `-Og` 优化，Release 使用 `-Os`；浮点 ABI 为 Cortex-M4F hard-float。

## VS Code：ST 官方 STM32Cube 插件

1. 用 VS Code **打开本目录 `motorbench-a`**，不要打开旧固件目录。
2. 安装 STMicroelectronics 的 STM32Cube 扩展及其依赖；在官方插件的工具管理界面完成所需构建和调试工具安装。
3. 选择 CMake 的 `Debug` configure/build preset，构建项目。也可以按 `Ctrl+Shift+B` 使用提供的 `Build Debug` 任务。
4. 接好 A 板电源、SWD 和调试器，在“运行和调试”选择
   `STM32Cube: MotorBench ST-Link` 或 `STM32Cube: MotorBench J-Link`，按 F5。
   调试启动会构建、下载当前选中工程的 ELF，并停在 `main`；继续运行后才能使用 USB 测试台。
5. 需要正常烧录运行时，使用 ST 官方插件的 Run/下载入口；已有 HEX/BIN 也可用 STM32CubeProgrammer 烧录。

`.vscode/launch.json` 使用本机 ST 官方 1.4.0 调试组件声明的
`stlinkgdbtarget` / `jlinkgdbtarget` 类型，以及官方的构建与 ELF 选择命令。
它们不依赖 Cortex-Debug。调试服务器和工具路径由官方插件管理；J-Link 需要可用的 SEGGER 软件包。
RTT 日志后端保持 SEGGER RTT；调试器连接成功不等于已打开 RTT 日志窗口。

## 迁移范围与执行顺序

- 保留动态添加/移除电机、绑定通道、启停、三环 PID 配置、遥测、USB CDC 和 UART7 备用链路。
- 电机测试台当前接入 DJI M3508/M2006/GM6020 与达妙 DM；原有 LK、HT、舵机等通用驱动源码也保留，尚未因此新增上位机支持。
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
```

这些测试读取本目录源码，CRC 交叉校验会用本机原生 C 编译器编译固件的 `crc8.c`。
2026-10-15 已用 ARM GCC 14.3.1 完成 Debug、Release 构建，均无编译/链接警告；
现有 590 项自测全部通过、无跳过，固件 CRC 交叉校验通过。Debug 的 Flash 占用为 64472 字节，
RAM 静态分配及链接预留合计 78624 字节（包含最小 C heap/主栈预留，不代表运行期峰值）。
构建和协议测试无法代替实机验证：首次下载后仍需确认 USB 枚举、心跳、动态添加、启停、遥测与断链停机。
