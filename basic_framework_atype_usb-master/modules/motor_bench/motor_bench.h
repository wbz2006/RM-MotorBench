/**
 * @file motor_bench.h
 * @brief 电机测试台模块:把上位机(PC/手机)下发的指令翻译为框架内的电机驱动调用,
 *        并把电机反馈打包上报。
 *
 * @note 分层约束(遵循 basic_framework 规范):
 *        1. 本模块不直接调用任何 HAL 函数,只经由 bsp_usart 与既有电机驱动交互;
 *        2. 电机实例由 app 层在 RobotInit() 中创建并登记,模块只持有指针,
 *           不在运行期凭空实例化(CAN 过滤器/DMA 均为有限启动期资源);
 *        3. 所有电机登记后默认停止,只有上位机显式 enable 后才允许写参考值。
 *
 * @copyright Copyright (c) 2026 HNU YueLu EC all rights reserved
 */
#ifndef MOTOR_BENCH_H
#define MOTOR_BENCH_H

#include "stdint.h"
#include <stddef.h>
#include "daemon.h"
#include "bsp_can.h"
#include "motor_def.h"
#include "dji_motor.h"
#include "dmmotor.h"
#include "general_def.h"

/* ============================================================
 * 协议参数
 * ============================================================ */

/** 帧头与帧尾,便于上位机在字节流中快速重同步 */
#define MB_FRAME_HEAD 0xA5u
#define MB_FRAME_TAIL 0x5Au

/** 固件版本号,随心跳应答上报给上位机 */
#define MB_FW_VERSION_MAJOR 1
#define MB_FW_VERSION_MINOR 0

/** 通道数上限 */
#define MB_CHANNEL_MAX 8

/** 单帧最大负载长度,越界即判定为假帧头(用于流式重同步) */
#define MB_PAYLOAD_MAX 64

/** 串口接收缓冲区大小 */
#define MB_RX_BUFF_SIZE (MB_PAYLOAD_MAX * 2 + 16)

/** 心跳应答负载长度(fw_major 起共 9 字节) */
#define MB_HEARTBEAT_ACK_CRC_LEN 9

/** 参考值安全限幅,防止误输入打飞电机 */
#define MB_REF_LIMIT_POS 12000.0f
#define MB_REF_LIMIT_NEG (-12000.0f)

/** 返回码 */
typedef enum
{
    MB_OK = 0,
    MB_ERR_BAD_PARAM = 1,
    MB_ERR_DUPLICATE = 2,
    MB_ERR_NOT_PROVISIONED = 3, /* 该电机未在固件中登记 */
    MB_ERR_NOT_ENABLED = 4,     /* 通道未使能,拒绝写参考值 */
    MB_ERR_UNSUPPORTED = 5,     /* 该电机种类尚未接入 */
    MB_ERR_NO_RESOURCE = 6,     /* 清单已满 */
} MB_Result_e;

/** 帧类型 */
typedef enum
{
    MB_FRAME_HEARTBEAT = 0x01,    /* 上位机心跳 */
    MB_FRAME_MOTOR_BIND = 0x02,   /* 把某颗已登记电机绑到通道 */
    MB_FRAME_MOTOR_SET = 0x03,    /* 设置通道参考值 */
    MB_FRAME_MOTOR_ENABLE = 0x04, /* 使能/停止通道 */
    MB_FRAME_ALL_STOP = 0x05,     /* 全部停止(急停) */
    MB_FRAME_QUERY = 0x06,        /* 查询全部状态 */
    MB_FRAME_INVENTORY_QUERY = 0x07, /* 询问本固件登记了哪些电机(上行) */
    /*
     * 动态建电机:上位机按实际电调拨码 ID 现场创建。
     *
     * @note 为什么需要它 —— 原设计要求"改配置表 + 重烧固件"才能换电机,
     *   这对测试台极不实用:机械组每次测不同型号电机都要找电控组烧程序,
     *   正是本项目要消除的痛点。
     *   改为由上位机下发 (kind, can_bus, motor_id),板端运行期创建实例。
     *
     * 0x08 建电机 / 0x09 拆电机(释放过滤器) / 0x8A 建电机应答
     */
    MB_FRAME_MOTOR_ADD = 0x08,
    MB_FRAME_MOTOR_REMOVE = 0x09,
    MB_FRAME_TELEMETRY = 0x81,    /* 板端遥测上报(仅板端发出) */
    MB_FRAME_INVENTORY_REPORT = 0x82, /* 电机清单应答(仅板端发出) */
    MB_FRAME_MOTOR_ADD_ACK = 0x8A,   /* 建电机结果应答(仅板端发出) */
} MB_FrameType_e;

