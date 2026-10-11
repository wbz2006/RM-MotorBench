/**
 * @file usb_probe.h
 * @brief USB 枚举诊断探针:在关键节点打印状态,用于定位"无法识别的USB设备"
 *
 * @note  这是一个**临时诊断工具**,定位完成后应删除。
 *        输出走 USART6(115200),因为 RTT 上行缓冲只有 1024 字节,
 *        两次寄存器 dump 极易溢出;且 USB 都认不出来时,不该再要求先接调试器。
 *
 * 排查思路:USB 枚举失败发生在"板子上电 → 主机检测到设备 → 读设备描述符"
 * 这条链路上,任何一环断掉都表现为同一个现象(无法识别的USB设备)。
 * 继续猜已经没有意义,应该让固件把每一环的状态报出来。
 *
 * 用法:USB 转串口线接 A 板 USART6(接口 10,PG9=RX / PG14=TX,3.3V,
 *       交叉接 + 共地),串口助手选 115200 8N1。
 */
#ifndef USB_PROBE_H
#define USB_PROBE_H

#include "stdint.h"

/** 探针阶段标记 */
typedef enum
{
    USB_PROBE_ENTER = 0,       /* 刚进入 MX_USB_DEVICE_Init */
    USB_PROBE_AFTER_USBD_INIT, /* USBD_Init 完成 */
    USB_PROBE_AFTER_CLASS,     /* 类与接口注册完成 */
    USB_PROBE_AFTER_START,     /* USBD_Start 完成 */
    USB_PROBE_DONE,            /* 全部完成 */
    USB_PROBE_MAX,
} USB_ProbeStage_e;

/**
 * @brief 打印 USB 探针阶段信息
 * @param stage 当前阶段
 * @param note  补充说明(可为 NULL)
 */
void USBProbeLog(uint8_t stage, const char *note);

/**
 * @brief 打印 USB 外设关键寄存器状态
 *
 * @note  这些寄存器能直接说明"外设到底有没有跑起来":
 *        - CID      : 芯片 ID,读回非 0 说明总线能访问 USB 外设
 *        - GAHBCFG  : bit7 HBEN,设备模式必须为 1
 *        - GUSBCFG  : bit9 PHYULPI,本板为板载 PHY 应为 0
 *        - GCCFG    : bit2 PWRDWN,置 1 说明外设仍在省电模式
 *        - DCFG     : bit0 DSPHSET,1=全速
 */
void USBProbeDumpRegisters(void);

/* ---------------- 底层输出接口(供本文件内使用) ---------------- */

/** 阻塞发送字符串到 USART6 */
void USBProbeWrite(const char *s);

/** 发送一行(自动补 CRLF) */
void USBProbeLogRaw(const char *s);

/** 变长参数日志,自动格式化并补 CRLF */
void USBProbeLogf(const char *fmt, ...);

#endif // USB_PROBE_H