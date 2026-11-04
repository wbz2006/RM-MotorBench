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

使用 ESP-IDF 5.x 的 PowerShell：

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