/** 支持的电机种类,与 motor_def.h / 各驱动一一对应 */
typedef enum
{
    MB_MOTOR_NONE = 0,
    MB_MOTOR_GM6020 = 1,
    MB_MOTOR_M3508 = 2,
    MB_MOTOR_M2006 = 3,
    MB_MOTOR_DM = 4, /* 达妙系列 DM-4310 等 */
    MB_MOTOR_LK = 5, /* LK9025 */
    MB_MOTOR_HT = 6, /* HT04 */
} MB_MotorKind_e;

/* ============================================================
 * 内部结构
 * ============================================================ */

/** 受控电机的一路通道(运行期) */
typedef struct
{
    uint8_t is_used;            /* 1=该槽位已绑定电机 */
    uint8_t channel_id;         /* 上位机看到的通道号 0~7 */
    uint8_t inv_index;          /* 对应清单下标 */
    MB_MotorKind_e kind;        /* 电机种类 */
    uint8_t can_bus;            /* 1=CAN1 2=CAN2 */
    uint8_t motor_id;           /* 电调 ID */
    void *motor_ptr;            /* 指向 DJIMotorInstance / DMMotorInstance 等 */
    Closeloop_Type_e outer_loop;
    uint8_t status_bit_enable;  /* 1=该通道已使能 */
    float ref_cmd;              /* 最近一次下发的参考值,用于上报 */
} MB_MotorChannel_s;

/* ============================================================
 * 对外通信结构
 *
 * 所有帧统一为自描述格式:
 *     head(1) type(1) len(1) body(len) crc(1) tail(1)
 * len 是 body 的字节数,上位机据此在字节流里切分帧并重同步。
 * ============================================================ */

#pragma pack(1)

/** 对外暴露的清单项,4 字节 */
typedef struct
{
    uint8_t kind;       /* MB_MotorKind_e */
    uint8_t can_bus;    /* 1=CAN1 2=CAN2 */
    uint8_t motor_id;   /* 电调 ID */
    uint8_t outer_loop; /* Closeloop_Type_e */
} MB_InventoryItemPublic_s;

/**
 * 动态建电机请求体,4 字节(与清单项同布局)
 *
 * @note 上位机按实际电调拨码 ID 下发这 4 字节,板端运行期创建电机实例。
 *       字段顺序与 MB_InventoryItemPublic_s 完全一致,
 *       这样"想加什么电机"就等于"清单里长什么样",两边心智统一。
 */
typedef struct
{
    uint8_t kind;     /* MB_MotorKind_e:1=6020 2=3508 3=2006 4=DM */
    uint8_t can_bus;  /* 1=CAN1 2=CAN2 */
    uint8_t motor_id; /* 电调拨码 ID,1~8 */
    uint8_t reserved; /* 保留,必须填 0 */
} MB_MotorAddReq_s;

/**
 * 动态建电机应答体,6 字节
 *
 * @note 无论成功失败都要回,否则上位机只能靠超时猜,
 *       无法区分"板子没收到"与"板子拒绝了"。
 */
typedef struct
{
    uint8_t result;    /* MB_Result_e */
    uint8_t kind;      /* 回显请求的种类,便于上位机匹配 */
    uint8_t can_bus;   /* 回显请求的总线 */
    uint8_t motor_id;  /* 回显请求的 ID */
    uint8_t channel_id;/* 成功时该电机占用的通道号;失败时为 0xFF */
    uint8_t detail;    /* 附加信息,如该总线剩余过滤器个数 */
} MB_MotorAddAck_s;

