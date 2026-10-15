# 电机测试台上位机

配套固件:`basic_framework_atype_usb-master`(A 板)与 `basic_framework_ctype_usb-master`(C 板)，默认 USB CDC。

## 快速开始

```bash
npm install          # 安装 serialport 与 ws
npm start            # 启动后访问 http://127.0.0.1:3000
```

命令行参数:

```bash
node server.js --port 8080              # HTTP 端口
node server.js --serial COM5 --baud 115200
node server.js --host 0.0.0.0           # 允许同一局域网的手机/平板访问(谨慎)
```

## 网页转速与遥控器

网页模式保留转速输入框和滑块：可先设转速再使能，运行中直接调整。新增「控制方式」面板，可选择 DT7/DR16 遥控器控制、遥控通道和最大转速；右拨杆上档、右摇杆回中后点通道「使能」，右摇杆上下控制正反转。

A 板接收机使用 USART1 DBUS，C 板使用参考工程 USART3 DBUS。切换方式会全部停止；遥控器掉线或右拨杆离开上档会停机。遥控器恢复后需要回中并重新使能。网页急停始终可用，遥控模式仍需保持上位机心跳。

## 四轮底盘遥控

「控制方式」支持麦克纳姆底盘与四轮全向底盘。先把四个同型号 DJI 电机绑定为速度环,
再按左前 FL、右前 FR、左后 RL、右后 RR 选择四个不同通道,设置每轮反向和最大轮电机转速,
点击「应用控制方式」并等待板端确认。右拨杆拨到上档、两摇杆回中后,点击「底盘使能」。

- 右摇杆上下:前后移动;右摇杆左右:左右平移。
- 左摇杆左右:底盘旋转。坐标为前方 x 正、左方 y 正、逆时针旋转正。
- 麦轮使用 X 型辊子布局;全向轮使用四轮 45° X 型切向布局。轮序和电机安装方向须对应,
  必要时勾选各轮「反向」。三轮全向、其他安装角度或舵轮不使用此配置。
- 转速为电机转子 rpm;混合平移/旋转时四轮等比例限幅,保持运动方向。最大值不是底盘 m/s。
- 点击任何成员卡片的「使能/停机」都会控制整组;「底盘停机」停止四轮。切换模式、解绑任一轮、
  任一轮离线、遥控器掉线、拨杆离开上档、心跳超时和急停都会停止底盘,恢复后须回中并重新使能。
  修改任一成员 PID 也会整组停机。控制配置编辑中或等待板端确认时,启动按钮保持禁用,停机仍可用。

这项功能需要重新烧录对应 A/C 板的新固件,并重启上位机服务、刷新网页。原有网页和单电机遥控仍可使用。

## PID 参数记忆

网页自动保存上次填写的整组 PID:Kp、Ki、Kd、输出限幅和积分限幅。
参数按电机型号、CAN 总线、ID 和控制环分别记忆,刷新页面、重新绑定或重新添加通道后,
选回同一颗电机即可恢复;首次使用才填入型号默认值。

记录保存在当前浏览器的当前网址中;更换浏览器、端口或清除网站数据后需重新设置。
「恢复该型号默认值」会替换该电机当前环的记忆值;「读回板端值」只用于查看,不会覆盖已保存的调试值。
恢复的是网页输入值,点击「应用到电机」后才会下发。此功能不需要重新烧录固件。

## 实时转速波形

选择电机并以「速度环」绑定后,在独立的「实时转速波形」面板选择通道。
蓝色虚线显示开发板回传的目标转速,绿色实线显示实际转速,跟踪误差为目标减实际。
DJI 电机使用 rpm,DM 使用 rad/s。非速度环的目标值不参与转速对比。

默认显示最近 10 秒,可切换 5/10/30/60 秒;纵轴自动缩放,支持正反转和超调。
「暂停显示」冻结画面供观察,后台仍采集;「继续显示」回到实时数据。
「清空波形」只清空选中通道的历史。这些按钮不会停机或修改电机设定。
调 PID 时可先清空,修改参数并应用,再改变目标转速,观察两条曲线的差异。

横轴按网页接收时间绘制,受通信延迟影响。离线、无效数据或超过 1 秒的通信间隔处断线。
每通道最多保存最近 60 秒/6000 点;解绑或重新绑定会清除对应旧历史,避免混入另一颗电机的数据。
更换电机或控制环前需先解绑并重新添加通道。上位机服务会保留本次串口会话中已确认的绑定信息,
刷新页面后自动恢复电机选择、控制环和图表采集;历史曲线从刷新后重新记录。
重新打开串口或重启服务会清除绑定记录。若通道在服务启动前就已绑定,在卡片中选回实际绑定的电机和控制环,
即可恢复波形显示,无需重复点击「绑定」;这个操作只恢复显示,不会更改板端绑定。
用户确认的显示配置也会在本次串口会话中保存,供刷新页面或其他网页恢复。固件没有绑定应答,
对于无法确认原本为空的通道,服务不会用首包遥测猜测电机身份。
这也包括服务启动时已有预置电机的情况:通道出现实时读数后,先将电机下拉框切到「选择电机…」,
选择实际控制环,再选回实际电机即可保存显示配置。不要只重复选择下拉框当前项。
若绑定未成功且始终没有该通道遥测,点击「解绑」确认通道未绑定后,卡片也会删除;重新添加通道即可纠正电机选择并重试。
波形由前端现有遥测生成,不需要重烧固件或安装图表依赖。

