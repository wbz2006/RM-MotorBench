# ESP32-S3 Wi-Fi TCP 透明桥

本目录是电机测试台的 ESP-IDF 桥接固件。数据链路为：

```text
STM32 A 板 UART7 ⇄ ESP32-S3 ⇄ Wi-Fi TCP ⇄ Windows 上位机
```

桥接器默认启动 SoftAP：

| 项目 | 默认值 |
| --- | --- |
| SSID | `RM-MotorBench-ESP32` |
| 密码 | `motorbench` |
| IP | `192.168.4.1` |
| TCP 端口 | `7000` |
| UART | UART1，TX GPIO17，RX GPIO18，115200 8-N-1 |

GPIO17/18 只是本工程默认值，必须按实际 ESP32-S3 开发板原理图确认。STM32 PE8（UART7_TX）接 ESP32 RX，STM32 PE7（UART7_RX）接 ESP32 TX，双方共地。两块板使用独立、稳定的 3.3 V 电源。

## 构建和烧录

使用 ESP-IDF 5.5 / 6.x 的 PowerShell：

```powershell
cd esp32s3_wifi_bridge
idf.py set-target esp32s3
idf.py build
idf.py -p COMx flash monitor
```

上位机启动后，先连接 `RM-MotorBench-ESP32` 热点，在“设备接入 → ESP32-S3 Wi-Fi（TCP）”输入默认地址和端口，点击“连接 Wi-Fi”。服务会发送握手，握手成功后开始转发原有 MotorBench 协议。TCP 连接断开时桥接器清空 UART 接收缓存，并允许下一台客户端连接；上位机会按 0.5、1、2、4、8、10 秒间隔重连。

## 稳定性约束

- TCP 只接受一个客户端，旧连接断开后才接受新连接。
- TCP keepalive 用于发现 Wi-Fi 链路失效；应用层握手用于防止误连普通 TCP 服务。
- 断线后不保留待转发的控制帧；上位机恢复后由现有心跳重新建立 STM32 链路，电机不会自动恢复使能。
- 先用 115200 验证。若实际 UART 仍设为 9600，需同时修改 `BRIDGE_UART_BAUD` 和 STM32 `MOTOR_BENCH_UART_BAUD_RATE`，两端必须一致。
- UART 上行收到首字节后只读取当前已缓存的数据，立即转发；不能用长超时等待 4096 字节，否则连续 50 Hz 遥测会被攒成数秒一批，触发上位机反馈超时。

在 `motor_bench_host` 中运行 `npm run test:bridge`，使用本机 GCC 编译真实的 UART 转发任务，验证连续 50 Hz 输入和缓存积压时的数据顺序及转发间隔。

## 离线日志采集

在 ESP-IDF PowerShell 中执行（COM34 换成 ESP32 的实际 USB 端口）：

```powershell
idf.py -p COM34 monitor --timestamps
```

进入监视器后依次按 `Ctrl+T`、`Ctrl+L` 开启文件记录，终端会显示日志文件路径；
按 `Ctrl+]` 退出。新版固件启动行包含
`immediate_forward=1`；每 5 秒打印 `UART stats`，包含 UART 累计收包字节数、
批次数、最大批次、距上次 UART 收包时长和 TCP 状态。断开时记录 Wi-Fi 原因码、
TCP 收发错误及空闲超时，发送耗时超过 100 ms 时记录 `TCP forwarding delayed`。
这些 ESP32 日志需要烧录新版固件后才会出现；修改源码或刷新网页不能更新板上程序。

上位机的持久日志在 `%LOCALAPPDATA%\RM-MotorBench\logs`。对照两份日志：
UART 持续有数据而上位机长时间不收包，应检查桥接/网络；UART 自身长时间无数据，
应检查 STM32、UART 接线和两端配置；TCP 或 Wi-Fi 断开会有对应事件。