/** 单通道遥测,21 字节 */
typedef struct
{
    uint16_t channel_id;  /* 通道号 */
    uint16_t status;      /* bit0 在线 bit1 已使能 */
    float ref;            /* 当前参考值 */
    float measure_speed;  /* 转速(rpm)或角速度(rad/s),取决于 kind */
    float measure_torque; /* 电流(A)或转矩(N·m) */
    float measure_angle;  /* 单圈角度(deg) */
    int8_t temperature;   /* 温度,未知为 -128 */
} MB_TelemetryItem_s;

/** 遥测帧:body = count(1) + seq(2) + items[count*21] */
typedef struct
{
    uint8_t head;
    uint8_t type;
    uint8_t len;
    uint8_t count;
    uint16_t seq;
    MB_TelemetryItem_s items[MB_CHANNEL_MAX];
    uint8_t crc;
    uint8_t tail;
} MB_TelemetryFrame_s;

/** 心跳应答帧:body = fw_major fw_minor inventory flags uptime(2) seq(2) = 9 字节 */
typedef struct
{
    uint8_t head;
    uint8_t type;
    uint8_t len;
    uint8_t fw_version_major;
    uint8_t fw_version_minor;
    uint8_t motor_inventory_count;
    uint8_t board_flags;
    uint16_t uptime_s;
    uint16_t seq;
    uint8_t crc;
    uint8_t tail;
} MB_HeartbeatAck_s;

/**
 * @brief 电机清单应答帧
 * body = count(1) + items[count*4]
 *
 * @note  上位机连上板子后先发 MB_FRAME_INVENTORY_QUERY 拿到这张表,
 *        才能在界面上列出"这块板上可以测哪些电机"。这是"前端不虚报电机"
 *        的关键:界面上出现的电机,一定是真的在固件里登记过的。
 */
typedef struct
{
    uint8_t head;
    uint8_t type;
    uint8_t len;
    uint8_t count;
    MB_InventoryItemPublic_s items[MB_CHANNEL_MAX];
    uint8_t crc;
    uint8_t tail;
} MB_InventoryFrame_s;

#pragma pack()

/* ============================================================
 * 协议布局静态断言
 *
 * 上位机(motor_bench_host/protocol.js)按固定字节偏移解析这些结构。
 * 一旦有人调整字段顺序、类型或 pack 设置,这里会在编译期直接失败,
 * 避免"上位机按旧布局解析、板端按新布局发送"这类极难排查的问题。
 * ============================================================ */
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
_Static_assert(MB_FRAME_HEAD == 0xA5, "frame head must be 0xA5 (protocol.js FRAME_HEAD)");
_Static_assert(MB_FRAME_TAIL == 0x5A, "frame tail must be 0x5A (protocol.js FRAME_TAIL)");

_Static_assert(MB_MOTOR_GM6020 == 1, "kind GM6020 mismatch");
_Static_assert(MB_MOTOR_M3508 == 2, "kind M3508 mismatch");
_Static_assert(MB_MOTOR_M2006 == 3, "kind M2006 mismatch");
_Static_assert(MB_MOTOR_DM == 4, "kind DM mismatch");
_Static_assert(MB_MOTOR_LK == 5, "kind LK mismatch");
_Static_assert(MB_MOTOR_HT == 6, "kind HT mismatch");

_Static_assert(sizeof(MB_TelemetryItem_s) == 21, "telemetry item must be 21 bytes");
_Static_assert(offsetof(MB_TelemetryItem_s, channel_id) == 0, "item channel_id @0");
_Static_assert(offsetof(MB_TelemetryItem_s, status) == 2, "item status @2");
_Static_assert(offsetof(MB_TelemetryItem_s, ref) == 4, "item ref @4");
_Static_assert(offsetof(MB_TelemetryItem_s, measure_speed) == 8, "item speed @8");
_Static_assert(offsetof(MB_TelemetryItem_s, measure_torque) == 12, "item torque @12");
_Static_assert(offsetof(MB_TelemetryItem_s, measure_angle) == 16, "item angle @16");
_Static_assert(offsetof(MB_TelemetryItem_s, temperature) == 20, "item temp @20");

