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
#include "remote_control.h"

static RC_ctrl_t *bench_remote;
static void BenchReadRemote(uint8_t *online, int16_t axes[3], uint8_t *switch_right)
{
    uint32_t mask = __get_PRIMASK();
    __disable_irq();
    *online = RemoteControlIsOnline();
    axes[0] = bench_remote ? bench_remote[TEMP].rc.rocker_r1 : 0;
    axes[1] = bench_remote ? bench_remote[TEMP].rc.rocker_r_ : 0;
    axes[2] = bench_remote ? bench_remote[TEMP].rc.rocker_l_ : 0;
    *switch_right = bench_remote ? bench_remote[TEMP].rc.switch_right : 0;
    __set_PRIMASK(mask);
}

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

/* ---------------- PID 默认参数表 ----------------
 *
 * 来源:gimbal-fed infantry 工程的实机整定值(2026-10-12 迁移)。
 * 原工程机器人已稳定运行,比测试台此前的"通用经验值"更可靠。
 *
 *   电机型号     用途          取值位置
 *   --------     ----------    -----------------------
 *   M3508        摩擦轮        shoot.c  friction_config
 *   M2006        拨弹盘        shoot.c  loader_config  (速度环部分)
 *   GM6020       yaw 轴        gimbal.c yaw_config    (速度环部分)
 *   DM 达妙       保持不变       沿用原测试台经验值
 *
 * [!] 重要前提:原工程三组参数均开启电流环(close_loop_type 含 CURRENT_LOOP),
 *     电流环 Kp≈0.7 / Ki≈0.1 / IntegralLimit=5000~10000。
 *     测试台此前只开速度环,若只搬速度环参数而不补电流环,
 *     "同样的参数"不会有同样的效果 —— 速度环输出直接进入电流指令,
 *     缺少电流内环的整形,响应与稳定性都会变差。
 *
 *     GM6020 yaw 的速度环 Kp=50 / Ki=200 数值很大,
 *     这是原工程配合 CURRENT_LOOP + 梯形积分 + 500Hz 控制频率的结果,
 *     单独使用时不会得到相应表现。迁移时一并保留三环配置。
 * ================================================================ */

/*
 * 枚举顺序(motor_def.h):MOTOR_TYPE_NONE=0, GM6020, M3508, M2006, LK9025, HT04
 * 注意 MOTOR_TYPE_NONE 在**开头**且等于 0,不能拿它当数组大小。
 * 这里用最大的电机类型 + 1 作为表容量,并用静态断言保证枚举变动时立刻报错,
 * 而不是静默索引越界。
 *
 * 只支持 DJI 三型;若某型号无实参,保持零值 + 在下方注释说明。
 */
#define BENCH_PID_TABLE_SIZE (HT04 + 1)
_Static_assert(BENCH_PID_TABLE_SIZE > 0, "PID table size must be positive");
/* 确保我们用到的型号都在表范围内(编译期校验,避免索引越界) */
_Static_assert(GM6020 < BENCH_PID_TABLE_SIZE, "GM6020 out of PID table");
_Static_assert(M3508 < BENCH_PID_TABLE_SIZE, "M3508 out of PID table");
_Static_assert(M2006 < BENCH_PID_TABLE_SIZE, "M2006 out of PID table");

typedef struct
{
    float Kp;
    float Ki;
    float Kd;
    float MaxOut;
    float IntegralLimit;
    PID_Improvement_e Improve;
} BenchPidSet_s;

/* DJI 速度环:ref 单位为 rpm,输出为发送电流值。
 * M3508 最大约 16000,M2006 最大约 10000,GM6020 最大约 30000。 */
static const BenchPidSet_s bench_dji_speed_pid[BENCH_PID_TABLE_SIZE] = {
    [M3508] = {4.5f, 0.0f, 0.0f, 15000.0f, 10000.0f, PID_Integral_Limit},
    [M2006] = {10.0f, 1.0f, 0.0f, 5000.0f, 5000.0f, PID_Integral_Limit},
    [GM6020] = {50.0f, 200.0f, 0.0f, 20000.0f, 3000.0f,
                PID_Trapezoid_Intergral | PID_Integral_Limit | PID_Derivative_On_Measurement},
};

