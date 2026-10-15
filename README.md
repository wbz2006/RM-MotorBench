# RM-MotorBench · RoboMaster 实验室电机测试台

> 机械组自己就能测电机——不用再找电控组烧程序。

一套面向 RoboMaster 实验室的电机测试台：通过**浏览器页面**设定电机种类与转速，指令经 **USB 虚拟串口**下发到永久烧录固件的**大疆 A 型开发板**，由 A 板驱动 CAN 总线上的大疆/达妙电机，并**实时回传**转速、电流、温度。

**核心特性：换电机不需要改配置表、不需要重新烧固件。** 按电调拨码开关上的实际 ID，在网页上现场添加即可。

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
| [`basic_framework_atype_usb-master`](basic_framework_atype_usb-master) | 保留的旧 Makefile 工程，作为已验证可用的参考版本 |
| [`motor_bench_host`](motor_bench_host) | **上位机**。Node 服务（WebSocket 桥接串口）+ 原生 Web UI |
| `电机测试台方案.md` | 完整方案文档（设计推导、协议定义、排查记录） |
| [`basic_framework_atype_usb-master/USB排障指南.md`](basic_framework_atype_usb-master/USB排障指南.md) | USB 枚举失败（电脑报"无法识别的USB设备"）的 RTT 诊断步骤 |
| [`basic_framework_atype_usb-master/CAN_ID冲突说明.md`](basic_framework_atype_usb-master/CAN_ID冲突说明.md) | CAN ID 冲突规则、推荐接法、实测触发与排障 |

---

## 快速开始

### 1. 编译并烧录固件

```powershell
cd motorbench-a
# 确保 cmake、ninja、arm-none-eabi-gcc 在 PATH 中。
cmake --preset Debug
cmake --build --preset Debug --parallel
```

产物：`motorbench-a/build/Debug/basic_framework_ATYPE.{elf,hex,bin}`。

使用 VS Code 时，直接打开 `motorbench-a` 文件夹，安装 ST 官方 STM32Cube 扩展，选择 `Debug` CMake preset，再使用项目提供的 ST-Link 或 J-Link 调试配置。详见 [新工程说明](motorbench-a/README.md)。

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
4. 「添加电机」填：型号 / 总线 / 电调 ID
5. 通道卡片里选电机 → 绑定 → 使能 → 拖动滑块设转速

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
| MOTOR_ADD_ACK | `0x8A` | 上行 | 建电机结果 |

**安全设计**：心跳中断约 1.5s 自动全停；通道未使能时拒绝写参考值；关闭网页/服务时下发全停。

---

## 测试

```powershell
cd motor_bench_host
npm test                  # 协议自测（100+ 项）
npm run test:integration  # 与固件 CRC 表逐字节交叉校验
```

---

## 已知限制

- 电机清单在断电后不保留，重新上电需在网页重新添加（CAN 过滤器为启动期硬件资源）
- PID 当前为实验室通用经验值，实际电机需按型号整定
- 同总线 6020 与 3508/2006 不能共存（见上文 ID 规则）

---

## 致谢

- 跃鹿 `basic_framework`：[Gitee](https://gitee.com/hnuyuelurm/basic_framework)
- A 板适配版基础：[basic_framework_atype](https://gitee.com/hnuyuelurm/basic_framework_atype)

---

## 许可

本项目基于 `basic_framework` 修改，请遵循原项目的许可要求。
