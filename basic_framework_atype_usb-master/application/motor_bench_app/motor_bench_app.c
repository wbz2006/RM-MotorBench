/**
 * @file motor_bench_app.c
 * @brief 电机测试台应用层实现
 *
 * @copyright Copyright (c) 2026 HNU YueLu EC all rights reserved
 */
#include "motor_bench_app.h"
#include "motor_bench.h"
#include "robot_def.h"
#include "bsp_log.h"
#include "bsp_dwt.h"
#include "can.h"
#include "usart.h"

/*
 * 使用哪张电机配置表由 robot_def.h 的 MOTOR_BENCH_DEFAULT_CONFIG 等宏决定;
 * 若工程里没有定义这些宏,则默认使用下方默认配置,避免本文件被编译成空目标文件。
 */
#if !defined(MOTOR_BENCH_DEFAULT_CONFIG)
#define MOTOR_BENCH_DEFAULT_CONFIG
#endif

/* ============================================================
 * 电机配置表 —— 这是本固件唯一的"硬件清单"
 *
 * 换电机 = 改这张表 + 重新烧录,而不是在上位机上点几下。
 * 原因见 motor_bench_app.h 的说明(CAN 过滤器/DMA 为有限启动期资源)。
 *
 * ===================== ID 分配规则(务必读,曾因此卡死) =====================
 * 框架 dji_motor.c 的 rx_id 计算:
 *     GM6020        : rx_id = 0x204 + (tx_id-1) + 1 = 0x204 + tx_id -> 0x205~0x20C
 *     M3508 / M2006 : rx_id = 0x200 + (tx_id-1) + 1 = 0x200 + tx_id -> 0x201~0x208
 *
 * [!] 两段区间**互相重叠**(0x205~0x208 同属两者)。
 *     所以 6020 与 3508/2006 **绝对不能挂在同一条 CAN 总线上**:
 *     例如 6020 用 tx_id=1(->0x205)与 3508 用 tx_id=5(->0x205)就会撞,
 *     MotorSenderGrouping() 检测到冲突会 while(1) 死等,
 *     表现为主机一直刷 "[dji_motor] ID crash" 且程序不再往下走。
 *
 * 正确做法:按总线分离
 *     CAN1 -> 只放 GM6020
 *     CAN2 -> 只放 M3508 / M2006
 * 同一总线内同型号之间 tx_id 互不相同即可。
 *
 * 另注:一条总线挂超过 6 个电机时,应把反馈降到 500Hz。
 *     达妙 DM 电机为独立 CAN 帧(非 4 合 1 打包),每台占一个过滤器。
 * ======================================================================== */

/** 实验室默认配置:清单为空,全部由上位机运行期动态创建 */
#if defined(MOTOR_BENCH_DEFAULT_CONFIG)

/*
 * @note 这里不再保留 bench_mXXXX 静态指针。
 *   改为动态创建后,电机实例的真正持有者是 motor_bench 的清单
 *   (mb_inventory[].motor_ptr),由 MotorBenchRemoveMotor() 负责销毁。
 *   app 层若再存一份指针,就会出现两份所有权,移除电机时极易漏掉其中一份,
 *   导致 CAN 实例与过滤器泄漏。
 */

/**
 * @brief 生成一台 DJI 电机的初始化配置(速度环整定值取自实验室通用经验值)
 * @param ref 输出参数
 */
