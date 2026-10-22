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
#include "LK9025.h"
#include "HT04.h"
#include <string.h> /* memset —— 生成电机配置前必须把整个结构体清零 */

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
 *
 * @attention 【2026-10-13 实测修正】Kp=1 太小,电机实际转不起来。
 *
 * 上一版曾统一设为 Kp=1/Ki=0/Kd=0,理由是"原实车参数(摩擦轮 20、yaw 50/200)
 * 是带机构与 IMU 前馈整定的,裸电机必然震荡"。方向对,但**幅度走极端了**。
 *
 * 量纲算一下就清楚:裸电机静摩擦与齿槽转矩要吃掉可观的电流,
 * 速度环输出 = Kp × 误差(rpm)。若 Kp=1,要输出 1000(约相当于
 * 3508 的 6% 电流值)就需要 1000rpm 的误差 —— 而电机全速也不过 9000rpm,
 * 等于开环都转不动,更别说闭环。
 *
 * 空载台架的经验起点:Kp 用原值除以 4~8。取:
 *   M3508  Kp=3    (原 20  → /6.7)
 *   M2006  Kp=2    (原 10  → /5)
 *   GM6020 Kp=8    (原 50  → /6.2)
 * Ki 保持 0:先只用比例项,让使用者判断"能不能转、稳不稳",再自己加 Ki 消静差。
 * 这三个值只是**能转起来的保守起点**,不是最优 —— 真正的整定在网页面板上做。
 *
 * MaxOut 仍按型号留足余量(它是输出限幅不是增益):
 *   M3508 最大约 16000,M2006 约 10000,GM6020 约 30000。
 */
