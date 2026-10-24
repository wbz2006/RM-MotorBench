# MC02 电机测试台固件

本目录为达妙 MC02（STM32H723VGT6）的独立 CMake 工程，当前固件 **1.26**。已从 A/C 工程迁入完整电机测试台控制代码，并适配 H7 的 FDCAN、USB 和 DWT；与根目录的 `motor_bench_host` 共用网页与协议。已完成软件回归和 Debug / Release 编译，**尚未烧录或进行 MC02 实机运动验证**。

## 已同步功能

- 动态添加／删除电机、8 通道绑定、速度／位置／电流闭环切换、PID 读写和遥测。
- M2006 位置环默认值：Kp **4**、Ki **5**、Kd **0**、MaxOut **6000**、IntegralLimit **1000**（PID improve = 1），与网页默认值一致。已有实例的在线参数不会因修改源码而改变，需烧录新固件并重新创建实例。
- 输出轴位置单位、每次使能建立相对零点、单／双发位置步进、共享到位容差、累计理论目标、DJI 末端死区和重复触发保护。
- 速度目标过渡、快速归零、DM 零速积分保持、异常计时／非有限数停机、离线恢复及动态资源回收。
- 上电未使能不出力，主机心跳超时约 1.5 秒全停；网页空格急停、失焦保护等由同一套上位机提供。

计算器、橙色曲线游标、串口选择教程、输入布局及内置减速比复选框属于共享网页功能，不需要复制到板端。

## 板级适配

| 项目 | MC02 配置 |
| --- | --- |
| MCU / 主频 | STM32H723VGT6 / 480 MHz，保留原工程时钟配置 |
| 网页 CAN1 | FDCAN1，PD0 RX / PD1 TX，经典 CAN 1 Mbps |
| 网页 CAN2 | FDCAN2，PB5 RX / PB6 TX，经典 CAN 1 Mbps |
| FDCAN3 | 保留生成配置，本次不作为网页第三条总线开放 |
| 接收过滤器 | 每条总线独立 14 个标准 ID 过滤器，动态登记、删除及复用 |
| 发送 | 每条总线 3 个 FIFO 槽，自动重发；共用 10 ms 过期取消和有界等待逻辑 |
| 总线关闭恢复 | 中止旧发送请求后清 INIT，请求硬件执行标准总线恢复；电机重新上线保持原有停机保护 |
| USB | HS 外设、内置 PHY、全速 CDC，PA11 DM / PA12 DP，DMA 关闭 |
| USB 标识 | VID:PID `0483:5740`，产品名 `Motor Bench CDC MC02` |
| 心跳板型 | `board_flags & 0x60 == 0x60`，网页显示“MC02 板在线” |
| DWT | 按 `SystemCoreClock` 换算，解锁 Cortex-M7 计数器，恢复调试器断开后被清除的使能 |

`Core/Inc/can.h` 与 `bsp/can/bsp_can_hal.c` 将共用电机驱动的 bxCAN API 转接到 H7 HAL，发送和接收均使用经典标准帧。拒收未登记 ID、远程帧和扩展帧，避免将 CAN FD 长载荷写入共用驱动的 8 字节缓存。

保留本工程生成的外设、引脚、启动和链接配置，不覆盖为 F4 文件。UART 外设保留生成配置，测试台链路仅使用 USB，未开放 UART DMA 通信。

## 构建和下载

在本目录运行：

```powershell
cmake --preset Debug
cmake --build --preset Debug --parallel
cmake --preset Release
cmake --build --preset Release --parallel
```

产物为 `build/Debug/Basic_Framework_MC02.{elf,hex,bin}` 和 `build/Release/Basic_Framework_MC02.{elf,hex,bin}`。可在 VS Code 打开本目录，使用共享的构建任务及 STM32Cube ST-Link / J-Link 调试配置，目标器件为 STM32H723VGT6。不可烧录 A/C 的产物。

### DAPLink 烧录与调试

