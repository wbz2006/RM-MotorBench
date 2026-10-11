/**
 * @file motor_bench.c
 * @brief 电机测试台模块实现:上位机协议解析 + 电机通道管理 + 遥测上报
 *
 * @note 传输层抽象:协议处理与电机控制逻辑完全独立于"数据从哪来"，
 *       上位机既可以走 UART,也可以走 USB 虚拟串口(CDC),二选一。
 *
 * @copyright Copyright (c) 2026 HNU YueLu EC all rights reserved
 */
#include "motor_bench.h"
#include "bsp_usart.h"
#include "bsp_usb.h"
#include "bsp_log.h"
#include "crc8.h"
#include "string.h"
#include "stdlib.h"
#include "main.h"

#define MB_CHANNEL_MAX 8

/*
 * 上位机链路断开判定阈值(守护计数)
 *
 * @attention 这里的换算曾经算错,导致安全门闩几乎一直关着。
 *
 *   StartDAEMONTASK() 在 freertos.c 中是 osDelay(10) —— **100Hz,每拍 10ms**。
 *   原值 5 => 5 × 10ms = **50ms**,而注释却写"约 1s"。
 *   上位机心跳是 200ms 一次(见 motor_bench_host/server.js 的 startHeartbeat),
 *   于是每 200ms 里只有 50ms 门闩是开的、150ms 是关的 ——
 *   绑定/使能/设参考值只要落在关闭窗口内就被拒,
 *   表现为 RTT 刷 "command 0x02/0x03/0x04 rejected: host link not established",
 *   而心跳应答又明明正常,极具迷惑性。
 *
 * 现在取 150 => 1.5s 判定断开:远大于心跳间隔(抗抖动),
 * 又远小于人能察觉的等待时间(链路真断时 1.5s 内全停,安全)。
 */
#define MB_LINK_TIMEOUT_COUNT 150

/* 遥测上报周期:500Hz 任务下节流到约 50Hz */
#define MB_TELEMETRY_DIVIDER 10

/** 传输层类型 */
typedef enum
{
    MB_LINK_NONE = 0,
    MB_LINK_UART = 1,
    MB_LINK_USB = 2,
} MB_LinkType_e;

/* ---------------- 私有类型 ---------------- */

/**
 * @brief 固件开机时登记的电机清单项
 * @note  CAN 过滤器、CANInstance、DMA 资源均为有限的启动期资源,
 *        不允许在运行期凭空创建电机实例,因此电机清单必须由 app 层在
 *        RobotInit() 中预先登记,上位机只能在清单中做选择。
 */
typedef struct
{
    uint8_t is_used;
    MB_MotorKind_e kind;
    uint8_t can_bus;
    uint8_t motor_id;
    Closeloop_Type_e outer_loop;
    void *motor_ptr;
} MB_InventoryItem_s;

/* ---------------- 私有变量 ---------------- */

static MB_LinkType_e mb_link_type = MB_LINK_NONE;
static USARTInstance *mb_usart = NULL;
static uint8_t *mb_usb_rx_buffer = NULL; /* bsp/usb 提供的接收缓冲区 */

static MB_InventoryItem_s mb_inventory[MB_CHANNEL_MAX];
static MB_MotorChannel_s mb_channels[MB_CHANNEL_MAX];
static uint8_t mb_inventory_used = 0;
static uint16_t mb_tx_seq = 0; /* 上报序号 */
static DaemonInstance *mb_link_daemon = NULL; /* 上位机链路守护 */
static uint8_t mb_telemetry_div = 0;          /* 遥测节流计数 */
static uint8_t mb_link_online = 0;            /* 上位机心跳是否在线(安全门闩) */
static uint32_t mb_hb_count = 0;               /* 【诊断】累计收到的心跳帧数 */

/* ============================================================
 * USB 发送环形队列
 *
 * @note  USB FS 单个数据包最大 64 字节,而遥测帧最长可达 176 字节
 *        (5 + 3 + 8*21),必须分多包发送。usbd_cdc 的发送是异步的:
 *        CDC_Transmit_FS() 在上一包发完前会返回 USBD_BUSY,
 *        因此不能在一个函数里循环把所有分包发完(那样第 2 包必然失败,
 *        整帧丢失)。正确做法是维护一个环形队列,由发送完成回调逐包推动。
 *
 * @note  单生产者(500Hz 的 motor task)+ 单消费者(USB 中断),无需加锁;
 *        head/tail 用 volatile 保证跨上下文可见。
 * ============================================================ */
#define MB_USB_TX_RING_SIZE 1024 /* 需 >= 单帧最大长度 176,取约 5 倍余量 */

static uint8_t mb_usb_tx_ring[MB_USB_TX_RING_SIZE];
static volatile uint16_t mb_usb_tx_head = 0; /* 生产者写位置 */
static volatile uint16_t mb_usb_tx_tail = 0; /* 消费者读位置 */
#if defined(MOTOR_BENCH_TX_DIAG)
static uint8_t mb_tx_diag_cnt = 0;     /* [tx] 诊断打印次数上限,避免刷屏 */
static uint8_t mb_txcmpl_diag_cnt = 0; /* 发送完成回调的诊断计数 */
#endif

/* ---------------- USB 接收:中断只入队,任务侧出队 ----------------
 * @note 为什么要这一层间接:协议解析必须离开中断上下文,
 *       否则 DWT_Delay(0.1)(DM 编码器校准)之类的忙等会把整个系统卡住。
 *       见 MotorBenchUsbRxCallback() 的详细说明。
 */
#define MB_USB_RX_SLOTS 4                 /* 最多缓存 4 包待解析 */
#define MB_USB_RX_MAX 128                 /* 单包上限(USART 帧最长 16,但留余量) */
static uint8_t mb_usb_rx_slots[MB_USB_RX_SLOTS][MB_USB_RX_MAX];
static volatile uint16_t mb_usb_rx_len[MB_USB_RX_SLOTS];
static volatile uint8_t mb_usb_rx_ready = 0;  /* 中断侧写指针 */
static volatile uint8_t mb_usb_rx_taken = 0;  /* 任务侧读指针 */

/**
 * @brief 把数据压入 USB 发送队列
 * @return 1=成功 0=队列已满,丢弃
 */
static uint8_t MotorBenchUsbEnqueue(const uint8_t *buf, uint16_t len)
{
    uint16_t head = mb_usb_tx_head;
    uint16_t tail = mb_usb_tx_tail;

    /* 队列剩余空间不足则丢弃本次上报(宁可丢一帧,也不能阻塞控制任务) */
    if ((uint16_t)(MB_USB_TX_RING_SIZE - (uint16_t)((head - tail + MB_USB_TX_RING_SIZE) % MB_USB_TX_RING_SIZE)) < len)
        return 0;

    for (uint16_t i = 0; i < len; i++)
        mb_usb_tx_ring[(head + i) % MB_USB_TX_RING_SIZE] = buf[i];

    mb_usb_tx_head = (uint16_t)((head + len) % MB_USB_TX_RING_SIZE);
    return 1;
}

/**
 * @brief 从队列取出一个不超过 64 字节的分包并发送
 * @return 1=已发出一个包 0=队列为空或总线忙
 *
 * @attention **不能**把数据先 memcpy 到一个 static 缓冲区再把该缓冲区的指针
 *            交给 CDC_Transmit_FS()。
 *            CDC_Transmit_FS() 只是把指针存进 usbd_cdc.c,真正拷贝进 USB FIFO
 *            要等到发送完成中断;而该中断回调又会再调本函数,
 *            若共用同一个 static 缓冲,第二个包会在第一个包真正发出之前
 *            就把它覆盖掉 —— 表现为:固件自认为发送成功、日志一切正常,
 *            但上位机收到的是被破坏的字节流(解析失败、CRC 永远不通过),
 *            现象与"完全没数据"难以区分。
 *
 *            本实现的做法:**永不跨队尾**。队尾到数组末尾的连续空间不足 64 字节时,
 *            就先只发这一小段(CDC 是字节流,短包合法),下一拍再从数组开头继续。
 *            于是每次发送的数据源都是环形队列里一段连续内存 —— 零拷贝,
 *            也不可能出现"同一块内存被两次传输共享"的情况。
 */
