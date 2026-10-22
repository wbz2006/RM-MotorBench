# RM-MotorBench · RoboMaster 实验室电机测试台

> 多用途复合电机测试台

一套面向 RoboMaster 实验室的电机测试台：通过**浏览器页面**设定电机种类与转速，指令经 **USB 虚拟串口**下发到永久烧录固件的开发板（**大疆 A 型或 C 型**均可），由开发板驱动 CAN 总线上的常见无刷电机，并**实时回传**转速、电流、温度。

**核心特性：换电机不需要改配置表、不需要重新烧固件。** 按电调拨码开关上的实际 ID，在网页上现场添加即可。

上位机提供**两种并行的使用方式**，功能完全相同，按需选择：

| | 桌面便携版（推荐给机械组） | 浏览器版 |
|---|---|---|
| 形态 | 单个 `MotorBench-1.1.0-Windows-x64.exe` | `npm start` + 浏览器 |
| 前置依赖 | 无（内置 Electron / 网页 / 串口依赖，可离线） | Node.js 22.12+ |
| 打开方式 | 双击，进入独立调试窗口 | 手动打开 `http://127.0.0.1:3000` |
| 端口 | 自动选空闲端口，**不占 3000** | 固定 3000（可 `--port` 改） |
| 适用 | 日常测电机、分发给机械组 | 改代码、调试上位机本身 |