static void BenchBuildDJIConfig(Motor_Init_Config_s *ref, Motor_Type_e type, CAN_HandleTypeDef *bus, uint8_t tx_id)
{
    ref->motor_type = type;
    ref->can_init_config.can_handle = bus;
    ref->can_init_config.tx_id = tx_id;

    ref->controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.close_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.motor_reverse_flag = MOTOR_DIRECTION_NORMAL;
    ref->controller_setting_init_config.feedback_reverse_flag = FEEDBACK_DIRECTION_NORMAL;
    ref->controller_setting_init_config.angle_feedback_source = MOTOR_FEED;
    ref->controller_setting_init_config.speed_feedback_source = MOTOR_FEED;

    /*
     * 速度环:ref 单位为 rpm(驱动内部 speed_aps/6.0f 换算为 rpm 后比较),
     * 输出为发送电流值,M3508 最大约 16000,M2006 最大约 10000,
     * GM6020 最大约 30000,这里留出余量。
     */
    ref->controller_param_init_config.speed_PID.Kp = 8.0f;
    ref->controller_param_init_config.speed_PID.Ki = 2.0f;
    ref->controller_param_init_config.speed_PID.Kd = 0.0f;
    ref->controller_param_init_config.speed_PID.MaxOut = (type == M2006) ? 9000.0f : 15000.0f;
    ref->controller_param_init_config.speed_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.speed_PID.IntegralLimit = 4000.0f;
}

/**
 * @brief 生成达妙 DM 电机的初始化配置
 * @note DM 驱动的速度单位是 rad/s(DM_V_MIN/MAX = ±45),
 *       上位机若要给 rpm,需要在协议层做单位换算,见 motor_bench_app.md
 */
static void BenchBuildDMConfig(Motor_Init_Config_s *ref, CAN_HandleTypeDef *bus, uint8_t tx_id)
{
    ref->motor_type = MOTOR_TYPE_NONE; /* DM 不使用该字段 */
    ref->can_init_config.can_handle = bus;
    ref->can_init_config.tx_id = tx_id;

    ref->controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.close_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.motor_reverse_flag = MOTOR_DIRECTION_NORMAL;
    ref->controller_setting_init_config.speed_feedback_source = MOTOR_FEED;

    ref->controller_param_init_config.speed_PID.Kp = 5.0f;
    ref->controller_param_init_config.speed_PID.Ki = 0.0f;
    ref->controller_param_init_config.speed_PID.Kd = 0.0f;
    ref->controller_param_init_config.speed_PID.MaxOut = 10.0f; /* 对应 DM_T_MAX=18 留余量 */
    ref->controller_param_init_config.speed_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.speed_PID.IntegralLimit = 8.0f;
}

/* ============================================================
 * 电机工厂 —— 供 motor_bench 运行期调用
 *
 * @note 为什么放在 app 层:框架分层规范要求 module 层不得实例化
 *       具体电机驱动(BSP / Module / APP 三层,BSP 只提供能力、
 *       Module 不碰 HAL 与具体器件、APP 负责装配)。
 *       motor_bench 属于 module,所以它通过 MotorBenchSetMotorFactory()
 *       把"怎么造一台电机"注入进来,自己只管协议与调度。
 * ============================================================ */

/**
 * @brief 按 (kind, bus, id) 创建一台电机
 * @return MB_OK 成功;MB_ERR_UNSUPPORTED 种类未接入;其它为失败
 */
static uint8_t BenchMotorFactory(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, void **out_instance)
{
    Motor_Init_Config_s cfg;
    CAN_HandleTypeDef *bus = (can_bus == 1) ? &hcan1 : &hcan2;

    if (!out_instance)
        return MB_ERR_BAD_PARAM;
    *out_instance = NULL;

    switch (kind)
    {
    case MB_MOTOR_GM6020:
    case MB_MOTOR_M3508:
    case MB_MOTOR_M2006:
    {
        Motor_Type_e t = (kind == MB_MOTOR_GM6020) ? GM6020
                      : (kind == MB_MOTOR_M3508) ? M3508 : M2006;
        BenchBuildDJIConfig(&cfg, t, bus, motor_id);
        DJIMotorInstance *m = DJIMotorInit(&cfg); /* 失败(过滤器耗尽/ID冲突)返回 NULL */
        if (!m)
            return MB_ERR_NO_RESOURCE;
        *out_instance = m;
        return MB_OK;
    }

    case MB_MOTOR_DM:
    {
        BenchBuildDMConfig(&cfg, bus, motor_id);
        DMMotorInstance *m = DMMotorInit(&cfg);
        if (!m)
            return MB_ERR_NO_RESOURCE;
        *out_instance = m;
        return MB_OK;
    }

    default:
        /* LK9025 / HT04 等尚未接入测试台 */
        LOGWARNING("[motor_bench_app] motor kind %d not supported yet", (int)kind);
        return MB_ERR_UNSUPPORTED;
    }
}