_Static_assert(sizeof(MB_InventoryItemPublic_s) == 4, "inventory item must be 4 bytes");
_Static_assert(sizeof(MB_MotorAddReq_s) == 4, "motor add req must be 4 bytes");
_Static_assert(sizeof(MB_MotorAddAck_s) == 6, "motor add ack must be 6 bytes");
_Static_assert(offsetof(MB_MotorAddReq_s, kind) == 0, "addreq kind @0");
_Static_assert(offsetof(MB_MotorAddReq_s, can_bus) == 1, "addreq can_bus @1");
_Static_assert(offsetof(MB_MotorAddReq_s, motor_id) == 2, "addreq motor_id @2");
_Static_assert(offsetof(MB_MotorAddAck_s, result) == 0, "addack result @0");
_Static_assert(offsetof(MB_MotorAddAck_s, channel_id) == 4, "addack channel @4");
_Static_assert(offsetof(MB_MotorAddAck_s, detail) == 5, "addack detail @5");

_Static_assert(offsetof(MB_TelemetryFrame_s, head) == 0, "tm head @0");
_Static_assert(offsetof(MB_TelemetryFrame_s, type) == 1, "tm type @1");
_Static_assert(offsetof(MB_TelemetryFrame_s, len) == 2, "tm len @2");
_Static_assert(offsetof(MB_TelemetryFrame_s, count) == 3, "tm count @3");
_Static_assert(offsetof(MB_TelemetryFrame_s, seq) == 4, "tm seq @4");
_Static_assert(offsetof(MB_TelemetryFrame_s, items) == 6, "tm items @6");

_Static_assert(offsetof(MB_InventoryFrame_s, head) == 0, "inv head @0");
_Static_assert(offsetof(MB_InventoryFrame_s, type) == 1, "inv type @1");
_Static_assert(offsetof(MB_InventoryFrame_s, len) == 2, "inv len @2");
_Static_assert(offsetof(MB_InventoryFrame_s, count) == 3, "inv count @3");
_Static_assert(offsetof(MB_InventoryFrame_s, items) == 4, "inv items @4");

_Static_assert(offsetof(MB_HeartbeatAck_s, head) == 0, "ack head @0");
_Static_assert(offsetof(MB_HeartbeatAck_s, type) == 1, "ack type @1");
_Static_assert(offsetof(MB_HeartbeatAck_s, len) == 2, "ack len @2");
_Static_assert(offsetof(MB_HeartbeatAck_s, fw_version_major) == 3, "ack major @3");
_Static_assert(offsetof(MB_HeartbeatAck_s, fw_version_minor) == 4, "ack minor @4");
_Static_assert(offsetof(MB_HeartbeatAck_s, motor_inventory_count) == 5, "ack inventory @5");
_Static_assert(offsetof(MB_HeartbeatAck_s, board_flags) == 6, "ack flags @6");
_Static_assert(offsetof(MB_HeartbeatAck_s, uptime_s) == 7, "ack uptime @7");
_Static_assert(offsetof(MB_HeartbeatAck_s, seq) == 9, "ack seq @9");
#endif

/* ============================================================
 * 对外接口
 * ============================================================ */

/**
 * @brief 初始化电机测试台模块,注册上位机通信串口(UART 通道)
 *
 * @param handle 与上位机通信的串口句柄(建议用 A 板 UART7/UART8,115200);
 *               传 NULL 表示不启用 UART 通道
 *
 * @attention 该串口必须在 CubeMX 中已开启 RX DMA,bsp/usart 依赖
 *            HAL_UARTEx_ReceiveToIdle_DMA;且不可与其他模块共用。
 */