两者可以**同时运行**：桌面版用随机空闲端口，不会和浏览器版的 3000 冲突。
下载见 [GitHub Releases](https://github.com/wbz2006/RM-MotorBench/releases)；
配套固件源码和烧录说明见 [`motorbench-a`](motorbench-a) 与 [`motorbench-c`](motorbench-c)。

---

## 为什么做这个

实验室里电机型号多（M3508 / M2006 / GM6020 / 达妙 DM-4310…），机械组想测一颗电机好坏，传统流程是找电控组改代码、重新烧板子。本项目把"配置"从固件里搬到了网页上，让测试变成点几下的事。

同样适用于多种简单的电机使用场景，如**发射机构的简单测试**：搭好拨弹盘后，用上位机的射频换算器，根据每圈发数和减速比换算电机转速，再给 M2006（或 M3508）设定转速，实测拨弹盘性能；**简单的自旋靶车**：单电机固定点旋转，本上位机可生成正弦或阶梯速度输出。

---

## 系统架构

```
浏览器 ──WebSocket──> Node 服务 ──USB 虚拟串口──> 开发板 ──CAN──> 电机
                                                 │
                                            遥测实时回传
```

| 环节 | 实现 |
|---|---|
| 前端 | 原生 Web UI（无框架依赖） |
| 桥接 | Node + WebSocket + serialport |
| 传输 | USB OTG FS（CDC 虚拟串口） |
| 控制 | A 板 STM32F427IIH6 / C 板 STM32F407IGH6 |
| 驱动 | CAN 总线，支持常见的无刷电机 |

---

## 目录结构

| 目录 | 说明 |
|---|---|
| [`motorbench-a`](motorbench-a) | **固件主工程**。CubeMX + CMake/Ninja，电机测试台、USB CDC 与动态建电机 |
| [`motorbench-c`](motorbench-c) | **C板的固件工程** |
| [`basic_framework_atype_usb-master`](basic_framework_atype_usb-master) | 保留的旧 Makefile 工程，作为已验证可用的参考版本 |
| [`motor_bench_host`](motor_bench_host) | **上位机**。Node 服务（WebSocket 桥接串口）+ 原生 Web UI；含 Electron 桌面版打包配置 |
| `电机测试台方案.md` | 完整方案文档（设计推导、协议定义、排查记录） |

---

## 快速开始

### 1. 编译并烧录固件

本项目**同时支持 A 板与 C 板**，两者用各自的工程、各自烧录，上位机是同一套。

| | A 板 | C 板 |
|---|---|---|
| 工程目录 | `motorbench-a` | `motorbench-c` |
| 主控 | STM32F427IIH6 | STM32F407IGH6 |
| 调试配置 | `STM32Cube: MotorBench ST-Link` / `J-Link` | `STM32Cube: MotorBench C ST-Link` / `C J-Link` |
| 产物 | `build/Debug/basic_framework_ATYPE.{elf,hex,bin}` | `build/Debug/basic_framework.{elf,hex,bin}` |

**操作步骤（两板相同）**：在 VS Code 中打开对应工程目录，装好
**STM32CubeIDE for Visual Studio Code** 扩展（STMicroelectronics 出品），
编译和烧录均在 VS Code 中完成：

- **烧录 + 调试**：接好开发板电源、SWD 和调试器，「运行和调试」里选上表对应的配置，按 F5

首次使用请在扩展的工具管理界面安装所需的构建/调试工具
（CMake、Ninja、ARM GCC、ST-Link/J-Link GDB Server）。

> 两板固件**不可混用**（主控与外设不同）。C 板工程是 2026-10-18 从 A 板工作区迁入的阶段快照，
> 不自动同步 A 板后续开发，详见 [C 板迁移与验证说明](motorbench-c/README.md)。

如果偏好命令行（CI / 脚本化场景），在对应工程目录下执行：

```powershell
cd motorbench-a        # 或 cd motorbench-c
cmake --preset Debug
cmake --build --preset Debug --parallel
```

详见 [A 板固件说明](motorbench-a/README.md)。

### 2. 启动上位机（两种方式任选）

**方式 A：桌面便携版（推荐，无需环境配置）**

下载 Release 里的 `MotorBench-x.x.x-Windows-x64.exe`，双击即可。
它会拉起一个独立的「电机测试台」窗口，内部已经带好网页界面和串口依赖，**不用装 Node.js，也不用另开浏览器**。

- 关闭窗口时，后台会先请求电机全停、关闭串口，再退出
- 重复双击不会开第二个窗口，而是激活已有窗口
- 端口自动选空闲端口，不会和下面方式 B 的 3000 端口冲突，**两者可同时开**

**方式 B：浏览器版**

```powershell
cd motor_bench_host
npm install
npm start
```

浏览器打开 **http://127.0.0.1:3000**

改 `server.js` 或 `protocol.js` 后要重启 Node 服务；只改 HTML/CSS/网页脚本时刷新即可。
只刷新网页**不会**更新后台已加载的代码。

> 两种方式功能完全一致，共用同一套逻辑

### 3. 使用流程（已添加较详细使用教程）

1. XT30 接 **24V** 电源
2. USB 线接 开发板 Micro-USB
3. 网页/程序选择串口 → 打开
4. 右上角 `＋` 添加电机：型号 / 总线 / 电调 ID
5. 通道卡片里选电机 → 绑定 → 使能 → 拖动滑块设转速
6. 列表里每行末尾 `×` 可移除该电机

---

## ⚠️ CAN ID 规则（重要）

| 电机 | 反馈 ID |
|---|---|
| GM6020 | `0x204 + ID` |
| M3508 / M2006 | `0x200 + ID` |

两段区间**重叠**（`0x205~0x208`），所以：

同一 CAN 总线的反馈 ID 不能重复：GM6020 ID 1～4 分别与 M3508/M2006 ID 5～8 冲突。
添加前，页面会提示冲突对象并列出**当前型号**可用的 ID；也可以将冲突电机接到不同 CAN 总线。

---

## 硬件连接

| 接口 | 用途 |
|---|---|
| A板/C板+电机的XT30 | 供电 |
| Micro-USB | USB 通信（OTG FS，PA11/PA12） |
| SWD（仅烧录程序使用） | 调试下载（PA13/PA14） |
| CAN1 / CAN2 | 接电机电调/电机本体 |

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
npm run test:desktop       # 检查打包后的窗口、资源、串口枚举与退出
```

桌面版打包（需 Node.js 22.12+，首次下载打包工具需联网）：

```powershell
cd motor_bench_host
npm ci
npm run build:exe          # 生成 dist/MotorBench-1.1.0-Windows-x64.exe
```

---

## 已知限制

- **电机清单不跨断电保留**：重新上电后板端清单为空，需在网页重新添加
- PID 需按实际电机与负载整定，网页默认值只是起点
- 同总线 6020 与 3508/2006 存在部分冲突（见上文 ID 规则）

---

## 致谢

- 跃鹿 `basic_framework`：[Gitee](https://gitee.com/hnuyuelurm/basic_framework)
- A 板适配版基础：[basic_framework_atype](https://gitee.com/hnuyuelurm/basic_framework_atype)

---

## 许可

本项目基于 `basic_framework` 二次修改，请遵循原项目的许可要求。