static const BenchPidSet_s bench_dji_speed_pid[BENCH_PID_TABLE_SIZE] = {
    [M3508] = {3.0f, 0.0f, 0.0f, 15000.0f, 10000.0f, PID_Integral_Limit},
    [M2006] = {2.0f, 0.0f, 0.0f, 5000.0f, 5000.0f, PID_Integral_Limit},
    [GM6020] = {8.0f, 0.0f, 0.0f, 20000.0f, 3000.0f,
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
    /* deg -> deg/s; bounded commissioning settings for rotor position. */
    [M3508] = {4.0f, 0.0f, 0.0f, 600.0f, 0.0f, PID_Integral_Limit},
    [M2006] = {4.0f, 0.0f, 0.0f, 600.0f, 0.0f, PID_Integral_Limit},
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

    /*
     * @attention 【2026-10-13】DeadBand 必须显式写 0,不能靠结构体清零"顺带"解决。
     *
     * 为什么这里刻意不用死区:
     *   controller.c 的死区分支是 `else { Output = 0; ITerm = 0; }` ——
     *   **误差进入死区时输出直接归零**,而不是保持或衰减。
     *   在速度环上这等于一个开关控制器:接近目标 → 输出断掉 → 电机减速
     *   → 误差重新变大 → 再次输出。结果就是每次阶跃都过冲、然后来回抽,
     *   而且**与 Kp 大小无关**(Kp=2 也照样过冲)。
     *
     *   测试台要的是把电机当被控对象如实呈现,不是让内建死区替我们
     *   "隐藏"小误差。死区应当由使用者在整定时自行决定是否启用,
     *   而不是被框架默认值悄悄塞进来。
     *
     * @note 若将来要给死区留接口,应做成界面上的可调项并同步改
     *   controller.c 的死区语义(保持输出而非归零),不要只改这里。
     */
    dst->DeadBand = 0.0f;
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
    /* 各型号使用非零的位置环初始参数，按实际负载继续整定。 */
    BenchApplyPid(&ref->controller_param_init_config.angle_PID, &bench_dji_angle_pid[type]);
}

/**
 * @brief 生成达妙 DM 电机的初始化配置
 *
 * @param rx_id 反馈 ID(接收用)。DM 走 MIT 协议,发送与接收是**两个独立 ID**:
 *              主机 → 电机 用 tx_id,电机 → 主机 回传感测 用 rx_id,
 *              主机的 CAN 过滤器按 rx_id 匹配,配错就永远收不到反馈。
 *
 * @note DM4310 速度量程为 ±30 rad/s，DM8009P 为 ±45 rad/s，
 *       上位机若要给 rpm,需要在协议层做单位换算
 */
static void BenchBuildDMConfig(Motor_Init_Config_s *ref, CAN_HandleTypeDef *bus, uint8_t tx_id, uint16_t rx_id)
{
    ref->motor_type = MOTOR_TYPE_NONE; /* DM 不使用该字段 */
    ref->can_init_config.can_handle = bus;
    ref->can_init_config.tx_id = tx_id;
    /*
     * @attention 2026-10-17 之前这里**没有设置 rx_id** ——
     *   结构体虽被 memset 清零,于是 rx_id 恒为 0。
     *   后果一:CANRegister() 的过滤器按 rx_id=0 匹配,挂多颗 DM 时
     *           第二颗会因"rx_id 0x00 already used"直接注册失败,
     *           而 MotorBenchAddMotor 只把它转成 NO_RESOURCE,
     *           上位机看到的提示是"滤波器已用完",完全指错方向。
     *   后果二:即使只挂一颗,只要电机的实际反馈 ID 不是 0,
     *           过滤器也收不到任何反馈,遥测永远是 --。
     *   现在由上位机显式指定,两个 ID 都可配。
     */
    ref->can_init_config.rx_id = rx_id;

    ref->controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.close_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.motor_reverse_flag = MOTOR_DIRECTION_NORMAL;
    ref->controller_setting_init_config.speed_feedback_source = MOTOR_FEED;

    /* MIT speed-loop output is N*m. Start with P-only control and the
     * DM-J4310-2EC manual's 3 N*m rated torque; tune for the actual load. */
    ref->controller_param_init_config.speed_PID.Kp = 0.05f;
    ref->controller_param_init_config.speed_PID.Ki = 0.0f;
    ref->controller_param_init_config.speed_PID.Kd = 0.0f;
    ref->controller_param_init_config.speed_PID.MaxOut = 3.0f; /* N*m, rated torque */
    ref->controller_param_init_config.speed_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.speed_PID.IntegralLimit = 0.0f;
    /* Position targets and feedback are degrees; output is speed in rad/s. */
    ref->controller_param_init_config.angle_PID.Kp = 0.1f;
    ref->controller_param_init_config.angle_PID.MaxOut = 2.0f;
    ref->controller_param_init_config.angle_PID.Improve = PID_Integral_Limit;

    /*
     * @attention 死区必须显式写 0,与 BenchApplyPid 的理由相同:
     *   controller.c 的死区分支是 `else { Output = 0; }` ——
     *   误差进入死区时输出被**直接归零**而非保持,
     *   在速度环上会变成开关控制,造成与增益大小无关的过冲。
     *   虽然调用方已对整个 cfg 做过 memset,这里仍显式写一遍:
     *   让"这个字段被有意设置过"在代码里看得见,
     *   而不是依赖远处那一句 memset 的副作用。
     */
    ref->controller_param_init_config.speed_PID.DeadBand = 0.0f;
}

/* ============================================================
 * 岭芯 LK9025 / 海泰 HT04 —— 2026-10-19 接入
 *
 * 这两个库的源码早已在 cmake/motorbench.cmake 里编译(与 DJI/DM 同级),
 * 但工厂层一直走 default 分支返回 MB_ERR_UNSUPPORTED,
 * 所以上位机选不到、也建不出实例。本次把工厂接通。
 *
 * @attention 两者的对外接口与 DJI/DM 完全同构
 *   (Motor_Init_Config_s + Motor_Control_Setting_s + 三环 PID +
 *    CANInstance + daemon),所以不需要新的 config builder,
 *    直接复用 BenchBuildDJIConfig 的写法即可。
 *   差别只在 PID 默认值与闭环组合:
 *     - LK/HT 的电流环同样由驱动内部处理,close_loop 必须含 CURRENT_LOOP;
 *     - 速度单位都是 rad/s(与 DM 一致),**不是** DJI 的 rpm。
 * ============================================================ */

/**
 * @brief 生成岭芯 LK9025 的初始化配置
 *
 * @note LK 与 DJI 结构同构,但**没有** LKMotorOuterLoop() 这类切环接口
 *       (只有 SetRef/Stop/Enable/IsOnline),所以 outer_loop 在建实例时
 *       写死为 SPEED_LOOP|CURRENT_LOOP,运行期不支持切换 ——
 *       这一点由 motor_bench.c 的 MotorBenchSetLoopInstance 分流处理。
 */
static void BenchBuildLKConfig(Motor_Init_Config_s *ref, CAN_HandleTypeDef *bus, uint8_t tx_id)
{
    ref->motor_type = MOTOR_TYPE_NONE; /* LK 不使用该字段 */
    ref->can_init_config.can_handle = bus;
    ref->can_init_config.tx_id = tx_id;

    ref->controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.close_loop_type = SPEED_LOOP | CURRENT_LOOP;
    ref->controller_setting_init_config.motor_reverse_flag = MOTOR_DIRECTION_NORMAL;
    ref->controller_setting_init_config.feedback_reverse_flag = FEEDBACK_DIRECTION_NORMAL;
    ref->controller_setting_init_config.angle_feedback_source = MOTOR_FEED;
    ref->controller_setting_init_config.speed_feedback_source = MOTOR_FEED;

    /*
     * 保守的初始整定值。
     * @attention 这些数字**未经实机验证** —— LK9025 未参与过任何一轮台架整定。
     *   速度环取小增益 + 积分限幅,目的是"能转起来且不立刻振荡",
     *   真实负载下必须重新整定。电流环沿用框架通用基线。
     */
    ref->controller_param_init_config.speed_PID.Kp = 0.5f;
    ref->controller_param_init_config.speed_PID.Ki = 0.0f;
    ref->controller_param_init_config.speed_PID.Kd = 0.0f;
    ref->controller_param_init_config.speed_PID.MaxOut = 5.0f;
    ref->controller_param_init_config.speed_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.speed_PID.IntegralLimit = 0.0f;

    ref->controller_param_init_config.current_PID.Kp = 0.7f;
    ref->controller_param_init_config.current_PID.Ki = 0.1f;
    ref->controller_param_init_config.current_PID.MaxOut = 5.0f;
    ref->controller_param_init_config.current_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.current_PID.IntegralLimit = 0.0f;

    ref->controller_param_init_config.angle_PID.Kp = 0.1f;
    ref->controller_param_init_config.angle_PID.MaxOut = 2.0f;
    ref->controller_param_init_config.angle_PID.Improve = PID_Integral_Limit;

    /* 与 BenchBuildDMConfig 相同:死区必须显式清零 */
    ref->controller_param_init_config.speed_PID.DeadBand = 0.0f;
    ref->controller_param_init_config.current_PID.DeadBand = 0.0f;
    ref->controller_param_init_config.angle_PID.DeadBand = 0.0f;
}

/**
 * @brief 生成海泰 HT04 的初始化配置
 *
 * @param rx_id 反馈 ID(接收用)。HT04 的 HTMotorInit() 直接拿
 *              can_init_config.rx_id 建 CAN 过滤器,**不做内部改写**,
 *              所以与 DM 一样必须由上位机显式指定(多颗 HT 靠它区分)。
 *
 * @note HT04 有 HTMotorOuterLoop(),支持运行期切环;
 *       控制入口是 HTMotorControlInit()(每颗电机一个独立任务),
 *       与 LK 的 LKMotorControl() 不同。
 */
static void BenchBuildHTConfig(Motor_Init_Config_s *ref, CAN_HandleTypeDef *bus, uint8_t tx_id, uint16_t rx_id)
{
    ref->motor_type = MOTOR_TYPE_NONE; /* HT 不使用该字段 */
    ref->can_init_config.can_handle = bus;
    ref->can_init_config.tx_id = tx_id;
    ref->can_init_config.rx_id = rx_id;

    ref->controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    ref->controller_setting_init_config.close_loop_type = SPEED_LOOP | CURRENT_LOOP;
    ref->controller_setting_init_config.motor_reverse_flag = MOTOR_DIRECTION_NORMAL;
    ref->controller_setting_init_config.feedback_reverse_flag = FEEDBACK_DIRECTION_NORMAL;
    ref->controller_setting_init_config.angle_feedback_source = MOTOR_FEED;
    ref->controller_setting_init_config.speed_feedback_source = MOTOR_FEED;

    /* 同 LK:未经实机验证的保守基线,真实负载需重新整定 */
    ref->controller_param_init_config.speed_PID.Kp = 0.5f;
    ref->controller_param_init_config.speed_PID.Ki = 0.0f;
    ref->controller_param_init_config.speed_PID.Kd = 0.0f;
    ref->controller_param_init_config.speed_PID.MaxOut = 5.0f;
    ref->controller_param_init_config.speed_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.speed_PID.IntegralLimit = 0.0f;

    ref->controller_param_init_config.current_PID.Kp = 0.7f;
    ref->controller_param_init_config.current_PID.Ki = 0.1f;
    ref->controller_param_init_config.current_PID.MaxOut = 5.0f;
    ref->controller_param_init_config.current_PID.Improve = PID_Integral_Limit;
    ref->controller_param_init_config.current_PID.IntegralLimit = 0.0f;

    ref->controller_param_init_config.angle_PID.Kp = 0.1f;
    ref->controller_param_init_config.angle_PID.MaxOut = 2.0f;
    ref->controller_param_init_config.angle_PID.Improve = PID_Integral_Limit;

    ref->controller_param_init_config.speed_PID.DeadBand = 0.0f;
    ref->controller_param_init_config.current_PID.DeadBand = 0.0f;
    ref->controller_param_init_config.angle_PID.DeadBand = 0.0f;
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
 * @brief 按 (kind, bus, motor_id, rx_id) 创建一台电机
 *
 * @param rx_id 反馈 ID(接收用)。仅 DM 系使用;DJI 系传 0,驱动内部按规则计算
 * @return MB_OK 成功;MB_ERR_UNSUPPORTED 种类未接入;其它为失败
 */
static uint8_t BenchMotorFactory(MB_MotorKind_e kind, uint8_t can_bus, uint8_t motor_id, uint16_t rx_id, void **out_instance)
{
    /*
     * @attention 【2026-10-13 修复】必须显式清零。
     *
     * 原写法 `Motor_Init_Config_s cfg;` 是**未初始化的栈变量**,
     * 而 BenchBuildDJIConfig / BenchBuildDMConfig 只写其中一部分字段 ——
     * 没被写到的字段就是**随机栈垃圾**。
     *
     * 实测症状:每次设定新速度都出现明显超调(尖峰 4280 → 回落 1050),
     *   而速度环 Kp 只有 2 —— 这么小的增益不可能产生那种过冲。
     *
     * 根因在 controller.c 的死区分支:
     *     if (abs(Err) > DeadBand) { 正常PID }
     *     else { Output = 0; ITerm = 0; }   // 进入死区直接归零输出
     *   DeadBand 恰好是**没人写过**的字段。若它被填成正值,
     *   误差一进入死区输出就归零 → 电机减速 → 误差重新变大 → 再输出,
     *   形成开关式极限环:每次阶跃都过冲,然后来回抽。
     *
     * 显式清零 + 在 BenchApplyPid 里明确设置 DeadBand,二者缺一不可:
     *   清零保证"没打算用的字段"不会带着垃圾值参与运算;
     *   显式赋值保证"确实要用的字段"有一个经过思考的值。
     */
    Motor_Init_Config_s cfg;
    memset(&cfg, 0, sizeof(cfg));
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
        m->speed_ramp.rate = MB_SPEED_ACCEL_RPM * 6.0f;
        m->speed_ramp.zero_rate = MB_SPEED_ZERO_DECEL_RPM * 6.0f;
        *out_instance = m;
        return MB_OK;
    }

    case MB_MOTOR_DM:
    case MB_MOTOR_DM8009P:
    {
        /*
         * DM:两个 ID 都由上位机给 ——
         *   motor_id → tx_id(主机发给电机的控制指令 ID)
         *   rx_id    → 反馈 ID(电机回传的传感数据,过滤器按它匹配)
         * 2026-10-17 之前 rx_id 从未被设置(恒 0),导致多颗 DM 无法共存、
         * 单颗也可能收不到反馈。现在由协议显式传入。
         */
        BenchBuildDMConfig(&cfg, bus, motor_id, rx_id);
        /* Model-specific commissioning defaults. Gains need load tuning;
         * MaxOut is an output ceiling, not a constant torque command. */
        if (kind == MB_MOTOR_DM)
        {
            cfg.controller_param_init_config.speed_PID.Kp = 0.55f;
            cfg.controller_param_init_config.speed_PID.Ki = 0.5f;
            cfg.controller_param_init_config.speed_PID.Kd = 0.0f;
            cfg.controller_param_init_config.speed_PID.MaxOut = 7.0f;
            cfg.controller_param_init_config.speed_PID.IntegralLimit = 100.0f;
        }
        else if (kind == MB_MOTOR_DM8009P)
        {
            cfg.controller_param_init_config.speed_PID.Kp = 0.55f;
            cfg.controller_param_init_config.speed_PID.Ki = 5.0f;
            cfg.controller_param_init_config.speed_PID.Kd = 0.0f;
            cfg.controller_param_init_config.speed_PID.MaxOut = 17.5f;
            cfg.controller_param_init_config.speed_PID.IntegralLimit = 100.0f;
        }
        DMMotorInstance *m = DMMotorInitWithModel(&cfg,
            kind == MB_MOTOR_DM8009P ? DM_MODEL_8009P : DM_MODEL_4310);
        if (!m)
            return MB_ERR_NO_RESOURCE;
        m->speed_ramp.rate = MB_SPEED_ACCEL_RAD;
        m->speed_ramp.zero_rate = MB_SPEED_ZERO_DECEL_RAD;
        *out_instance = m;
        return MB_OK;
    }

    case MB_MOTOR_LK:
    {
        /*
         * 岭芯 LK9025 —— 2026-10-19 接入。
         * @note rx_id 由 LK 驱动内部按自身规则处理,与 DJI 同理,
         *   上位机传 0 即可(协议层对非 DM 系强制要求 0)。
         */
        BenchBuildLKConfig(&cfg, bus, motor_id);
        LKMotorInstance *m = LKMotorInit(&cfg);
        if (!m)
            return MB_ERR_NO_RESOURCE;
        m->speed_ramp.rate = MB_SPEED_ACCEL_RAD;
        m->speed_ramp.zero_rate = MB_SPEED_ZERO_DECEL_RAD;
        *out_instance = m;
        return MB_OK;
    }

    case MB_MOTOR_HT:
    {
        /* 海泰 HT04 —— 2026-10-19 接入。rx_id 与 DM 一样由上位机显式指定 */
        BenchBuildHTConfig(&cfg, bus, motor_id, rx_id);
        HTMotorInstance *m = HTMotorInit(&cfg);
        if (!m)
            return MB_ERR_NO_RESOURCE;
        /*
         * @attention HT04 的控制入口与其它电机不同:
         *   它不走 MotorControlTask() 里的统一循环(motor_task.c 中
         *   HTMotorControl() 是注释掉的),而是由 HTMotorControlInit()
         *   **给每颗已注册的 HT 电机各建一个独立任务**(内含 osDelay(1))。
         *
         *   因此运行期动态创建 HT 电机后必须再调一次,否则电机建得出来、
         *   遥测也收得到,但**永远不会被驱动**。
         *
         * @note 该函数内部按 HT 自己的实例表遍历,重复调用是安全的
         *   (已建过任务的实例不会重复建),但每次调用都会为**所有**
         *   HT 实例尝试建任务,所以放在"创建成功之后"只调一次即可。
         */
        HTMotorControlInit();
        m->speed_ramp.rate = MB_SPEED_ACCEL_RAD * RAD_2_DEGREE;
        m->speed_ramp.zero_rate = MB_SPEED_ZERO_DECEL_RAD * RAD_2_DEGREE;
        *out_instance = m;
        return MB_OK;
    }

    default:
        /* servo / step 等未接入:CAN 电机工厂模式不适用(见文件头说明) */
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

    if (MotorBenchIsDMKind(kind))
    {
        DMMotorDestroy((DMMotorInstance *)instance);
        return;
    }

    if (kind == MB_MOTOR_LK || kind == MB_MOTOR_HT)
    {
        /*
         * 岭芯 LK9025 / 海泰 HT04 —— 2026-10-19 接入。
         *
         * @attention 这两个库**没有**提供 XxxMotorDestroy() 接口
         *   (DJI/DM 都有),所以只能手动完成"停机 → 注销 CAN → free"。
         *   顺序不能反:必须先停输出,否则 motor_task 下一拍还会访问
         *   已释放的指针。
         *
         * @note HT04 的已知限制:它的控制是"每颗电机一个独立任务"
         *   (HTMotorControlInit 创建),而 HT 库没有提供删除任务的接口。
         *   移除 HT 电机后,那个任务仍在运行并访问已 free 的实例
         *   —— 悬空指针。当前测试台的规避办法是:
         *   界面层不提供 HT 的删除入口(见 motor_bench_host 的说明),
         *   或由使用者接受该风险。彻底修需要给 HT 库加实例销毁接口。
         */
        if (kind == MB_MOTOR_LK)
        {
            LKMotorInstance *m = (LKMotorInstance *)instance;
            LKMotorStop(m);
            CANUnregister(m->motor_can_ins);
        }
        else
        {
            HTMotorInstance *m = (HTMotorInstance *)instance;
            HTMotorStop(m);
            CANUnregister(m->motor_can_instace);
        }
        free(instance);
        return;
    }

    DJIMotorDestroy((DJIMotorInstance *)instance);
}

void MotorBenchAppInit(void)
{
    /*
     * @note 这里原先声明了 dji_config / dm_config 两个结构体并立即 (void) 弃用,
     *   是从"静态清单"版本遗留下来的死代码。已删除 ——
     *   未初始化的栈结构体留在代码里除了误导没有别的作用
     *   (本轮修的那处 DeadBand 垃圾值就是同类问题的真实后果)。
     */

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