void MotorBenchInit(void *handle);

/**
 * @brief 初始化电机测试台模块,注册 USB 虚拟串口(CDC)作为指令通道
 *
 * @note  A 板板载 Micro USB OTG FS(PA11=DM / PA12=DP / PA10=ID)。
 *        插入电脑后枚举为一个虚拟串口,波特率可任意设置
 *        (CDC 是包协议,不使用真实波特率),上位机侧与 UART 完全一致,
 *        只是省去了外接 USB 转串口线。
 *
 * @attention 需先在 main.c 的时钟配置之后调用 MX_USB_DEVICE_Init(),
 *            否则 USB 外设不会枚举。
 */
void MotorBenchInitUSB(void);

/**
 * @brief 当前上位机链路类型
 * @return 0=未连接 1=UART 2=USB
 */
uint8_t MotorBenchGetLinkType(void);

/**
 * @brief 运行期创建一颗电机(动态建电机)
 *
 * @param kind     电机种类(MB_MotorKind_e)
 * @param can_bus  1=CAN1 2=CAN2
 * @param motor_id 电调拨码 ID
 * @param out_ch   输出:该电机占用的通道号
 * @return MB_OK / MB_ERR_DUPLICATE(同总线同 rx_id) / MB_ERR_UNSUPPORTED(种类未接入)
 *         / MB_ERR_NO_RESOURCE(该总线过滤器耗尽或清单已满)
 *
 * @note 这是测试台"换电机不用重烧"的核心接口。
 *       原设计要求改配置表重新烧录,正是本项目要消除的痛点。
 *
 * @warning 必须由上层应用在**任务上下文**中调用(如 motor_bench_app 的命令处理),
 *          不宜在 CAN 接收中断里调用 —— 内部会 malloc 并重配过滤器。
 */
uint8_t MotorBenchAddMotor(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, uint8_t *out_ch);

/**
 * @brief 运行期移除一颗电机并释放其 CAN 过滤器
 *
 * @param kind     电机种类
 * @param can_bus  1=CAN1 2=CAN2
 * @param motor_id 电调拨码 ID
 * @return MB_OK / MB_ERR_NOT_PROVISIONED(该电机不存在)
 *
 * @attention 移除前会先停止该电机输出。移除后其占用的通道被释放,
 *            界面需重新拉取清单(发送 INVENTORY_QUERY)。
 */
uint8_t MotorBenchRemoveMotor(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id);

/**
 * @brief 某条 CAN 总线上剩余可用的过滤器个数
 * @return 剩余 filter bank 数;供上位机在添加电机前预判资源
 */
uint8_t MotorBenchGetFilterFree(uint8_t can_bus);

/**
 * @brief 注册"创建/销毁电机"的工厂回调
 *
 * @param factory  按 (kind, bus, id) 创建电机实例,成功时 *out_instance 有效并返回 MB_OK
 * @param destroy  销毁实例并释放其 CAN 过滤器
 *
 * @note 按框架分层规范,motor_bench 属于 module 层,不能直接实例化
 *       各厂商电机驱动(那是 application 层的职责)。
 *       因此动态建电机的具体动作由 application/motor_bench_app 注册进来。
 *       若不注册,MotorBenchAddMotor() 返回 MB_ERR_UNSUPPORTED。
 */
typedef uint8_t (*MB_MotorFactory_t)(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, void **out_instance);
typedef void (*MB_MotorDestroy_t)(MB_MotorKind_e kind, void *instance);

void MotorBenchSetMotorFactory(MB_MotorFactory_t factory, MB_MotorDestroy_t destroy);

/**
 * @brief 登记一颗电机(启动期调用,由 app 层在 RobotInit() 中调用)
 *
 * @param kind       电机种类
 * @param can_bus    1=CAN1 2=CAN2
 * @param motor_id   电调 ID(DJI 系 1~8,达妙 1~4)
 * @param outer_loop 外层闭环:OPEN_LOOP / SPEED_LOOP / ANGLE_LOOP
 * @param instance   已由 DJIMotorInit()/DMMotorInit() 等创建好的实例指针
 * @return MB_OK 成功
 *
 * @note  登记后该电机立即被置为停止状态,须由上位机 enable 才会输出。
 *        同一总线上不允许重复登记相同 ID。
 */