/**
 * @brief 销毁一台电机:先停输出,再释放其 CAN 实例与过滤器
 *
 * @attention 必须先停。电机仍在输出时释放 CAN 实例,
 *            motor_task 下一拍还会去访问已释放的指针。
 */
static void BenchMotorDestroy(MB_MotorKind_e kind, void *instance)
{
    if (!instance)
        return;

    if (kind == MB_MOTOR_DM)
    {
        DMMotorInstance *m = (DMMotorInstance *)instance;
        DMMotorStop(m);
        CANUnregister(m->motor_can_instace);
        free(m);
    }
    else
    {
        DJIMotorInstance *m = (DJIMotorInstance *)instance;
        DJIMotorStop(m);
        CANUnregister(m->motor_can_instance);
        free(m);
    }
}

void MotorBenchAppInit(void)
{
    Motor_Init_Config_s dji_config;
    Motor_Init_Config_s dm_config;
    (void)dji_config;
    (void)dm_config;

    /*
     * ★ 电机清单为空:全部由上位机在运行期动态创建。
     *
     * 这是本测试台与"改配置表 + 重烧固件"传统做法的分水岭:
     * 机械组拿到任意型号的电机,只要拨好电调 ID、插上 CAN 线,
     * 在网页上填"种类 + 总线 + ID"就能驱动,不必再找电控组烧程序。
     *
     * 代价:板子重启后清单为空,需要重新添加。
     *       （CAN 过滤器由硬件分配且不跨复位保存,这是框架的固有限制。）
     */
    MotorBenchSetMotorFactory(BenchMotorFactory, BenchMotorDestroy);
    LOGINFO("[motor_bench_app] dynamic motor factory registered, inventory starts empty");

    /*
     * 注册上位机通信通道。
     *
     * 默认使用 USB 虚拟串口(CDC):A 板板载 Micro USB OTG FS,
     * 直接插电脑线就能用,不需要外接 USB 转串口模块。
     * 该工程时钟树为 HSE 12MHz → PLL(M=6,N=168,P=2 → 168MHz,Q=7 → 48MHz),
     * PLLQ 输出的 48MHz 正好满足 USB OTG FS 的时钟要求,无需额外配置。
     *
     * 若实验室习惯用有线串口,把 robot_def.h 里的宏换成 MOTOR_BENCH_LINK_UART。
     */
#if defined(MOTOR_BENCH_LINK_USB)
    MotorBenchInitUSB();
#elif defined(MOTOR_BENCH_LINK_UART)
    /*
     * A 板上 UART7(PE7/PE8)与 UART8(PE0/PE1)均已配置 RX DMA 且
     * 其 DMA 中断已在 stm32f4xx_it.c 中使能,波特率 115200。
     */
    MotorBenchInit(&huart7);
#else
#error "请在 robot_def.h 中定义 MOTOR_BENCH_LINK_USB 或 MOTOR_BENCH_LINK_UART"
#endif

    LOGINFO("[motor_bench_app] init done, link=%d, inventory=%d motors",
            MotorBenchGetLinkType(), MotorBenchGetInventoryCount());
}

void MotorBenchAppTask(void)
{
    MotorBenchTask();
}

void MotorBenchAppEmergencyStop(void)
{
    MotorBenchEmergencyStop();
}

#endif // MOTOR_BENCH_DEFAULT_CONFIG