/* DJI 电流环:速度环输出作为电流参考,输出为发送电流值 */
static const BenchPidSet_s bench_dji_current_pid[BENCH_PID_TABLE_SIZE] = {
    [M3508] = {0.7f, 0.1f, 0.0f, 15000.0f, 10000.0f, PID_Integral_Limit},
    [M2006] = {0.7f, 0.1f, 0.0f, 5000.0f, 5000.0f, PID_Integral_Limit},
    /* 原工程 GM6020 yaw 未单独给 current_PID(其靠 speed_PID.MaxOut=20000 限幅),
     * 这里沿用与 M3508 相同的通用电流环参数,保证 GM6020 也有电流内环 */
    [GM6020] = {0.7f, 0.1f, 0.0f, 20000.0f, 3000.0f, PID_Integral_Limit},
};

static const BenchPidSet_s bench_dji_angle_pid[BENCH_PID_TABLE_SIZE] = {
    [GM6020] = {8.0f, 0.0f, 0.0f, 500.0f, 100.0f,
                PID_Trapezoid_Intergral | PID_Integral_Limit | PID_Derivative_On_Measurement},
};

/**
 * @brief 把一组 PID 配置写入目标结构
 */
static void BenchApplyPid(PID_Init_Config_s *dst, const BenchPidSet_s *src)
{
    dst->Kp = src->Kp;
    dst->Ki = src->Ki;
    dst->Kd = src->Kd;
    dst->MaxOut = src->MaxOut;
    dst->IntegralLimit = src->IntegralLimit;
    dst->Improve = src->Improve;
}

/**
 * @brief 生成一台 DJI 电机的初始化配置
 * @param type M3508 / M2006 / GM6020 —— 决定采用哪一套 PID 实参
 * @param tx_id 电调拨码 ID(1~8);rx_id 由框架按型号计算
 *
 * @note 默认开启 速度+电流 双环(与来源工程一致)。
 *       运行期可在上位机切换到仅速度环或速度+位置环。
 */
static void BenchBuildDJIConfig(Motor_Init_Config_s *ref, Motor_Type_e type, CAN_HandleTypeDef *bus, uint8_t tx_id)
{
    /* 只对 DJI 三型有实参;其它型号退回 M3508 通用参数,
     * 并保证索引在表范围内(编译期已断言,这里再兜一次运行期) */
    if (type != M3508 && type != M2006 && type != GM6020)
        type = M3508;

    ref->motor_type = type;
    ref->can_init_config.can_handle = bus;
    ref->can_init_config.tx_id = tx_id;

    ref->controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    /*
     * @attention 必须含 CURRENT_LOOP。
     *   原工程三组参数都在电流环闭环下整定;去掉电流环,
     *   speed_PID 的输出将直接作为未整形的电流指令,
     *   低速爬行与负载突变时的表现都会明显变差。
     */
    ref->controller_setting_init_config.close_loop_type = SPEED_LOOP | CURRENT_LOOP;
    ref->controller_setting_init_config.motor_reverse_flag = MOTOR_DIRECTION_NORMAL;
    ref->controller_setting_init_config.feedback_reverse_flag = FEEDBACK_DIRECTION_NORMAL;
    ref->controller_setting_init_config.angle_feedback_source = MOTOR_FEED;
    ref->controller_setting_init_config.speed_feedback_source = MOTOR_FEED;

    BenchApplyPid(&ref->controller_param_init_config.speed_PID, &bench_dji_speed_pid[type]);
    BenchApplyPid(&ref->controller_param_init_config.current_PID, &bench_dji_current_pid[type]);
    /* 位置环参数仅 GM6020 有实参;其余型号为零值(未指定,由上层整定) */
    BenchApplyPid(&ref->controller_param_init_config.angle_PID, &bench_dji_angle_pid[type]);
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
    Motor_Init_Config_s cfg = {0};
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
        DMMotorDestroy((DMMotorInstance *)instance);
    }
    else
    {
        DJIMotorDestroy((DJIMotorInstance *)instance);
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
    bench_remote = RemoteControlInit(MOTOR_BENCH_RC_UART);
    MotorBenchSetRemoteReader(BenchReadRemote);
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
    MotorBenchInit(&huart6);
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