static uint8_t MotorBenchUsbPump(void)
{
    uint16_t tail = mb_usb_tx_tail;
    uint16_t head = mb_usb_tx_head;

    if (tail == head)
        return 0;

    uint16_t avail = (uint16_t)((head - tail + MB_USB_TX_RING_SIZE) % MB_USB_TX_RING_SIZE);

    /*
     * 本次只取"连续且不超过 64 字节"的那一段。
     * @note USB 是字节流,短包完全合法 —— 队尾到数组末尾的连续空间不足 64 字节时,
     *       先发这一小段、下一拍再从数组开头继续即可,于是不需要任何数据拷贝。
     *       这样每次发送的数据源都是环形队列里一段**连续内存**,
     *       根本不存在"共享缓冲区被复用"的问题(见函数上方说明)。
     */
    uint16_t contiguous = (uint16_t)(MB_USB_TX_RING_SIZE - tail);
    uint16_t chunk = avail;
    if (chunk > 64)
        chunk = 64;
    if (chunk > contiguous)
        chunk = contiguous; /* 连续空间不足,先发这一小段 */

    /*
     * @attention contiguous 可能为 0:当 tail 正好落在数组末尾时
     *   (MB_USB_TX_RING_SIZE - tail == 0)。此时 chunk 会算成 0,
     *   若直接进 CDC_Transmit_FS 就是发一个 0 长度的包,
     *   而且 tail 不会前进 —— Pump 每次都返回 1 却什么都没发,
     *   形成静默死锁:队列非空但永远发不出去。
     *   必须先把 tail 归零(未发送的数据仍然完整地排在数组里)。
     */
    if (chunk == 0)
    {
        mb_usb_tx_tail = 0;
        return 1; /* 下一次调用(或发送完成回调)会从数组开头取 */
    }

    uint8_t tx_ret = CDC_Transmit_FS((uint8_t *)&mb_usb_tx_ring[tail], chunk);

    /*
     * 【诊断】确认 HAL 层的真实返回码,避免"以为发出去了"。
     * 同时打印 USB 外设的端点 0 状态寄存器,用来区分两种完全不同的故障:
     *   - DIEPTS0(发送端点0)bit0 TX.0 恒为 1,bit1 TX.1 表示还有数据在发
     *   - 若 ret=0 且 TX.1=0 却迟迟等不到发送完成回调 → 数据没真正出芯片
     *   - 若端点状态正常但主机侧无数据 → 问题在主机/线缆
     */
    /*
     * 【诊断已关闭】
     * @attention 曾经在这里逐条打印 [tx] pump/COMPLETE,现在**不要恢复**。
     *   每次发送、每次发送完成都打一行,而遥测 50Hz + 心跳应答让发送非常频繁,
     *   几秒就把 RTT 上行缓冲(仅 1024 字节)写满,
     *   结果是更重要的日志([add] / [link] / motor task alive)被挤掉,
     *   表现为"日志突然消失",极易被误判成程序卡死。
     *   排查 USB 时需要这些信息,临时打开即可。
     */
#if defined(MOTOR_BENCH_TX_DIAG)
    if (mb_tx_diag_cnt < 12)
    {
        mb_tx_diag_cnt++;
        /*
         * IN 端点 0(CDC 通信端)的寄存器基址是 0x900(见 stm32f427xx.h
         * 的 USB_OTG_INEndpointTypeDef:900h + ep_num*20h)。
         * 注意别写成 0x808 —— 那是 DSTS(设备状态),不是端点寄存器。
         */
        volatile uint32_t *diepts0 = (volatile uint32_t *)(USB_OTG_FS_PERIPH_BASE + 0x900);
        volatile uint32_t *dieptsiz0 = (volatile uint32_t *)(USB_OTG_FS_PERIPH_BASE + 0x910);
        volatile uint32_t *dtxfsts = (volatile uint32_t *)(USB_OTG_FS_PERIPH_BASE + 0x918);

        LOGINFO("[tx] pump chunk=%u ret=%u head=%u tail=%u DIEPTS0=0x%08X DIEPTSIZ0=0x%08X DTXFSTS=0x%08X",
                chunk, tx_ret, mb_usb_tx_head, tail,
                (unsigned)*diepts0, (unsigned)*dieptsiz0, (unsigned)*dtxfsts);
    }
#else
    (void)tx_ret;
#endif

    if (tx_ret != USBD_OK)
        return 0; /* 总线忙,等下一次发送完成回调再试 */

    /*
     * 只有确认发送成功后才能前移队尾。
     * @attention 若在此之前前移,而 CDC_Transmit_FS 返回 BUSY,
     *   这段数据就被跳过了 —— 下次 Pump 从新 tail 开始,中间的数据永久丢失。
     */
    mb_usb_tx_tail = (uint16_t)((tail + chunk) % MB_USB_TX_RING_SIZE);
    return 1;
}

/**
 * @brief USB 发送完成回调:继续推送队列中的剩余分包
 * @param len 本次已发送字节数(bsp/usb 传入,此处不需要)
 *
 * @attention 这个回调是判断"数据是否真的离开了芯片"的**唯一可靠信号**。
 *   CDC_Transmit_FS() 返回 USBD_OK 只代表协议栈**接收**了这块数据,
 *   真正被主机取走才会触发本回调(USBD_CDC_HandleTypeDef.TxState 归零)。
 *   若本回调从不触发,说明数据卡在 USB 外设里没发出去
 *   (FIFO/端点/主机未轮询),而不是主机侧解析失败。
 */
static void MotorBenchUsbTxCallback(uint16_t len)
{
    (void)len;

    /*
     * 发送完成回调的诊断默认关闭。
     * @attention 与 [tx] pump 同理:每次发送完成都打会迅速写满 RTT 上行缓冲
     *   (1024 字节),把 [add]/[link]/motor task alive 等关键日志挤掉。
     *   需要时定义 MOTOR_BENCH_TX_DIAG 打开。
     */
#if defined(MOTOR_BENCH_TX_DIAG)
    if (mb_txcmpl_diag_cnt < 8)
    {
        mb_txcmpl_diag_cnt++;
        LOGINFO("[tx] COMPLETE len=%u (data actually left the chip)", len);
    }
#endif

    MotorBenchUsbPump();
}

/* ---------------- 发送忙闲判定 ----------------
 * @note 不使用 bsp/usart 的 USARTIsReady():其实现为
 *       (gState | HAL_UART_STATE_BUSY_TX) != 0,用的是按位或而非按位与,
 *       结果恒为真,会让本模块的遥测帧永远发不出去。
 *       框架规范要求 BSP 层改动须经组长确认,故此处按同样的思路就地正确实现。
 */
static uint8_t MotorBenchTxReady(void)
{
    if (mb_link_type == MB_LINK_UART)
    {
        if (!mb_usart)
            return 0;
        return (mb_usart->usart_handle->gState == HAL_UART_STATE_READY) ? 1 : 0;
    }
    /* USB CDC 的忙闲由 usbd_cdc.c 内部 TxState 管理,忙时返回 USBD_BUSY,这里直接尝试 */
    return (mb_link_type == MB_LINK_USB);
}

/**
 * @brief 发送一帧;上一帧未完成时直接丢弃,保证不阻塞控制任务
 */
static uint8_t MotorBenchSend(uint8_t *buf, uint16_t size)
{
    if (mb_link_type == MB_LINK_UART)
    {
        if (!mb_usart || !MotorBenchTxReady())
            return 0;
        USARTSend(mb_usart, buf, size, USART_TRANSFER_DMA);
        return 1;
    }
    if (mb_link_type == MB_LINK_USB)
    {
        /* 压入环形队列后立即尝试发第一包,其余由发送完成回调续推 */
        if (!MotorBenchUsbEnqueue(buf, size))
            return 0;
        MotorBenchUsbPump();
        return 1;
    }
    return 0;
}

/* ---------------- 私有函数声明 ---------------- */

