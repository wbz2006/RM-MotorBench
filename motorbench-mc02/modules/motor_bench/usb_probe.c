/**
 * @file usb_probe.c
 * @brief USB 枚举诊断探针实现(临时工具,定位完成后可删除)
 *
 * @note 输出走 SEGGER RTT(bsp/log 的 LOG 宏)。
 *       选它而不是 UART 的原因:UART7 是电机测试台的指令通道,
 *       USART1 是遥控器 DBUS,USART6 虽是调试口但会多占一根排线;
 *       而 RTT 只需 J-Link 已经在手 —— 排查 USB 问题时调试器本来就必须接着。
 *
 * @note RTT 上行缓冲只有 1024 字节(BUFFER_SIZE_UP),所以本模块做了限流:
 *       - 每次 dump 前先打印"还有多少字节可用",超过阈值就跳过本次 dump;
 *       - 寄存器逐行输出,便于即使丢一部分也能看到关键行。
 */
#include "usb_probe.h"
#include "bsp_log.h"
#include "stm32h723xx.h"

/** RTT 上行缓冲容量(BUFFER_SIZE_UP),仅用于说明 */
#define PROBE_RTT_UP_SIZE 1024u

/**
 * @brief 允许的最大"未被读走"字节数
 * @note 若超过这个值,说明 J-Link 没在实时读 RTT(例如没开 RTT Viewer),
 *       继续输出只会把缓冲写满并覆盖更有价值的前序日志,故跳过寄存器 dump。
 */
#define PROBE_PENDING_MAX 256u

static void ProbeDumpRegisters(const char *tag)
{
    USB_OTG_GlobalTypeDef *g = USB_OTG_HS;
    /* DCFG 属 Device 结构体,基址 = 全局基址 + 0x800 */
    USB_OTG_DeviceTypeDef *d =
        (USB_OTG_DeviceTypeDef *)((uint32_t)USB_OTG_HS_PERIPH_BASE + 0x800);

    LOG("[P] ---- USB OTG HS registers (%s) ----", tag);

    /* 时钟:AHB1ENR USB1OTGHSEN,为 0 则后续操作全部无效 */
    LOG("[P] RCC->AHB1ENR=0x%08X OTGHSCLKEN=%d",
        (unsigned)RCC->AHB1ENR, (int)((RCC->AHB1ENR & RCC_AHB1ENR_USB1OTGHSEN) != 0));

    /* CID:芯片 ID。读回非 0 说明总线能访问 USB 外设;
     * 全 0 / 全 F 说明时钟未开或芯片型号不匹配 */
    LOG("[P] CID=0x%08X (expect non-zero)", (unsigned)g->CID);

    /* GOTGCTL:bit0 SCNE 会话请求,bit1 SRST 软复位,bit2 CNTRPRT(0=device) */
    LOG("[P] GOTGCTL=0x%08X SCNE=%d SRST=%d DEV=%d",
        (unsigned)g->GOTGCTL,
        (int)(g->GOTGCTL & 1),
        (int)((g->GOTGCTL >> 1) & 1),
        (int)((g->GOTGCTL >> 2) & 1));

    /* GAHBCFG bit7 HBEN:设备模式必须为 1 */
    LOG("[P] GAHBCFG=0x%08X HBEN=%d",
        (unsigned)g->GAHBCFG, (int)((g->GAHBCFG >> 7) & 1));

    /* GUSBCFG bit9 PHYULPI:本板为板载 PHY,该位应为 0 */
    LOG("[P] GUSBCFG=0x%08X PHYULPI=%d (0=internal)",
        (unsigned)g->GUSBCFG, (int)((g->GUSBCFG >> 9) & 1));

    /* GCCFG bit2 PWRDWN:为 1 说明外设仍在省电模式,未真正工作 */
    LOG("[P] GCCFG=0x%08X PWRDWN=%d (1=powered down!)",
        (unsigned)g->GCCFG, (int)((g->GCCFG >> 2) & 1));

    LOG("[P] GINTSTS=0x%08X", (unsigned)g->GINTSTS);
    LOG("[P] GINTMSK=0x%08X", (unsigned)g->GINTMSK);
    LOG("[P] GRXFSIZ=0x%04X", (unsigned)g->GRXFSIZ);
    LOG("[P] DIEPTXF0=0x%08X", (unsigned)g->DIEPTXF0_HNPTXFSIZ);

    /* DCFG bit0 DSPHSET:1=全速 */
    LOG("[P] DCFG=0x%08X DSPHSET=%d (1=FS)",
        (unsigned)d->DCFG, (int)(d->DCFG & 1));

    LOG("[P] --------------------------------------");
}

void USBProbeLog(uint8_t stage, const char *note)
{
    static const char *const stage_names[USB_PROBE_MAX] = {
        "ENTER_MX_USB_DEVICE_Init",
        "AFTER_USBD_Init",
        "AFTER_RegisterClass_CDC",
        "AFTER_USBD_Start",
        "DONE",
    };

    if (stage >= USB_PROBE_MAX)
        stage = USB_PROBE_MAX - 1;

    if (note)
        LOG("[P] %s | %s", stage_names[stage], note);
    else
        LOG("[P] %s", stage_names[stage]);
}

void USBProbeDumpRegisters(void)
{
    /*
     * @note RTT 上行缓冲只有 1024 字节(BUFFER_SIZE_UP),一次 dump 约 600 字节。
     *
     * @attention 这里的判据不是"剩余空间",而是 **J-Link 是否已经把数据读走**:
     *          SEGGER_RTT_HASDATA_UP(0) 的语义是"WrOff - RdOff",
     *          即缓冲区中尚未被主机读走的字节数。
     *          若 J-Link 一直挂着(RTT Viewer 打开),RdOff 会跟上 WrOff,
     *          HASDATA_UP 始终为 0,说明缓冲正在被实时排空,可以放心输出。
     *          反之若 J-Link 没在读(没挂 Viewer),HasData 会持续增长,
     *          此时继续 dump 只会覆盖前面的日志。
     *
     *          该宏依赖 uncached 访问(_SEGGER_RTT + UNCACHED_OFF),
     *          在 Cortex-M4 上可用。
     */
    unsigned pending = (unsigned)SEGGER_RTT_HASDATA_UP(0);

    LOG("[P] RTT pending bytes: %u", pending);

    if (pending > PROBE_PENDING_MAX)
    {
        LOG("[P] dump skipped: J-Link not draining RTT (pending=%u > %u)",
            pending, (unsigned)PROBE_PENDING_MAX);
        return;
    }

    ProbeDumpRegisters("live");
}