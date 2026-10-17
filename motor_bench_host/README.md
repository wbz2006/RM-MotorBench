# 电机测试台上位机

配套固件:[`motorbench-a`](../motorbench-a)(A 板 + USB CDC，CMake 主工程)。
`npm test` 与 `npm run test:integration` 均读取该目录中的固件源码。

## 快速开始

```bash
npm install          # 安装 serialport 与 ws
npm start            # 启动后访问 http://localhost:8080
```

修改上位机代码后需重启 `npm start` 对应的 Node 服务，再用 `Ctrl+F5` 刷新网页。
只刷新网页不会更新后台已加载的代码。网页会检查后台是否支持通道清理；
若提示“后台版本过旧”，需重启后台。清理超时会显示缺少应答的通道，可点击“同步清单”重试。
通道清理按 0～7 逐个发送，收到应答后才发送下一个；单个通道每 400 ms 重试，最多发送 3 次，
避免批量指令跨 USB 包时漏掉最后一个通道。关闭串口会同时取消启动及常规心跳定时器。

命令行参数:

```bash
node server.js --port 8080              # HTTP 端口
node server.js --serial COM5 --baud 115200
node server.js --host 0.0.0.0           # 允许同一局域网的手机/平板访问(谨慎)
```

## 使用流程(USB 直连,推荐)

1. 用**一根普通 USB 线**把 A 板插到电脑(板载 Micro USB-OTG FS,接口编号 17)
   —— 不需要外接 USB 转串口模块
2. 上电烧录好电机测试台固件
3. Windows 设备管理器会出现一个新的 **COM 口**(产品名 `Motor Bench CDC`)
4. 页面点「刷新」选它 → 「打开」
5. 页面自动拉取固件登记的电机清单并填入下拉框
6. 选电机 → 「绑定」→ 拖滑块设转速 → 「使能」
7. 结束务必「停机」或直接点顶部「急停」

> **波特率随便填**:USB CDC 是包协议,不依赖真实波特率,
> `Motor Bench CDC` 的枚举名比普通 UART 好认。

曲线按型号显示单位：DM4310 为转速 `rad/s`、转矩 `N·m`，对应当前 MIT 驱动的反馈量；
大疆电机为转速 `rpm`、电流协议原始值 `raw`，未换算为安培。
鼠标悬停曲线可查看最近一次遥测的数值（曲线本身仍按所选滤波设置绘制）。
未使能时仍显示真实反馈；DM 速度轴最小跨度为 1 rad/s，刻度保留小数，避免放大零速附近的量化波动。

### 如果改用 UART 通道

把固件 `application/robot_def.h` 里的宏换成:

```c
// #define MOTOR_BENCH_LINK_USB
#define MOTOR_BENCH_LINK_UART
```

重新编译烧录,然后用 USB 转串口线接 A 板 UART7(PE7/PE8,3.3V,交叉接+共地),
上位机操作完全不变。

## 安全设计(重要)

| 机制 | 说明 |
| --- | --- |
| 上电默认停止 | 所有电机登记后即为 `MOTOR_STOP`,必须显式「使能」才输出 |
| 未使能拒写参考值 | 通道未使能时板端拒绝写入并打日志 |
| 参考值限幅 | 固件侧硬限幅 ±12000,防止误输入打飞电机 |
| 心跳看门狗 | 上位机 200ms 一跳;约 1s 收不到,A 板自动全停 |
| 握手门闩 | 链路未建立时,除心跳/查询外的指令一律丢弃 |
| 急停 | 页面「急停」、页面关闭、服务 Ctrl+C 退出都会下发全停 |
| USB 不阻塞 | 固件发送队列满时丢弃帧,不阻塞 500Hz 电机控制任务 |

**物理急停按钮建议单独加一个**(框架 TODO 里也提到"急需一个无线遥控继电器")。
软件链路再可靠,也不该作为唯一的停机手段。

## 自测

```bash
npm test                  # 协议自测(45 项),不依赖串口
npm run test:integration  # 把固件 crc8.c 编译成原生程序,与 Node 侧逐位比对
node txqueue_test.js      # USB 发送环形队列模型测试
```

`test:integration` 需要本机有 gcc/clang(MinGW 亦可)。它把固件
`modules/algorithm/crc8.c` 原样编译成命令行程序,喂同一批字节给固件算法和
Node 实现 —— 比"两边各写一遍 CRC 再对答案"可靠得多。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `protocol.js` | 帧组装/解析/CRC,必须与固件 `motor_bench.h` 保持一致 |
| `server.js` | 串口 ↔ WebSocket 桥,附带心跳、全停、退出清理 |
| `ui.js` / `index.html` / `style.css` | 浏览器界面 |
| `selftest.js` | 协议自测 |
| `integration_test.js` | 与固件 CRC 的交叉校验 |
| `txqueue_test.js` | USB 发送队列行为模型 |

## 换串口

固件默认 USB;若要换 UART,改
`application/motor_bench_app/motor_bench_app.c` 里的
`MotorBenchInit(&huart7)`。该串口必须已在 CubeMX 中开启 RX DMA
(A 板上 UART7/UART8 的 DMA 中断均已在 `stm32f4xx_it.c` 中使能)。