static void MotorBenchRxCallback(void);
static void MotorBenchUsbRxCallback(uint16_t len);
static void MotorBenchLinkLostCallback(void *owner_id);
static void MotorBenchDispatch(uint8_t *buf, uint16_t len);
static void MotorBenchHandleHeartbeat(uint8_t *buf, uint16_t len);
static void MotorBenchHandleBind(uint8_t *buf, uint16_t len);
static void MotorBenchHandleSetRef(uint8_t *buf, uint16_t len);
static void MotorBenchHandleEnable(uint8_t *buf, uint16_t len);
static void MotorBenchSendHeartbeatAck(void);
static void MotorBenchSendTelemetry(void);
static void MotorBenchSendInventory(void);
static void MotorBenchStopAll(void);
static void MotorBenchHandleAdd(const uint8_t *payload, uint16_t payload_len);
static void MotorBenchHandleRemove(const uint8_t *payload, uint16_t payload_len);
static void MotorBenchSendAddAck(const MB_MotorAddAck_s *ack);
static uint8_t MotorBenchSetLoopInstance(MB_MotorKind_e kind, void *instance, Closeloop_Type_e loop);

/* ---------------- 初始化 ---------------- */

/**
 * @brief 初始化电机测试台模块,通过 UART 作为上位机指令通道
 *
 * @param handle 串口句柄(如 &huart7);传 NULL 表示暂不启用 UART 通道
 */
void MotorBenchInit(void *handle)
{
    mb_link_type = MB_LINK_NONE;
    memset(mb_inventory, 0, sizeof(mb_inventory));
    memset(mb_channels, 0, sizeof(mb_channels));
    mb_inventory_used = 0;
    mb_tx_seq = 0;

    if (handle)
    {
        USART_Init_Config_s usart_config = {
            .recv_buff_size = MB_RX_BUFF_SIZE,
            .usart_handle = (UART_HandleTypeDef *)handle,
            .module_callback = MotorBenchRxCallback,
        };
        mb_usart = USARTRegister(&usart_config);
        mb_link_type = MB_LINK_UART;
    }

    if (mb_link_type == MB_LINK_NONE)
    {
        LOGERROR("[motor_bench] no transport selected");
        return;
    }

    Daemon_Init_Config_s daemon_config = {
        .callback = MotorBenchLinkLostCallback,
        .owner_id = (void *)&mb_link_type,
        .reload_count = MB_LINK_TIMEOUT_COUNT,
    };
    mb_link_daemon = DaemonRegister(&daemon_config);

    LOGINFO("[motor_bench] init on UART, link timeout=%d ticks", MB_LINK_TIMEOUT_COUNT);
}

/**
 * @brief 初始化电机测试台模块,通过 USB 虚拟串口(CDC)作为指令通道
 *
 * @note  A 板板载 Micro USB OTG FS(PA11/PA12/PA10),插入电脑后会枚举出一个
 *        虚拟串口,波特率任意(CDC 不使用真实波特率)。
 *        使用前需确保 main.c 中已调用 MX_USB_DEVICE_Init()。
 */
void MotorBenchInitUSB(void)
{
    mb_link_type = MB_LINK_NONE;
    memset(mb_inventory, 0, sizeof(mb_inventory));
    memset(mb_channels, 0, sizeof(mb_channels));
    mb_inventory_used = 0;
    mb_tx_seq = 0;

    USB_Init_Config_s usb_config = {
        .tx_cbk = MotorBenchUsbTxCallback,
        .rx_cbk = MotorBenchUsbRxCallback,
    };
    mb_usb_rx_buffer = USBInit(usb_config);
    if (!mb_usb_rx_buffer)
    {
        LOGERROR("[motor_bench] USB init failed");
        return;
    }
    mb_link_type = MB_LINK_USB;

    Daemon_Init_Config_s daemon_config = {
        .callback = MotorBenchLinkLostCallback,
        .owner_id = (void *)&mb_link_type,
        .reload_count = MB_LINK_TIMEOUT_COUNT,
    };
    mb_link_daemon = DaemonRegister(&daemon_config);

    LOGINFO("[motor_bench] init on USB CDC, link timeout=%d ticks", MB_LINK_TIMEOUT_COUNT);
}

/* ---------------- 电机清单登记(启动期) ---------------- */

uint8_t MotorBenchGetLinkType(void)
{
    return (uint8_t)mb_link_type;
}

uint8_t MotorBenchRegisterMotor(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, Closeloop_Type_e outer_loop, void *instance)
{
    if (mb_inventory_used >= MB_CHANNEL_MAX)
    {
        LOGERROR("[motor_bench] inventory full (%d)", MB_CHANNEL_MAX);
        return MB_ERR_NO_RESOURCE;
    }
    if (!instance || (can_bus != 1 && can_bus != 2) || kind == MB_MOTOR_NONE || kind > MB_MOTOR_HT)
    {
        LOGERROR("[motor_bench] register failed: bad param kind=%d bus=%d id=%d", (int)kind, can_bus, motor_id);
        return MB_ERR_BAD_PARAM;
    }
    /* 同一总线上不允许重复登记同一 ID */
    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        if (mb_inventory[i].is_used && mb_inventory[i].can_bus == can_bus && mb_inventory[i].motor_id == motor_id)
        {
            LOGERROR("[motor_bench] register failed: bus%d id%d duplicated", can_bus, motor_id);
            return MB_ERR_DUPLICATE;
        }
    }

    uint8_t slot = mb_inventory_used++;
    mb_inventory[slot].is_used = 1;
    mb_inventory[slot].kind = kind;
    mb_inventory[slot].can_bus = can_bus;
    mb_inventory[slot].motor_id = motor_id;
    mb_inventory[slot].outer_loop = outer_loop;
    mb_inventory[slot].motor_ptr = instance;

    /* 上电默认停止,必须等上位机显式 enable */
    MotorBenchForceStopInstance(kind, instance);

    LOGINFO("[motor_bench] inventory[%d]: kind=%d bus=%d id=%d loop=%d", slot, (int)kind, can_bus, motor_id, (int)outer_loop);
    return MB_OK;
}

uint8_t MotorBenchGetInventoryCount(void)
{
    return mb_inventory_used;
}

/* ============================================================
 * 动态建/拆电机
 *
 * @note 设计要点:motor_bench 位于 module 层,按框架规范**不得直接实例化
 *       具体电机驱动**(那是 app 层的职责)。因此这里通过工厂回调,
 *       由 application/motor_bench_app 注册实现。
 *       协议解析与厂商驱动的耦合被挡在这一层之外。
 * ============================================================ */

typedef uint8_t (*MB_MotorFactory_t)(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, void **out_instance);
typedef void (*MB_MotorDestroy_t)(MB_MotorKind_e kind, void *instance);

static MB_MotorFactory_t mb_motor_factory = NULL;
static MB_MotorDestroy_t mb_motor_destroy = NULL;

void MotorBenchSetMotorFactory(MB_MotorFactory_t factory, MB_MotorDestroy_t destroy)
{
    mb_motor_factory = factory;
    mb_motor_destroy = destroy;
}

/**
 * @brief 预估某配置会产生的 rx_id,用于在真正创建前发现冲突
 * @return rx_id;kind 不属于 DJI 系时返回 0(表示不占用 DJI 的 ID 段)
 *
 * @note 规则来自 dji_motor.c 的 MotorSenderGrouping():
 *       GM6020      : rx_id = 0x204 + tx_id
 *       M3508/M2006 : rx_id = 0x200 + tx_id
 *       两者区间重叠(0x205~0x208),所以**不能挂在同一条总线上**。
 */
static uint16_t MotorBenchPredictRxId(MB_MotorKind_e kind, uint8_t motor_id)
{
    switch (kind)
    {
    case MB_MOTOR_GM6020:
        return (uint16_t)(0x204 + motor_id);
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
        return (uint16_t)(0x200 + motor_id);
    default:
        return 0; /* DM / LK / HT 不占 DJI 的 0x200 段 */
    }
}

/**
 * @brief 检查新增电机是否与已有电机的 rx_id 冲突
 * @return MB_OK 或 MB_ERR_DUPLICATE
 *
 * @note 必须在真正创建电机**之前**检查。
 *       若先创建再发现冲突,DJIMotorInit() 内部的 MotorSenderGrouping()
 *       会因 rx_id 冲突而 __WFI() 停机 —— 那时机体已经占用了滤波器,
 *       无法回滚,且整块板子挂死。
 */
