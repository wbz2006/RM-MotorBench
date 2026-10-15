# C 板电机测试台

以用户指定的 `D:/hanako/basic_framework-master3 - 1` 为板级参考，新增 STM32F407IGH6 固件，与项目中的 A 板工程共用 `motor_bench_host` 网页。

## 板级配置

| 项目 | 本工程配置 |
|---|---|
| 芯片 | STM32F407IGH6 |
| 时钟 | 参考工程的 HSE 12 MHz、SYSCLK 168 MHz、USB 48 MHz |
| CAN1 | PD0 RX、PD1 TX，1 Mbps |
| CAN2 | PB5 RX、PB6 TX，1 Mbps |
| USB CDC | PA11 DM、PA12 DP，产品名 `Motor Bench CDC C` |
| DR16 接收机 | USART3，100000 baud、8 数据位 + 偶校验、1 停止位，按参考工程 DBUS 接口连接 |
| 可选上位机 UART | USART6，115200 baud、RX DMA；默认使用 USB |

时钟和引脚忠实沿用指定参考工程。烧录前核对实物型号和晶振；实物晶振不同应同步修改 `Src/main.c`、`Inc/stm32f4xx_hal_conf.h`、`basic_framework.ioc`，保持 USB 48 MHz。

## 编译与烧录

用 VS Code 直接打开本目录，按 `Ctrl+Shift+P` 选择“任务：运行任务”，即可运行 `MotorBench: 烧录 C 板（CMSIS-DAP）` 或 `MotorBench: 烧录 C 板（J-Link）`。任务会先编译本板固件，成功后写入 `build/basic_framework_CTYPE.elf`、校验并复位运行；编译失败则停止烧录。仅编译时按 `Ctrl+Shift+B`，选择 `MotorBench: 编译 C 板`。

任务配置位于本目录的 `.vscode/tasks.json`，使用本机已配置的 Make、ARM GCC 和 OpenOCD 路径。连接与工具路径说明见[总工程 README](../README.md#在-vs-code-中烧录本机已配置)。

ARM GNU 工具链和 GNU Make 加入 PATH 后，在本目录运行：

```powershell
mingw32-make -j4
```

输出为 `build/basic_framework_CTYPE.hex`、`.bin`、`.elf`。将 **CTYPE** 固件烧录到 C 板；A 板使用另一个目录中的 **ATYPE** 固件。

## 网页与遥控器

在项目的 `motor_bench_host` 目录运行 `npm install`、`npm start`，打开 http://127.0.0.1:3000。

1. 打开板端 USB 串口，按电机型号、CAN 总线、电调 ID 添加电机。
2. 将电机绑定到通道，选择速度环。
3. **网页控制**：可先输入转速，再点「使能」；运行中也可输入转速或拖动滑块，DJI 单位 rpm，DM 单位 rad/s。
4. **遥控器控制**：选定遥控通道和最大转速，点「应用控制方式」。右拨杆拨到上档，右摇杆回中后点「使能」，上下推右摇杆控制正反转，回中为零转速。
5. 右拨杆离开上档或接收机掉线，选定通道立即停机，恢复后仍须回中并重新使能。网页「急停」始终可用。

切换控制方式会停止全部电机。遥控模式仍须保持上位机 USB 心跳；约 1.5 秒收不到合法心跳会全停。板端确认切换后，网页才禁用或恢复直接转速输入。

## 实现与限制

- 仅启动测试台电机任务和守护任务，不启动参考工程的遥控测试、底盘、云台、惯导或裁判系统。
- 8 个清单槽位、8 个控制通道；同一颗电机不能同时绑定多个通道，重启后需要重新添加。
- GM6020 与 M3508/M2006 的反馈 ID 存在重叠，建议分开 CAN 总线；同型号 ID 不重复。
- DM 保留默认反馈 Master ID `0`，每条 CAN 总线最多一台 DM；电机需配置为相应 MIT 控制/反馈方式。DM 已使用速度 PID 形成扭矩指令，其网页 PID 设置/查询尚不支持；DJI 三型支持网页 PID 整定。
- 添加 DM 时，先停止并发送其他电机的零输出，再执行原驱动启动等待。
- 已验证软件编译、协议、生命周期和浏览器操作；USB 实物枚举、DBUS 接线和带载 PID 尚需上板验证。

## 验证

从项目根目录运行以下命令；C 行为测试需要本机原生 GCC：

```powershell
node tests/ctype_firmware_test.mjs
node tests/control_protocol_test.mjs
node tests/lifecycle_test.mjs
node tests/firmware_behavior_test.mjs
```

真实 C 模块行为测试覆盖异步 USB 指针保护、队列堵满后断开重连、仅心跳续期、rpm 单位换算、遥控通道解绑清理，以及反复创建/销毁电机。