## 使用流程(USB 直连,推荐)

1. 用**一根普通 USB 线**把 A 板插到电脑(板载 Micro USB-OTG FS,接口编号 17)
   —— 不需要外接 USB 转串口模块
2. 上电烧录好电机测试台固件
3. Windows 设备管理器会出现一个新的 **COM 口**(产品名 `Motor Bench CDC`)
4. 页面点「刷新」选它 → 「打开」
5. 页面自动拉取固件登记的电机清单并填入下拉框
6. 选电机 → 「绑定」→ 拖滑块设转速 → 「使能」
7. 结束务必「停机」或直接点顶部「急停」

点击「解绑」并收到开发板成功应答后,对应通道卡片会删除,电机仍保留在可选清单中。
若开发板确认该通道本来就未绑定,同样删除空卡片,包括通道 0。
其余卡片保留原通道号。需要重新绑定时,点击「添加通道」,选择保留的电机后绑定;
通道卡片最多 8 张,新增时优先复用空闲通道号。

> **波特率随便填**:USB CDC 是包协议,不依赖真实波特率,
> `Motor Bench CDC` 的枚举名比普通 UART 好认。

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
| 心跳看门狗 | 上位机 200ms 一跳;约 1.5s 收不到合法心跳,A/C 板自动全停 |
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
npm run test:control     # 控制来源与遥控状态协议
npm run test:chassis     # A/C 麦轮/全向轮解算、轮序、反向、限幅及中位门控
npm run test:waveform    # 波形时间窗口、数据上限、断线与暂停快照
npm run test:waveform:server # 真实服务/WebSocket与模拟串口的恢复回归(Node >=18.19)
npm run test:firmware    # 真实 A/C C 模块行为(需要原生 GCC)
npm run test:ctype       # C 板 CAN 引脚/时序与 CRC(需要原生 GCC)
```

解绑界面回归使用真实浏览器和模拟板端应答。先在 `motor_bench_host` 中运行
`node server.js --port 3001`,再在项目根目录执行:

```bash
playwright-cli -s=unbind open about:blank --browser msedge
playwright-cli -s=unbind run-code --filename tests/browser_unbind_regression.js
playwright-cli -s=unbind close
```

实时波形浏览器回归同样使用 3001 端口,在单独会话运行:

```bash
playwright-cli -s=waveform open about:blank --browser msedge
playwright-cli -s=waveform run-code --filename tests/browser_waveform_regression.js
playwright-cli -s=waveform close
```

刷新恢复回归为 `tests/browser_waveform_restore_regression.js`,使用同一测试服务与独立浏览器会话。

PID 参数记忆回归使用同一测试服务,在独立浏览器会话运行:

```bash
playwright-cli -s=pid open about:blank --browser msedge
playwright-cli -s=pid run-code --filename tests/browser_pid_regression.js
playwright-cli -s=pid close
```

四轮底盘浏览器回归为 `tests/browser_chassis_regression.js`,同样通过独立 Playwright 会话和 3001 端口运行。

`test:integration` 需要本机有 gcc/clang(MinGW 亦可)。它把固件
`modules/algorithm/crc8.c` 原样编译成命令行程序,喂同一批字节给固件算法和
Node 实现 —— 比"两边各写一遍 CRC 再对答案"可靠得多。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `protocol.js` | 帧组装/解析/CRC,必须与固件 `motor_bench.h` 保持一致 |
| `server.js` | 串口 ↔ WebSocket 桥,附带心跳、全停、退出清理 |
| `ui.js` / `index.html` / `style.css` | 浏览器界面 |
| `waveform.js` | 有界遥测历史与实时转速 Canvas 图表 |
| `selftest.js` | 协议自测 |
| `integration_test.js` | 与固件 CRC 的交叉校验 |
| `txqueue_test.js` | USB 发送队列行为模型 |

## 换串口

固件默认 USB;若要换 UART,改
`application/motor_bench_app/motor_bench_app.c` 里的
`MotorBenchInit(&huart7)`。该串口必须已在 CubeMX 中开启 RX DMA
(A 板上 UART7/UART8 的 DMA 中断均已在 `stm32f4xx_it.c` 中使能)。