static uint8_t MotorBenchCheckRxIdFree(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id)
{
    uint16_t new_rx = MotorBenchPredictRxId(kind, motor_id);
    if (new_rx == 0)
        return MB_OK; /* 非 DJI 系,不参与该段冲突判定 */

    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        if (!mb_inventory[i].is_used || mb_inventory[i].can_bus != can_bus)
            continue;

        uint16_t exist_rx = MotorBenchPredictRxId(mb_inventory[i].kind, mb_inventory[i].motor_id);
        if (exist_rx == new_rx)
        {
            LOGERROR("[motor_bench] add rejected: bus%d rx_id 0x%03X conflicts "
                     "(existing: kind=%d id=%d | new: kind=%d id=%d)",
                     can_bus, (unsigned)new_rx,
                     (int)mb_inventory[i].kind, mb_inventory[i].motor_id,
                     (int)kind, motor_id);
            /*
             * 用 ASCII 打印这条规则 —— RTT Viewer 按本机代码页解码,
             * 中文会变乱码,而这恰恰是最需要看清的一行。
             */
            LOGERROR("[motor_bench] rule: 6020 rx=0x204+id, 3508/2006 rx=0x200+id; "
                     "ranges overlap -> put them on DIFFERENT CAN buses");
            return MB_ERR_DUPLICATE;
        }
    }
    return MB_OK;
}

uint8_t MotorBenchAddMotor(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, uint8_t *out_ch)
{
    if (out_ch)
        *out_ch = 0xFF;

    /* 1. 基本参数 */
    if ((can_bus != 1 && can_bus != 2) || kind == MB_MOTOR_NONE || kind > MB_MOTOR_HT || motor_id == 0)
    {
        LOGERROR("[motor_bench] add rejected: bad param kind=%d bus=%d id=%d", (int)kind, can_bus, motor_id);
        return MB_ERR_BAD_PARAM;
    }
    if (mb_inventory_used >= MB_CHANNEL_MAX)
    {
        LOGERROR("[motor_bench] add rejected: inventory full (%d)", MB_CHANNEL_MAX);
        return MB_ERR_NO_RESOURCE;
    }
    if (!mb_motor_factory)
    {
        LOGERROR("[motor_bench] add rejected: motor factory not registered");
        return MB_ERR_UNSUPPORTED;
    }

    /* 2. 重复:同一总线上已有相同 (kind, bus, id) */
    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        if (mb_inventory[i].is_used && mb_inventory[i].kind == kind &&
            mb_inventory[i].can_bus == can_bus && mb_inventory[i].motor_id == motor_id)
        {
            LOGERROR("[motor_bench] add rejected: bus%d id%d already exists", can_bus, motor_id);
            return MB_ERR_DUPLICATE;
        }
    }

    /* 3. rx_id 冲突(必须在创建实例之前,见函数注释) */
    uint8_t r = MotorBenchCheckRxIdFree(kind, can_bus, motor_id);
    if (r != MB_OK)
        return r;

    /* 4. 交给 app 层工厂真正创建实例 */
    void *instance = NULL;
    uint8_t fr = mb_motor_factory(kind, can_bus, motor_id, &instance);
    if (fr != MB_OK || !instance)
    {
        LOGERROR("[motor_bench] add rejected: factory failed kind=%d bus=%d id=%d (ret=%d)",
                 (int)kind, can_bus, motor_id, fr);
        return (fr != MB_OK) ? fr : MB_ERR_NO_RESOURCE;
    }

    /* 5. 登记进清单 */
    r = MotorBenchRegisterMotor(kind, can_bus, motor_id, SPEED_LOOP, instance);
    if (r != MB_OK)
    {
        /* 登记失败则把刚建的实例拆掉,避免留下无法管理的孤儿电机 */
        if (mb_motor_destroy)
            mb_motor_destroy(kind, instance);
        return r;
    }

    if (out_ch)
        *out_ch = (uint8_t)(mb_inventory_used - 1); /* 槽位即通道号 */

    LOGINFO("[motor_bench] motor added: kind=%d bus=%d id=%d ch=%d",
            (int)kind, can_bus, motor_id, mb_inventory_used - 1);
    return MB_OK;
}

uint8_t MotorBenchRemoveMotor(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id)
{
    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        if (mb_inventory[i].is_used && mb_inventory[i].kind == kind &&
            mb_inventory[i].can_bus == can_bus && mb_inventory[i].motor_id == motor_id)
        {
            /* 先停输出,再释放资源 */
            MotorBenchForceStopInstance(kind, mb_inventory[i].motor_ptr);

            if (mb_motor_destroy && mb_inventory[i].motor_ptr)
                mb_motor_destroy(kind, mb_inventory[i].motor_ptr);

            /* 槽位前移,保持清单紧凑 */
            for (uint8_t j = i; j + 1 < mb_inventory_used; j++)
                mb_inventory[j] = mb_inventory[j + 1];
            mb_inventory_used--;
            mb_inventory[mb_inventory_used].is_used = 0;

            LOGINFO("[motor_bench] motor removed: kind=%d bus=%d id=%d", (int)kind, can_bus, motor_id);
            return MB_OK;
        }
    }
    LOGERROR("[motor_bench] remove rejected: kind=%d bus=%d id=%d not found", (int)kind, can_bus, motor_id);
    return MB_ERR_NOT_PROVISIONED;
}

uint8_t MotorBenchGetFilterFree(uint8_t can_bus)
{
    if (can_bus == 1)
        return CANGetFilterFree(&hcan1);
    if (can_bus == 2)
        return CANGetFilterFree(&hcan2);
    return 0;
}

/**
 * @brief 读取电机清单,供上位机在连接后拉取"这台板子上到底能测哪些电机"
 * @param idx 清单序号
 * @return MB_OK 成功
 */
uint8_t MotorBenchGetInventory(uint8_t idx, MB_InventoryItemPublic_s *out)
{
    if (idx >= mb_inventory_used || !out)
        return MB_ERR_BAD_PARAM;
    out->kind = mb_inventory[idx].kind;
    out->can_bus = mb_inventory[idx].can_bus;
    out->motor_id = mb_inventory[idx].motor_id;
    out->outer_loop = mb_inventory[idx].outer_loop;
    return MB_OK;
}

/* ---------------- 通道绑定(运行期,只能在清单内选择) ---------------- */

uint8_t MotorBenchBind(uint8_t channel_id, MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, Closeloop_Type_e outer_loop)
{
    if (channel_id >= MB_CHANNEL_MAX)
    {
        LOGERROR("[motor_bench] bind failed: channel %d out of range", channel_id);
        return MB_ERR_BAD_PARAM;
    }
    if (mb_channels[channel_id].is_used)
    {
        LOGERROR("[motor_bench] bind failed: channel %d already used", channel_id);
        return MB_ERR_DUPLICATE;
    }

    /* 在清单中查找匹配项,找不到说明固件没有登记这颗电机 */
    uint8_t found = MB_CHANNEL_MAX;
    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        if (mb_inventory[i].kind == kind && mb_inventory[i].can_bus == can_bus && mb_inventory[i].motor_id == motor_id)
        {
            found = i;
            break;
        }
    }
    if (found == MB_CHANNEL_MAX)
    {
        LOGERROR("[motor_bench] bind failed: kind%d bus%d id%d not provisioned", (int)kind, can_bus, motor_id);
        return MB_ERR_NOT_PROVISIONED;
    }

    mb_channels[channel_id].is_used = 1;
    mb_channels[channel_id].channel_id = channel_id;
    mb_channels[channel_id].inv_index = found;
    mb_channels[channel_id].kind = kind;
    mb_channels[channel_id].can_bus = can_bus;
    mb_channels[channel_id].motor_id = motor_id;
    mb_channels[channel_id].outer_loop = outer_loop;
    mb_channels[channel_id].motor_ptr = mb_inventory[found].motor_ptr;
    mb_channels[channel_id].status_bit_enable = 0;
    mb_channels[channel_id].ref_cmd = 0.0f;

    /*
     * 把外层闭环类型真正下发到电机驱动实例。
     *
     * @attention 这里曾经只把 outer_loop 存进通道结构体就算完 ——
     *   而 DJIMotorControl() 读的是**电机实例**里的 motor_settings.outer_loop_type,
     *   那个值在 DJIMotorInit() 时被 BenchBuildDJIConfig 写死成 SPEED_LOOP。
     *   于是界面切"位置环"完全不起作用,实际仍在跑速度环,
     *   且位置环所需的 angle_PID 从未参与计算。
     *   表现:切换闭环无任何效果;电机在 rpm=0 时仍有输出(因为位置环
     *   未接管,速度环对着 0 参考仍按旧量纲积分)。
     */
    if (!MotorBenchSetLoopInstance(kind, mb_channels[channel_id].motor_ptr, outer_loop))
        LOGERROR("[motor_bench] channel %d: kind %d cannot switch loop", channel_id, (int)kind);

    /* 绑定即停止 */
    MotorBenchForceStopInstance(kind, mb_channels[channel_id].motor_ptr);

    LOGINFO("[motor_bench] channel %d bound to inventory[%d], loop=%d",
            channel_id, found, (int)outer_loop);
    return MB_OK;
}

