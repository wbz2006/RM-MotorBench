# RM-MotorBench · RoboMaster 实验室电机测试台

> 机械组自己就能测电机——不用再找电控组烧程序。

一套面向 RoboMaster 实验室的电机测试台：通过**浏览器页面**设定电机种类与转速，指令经 **USB 虚拟串口**下发到永久烧录固件的**大疆 A 型开发板**，由 A 板驱动 CAN 总线上的大疆/达妙电机，并**实时回传**转速、电流、温度。

**核心特性：换电机不需要改配置表、不需要重新烧固件。** 按电调拨码开关上的实际 ID，在网页上现场添加即可。

**Windows 桌面版下载：** [GitHub Releases](https://github.com/wbz2006/RM-MotorBench/releases)。
下载 `MotorBench-1.0.0-Windows-x64.exe`，双击进入独立调试窗口，无需安装 Node.js 或另外打开浏览器。
同一 Release 提供配套 A 板 1.12 固件；DM4310 请使用该固件，以匹配修正后的量程与默认 PID。
桌面版的开发和打包方法见[上位机说明](motor_bench_host/README.md#windows-桌面便携版)。

---

## 为什么做这个

实验室里电机型号多（M3508 / M2006 / GM6020 / 达妙 DM-4310…），机械组想测一颗电机好坏，传统流程是找电控组改代码、重新烧板子。本项目把"配置"从固件里搬到了网页上，让测试变成点几下的事。

---

## 系统架构

```
浏览器 ──WebSocket──> Node 服务 ──USB 虚拟串口──> A 板 ──CAN──> 电机
                                                    │
                                              遥测实时回传
```

| 环节 | 实现 |
|---|---|
| 前端 | 原生 Web UI（无框架依赖） |
| 桥接 | Node + WebSocket + serialport |
| 传输 | USB OTG FS（CDC 虚拟串口，VID:PID = `0483:00CA`） |
| 控制 | A 板 STM32F427IIH6 + FreeRTOS |
| 驱动 | CAN 总线，支持 DJI M3508/M2006/GM6020、达妙 DM-4310 |

---

## 目录结构

| 目录 | 说明 |
|---|---|
| [`motorbench-a`](motorbench-a) | **固件主工程**。CubeMX + CMake/Ninja，电机测试台、USB CDC 与动态建电机 |
| [`motorbench-c`](motorbench-c) | **C 型开发板阶段性快照**。2026-10-18 从 A 板工作区固件 1.6 迁入，STM32F407IGH6，仅 USB；不自动同步 A 板后续开发 |
| [`basic_framework_atype_usb-master`](basic_framework_atype_usb-master) | 保留的旧 Makefile 工程，作为已验证可用的参考版本 |
| [`motor_bench_host`](motor_bench_host) | **上位机**。Node 服务（WebSocket 桥接串口）+ 原生 Web UI |
| `电机测试台方案.md` | 完整方案文档（设计推导、协议定义、排查记录） |
| [`basic_framework_atype_usb-master/USB排障指南.md`](basic_framework_atype_usb-master/USB排障指南.md) | USB 枚举失败（电脑报"无法识别的USB设备"）的 RTT 诊断步骤 |
| [`basic_framework_atype_usb-master/CAN_ID冲突说明.md`](basic_framework_atype_usb-master/CAN_ID冲突说明.md) | CAN ID 冲突规则、推荐接法、实测触发与排障 |

---

## 快速开始

### 1. 编译并烧录固件

用 VS Code 打开 `motorbench-a` 文件夹，装好 **STM32CubeIDE for Visual Studio Code**
扩展（STMicroelectronics 出品），编译和烧录都在界面里完成，**不需要命令行**：

- **编译**：状态栏 `Build`，或命令面板搜 `STM32Cube: Build`；也可 `Ctrl+Shift+B`
- **烧录 + 调试**：接好 A 板电源、SWD 和调试器，「运行和调试」里选
  `STM32Cube: MotorBench ST-Link` 或 `STM32Cube: MotorBench J-Link`，按 F5
  —— 会**先自动编译，再下载 ELF，然后停在 `main`**

首次使用请在扩展的工具管理界面安装所需的构建/调试工具
（CMake、Ninja、ARM GCC、ST-Link/J-Link GDB Server）。

如果偏好命令行（CI / 脚本化场景），也可以：

```powershell
cd motorbench-a
cmake --preset Debug
cmake --build --preset Debug --parallel
```

产物在 `motorbench-a/build/Debug/basic_framework_ATYPE.{elf,hex,bin}`。
详见 [固件工程说明](motorbench-a/README.md)。

**使用 C 型开发板时**，在 VS Code 中打开 `motorbench-c`，选择
`STM32Cube: MotorBench C ST-Link` 或 `STM32Cube: MotorBench C J-Link`。
C 板产物为 `motorbench-c/build/Debug/basic_framework.{elf,hex,bin}`，
上位机仍使用下述同一套服务。详见 [C 板迁移与验证说明](motorbench-c/README.md)。

### 2. 启动上位机

```powershell
cd motor_bench_host
npm install
npm start
```

浏览器打开 **http://127.0.0.1:3000**

### 3. 使用流程

1. XT30 接 **15~24V** 电源（USB 口不供电）
2. USB 线接 A 板 Micro-USB
3. 网页选择串口 → 打开
4. 右上角 `＋` 添加电机：型号 / 总线 / 电调 ID（达妙还需填 TX / RX 两个 ID）
5. 通道卡片里选电机 → 绑定 → 使能 → 拖动滑块设转速
6. 列表里每行末尾 `×` 可移除该电机

---

## ⚠️ CAN ID 规则（重要）

| 电机 | 反馈 ID |
|---|---|
| GM6020 | `0x204 + ID` |
| M3508 / M2006 | `0x200 + ID` |

两段区间**重叠**（`0x205~0x208`），所以：

> **GM6020 不能与 M3508/M2006 挂在同一条 CAN 总线上。**
> 例：6020 用 ID1 会和 3508 用 ID5 撞车。

**建议**：CAN1 只接 6020，CAN2 接 3508/2006。每条总线最多 14 颗（受 CAN 过滤器数量限制）。

---

## 硬件连接

| 接口 | 用途 |
|---|---|
| 接口 21 XT30 | 供电 **15~24V**（**必需**） |
| 接口 17 Micro-USB | USB 通信（OTG FS，PA11/PA12） |
| 接口 14 SWD | 调试下载（PA13/PA14） |
| CAN1 / CAN2 | 接电机电调 |

> ⚠️ **不要**把电机/电调直接接到 A 板的 XT30 输出口（反电动势会烧板）。

---

## 通信协议

自描述帧，统一格式：

```
| 0xA5 | type | len | body[len] | crc8 | 0x5A |
```

- `crc8` 覆盖 `type + len + body`
- 支持流式重同步：帧头误判时右移一字节继续查找
- 上位机与固件端均有 CRC 交叉校验测试

主要帧类型：

| 类型 | 值 | 方向 | 说明 |
|---|---|---|---|
| HEARTBEAT | `0x01` | 上行 | 心跳（安全门闩） |
| MOTOR_BIND | `0x02` | 下行 | 绑定电机到通道 |
| MOTOR_SET | `0x03` | 下行 | 设参考值 |
| MOTOR_ENABLE | `0x04` | 下行 | 使能/停止 |
| ALL_STOP | `0x05` | 下行 | 全部急停 |
| QUERY | `0x06` | 下行 | 查询状态 |
| INVENTORY_QUERY | `0x07` | 下行 | 查询电机清单 |
| **MOTOR_ADD** | `0x08` | 下行 | **动态创建电机** |
| MOTOR_REMOVE | `0x09` | 下行 | 移除电机 |
| TELEMETRY | `0x81` | 上行 | 遥测上报 |
| INVENTORY_REPORT | `0x82` | 上行 | 清单应答 |
| MOTOR_ADD_ACK | `0x8A` | 上行 | 建/拆电机结果 |

**达妙 DM-4310 的两个 ID**：DM 走 MIT 协议，发送与接收是独立 ID——
`TX`（主机→电机的控制指令）与 `RX`（电调→主机的反馈，主机的 CAN 过滤器按它匹配）。
界面上直接填十六进制，例如 TX `06`、RX `302`。DJI 系只需填 1~8 的电调拨码 ID，
反馈 ID 由固件按 `0x200+ID` / `0x204+ID` 算出。

**安全设计**：心跳中断约 1.5s 自动全停；通道未使能时拒绝写参考值；关闭网页/服务时下发全停。

---

## 测试

```powershell
cd motor_bench_host
npm test                   # 协议自测（含 DOM/CSS 契约与界面接线断言）
npm run test:integration   # 与固件 CRC 表逐字节交叉校验
npm run test:motor-state   # 编译真实固件控制路径,验证启停/积分残留/增删电机
```

---

## 已知限制

- **电机清单不跨断电保留**：重新上电后板端清单为空，需在网页重新添加
  （CAN 过滤器由硬件在启动期分配，这是框架的固有限制）
- **达妙 DM 尚未实机验证**：TX/RX 双 ID、速度闭环参数（`Kp=0.05`、`MaxOut=0.5 N·m`）
  与离线检测都只经过原生回归验证，未上真机
- PID 需按实际电机与负载整定，网页默认值只是起点
- 同总线 6020 与 3508/2006 不能共存（见上文 ID 规则）

---

## 致谢

- 跃鹿 `basic_framework`：[Gitee](https://gitee.com/hnuyuelurm/basic_framework)
- A 板适配版基础：[basic_framework_atype](https://gitee.com/hnuyuelurm/basic_framework_atype)

---

## 许可

本项目基于 `basic_framework` 修改，请遵循原项目的许可要求。