uint8_t MotorBenchRegisterMotor(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, Closeloop_Type_e outer_loop, void *instance);

/**
 * @brief 已登记电机数量
 */
uint8_t MotorBenchGetInventoryCount(void);

/**
 * @brief 读取清单项,供上位机展示可选电机列表
 *
 * @param idx  清单序号 0 ~ count-1
 * @param out  输出
 * @return MB_OK 成功
 */
uint8_t MotorBenchGetInventory(uint8_t idx, MB_InventoryItemPublic_s *out);

/**
 * @brief 把清单中的某颗电机绑到通道上(运行期调用)
 *
 * @param channel_id 通道号 0~7
 * @param kind/can_bus/motor_id 必须与固件登记项完全一致,否则返回
 *                 MB_ERR_NOT_PROVISIONED —— 上位机无法驱动固件里不存在的电机
 * @param outer_loop 该通道使用的外层闭环
 * @return MB_OK 成功
 */
uint8_t MotorBenchBind(uint8_t channel_id, MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, Closeloop_Type_e outer_loop);

/**
 * @brief 动态替换某通道绑定的电机实例(用于 app 层重建电机后重新挂载)
 *
 * @return MB_OK 成功
 */
uint8_t MotorBenchAttachInstance(uint8_t channel_id, MB_MotorKind_e kind, void *instance);

/**
 * @brief 解除某通道绑定,自动停止该路
 */
uint8_t MotorBenchUnbind(uint8_t channel_id);

/**
 * @brief 使能/停止某通道
 *
 * @param channel_id 通道号
 * @param enable     1=使能 0=停止(停止是把 CAN 输出电流置零,而不是把 ref 设 0)
 */
uint8_t MotorBenchSetEnable(uint8_t channel_id, uint8_t enable);

/**
 * @brief 设置某通道参考值
 *
 * @param channel_id 通道号
 * @param ref        速度环:rpm;电流环:A;角度环:deg
 * @return MB_OK 成功;MB_ERR_NOT_ENABLED 表示通道未使能(已拒绝写入)
 *
 * @attention 未使能时拒绝写入,防止上电瞬间意外转动;值会被限幅到 ±MB_REF_LIMIT_*
 */
uint8_t MotorBenchSetRef(uint8_t channel_id, float ref);

/**
 * @brief 立即停止全部已绑定电机(急停入口)
 *
 * @note  建议上位机的物理急停按钮、页面关闭、异常检测均调用本函数
 */
void MotorBenchEmergencyStop(void);

/**
 * @brief 强制停止某个电机实例(不经通道,供登记/绑定时直接调用)
 */
void MotorBenchForceStopInstance(MB_MotorKind_e kind, void *instance);

/**
 * @brief 读取某通道电机反馈
 *
 * @param channel_id 通道号
 * @param out        输出:转速/电流/转矩/角度/温度/在线状态
 * @return MB_OK 成功
 */
uint8_t MotorBenchGetMeasure(uint8_t channel_id, MB_TelemetryItem_s *out);

/**
 * @brief 当前是否有任意电机在线
 */
uint8_t MotorBenchAnyMotorOnline(void);

/**
 * @brief 周期任务,建议以 500Hz 调用(与 MotorControlTask 同频)
 *
 * @note  内部按 MB_TELEMETRY_DIVIDER 节流到约 50Hz 上报遥测
 */
void MotorBenchTask(void);

/**
 * @brief 手动重载上位机链路守护
 *
 * @note  正常情况下心跳接收回调会自动调用,仅在特殊场景(如测试)手动调用
 */
void MotorBenchReloadLink(void);

#endif // MOTOR_BENCH_H