uint8_t MotorBenchAttachInstance(uint8_t channel_id, MB_MotorKind_e kind, void *instance)
{
    if (channel_id >= MB_CHANNEL_MAX || !mb_channels[channel_id].is_used || !instance)
        return MB_ERR_BAD_PARAM;
    mb_channels[channel_id].kind = kind;
    mb_channels[channel_id].motor_ptr = instance;
    MotorBenchForceStopInstance(kind, instance);
    return MB_OK;
}

uint8_t MotorBenchUnbind(uint8_t channel_id)
{
    if (channel_id >= MB_CHANNEL_MAX || !mb_channels[channel_id].is_used)
        return MB_ERR_BAD_PARAM;
    MotorBenchSetEnable(channel_id, 0);
    memset(&mb_channels[channel_id], 0, sizeof(MB_MotorChannel_s));
    LOGINFO("[motor_bench] channel %d unbound", channel_id);
    return MB_OK;
}

/* ---------------- 输出控制 ---------------- */

void MotorBenchForceStopInstance(MB_MotorKind_e kind, void *instance)
{
    if (!instance)
        return;
    switch (kind)
    {
    case MB_MOTOR_GM6020:
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
        DJIMotorStop((DJIMotorInstance *)instance);
        break;
    case MB_MOTOR_DM:
        DMMotorStop((DMMotorInstance *)instance);
        break;
    default:
        break;
    }
}

static uint8_t MotorBenchEnableInstance(MB_MotorKind_e kind, void *instance, uint8_t enable)
{
    if (!instance)
        return 0;
    switch (kind)
    {
    case MB_MOTOR_GM6020:
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
        enable ? DJIMotorEnable((DJIMotorInstance *)instance) : DJIMotorStop((DJIMotorInstance *)instance);
        return 1;
    case MB_MOTOR_DM:
        enable ? DMMotorEnable((DMMotorInstance *)instance) : DMMotorStop((DMMotorInstance *)instance);
        return 1;
    default:
        LOGERROR("[motor_bench] kind %d not wired for enable", (int)kind);
        return 0;
    }
}

static uint8_t MotorBenchSetRefInstance(MB_MotorKind_e kind, void *instance, float ref)
{
    if (!instance)
        return 0;
    switch (kind)
    {
    case MB_MOTOR_GM6020:
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
        DJIMotorSetRef((DJIMotorInstance *)instance, ref);
        return 1;
    case MB_MOTOR_DM:
        DMMotorSetRef((DMMotorInstance *)instance, ref);
        return 1;
    default:
        LOGERROR("[motor_bench] kind %d not wired for setref", (int)kind);
        return 0;
    }
}

/**
 * @brief 把外层闭环类型下发到具体的电机驱动实例
 * @return 1=成功 0=该种类不支持
 *
 * @note motor_bench 属 module 层,通过这种"厂商分发"的方式与各驱动交互,
 *       与 MotorBenchSetRefInstance / MotorBenchEnableInstance 保持同一风格。
 */
static uint8_t MotorBenchSetLoopInstance(MB_MotorKind_e kind, void *instance, Closeloop_Type_e loop)
{
    if (!instance)
        return 0;

    switch (kind)
    {
    case MB_MOTOR_GM6020:
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
        DJIMotorChangeLoop((DJIMotorInstance *)instance, loop);
        return 1;

    case MB_MOTOR_DM:
        /* DM 驱动当前未提供运行期切环接口,保持在初始化时设定的闭环 */
        LOGWARNING("[motor_bench] DM motor: loop switch not supported, keeping initial");
        return 1;

    default:
        LOGERROR("[motor_bench] kind %d not wired for loop switch", (int)kind);
        return 0;
    }
}

uint8_t MotorBenchSetEnable(uint8_t channel_id, uint8_t enable)
{
    if (channel_id >= MB_CHANNEL_MAX || !mb_channels[channel_id].is_used)
        return MB_ERR_BAD_PARAM;

    mb_channels[channel_id].status_bit_enable = enable ? 1 : 0;
    MotorBenchEnableInstance(mb_channels[channel_id].kind, mb_channels[channel_id].motor_ptr, enable);

    /*
     * 【诊断】enable 时打印该通道实际落到驱动里的状态。
     * 双电机场景下"第二个卡片点了没反应"有几种可能:
     *   (a) 绑定没成功 / 绑到了别的电机
     *   (b) 绑定成功但 enable 帧没送到
     *   (c) enable 送到了,但驱动把它分到了永不发送的发送组
     * 打印 kind/bus/id/stop_flag 才能区分这三者。
     */
    if (mb_channels[channel_id].kind == MB_MOTOR_GM6020 ||
        mb_channels[channel_id].kind == MB_MOTOR_M3508 ||
        mb_channels[channel_id].kind == MB_MOTOR_M2006)
    {
        DJIMotorInstance *m = (DJIMotorInstance *)mb_channels[channel_id].motor_ptr;
        if (m)
        {
            LOGINFO("[en] ch=%d bus%u id%u kind=%d stop=%d group=%d num=%d ref=%.1f",
                    channel_id,
                    mb_channels[channel_id].can_bus, mb_channels[channel_id].motor_id,
                    (int)mb_channels[channel_id].kind,
                    (int)m->stop_flag, (int)m->sender_group, (int)m->message_num,
                    (double)m->motor_controller.pid_ref);
        }
    }

    return MB_OK;
}

uint8_t MotorBenchSetRef(uint8_t channel_id, float ref)
{
    if (channel_id >= MB_CHANNEL_MAX || !mb_channels[channel_id].is_used)
        return MB_ERR_BAD_PARAM;
    if (!mb_channels[channel_id].status_bit_enable)
    {
        LOGWARNING("[motor_bench] setref rejected: channel %d not enabled", channel_id);
        return MB_ERR_NOT_ENABLED;
    }

    /* 安全限幅:防止误输入超大参考值打飞电机 */
    float limited = ref;
    LIMIT_MIN_MAX(limited, MB_REF_LIMIT_NEG, MB_REF_LIMIT_POS);

    if (!MotorBenchSetRefInstance(mb_channels[channel_id].kind, mb_channels[channel_id].motor_ptr, limited))
        return MB_ERR_UNSUPPORTED;

    mb_channels[channel_id].ref_cmd = limited;
    return MB_OK;
}

void MotorBenchEmergencyStop(void)
{
    MotorBenchStopAll();
    LOGWARNING("[motor_bench] EMERGENCY STOP triggered");
}

static void MotorBenchStopAll(void)
{
    for (uint8_t i = 0; i < MB_CHANNEL_MAX; i++)
    {
        if (mb_channels[i].is_used)
        {
            MotorBenchForceStopInstance(mb_channels[i].kind, mb_channels[i].motor_ptr);
            mb_channels[i].status_bit_enable = 0;
        }
    }
}

void MotorBenchReloadLink(void)
{
    if (mb_link_daemon)
        DaemonReload(mb_link_daemon);
}

/* ---------------- 反馈读取 ---------------- */

