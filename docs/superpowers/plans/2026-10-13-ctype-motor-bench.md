# C 板电机测试台 Implementation Plan

> 执行方式：在当前会话完成实施与验证，完成后按 requesting-code-review 技能请独立审查。

**Goal:** 新增来自指定参考工程的 STM32F407 C 板测试台，与现有上位机兼容。

**Architecture:** C 板底层独立，移入测试台模块；只编译所需源码。USB 协议在唯一电机任务处理，守护任务检测断线。

**Tech Stack:** STM32 HAL 1.8.1、FreeRTOS、USB CDC、ARM GCC、GNU Make、Node.js、原生 GCC。

## Global Constraints

- C 板参考：`D:/hanako/basic_framework-master3 - 1`。
- 输出：`basic_framework_ctype_usb-master/build/basic_framework_CTYPE.{elf,hex,bin}`。
- 芯片 STM32F407IGH6；CAN1 PD0/PD1，CAN2 PB5/PB6；CAN 1 Mbps。
- 复用现有网页协议、PID 默认值和单位约定。

## Task 1: C 板固件与验证

- [x] 新建 `tests/ctype_can_test.c`、`tests/support/can.h`、`tests/ctype_firmware_test.mjs`，执行 `node tests/ctype_firmware_test.mjs`，确认因 C 板生产源码不存在而失败。
- [x] 从参考目录复制 Drivers、Middlewares、Inc、Src 和 F407 板级文件到新工程。
- [x] 从 A 板复制 motor_bench、motor_bench_app、DJI/DM、algorithm/controller、crc8、user_lib、daemon、general_def 和 CAN/USART/USB/DWT/log BSP。
- [x] 创建测试台专用 robot_def.h、robot.c、motor_task.c；在 Src/freertos.c 创建唯一 500 Hz 电机任务和 100 Hz 守护任务，初始化 USB。
- [x] 创建明确列举源码的 Makefile，指定 STM32F407xx、F407 启动及链接脚本，生成 elf/hex/bin。
- [x] 执行 CAN 配置和 CRC 行为测试；执行 `mingw32-make -j4`，排除编译错误。
- [x] 对运行期移除所需的驱动/守护注销、CAN 回收补齐生命周期实现，并验证反复增删不会保留失效指针或覆盖存活过滤器。
- [x] 更新项目根 README、新工程 README、上位机 README 的板型、烧录和接线说明。
- [x] 执行 `node selftest.js` 与 USB 队列模型；复核生成固件内存与默认模式。
- [x] 独立代码审查后修复相关问题并重复受影响检查。

## 执行记录

已完成固件移植、A/C 遥控与网页来源切换、转速单位修正、生命周期及 USB 队列修复。行为测试先复现异步缓冲覆盖与满队列断开重连失败，再验证修复。两块板已生成 elf/hex/bin；协议、CAN、生命周期和真实 C 行为测试通过。独立审查的实质问题已逐项修复，保留实物 USB、DBUS 和带载 PID 验证限制。