在 VS Code 中**单独打开 `motorbench-mc02` 文件夹**，安装推荐的 **Cortex-Debug** 扩展。安装 OpenOCD **0.12.0 或更新版本**（需包含 `interface/cmsis-dap.cfg` 和 `target/stm32h7x.cfg` 脚本），并确保 `openocd`、`arm-none-eabi-gdb`、`arm-none-eabi-objdump`、`arm-none-eabi-nm`、`cmake` 和 `ninja` 在 PATH 中；修改 PATH 后重启 VS Code。ARM 工具链可使用 STM32CubeCLT 提供的版本。

DAPLink 通过 **SWDIO、SWCLK、GND、VTref（板上 3.3 V 电平参考）**连接 MC02 的 SWD 接口，开发板正常供电。默认使用软件复位，不要求连接 NRST。`openocd_dap.cfg` 已选择 H723 单核／单 Flash bank、1 MHz SWD，兼容 CMSIS-DAP v1/v2。

- **下载并调试**：在“运行和调试”选择 `MotorBench MC02 DAPLink (OpenOCD)`，按 **F5**。自动编译 Debug、下载，并停在 `main`；按 F5 继续运行。
- **仅烧录**：执行“终端 → 运行任务”，选择 `Flash MC02 (DAPLink, Release)` 或 `Flash MC02 (DAPLink, Debug)`。任务先编译，再烧录、校验并复位运行。

命令行烧录 Release（工作目录为本目录，先完成 Release 构建）：

```powershell
openocd -f openocd_dap.cfg -c "program {build/Release/Basic_Framework_MC02.elf} verify reset exit"
```

如果提示找不到 `openocd`，将安装目录加入 PATH，或将任务的 `command` 和调试配置的 `serverpath` 改为其实际路径。如果 SWD 连接不稳定，可将 `openocd_dap.cfg` 的 `adapter speed 1000` 改为 `adapter speed 400`。多个 CMSIS-DAP 调试器同时连接时，可在配置中添加 `adapter serial <调试器序列号>`。

本次已验证配置解析及目标选择，未执行实际烧录。

启动顺序为外设初始化 → `RobotInit()` 注册 USB 回调 → 初始化 USB 和 FreeRTOS 任务 → 调度器。电机任务每 2 ms 运行，守护任务每 10 ms 运行。电机任务栈 1024 words，守护任务栈 128 words；FreeRTOS heap 25600 B，链接器 C heap 最小预留 16 KiB。静态数据与动态内存位于 DTCM；USB DMA 已关闭。链接占用不代表运行时堆栈峰值。

CubeMX 再生成时保留 USER CODE 和根 CMake 对 `cmake/motorbench.cmake` 的引用；检查 CAN 头文件适配、USB CDC 回调／描述符、链接 heap、FDCAN 每条总线 3 个发送槽和 FDCAN1/2 自动重发仍然生效。

## 验证

在 `../motor_bench_host` 中运行：

```powershell
$env:MOTORBENCH_FIRMWARE = 'motorbench-mc02'
npm test
npm run test:motor-state
npm run test:integration
npm run test:fdcan
npm run test:mc02-usb
npm run test:firmware-parity
Remove-Item Env:MOTORBENCH_FIRMWARE
```

控制行为回归使用真实协议、应用工厂、驱动、PID、CAN 资源管理和守护源码，硬件与时间由测试桩提供。FDCAN 适配测试使用本工程真实 H723 HAL 头文件，验证两路过滤器隔离／复用、数据长度、发送位掩码、取消旧发送、接收缓存保护、FIFO 排空和总线关闭恢复请求。

USB 测试直接编译实际 CDC 接口，覆盖行编码读写、接收回调先于重新接收、未就绪／忙时拒绝发送及发送完成回调。

首次实机下载后仍需验证 USB 枚举与心跳、两路 CAN 收发、M2006 默认参数、单双发、快速归零、拔线／断链停机及负载下的稳定性。完整三板对照与构建占用见 [三板功能对照](../docs/FIRMWARE_PARITY.md)。