uint8_t MotorBenchGetMeasure(uint8_t channel_id, MB_TelemetryItem_s *out)
{
    if (channel_id >= MB_CHANNEL_MAX || !mb_channels[channel_id].is_used || !out)
        return MB_ERR_BAD_PARAM;

    MB_MotorChannel_s *ch = &mb_channels[channel_id];
    memset(out, 0, sizeof(MB_TelemetryItem_s));
    out->channel_id = channel_id;
    out->ref = ch->ref_cmd;
    out->temperature = -128; /* 默认未知 */

    switch (ch->kind)
    {
    case MB_MOTOR_GM6020:
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
    {
        DJIMotorInstance *m = (DJIMotorInstance *)ch->motor_ptr;
        if (!m)
            break;
        out->measure_speed = m->measure.speed_aps / 6.0f; /* aps -> rpm */
        out->measure_torque = (float)m->measure.real_current;
        out->measure_angle = m->measure.angle_single_round;
        out->temperature = (int8_t)m->measure.temperature;
        /* 先判空再调用,避免 daemon 未注册时解引用空指针 */
        out->status |= (m->daemon && DaemonIsOnline(m->daemon)) ? 0x01 : 0x00;
        break;
    }
    case MB_MOTOR_DM:
    {
        DMMotorInstance *m = (DMMotorInstance *)ch->motor_ptr;
        if (!m)
            break;
        out->measure_speed = m->measure.velocity; /* rad/s */
        out->measure_torque = m->measure.torque;  /* N·m */
        out->measure_angle = m->measure.position * RAD_2_DEGREE;
        out->status |= 0x01; /* DM 驱动当前无 daemon,默认在线 */
        break;
    }
    default:
        break;
    }

    out->status |= ch->status_bit_enable ? 0x02 : 0x00;
    return MB_OK;
}

uint8_t MotorBenchAnyMotorOnline(void)
{
    MB_TelemetryItem_s item;
    for (uint8_t i = 0; i < MB_CHANNEL_MAX; i++)
    {
        if (mb_channels[i].is_used && MotorBenchGetMeasure(i, &item) == MB_OK && (item.status & 0x01))
            return 1;
    }
    return 0;
}

/* ---------------- 串口接收与协议解析 ---------------- */

static void MotorBenchRxCallback(void)
{
    /*
     * @note bsp/usart 的 HAL_UARTEx_RxEventCallback 只在回调后清空
     *       [0, Size) 区间的字节,并不把实际接收长度传给模块,
     *       因此这里只能按缓冲区大小上限做流式扫描。为避免上一次
     *       更长帧留下的残留字节被误当成新命令:
     *         1. 命令类帧要求上位机心跳在线(mb_link_online)才被接受;
     *         2. 解析结束后清空整个缓冲区,消除残留。
     */
    DaemonReload(mb_link_daemon);
    MotorBenchDispatch(mb_usart->recv_buff, mb_usart->recv_buff_size);
    memset(mb_usart->recv_buff, 0, mb_usart->recv_buff_size);
}

/**
 * @brief USB CDC 接收回调:与 UART 走同一套协议处理
 * @param len 本次收到的字节数(由 usbd_cdc_if 传入,注意是 uint16_t)
 */
static void MotorBenchUsbRxCallback(uint16_t len)
{
    /*
     * @attention 这是 **USB 中断上下文**,绝对不能做重活。
     *
     * 早期实现直接在这里调用 MotorBenchDispatch(),于是整条协议解析
     * (malloc 电机实例、重配 CAN 过滤器、DWT_Delay 100ms 做 DM 编码器校准…)
     * 全部跑在中断里。后果:
     *   - DWT_Delay(0.1) 期间 CPU 100% 忙等,FreeRTOS tick 与 500Hz 任务停摆;
     *   - USB 中断嵌套/丢中断,主机侧表现为一帧帧突然全部涌出;
     *   - 板子看起来"卡死",RTT 也不再有心跳。
     *
     * 正确做法:中断只做"把字节搬进环形缓冲 + 记住长度",协议解析与所有
     * 可能耗时的动作(MotorBenchTask)都在任务上下文里做。
     */
    DaemonReload(mb_link_daemon);

    if (!mb_usb_rx_buffer || len == 0)
        return;

    /*
     * 环形队列判满:下一个写入位置若正好等于读取位置,说明 4 个槽位全满未消费。
     * @attention 这里必须比较 mb_usb_rx_taken(读指针)。
     *   早期实现误写成与 mb_usb_rx_len(各槽长度数组)比较 ——
     *   指针与数组比较毫无意义,判满逻辑形同虚设,
     *   生产者会一路写下去,覆盖任务尚未解析的数据,表现为随机丢指令。
     */
    uint8_t next = (uint8_t)((mb_usb_rx_ready + 1u) % MB_USB_RX_SLOTS);
    if (next == mb_usb_rx_taken) /* 队列满:丢一包,优先保证后续数据 */
        return;

    uint16_t copy = len;
    if (copy > MB_USB_RX_MAX)
        copy = MB_USB_RX_MAX;

    for (uint16_t i = 0; i < copy; i++)
        mb_usb_rx_slots[mb_usb_rx_ready][i] = mb_usb_rx_buffer[i];
    mb_usb_rx_len[mb_usb_rx_ready] = copy;

    /* 先写数据再发布下标,任务侧看到标志即代表数据已就绪 */
    mb_usb_rx_ready = next;
}

/**
 * @brief 帧解析:在字节流中搜索帧头,校验 CRC8 与帧尾
 * @note  上位机可能一次 DMA 收到多帧或半帧,这里做流式重同步;
 *        校验失败时右移一字节继续找帧头,避免一次坏数据导致整块丢弃。
 */
static void MotorBenchDispatch(uint8_t *buf, uint16_t len)
{
    uint16_t i = 0;
    while (i < len)
    {
        /* 1. 找帧头 */
        if (buf[i] != MB_FRAME_HEAD)
        {
            i++;
            continue;
        }
        /*
         * 2. 剩余长度是否够一帧最小结构。
         *
         * @attention 最小帧是 5 字节,不是 6:head(1) type(1) len(1) crc(1) tail(1),
         *   payload 可以为 0 字节。上位机的心跳正是这种空负载帧。
         *   原实现写成 `< 6`,于是心跳帧每次都被判为"数据还没收全"而 break,
         *   永远走不到 CRC 校验与分派 ——
         *   表现为 hb_count 恒为 0、安全门闩永远打不开、
         *   绑定/使能/设参考值全部被拒,但心跳应答却"看起来正常"
         *   (因为收不到心跳,自然也不会有应答,只是没人注意到)。
         */
        if (len - i < 5)
            break;

        uint8_t type = buf[i + 1];
        uint8_t payload_len = buf[i + 2];

        /*
         * 负载长度越界说明这个 0xA5 不是真帧头(多半是数据里恰好出现该字节)。
         * 必须立刻右移一字节重找,否则会一直等一帧永远不会到来的数据,
         * 表现为上位机一按按钮板端就"卡住不再响应"。
         */
        if (payload_len > MB_PAYLOAD_MAX)
        {
            i++;
            continue;
        }

        uint16_t frame_len = 5 + payload_len;

        if (len - i < frame_len)
            break;

        /* 3. CRC 校验:覆盖 type + len + payload */
        uint8_t crc = crc_8(&buf[i + 1], (uint16_t)(2 + payload_len));
        if (crc != buf[i + 3 + payload_len] || buf[i + 3 + payload_len + 1] != MB_FRAME_TAIL)
        {
            i++; /* 帧头可能是数据的一部分,右移一位重找 */
            continue;
        }

        uint8_t *payload = &buf[i + 3];

        /*
         * 安全门闩:心跳离线时不接受任何**会驱动电机**的命令。
         *
         * @attention 放行名单必须与"只读/无副作用"清单严格一致,漏一个就会
         *   让上位机永远等不到应答,界面卡在"正在添加…"。
         *   已放行(都不改变电机运行状态):
         *     - HEARTBEAT          握手
         *     - QUERY              状态查询
         *     - INVENTORY_QUERY    询问电机清单
         *     - MOTOR_ADD          创建电机(默认停止,需再显式 enable 才会转)
         *     - MOTOR_REMOVE       移除电机(内部会先停止该电机)
         *
         * 早期版本先后漏放行 INVENTORY_QUERY 与 MOTOR_ADD/MOTOR_REMOVE,
         * 表现为"上位机下发了但板子毫无反应"。
         */
        if (!mb_link_online &&
            type != MB_FRAME_HEARTBEAT &&
            type != MB_FRAME_QUERY &&
            type != MB_FRAME_INVENTORY_QUERY &&
            type != MB_FRAME_MOTOR_ADD &&
            type != MB_FRAME_MOTOR_REMOVE)
        {
            /*
             * 【诊断】拒绝时把门闩的真实状态一并打出来。
             * 只印 "link not established" 不足以定位 ——
             * 实测出现过心跳应答正常、门闩却反复拒绝的情况,
             * 光看这句无法区分"心跳没进来"与"进来了但超时又被关掉"。
             * hb_count 能直接回答:心跳到底有没有到达板端。
             */
            LOGWARNING("[motor_bench] cmd 0x%02X rejected: link_online=%d hb_count=%u daemon_count=%d",
                        type, (int)mb_link_online, (unsigned)mb_hb_count,
                        mb_link_daemon ? (int)mb_link_daemon->temp_count : -1);
            i += frame_len;
            continue;
        }

        switch (type)
        {
        case MB_FRAME_HEARTBEAT:
            MotorBenchHandleHeartbeat(payload, payload_len);
            break;
        case MB_FRAME_MOTOR_BIND:
            MotorBenchHandleBind(payload, payload_len);
            break;
        case MB_FRAME_MOTOR_SET:
            MotorBenchHandleSetRef(payload, payload_len);
            break;
        case MB_FRAME_MOTOR_ENABLE:
            MotorBenchHandleEnable(payload, payload_len);
            break;
        case MB_FRAME_ALL_STOP:
            MotorBenchEmergencyStop();
            break;
        case MB_FRAME_QUERY:
            MotorBenchSendTelemetry();
            break;
        case MB_FRAME_INVENTORY_QUERY:
            MotorBenchSendInventory();
            break;
        case MB_FRAME_MOTOR_ADD:
            MotorBenchHandleAdd(payload, payload_len);
            break;
        case MB_FRAME_MOTOR_REMOVE:
            MotorBenchHandleRemove(payload, payload_len);
            break;
        default:
            LOGWARNING("[motor_bench] unknown frame type 0x%02X", type);
            break;
        }
        i += frame_len;
    }
}

/* ---------------- 各帧处理 ---------------- */

static void MotorBenchHandleHeartbeat(uint8_t *buf, uint16_t len)
{
    (void)buf;
    (void)len;
    /* 心跳到达即置位门闩,后续命令帧才被接受 */
    mb_link_online = 1;

    /*
     * 【诊断】心跳计数与门闩状态。
     * 若这里计数一直为 0,说明心跳根本没进到解析函数 ——
     * 那么 daemon 再宽松也没用,门闩永远不会打开。
     * 反之若计数正常但门闩仍被拒,才是超时阈值的问题。
     */
    mb_hb_count++;

    /*
     * 心跳诊断:只在首次与每 500 次(约 100 秒)打印一次。
     * @attention 频率必须很低 —— 心跳每 200ms 一次,若每 50 次打一行仍是每 10 秒一行,
     *   叠加遥测 50Hz,几秒就会写满 RTT 上行缓冲(1024 字节),
     *   把 [add]/[link]/motor task alive 等关键日志挤掉,
     *   表现为"日志突然消失",极易被误判为程序卡死。
     */
    if (mb_hb_count == 1 || (mb_hb_count % 500) == 0)
    {
        LOGINFO("[link] heartbeat #%u, link_online=%d, reload_count=%d",
                (unsigned)mb_hb_count, (int)mb_link_online,
                mb_link_daemon ? (int)mb_link_daemon->reload_count : -1);
    }

    MotorBenchSendHeartbeatAck();
}

static void MotorBenchHandleBind(uint8_t *buf, uint16_t len)
{
    if (len < 5)
        return;
    MotorBenchBind(buf[0], (MB_MotorKind_e)buf[1], buf[2], buf[3], (Closeloop_Type_e)buf[4]);
}

static void MotorBenchHandleSetRef(uint8_t *buf, uint16_t len)
{
    if (len < 5)
        return;
    float ref;
    memcpy(&ref, &buf[1], 4);
    MotorBenchSetRef(buf[0], ref);
}

static void MotorBenchHandleEnable(uint8_t *buf, uint16_t len)
{
    if (len < 2)
        return;
    MotorBenchSetEnable(buf[0], buf[1]);
}

/* ---------------- 上报 ---------------- */

static void MotorBenchSendHeartbeatAck(void)
{
    MB_HeartbeatAck_s ack;
    memset(&ack, 0, sizeof(ack));
    ack.head = MB_FRAME_HEAD;
    ack.type = MB_FRAME_HEARTBEAT;
    ack.len = MB_HEARTBEAT_ACK_CRC_LEN;
    ack.seq = mb_tx_seq++;
    ack.fw_version_major = MB_FW_VERSION_MAJOR;
    ack.fw_version_minor = MB_FW_VERSION_MINOR;
    ack.uptime_s = (uint16_t)(HAL_GetTick() / 1000);
    ack.motor_inventory_count = mb_inventory_used;
    ack.board_flags = MotorBenchAnyMotorOnline() ? 0x01 : 0x00;

    uint8_t *p = (uint8_t *)&ack;
    /* CRC 覆盖 type + len + body(len),与 buildFrame() 的规则一致 */
    ack.crc = crc_8(p + 1, (uint16_t)(2 + MB_HEARTBEAT_ACK_CRC_LEN));
    ack.tail = MB_FRAME_TAIL;

    MotorBenchSend(p, sizeof(ack));
}

void MotorBenchTask(void)
{
    /*
     * 先把 USB 接收队列里积压的数据全部解析掉。
     * @attention 这一步必须在任务上下文做,且要先于任何耗时动作 ——
     *         协议处理里可能有 DWT_Delay(0.1)(DM 编码器校准)甚至 malloc,
     *         若放在 USB 中断里会阻塞整个系统。
     */
    while (mb_usb_rx_taken != mb_usb_rx_ready)
    {
        uint8_t slot = mb_usb_rx_taken;
        uint16_t len = mb_usb_rx_len[slot];

        if (len > 0 && len <= MB_USB_RX_MAX)
            MotorBenchDispatch(mb_usb_rx_slots[slot], len);

        /* 标记该槽已消费后前进,顺序不能反(先清标志再解析会覆盖新数据) */
        mb_usb_rx_len[slot] = 0;
        mb_usb_rx_taken = (uint8_t)((slot + 1u) % MB_USB_RX_SLOTS);
    }

    if (++mb_telemetry_div >= MB_TELEMETRY_DIVIDER)
    {
        mb_telemetry_div = 0;
        MotorBenchSendTelemetry();
    }
}

static void MotorBenchSendTelemetry(void)
{
    /*
     * @attention 与 MotorBenchSendInventory() 同样的定长数组陷阱,详见那里的说明。
     * MB_TelemetryFrame_s 里 items[MB_CHANNEL_MAX] 是定长的,crc/tail 位于固定偏移,
     * 而这里只发 count 个 —— 用结构体直接发送会让 crc/tail 落在传输范围之外,
     * 上位机收到的是数组空槽,帧尾校验必然失败。
     */
    MB_TelemetryItem_s items[MB_CHANNEL_MAX];
    uint8_t count = 0;

    for (uint8_t i = 0; i < MB_CHANNEL_MAX && count < MB_CHANNEL_MAX; i++)
    {
        if (!mb_channels[i].is_used)
            continue;
        if (MotorBenchGetMeasure(i, &items[count]) == MB_OK)
            count++;
    }
    if (count == 0)
        return; /* 无绑定通道时不发,节省带宽 */

    /* 统一帧格式:head type len body(len) crc tail
     *   len = count(1) + seq(2) + count*21
     * CRC 覆盖 type + len + body。*/
    uint8_t body_len = (uint8_t)(3 + count * sizeof(MB_TelemetryItem_s));
    uint8_t buf[5 + 3 + MB_CHANNEL_MAX * sizeof(MB_TelemetryItem_s)];

    buf[0] = MB_FRAME_HEAD;
    buf[1] = MB_FRAME_TELEMETRY;
    buf[2] = body_len;
    buf[3] = count;
    buf[4] = (uint8_t)(mb_tx_seq & 0xFF);
    buf[5] = (uint8_t)((mb_tx_seq >> 8) & 0xFF);
    mb_tx_seq++;

    uint8_t off = 6;
    for (uint8_t i = 0; i < count; i++)
    {
        memcpy(&buf[off], &items[i], sizeof(MB_TelemetryItem_s));
        off += sizeof(MB_TelemetryItem_s);
    }

    buf[off] = crc_8(&buf[1], (uint16_t)(2 + body_len));
    buf[off + 1] = MB_FRAME_TAIL;

    MotorBenchSend(buf, (uint16_t)(off + 2));
}

/* ---------------- 电机清单应答 ---------------- */

static void MotorBenchSendInventory(void)
{
    /*
     * @attention 这里**不能**使用 MB_InventoryFrame_s 那个带定长数组的结构体。
     *
     * 该结构体形如:
     *   head(1) type(1) len(1) count(1) | items[MB_CHANNEL_MAX]×4 | crc(1) tail(1)
     * 其中 crc/tail 位于固定偏移 4 + MB_CHANNEL_MAX*4 处(本工程 = offset 36/37)。
     * 但实际发送长度是按 **实际数量** 算的:
     *   MotorBenchSend(p, 5 + frame.len),frame.len = 1 + count*4
     * count=1 时只发出 10 字节,结构体里 crc/tail 所在的 36/37 偏移根本没进 USB,
     * 取而代之的是 items[1..] 未使用槽位的 0x00。
     *
     * 后果(实测):上位机收到 a5 82 05 01 03 01 01 02 00 00
     *   尾部是 00 00 而不是 "crc 5A" → 帧尾校验失败 → 整帧被丢弃 →
     *   界面永远收不到清单。且现象与"没数据""USB 坏了"难以区分。
     *
     * 正确做法:按字节拼装,长度与实际数量严格一致。
     */
    uint8_t buf[5 + 1 + MB_CHANNEL_MAX * 4];
    uint8_t body_len = (uint8_t)(1 + mb_inventory_used * sizeof(MB_InventoryItemPublic_s));

    buf[0] = MB_FRAME_HEAD;
    buf[1] = MB_FRAME_INVENTORY_REPORT;
    buf[2] = body_len;
    buf[3] = mb_inventory_used;

    uint8_t off = 4;
    for (uint8_t i = 0; i < mb_inventory_used; i++)
    {
        buf[off++] = (uint8_t)mb_inventory[i].kind;
        buf[off++] = mb_inventory[i].can_bus;
        buf[off++] = mb_inventory[i].motor_id;
        buf[off++] = (uint8_t)mb_inventory[i].outer_loop;
    }

    buf[off] = crc_8(&buf[1], (uint16_t)(2 + body_len)); /* CRC 覆盖 type+len+body */
    buf[off + 1] = MB_FRAME_TAIL;

    MotorBenchSend(buf, (uint16_t)(off + 2));
}

/* ---------------- 动态建/拆电机 ---------------- */

/**
 * @brief 处理"创建电机"请求(帧类型 0x08)
 *
 * @note 必须回应答帧(0x8A),无论成败。上位机要靠它区分:
 *       - 板子没收到(超时)
 *       - 板子拒绝(带具体原因)
 *       否则用户只会看到"没反应",无从下手。
 */
static void MotorBenchHandleAdd(const uint8_t *payload, uint16_t payload_len)
{
    MB_MotorAddAck_s ack;
    memset(&ack, 0, sizeof(ack));
    ack.channel_id = 0xFF;

    if (payload_len < sizeof(MB_MotorAddReq_s))
    {
        LOGERROR("[motor_bench] add ack: bad payload len %d", payload_len);
        ack.result = MB_ERR_BAD_PARAM;
        MotorBenchSendAddAck(&ack);
        return;
    }

    MB_MotorAddReq_s req;
    memcpy(&req, payload, sizeof(req));

    /*
     * 添加流程日志。
 *
 * @attention 诊断时曾逐步打印 1/5~5/5,现已压缩为一行。
     *   原因:RTT 上行缓冲只有 1024 字节,叠加遥测 50Hz + 心跳应答后,
     *   多行输出会把 [link] / motor task alive 等更关键的日志挤掉,
     *   表现为"日志突然消失",极易被误判为程序卡死。
     *
     * @note 日志一律用**纯 ASCII**:固件里的中文是 UTF-8 字节流,
     *   而 RTT Viewer 按本机代码页解释字节(通常非 UTF-8),中文会变乱码。
     */
    uint8_t ch = 0xFF;
    uint8_t result = MotorBenchAddMotor((MB_MotorKind_e)req.kind, req.can_bus, req.motor_id, &ch);

    ack.result = result;
    ack.kind = req.kind;
    ack.can_bus = req.can_bus;
    ack.motor_id = req.motor_id;
    ack.channel_id = (result == MB_OK) ? ch : 0xFF;
    ack.detail = MotorBenchGetFilterFree(req.can_bus);

    MotorBenchSendAddAck(&ack);

    if (result == MB_OK)
        MotorBenchSendInventory();

    /* 成功时一行概括;失败时 MotorBenchAddMotor 内部已打印具体原因 */
    LOGINFO("[add] kind=%d bus=%u id=%u -> %s ch=%d, CAN%u free=%d",
            (int)req.kind, req.can_bus, req.motor_id,
            (result == MB_OK) ? "OK" : "FAIL", ch, req.can_bus, ack.detail);
}

static void MotorBenchHandleRemove(const uint8_t *payload, uint16_t payload_len)
{
    if (payload_len < sizeof(MB_MotorAddReq_s))
    {
        LOGERROR("[motor_bench] remove: bad payload len %d", payload_len);
        return;
    }

    MB_MotorAddReq_s req;
    memcpy(&req, payload, sizeof(req));

    uint8_t r = MotorBenchRemoveMotor((MB_MotorKind_e)req.kind, req.can_bus, req.motor_id);

    /* 移除也回应答,用同一个 0x8A 帧 */
    MB_MotorAddAck_s ack;
    memset(&ack, 0, sizeof(ack));
    ack.result = r;
    ack.kind = req.kind;
    ack.can_bus = req.can_bus;
    ack.motor_id = req.motor_id;
    ack.channel_id = 0xFF;
    ack.detail = MotorBenchGetFilterFree(req.can_bus);
    MotorBenchSendAddAck(&ack);

    if (r == MB_OK)
        MotorBenchSendInventory(); /* 通道重排,清单已变,必须同步给上位机 */
}

/**
 * @brief 发送建/拆电机应答帧
 *
 * @note 协议头 head/type/len 只有 3 个字节,而本工程每个帧类型都有自己的结构体
 *       (MB_TelemetryFrame_s / MB_HeartbeatAckFrame_s / MB_InventoryFrame_s …),
 *       没有通用的帧头类型。这里直接按字节拼装,
 *       比再定义一个只用一次的结构体更直白,也少一处可与 protocol.js 脱节的地方。
 */
static void MotorBenchSendAddAck(const MB_MotorAddAck_s *ack)
{
    const uint8_t body_len = (uint8_t)sizeof(MB_MotorAddAck_s);
    uint8_t buf[3 + sizeof(MB_MotorAddAck_s) + 2]; /* head+type+len | body | crc+tail */

    buf[0] = MB_FRAME_HEAD;
    buf[1] = MB_FRAME_MOTOR_ADD_ACK;
    buf[2] = body_len;
    memcpy(&buf[3], ack, body_len);

    /* CRC 覆盖 type + len + body,与其它帧一致 */
    buf[3 + body_len] = crc_8(&buf[1], (uint16_t)(2 + body_len));
    buf[4 + body_len] = MB_FRAME_TAIL;

    MotorBenchSend(buf, (uint16_t)(5 + body_len));
}

static void MotorBenchLinkLostCallback(void *owner_id)
{
    uint8_t was_online = mb_link_online; /* 先记录,再清标志 */
    (void)owner_id;

    MotorBenchStopAll(); /* 安全动作:每次都必须执行,不受日志开关影响 */
    mb_link_online = 0;   /* 断开即关闭门闩,恢复后需重新握手 */

    /*
     * @attention 日志只在"由在线变为离线"时打一次。
     *           DaemonTask() 以 100Hz 运行,超时后会**每周期都调用**本回调,
     *           若不记忆状态,上位机未连接时会每秒刷 10 条,几秒即写满
     *           RTT 上行缓冲(1024 字节),把启动日志和 USB 诊断信息全冲掉。
     */
    if (was_online)
    {
        LOGERROR("[motor_bench] host link lost, all motors stopped");
    }
}
