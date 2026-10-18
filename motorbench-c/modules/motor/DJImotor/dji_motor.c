#include "dji_motor.h"
#include "string.h"
#include "general_def.h"
#include "bsp_dwt.h"
#include "bsp_log.h"
/*
 * 必须包含 robot_def.h:MOTOR_BENCH_QUIET_LOG 与 MOTOR_BENCH_DAEMON_RELOAD_COUNT
 * 定义在 application/robot_def.h。若不包含,下面的条件编译会**静默全部为假**,
 * 表现为"改了开关却毫无效果" —— 本工程已经踩过这个坑两次(motor_task.c 同因)。
 */
#include "robot_def.h"

static uint8_t idx = 0; // register idx,是该文件的全局电机索引,在注册时使用
/* DJI电机的实例,此处仅保存指针,内存的分配将通过电机实例初始化时通过malloc()进行 */
static DJIMotorInstance *dji_motor_instance[DJI_MOTOR_CNT] = {NULL}; // 会在control任务中遍历该指针数组进行pid计算

/**
 * @brief 由于DJI电机发送以四个一组的形式进行,故对其进行特殊处理,用6个(2can*3group)can_instance专门负责发送
 *        该变量将在 DJIMotorControl() 中使用,分组在 MotorSenderGrouping()中进行
 *
 * @note  因为只用于发送,所以不需要在bsp_can中注册
 *
 * C610(m2006)/C620(m3508):0x1ff,0x200;
 * GM6020:0x1ff,0x2ff
 * 反馈(rx_id): GM6020: 0x204+id ; C610/C620: 0x200+id
 * can1: [0]:0x1FF,[1]:0x200,[2]:0x2FF
 * can2: [3]:0x1FF,[4]:0x200,[5]:0x2FF
 */
static CANInstance sender_assignment[6] = {
    [0] = {.can_handle = &hcan1, .txconf.StdId = 0x1ff, .txconf.IDE = CAN_ID_STD, .txconf.RTR = CAN_RTR_DATA, .txconf.DLC = 0x08, .tx_buff = {0}},
    [1] = {.can_handle = &hcan1, .txconf.StdId = 0x200, .txconf.IDE = CAN_ID_STD, .txconf.RTR = CAN_RTR_DATA, .txconf.DLC = 0x08, .tx_buff = {0}},
    [2] = {.can_handle = &hcan1, .txconf.StdId = 0x2ff, .txconf.IDE = CAN_ID_STD, .txconf.RTR = CAN_RTR_DATA, .txconf.DLC = 0x08, .tx_buff = {0}},
    [3] = {.can_handle = &hcan2, .txconf.StdId = 0x1ff, .txconf.IDE = CAN_ID_STD, .txconf.RTR = CAN_RTR_DATA, .txconf.DLC = 0x08, .tx_buff = {0}},
    [4] = {.can_handle = &hcan2, .txconf.StdId = 0x200, .txconf.IDE = CAN_ID_STD, .txconf.RTR = CAN_RTR_DATA, .txconf.DLC = 0x08, .tx_buff = {0}},
    [5] = {.can_handle = &hcan2, .txconf.StdId = 0x2ff, .txconf.IDE = CAN_ID_STD, .txconf.RTR = CAN_RTR_DATA, .txconf.DLC = 0x08, .tx_buff = {0}},
};

/**
 * @brief 6个用于确认是否有电机注册到sender_assignment中的标志位,防止发送空帧,此变量将在DJIMotorControl()使用
 *        flag的初始化在 MotorSenderGrouping()中进行
 */
static uint8_t sender_enable_flag[6] = {0};

/**
 * @brief 根据电调/拨码开关上的ID,根据说明书的默认id分配方式计算发送ID和接收ID,
 *        并对电机进行分组以便处理多电机控制命令
 */
static void MotorSenderGrouping(DJIMotorInstance *motor, CAN_Init_Config_s *config)
{
    uint8_t motor_id = config->tx_id - 1; // 下标从零开始,先减一方便赋值
    uint8_t motor_send_num;
    uint8_t motor_grouping;

    switch (motor->motor_type)
    {
    case M2006:
    case M3508:
        if (motor_id < 4) // 根据ID分组
        {
            motor_send_num = motor_id;
            motor_grouping = config->can_handle == &hcan1 ? 1 : 4;
        }
        else
        {
            motor_send_num = motor_id - 4;
            motor_grouping = config->can_handle == &hcan1 ? 0 : 3;
        }

        // 计算接收id并设置分组发送id
        config->rx_id = 0x200 + motor_id + 1;   // 把ID+1,进行分组设置
        sender_enable_flag[motor_grouping] = 1; // 设置发送标志位,防止发送空帧
        motor->message_num = motor_send_num;
        motor->sender_group = motor_grouping;

        // 检查是否发生id冲突
        for (size_t i = 0; i < idx; ++i)
        {
            if (dji_motor_instance[i]->motor_can_instance->can_handle == config->can_handle && dji_motor_instance[i]->motor_can_instance->rx_id == config->rx_id)
            {
                /*
                 * rx_id 冲突,与上面 GM6020 分支同一原因:
                 * 6020 占 0x204+tx_id,3508/2006 占 0x200+tx_id,区间重叠,
                 * 故两类电机不能挂在同一条总线上。
                 * 只报一次然后停机等待复位,避免 while(1) 刷屏把 RTT/串口塞满,
                 * 那样反而看不到其他有用日志。
                 */
                uint16_t can_bus = config->can_handle == &hcan1 ? 1 : 2;
                LOGERROR("[dji_motor] rx_id crash! rx_id=0x%03X(%d) can_bus=%d, tx_id=%d",
                         config->rx_id, config->rx_id, can_bus, config->tx_id);
                LOGERROR("[dji_motor] 6020(0x204+id) and 3508/2006(0x200+id) ranges overlap.");
                LOGERROR("[dji_motor] Put them on DIFFERENT CAN buses. HALT.");
                while (1)
                {
                    __WFI(); // 停机等待复位,不再重复打印
                }
            }
        }
        break;

    case GM6020:
        if (motor_id < 4)
        {
            motor_send_num = motor_id;
            motor_grouping = config->can_handle == &hcan1 ? 0 : 3;
        }
        else
        {
            motor_send_num = motor_id - 4;
            motor_grouping = config->can_handle == &hcan1 ? 2 : 5;
        }

        config->rx_id = 0x204 + motor_id + 1;   // 把ID+1,进行分组设置
        sender_enable_flag[motor_grouping] = 1; // 只要有电机注册到这个分组,置为1;在发送函数中会通过此标志判断是否有电机注册
        motor->message_num = motor_send_num;
        motor->sender_group = motor_grouping;

        for (size_t i = 0; i < idx; ++i)
        {
            if (dji_motor_instance[i]->motor_can_instance->can_handle == config->can_handle && dji_motor_instance[i]->motor_can_instance->rx_id == config->rx_id)
            {
                /*
                 * rx_id 冲突:两颗电机在同一条总线上抢同一个反馈 ID,
                 * CAN 过滤器也无法区分,属于不可恢复的初始化期错误。
                 *
                 * ⚠️ 原因:G6020 用 0x204+tx_id(0x205~0x20C),
                 *    M3508/M2006 用 0x200+tx_id(0x201~0x208),两段区间重叠,
                 *    因此这两类电机**不能挂在同一条总线上**。
                 *
                 * @note 这里必须停在这里,否则会继续往下注册出错误配置。
                 *       但不要写成 while(1){ LOGERROR(...) } 的死循环刷屏 ——
                 *       RTT/串口会被刷满,反而看不到别的日志。
                 */
                uint16_t can_bus = config->can_handle == &hcan1 ? 1 : 2;
                LOGERROR("[dji_motor] rx_id crash! rx_id=0x%03X(%d) can_bus=%d, tx_id=%d",
                         config->rx_id, config->rx_id, can_bus, config->tx_id);
                LOGERROR("[dji_motor] 6020(0x204+id) and 3508/2006(0x200+id) ranges overlap.");
                LOGERROR("[dji_motor] Put them on DIFFERENT CAN buses. HALT.");
                while (1)
                {
                    /* 故意停机:配置错误会导致 CAN 收发指向错误电机,继续运行有风险。
                     * 仅保持空转等待人工复位,不再重复打印。 */
                    __WFI();
                }
            }
        }
        break;

    default: // other motors should not be registered here
        while (1)
        {
            LOGERROR("[dji_motor] You must not register other motors using the DJI motor API.");
            __WFI(); // 停机等待复位,避免刷屏
        }
    }
}

/**
 * @todo  是否可以简化多圈角度的计算？
 * @brief 根据返回的can_instance对反馈报文进行解析
 *
 * @param _instance 收到数据的instance,通过遍历与所有电机进行对比以选择正确的实例
 */
static void DecodeDJIMotor(CANInstance *_instance)
{
    // 这里对can instance的id进行了强制转换,从而获得电机的instance实例地址
    // _instance指针指向的id是对应电机instance的地址,通过强制转换为电机instance的指针,再通过->运算符访问电机的成员motor_measure,最后取地址获得指针
    uint8_t *rxbuff = _instance->rx_buff;
    DJIMotorInstance *motor = (DJIMotorInstance *)_instance->id;
    DJI_Motor_Measure_s *measure = &motor->measure; // measure要多次使用,保存指针减小访存开销

    DaemonReload(motor->daemon);
    motor->dt = DWT_GetDeltaT(&motor->feed_cnt);

    measure->last_ecd = measure->ecd;
    measure->ecd = ((uint16_t)rxbuff[0]) << 8 | rxbuff[1];
    measure->angle_single_round = ECD_ANGLE_COEF_DJI * (float)measure->ecd;

    /*
     * 解析数据并对电流和速度做一阶低通。
     *
     * @attention 【2026-10-13 修正】原公式把滤波系数的语义用反了。
     *
     * 原写法:
     *     measure->real_current = (1 - COEF) * 旧值 + COEF * 新采样;
     * 且 CURRENT_SMOOTH_COEF = 0.9 —— 即新采样占 90% 权重,
     * **几乎等于不做滤波**(实测噪声只降 10%)。
     * 注释"系数为1即关闭滤波"是对的,但由此推出"必须大于0.9"就完全反了:
     * 在这个公式下系数越大越不滤波。
     *
     * 这是"电流曲线怎么滤都抖"的根源 —— 源头这道滤波器形同虚设,
     * 后面无论再叠多少级平滑,都只是在补它的窟窿。
     *
     * 现改为系数 = 旧值权重的标准写法,含义与直觉一致:
     *     measure = COEF * 旧值 + (1 - COEF) * 新采样
     */
    measure->speed_aps = SPEED_SMOOTH_COEF * measure->speed_aps +
                         (1.0f - SPEED_SMOOTH_COEF) * RPM_2_ANGLE_PER_SEC *
                             (float)((int16_t)(rxbuff[2] << 8 | rxbuff[3]));
    measure->real_current = CURRENT_SMOOTH_COEF * measure->real_current +
                            (1.0f - CURRENT_SMOOTH_COEF) *
                                (float)((int16_t)(rxbuff[4] << 8 | rxbuff[5]));
    measure->temperature = rxbuff[6];

    // 多圈角度计算,前提是假设两次采样间电机转过的角度小于180°,自己画个图就清楚计算过程了
    if (measure->ecd - measure->last_ecd > 4096)
        measure->total_round--;
    else if (measure->ecd - measure->last_ecd < -4096)
        measure->total_round++;
    measure->total_angle = measure->total_round * 360 + measure->angle_single_round;
}

static void DJIMotorLostCallback(void *motor_ptr)
{
    DJIMotorInstance *motor = (DJIMotorInstance *)motor_ptr;

#if defined(MOTOR_BENCH_QUIET_LOG)
    /*
     * 电机测试台模式:静音离线告警。
     * @attention DaemonTask() 以 100Hz 运行,且离线时会**每周期都调用**本回调,
     *           没有"已告警"的状态记忆。所以只要电机没接(实验室常态),
     *           每秒就会打 10 条,几秒内把 RTT 上行缓冲(仅 1024 字节)刷满,
     *           导致真正的启动日志与 USB 诊断信息全部被覆盖。
     *           这不是 bug,而是测试台场景下"电机常态离线"与框架
     *           "离线即告警"设计之间的固有矛盾。
     *           需要看离线状态请用上位机界面的在线/离线标识。
     *
     * @note  此分支下 motor 变量未使用,故一并用 (void) 抑制警告 ——
     *        工程开启了 -Werror,留下未使用变量会直接编译失败。
     */
    (void)motor;
#else
    uint16_t can_bus = motor->motor_can_instance->can_handle == &hcan1 ? 1 : 2;
    LOGWARNING("[dji_motor] Motor lost, can bus [%d] , id [%d]", can_bus, motor->motor_can_instance->tx_id);
#endif
}

// 电机初始化,返回一个电机实例
DJIMotorInstance *DJIMotorInit(Motor_Init_Config_s *config)
{
    if (idx >= DJI_MOTOR_CNT)
        return NULL;
    DJIMotorInstance *instance = (DJIMotorInstance *)malloc(sizeof(DJIMotorInstance));
    if (!instance)
        return NULL;
    memset(instance, 0, sizeof(DJIMotorInstance));

    // motor basic setting 电机基本设置
    instance->motor_type = config->motor_type;                         // 6020 or 2006 or 3508
    instance->motor_settings = config->controller_setting_init_config; // 正反转,闭环类型等

    // motor controller init 电机控制器初始化
    PIDInit(&instance->motor_controller.current_PID, &config->controller_param_init_config.current_PID);
    PIDInit(&instance->motor_controller.speed_PID, &config->controller_param_init_config.speed_PID);
    PIDInit(&instance->motor_controller.angle_PID, &config->controller_param_init_config.angle_PID);
    instance->motor_controller.other_angle_feedback_ptr = config->controller_param_init_config.other_angle_feedback_ptr;
    instance->motor_controller.other_speed_feedback_ptr = config->controller_param_init_config.other_speed_feedback_ptr;
    instance->motor_controller.current_feedforward_ptr = config->controller_param_init_config.current_feedforward_ptr;
    instance->motor_controller.speed_feedforward_ptr = config->controller_param_init_config.speed_feedforward_ptr;
    // 后续增加电机前馈控制器(速度和电流)

    // 电机分组,因为至多4个电机可以共用一帧CAN控制报文
    MotorSenderGrouping(instance, &config->can_init_config);

    // 注册电机到CAN总线
    config->can_init_config.can_module_callback = DecodeDJIMotor; // set callback
    config->can_init_config.id = instance;                        // set id,eq to address(it is identity)
    instance->motor_can_instance = CANRegister(&config->can_init_config);

    /*
     * @attention CANRegister() 在 rx_id 冲突 / 过滤器耗尽 / 实例池满时返回 NULL
     *   (原先是 while(1) 死等)。测试台支持运行期动态建电机,
     *   用户填错 ID 时必须让上层知道并把错误回传上位机,
     *   而不是返回一个"看起来正常"的半成品实例导致后续空指针崩溃。
     */
    if (instance->motor_can_instance == NULL)
    {
        LOGERROR("[dji_motor] CAN register failed (check rx_id / bus / filter bank)");
        free(instance);
        return NULL;
    }

    // 注册守护线程
    Daemon_Init_Config_s daemon_config = {
        .callback = DJIMotorLostCallback,
        .owner_id = instance,
#if defined(MOTOR_BENCH_DAEMON_RELOAD_COUNT)
        /*
         * 电机测试台模式:放宽离线判定阈值(守护 100Hz,故 10 ≈ 100ms)。
         * 原值 2(≈20ms)对测试台场景太激进 —— 电机常态未接时容易反复误报。
         * 代价是真掉线时反应慢约 80ms,对测试台无影响。
         */
        .reload_count = MOTOR_BENCH_DAEMON_RELOAD_COUNT,
#else
        .reload_count = 2, // 20ms未收到数据则丢失
#endif
    };
    instance->daemon = DaemonRegister(&daemon_config);
    if (!instance->daemon)
    {
        CANUnregister(instance->motor_can_instance);
        free(instance);
        return NULL;
    }

    DJIMotorEnable(instance);
    dji_motor_instance[idx++] = instance;
    return instance;
}

void DJIMotorDestroy(DJIMotorInstance *motor)
{
    if (!motor)
        return;
    for (uint8_t i = 0; i < idx; i++)
    {
        if (dji_motor_instance[i] != motor)
            continue;
        DJIMotorStop(motor);
        uint8_t group = motor->sender_group;
        memset(sender_assignment[group].tx_buff + 2 * motor->message_num, 0, sizeof(uint16_t));
        CANTransmit(&sender_assignment[group], 1); /* Clear only this slot; retain peers. */
        memmove(&dji_motor_instance[i], &dji_motor_instance[i + 1], (idx - i - 1) * sizeof(dji_motor_instance[0]));
        dji_motor_instance[--idx] = NULL;
        sender_enable_flag[group] = 0;
        for (uint8_t j = 0; j < idx; j++)
            if (dji_motor_instance[j]->sender_group == group)
                sender_enable_flag[group] = 1;
        CANUnregister(motor->motor_can_instance);
        DaemonUnregister(motor->daemon);
        free(motor);
        return;
    }
}

/* 电流只能通过电机自带传感器监测,后续考虑加入力矩传感器应变片等 */
void DJIMotorChangeFeed(DJIMotorInstance *motor, Closeloop_Type_e loop, Feedback_Source_e type)
{
    if (loop == ANGLE_LOOP)
        motor->motor_settings.angle_feedback_source = type;
    else if (loop == SPEED_LOOP)
        motor->motor_settings.speed_feedback_source = type;
    else
        LOGERROR("[dji_motor] loop type error, check memory access and func param"); // 检查是否传入了正确的LOOP类型,或发生了指针越界
}

static void DJIMotorResetController(DJIMotorInstance *motor)
{
    PIDReset(&motor->motor_controller.angle_PID);
    PIDReset(&motor->motor_controller.speed_PID);
    PIDReset(&motor->motor_controller.current_PID);
}

void DJIMotorStop(DJIMotorInstance *motor)
{
    motor->stop_flag = MOTOR_STOP;
    DJIMotorResetController(motor);
}

void DJIMotorEnable(DJIMotorInstance *motor)
{
    if (motor->stop_flag == MOTOR_STOP)
        DJIMotorResetController(motor);
    motor->stop_flag = MOTOR_ENALBED;
}

/* 修改电机的实际闭环对象 */
void DJIMotorOuterLoop(DJIMotorInstance *motor, Closeloop_Type_e outer_loop)
{
    motor->motor_settings.outer_loop_type = outer_loop;
}

/**
 * @brief 运行期切换外层闭环,并做必要的安全处理
 *
 * @attention 为什么不能只改 outer_loop_type:
 *   各环的量纲不同(角度 deg / 转速 rpm / 电流 A),切换后残留在 PID 里的
 *   积分项与历史误差是以**旧量纲**累积的。若不清理,新环一接管就可能输出突跳,
 *   轻则电机猛地一抖,重则直接打飞。
 *
 *   典型现象(实测):电机在速度环下以 1100rpm 运行,切到位置环的瞬间
 *   位置环把"当前角度"与"角度参考值"的巨大差值当作误差,
 *   若积分项还留着速度环的值,输出会远超电流上限。
 */
void DJIMotorChangeLoop(DJIMotorInstance *motor, Closeloop_Type_e loop)
{
    if (!motor)
        return;

    /*
     * @attention 【2026-10-13 修复】这里必须接受**组合值**,不能只放行单环。
     *
     * 原判断是 `loop != ANGLE_LOOP && loop != SPEED_LOOP && ...` ——
     * 只认 4 个单环常量,于是 SPEED_AND_CURRENT_LOOP(0b0011) 与
     * ANGLE_AND_SPEED_LOOP(0b0110) 会被当作非法参数直接拒绝,
     * 日志打 "invalid loop"。
     *
     * 但串级叠加本就是框架的原生能力:close_loop_type 是**位掩码**,
     * DJIMotorControl() 逐环判断 `close_loop_type & XXX_LOOP`,
     * pid_ref 顺次穿过被启用的每一环。
     * 结果就是"界面上选不到双环",看起来像功能不存在,实际只是入口被这道校验挡住了。
     *
     * 现在改成位掩码合法性检查:允许的位必须非空,且不含未定义的位。
     */
    if (loop == OPEN_LOOP)
    {
        /* 开环是合法目标,单独放行(掩码为 0,不能用下面的非空判断) */
    }
    else if ((loop & ~(ANGLE_LOOP | SPEED_LOOP | CURRENT_LOOP)) != 0 || loop == 0)
    {
        LOGERROR("[dji_motor] change loop failed: invalid loop %d", (int)loop);
        return;
    }

    if (motor->motor_settings.outer_loop_type == loop)
        return; /* 无变化,什么都不用做 */

    /* 1. 先停机:切换期间电机不应继续响应旧参考值 */
    motor->stop_flag = MOTOR_STOP;

    /* 2. 切换外环 */
    motor->motor_settings.outer_loop_type = loop;

    /*
     * 3. close_loop_type 必须与新的外环一致。
     *    DJIMotorControl() 的判定条件是
     *      位置环:(close_loop & ANGLE_LOOP) && outer_loop == ANGLE_LOOP
     *      速度环:(close_loop & SPEED_LOOP)  && (outer_loop & (ANGLE|SPEED))
     *      电流环:(close_loop & CURRENT_LOOP)  —— 只要启用就执行,不限外层
     *    只改 outer_loop 而 close_loop 里没有对应位,那一环就根本不会执行。
     *
     * @attention 【2026-10-13】补全组合值的映射。
     *   "速度环 + 电流环"是最常用的组合(速度环输出作为电流环参考),
     *   也是本测试台建电机时的默认配置。
     *   "角度环 + 速度环"由单环 ANGLE_LOOP 的既有语义推广而来
     *   (位置环输出必须经过速度环才能变成电流指令)。
     *
     * @note 电流环的开启是**叠加式**而非替换式:
     *   选 SPEED_LOOP 单环时 close_loop 里不含 CURRENT_LOOP ——
     *   此时速度环输出**直接当作电流值**下发给电调,
     *   表现为"没有电流内环的纯速度控制",这是有意保留的对照模式。
     */
    switch (loop)
    {
    case ANGLE_LOOP:
        motor->motor_settings.close_loop_type = ANGLE_LOOP | SPEED_LOOP;
        break;
    case SPEED_LOOP:
        motor->motor_settings.close_loop_type = SPEED_LOOP;
        break;
    case CURRENT_LOOP:
        motor->motor_settings.close_loop_type = CURRENT_LOOP;
        break;
    case SPEED_AND_CURRENT_LOOP:
        /* 速度外环 + 电流内环:速度环输出作为电流环参考 */
        motor->motor_settings.close_loop_type = SPEED_LOOP | CURRENT_LOOP;
        break;
    case ANGLE_AND_SPEED_LOOP:
        /* 位置外环 + 速度内环(不含电流环,与单环 ANGLE_LOOP 语义对齐) */
        motor->motor_settings.close_loop_type = ANGLE_LOOP | SPEED_LOOP;
        break;
    case ALL_THREE_LOOP:
        /* 三环全开:位置 → 速度 → 电流 */
        motor->motor_settings.close_loop_type = ANGLE_LOOP | SPEED_LOOP | CURRENT_LOOP;
        break;
    default:
        motor->motor_settings.close_loop_type = OPEN_LOOP;
        break;
    }

    /*
     * 4. 清零全部 PID 的历史量,避免旧量纲的积分残留。
     *    注意不能调用 PIDInit():它要求传入完整配置结构体,
     *    会把 Kp/Ki/Kd 等整定参数一并重置,导致换环后电机整定值丢失。
     *    这里只清"记忆类"字段,保留整定参数。
     */
#define MB_CLEAR_PID_STATE(p)      \
    do                            \
    {                             \
        (p)->Measure = 0.0f;      \
        (p)->Last_Measure = 0.0f; \
        (p)->Err = 0.0f;          \
        (p)->Last_Err = 0.0f;     \
        (p)->Last_ITerm = 0.0f;   \
        (p)->Pout = 0.0f;         \
        (p)->Iout = 0.0f;         \
        (p)->Dout = 0.0f;         \
        (p)->ITerm = 0.0f;        \
        (p)->Output = 0.0f;       \
        (p)->Last_Output = 0.0f;  \
        (p)->Last_Dout = 0.0f;    \
        (p)->Ref = 0.0f;          \
    } while (0)

    MB_CLEAR_PID_STATE(&motor->motor_controller.angle_PID);
    MB_CLEAR_PID_STATE(&motor->motor_controller.speed_PID);
    MB_CLEAR_PID_STATE(&motor->motor_controller.current_PID);

#undef MB_CLEAR_PID_STATE

    /* 5. 参考值归零,避免切换后立刻以旧参考值驱动 */
    motor->motor_controller.pid_ref = 0.0f;

    LOGINFO("[dji_motor] loop switched to %d (close=%d), motor stopped, PID cleared",
            (int)loop, (int)motor->motor_settings.close_loop_type);
}

// 设置参考值
void DJIMotorSetRef(DJIMotorInstance *motor, float ref)
{
    motor->motor_controller.pid_ref = ref;
}

// 为所有电机实例计算三环PID,发送控制报文
void DJIMotorControl()
{
    // 直接保存一次指针引用从而减小访存的开销,同样可以提高可读性
    uint8_t group, num; // 电机组号和组内编号
    int16_t set;        // 电机控制CAN发送设定值
    DJIMotorInstance *motor;
    Motor_Control_Setting_s *motor_setting; // 电机控制参数
    Motor_Controller_s *motor_controller;   // 电机控制器
    DJI_Motor_Measure_s *measure;           // 电机测量值
    float pid_measure, pid_ref;             // 电机PID测量值和设定值

    // 遍历所有电机实例,进行串级PID的计算并设置发送报文的值
    for (size_t i = 0; i < idx; ++i)
    { // 减小访存开销,先保存指针引用
        motor = dji_motor_instance[i];
        group = motor->sender_group;
        num = motor->message_num;
        if (motor->stop_flag == MOTOR_STOP)
        {
            memset(sender_assignment[group].tx_buff + 2 * num, 0, sizeof(uint16_t));
            continue; /* No PID integration or history updates while stopped. */
        }
        motor_setting = &motor->motor_settings;
        motor_controller = &motor->motor_controller;
        measure = &motor->measure;
        if ((motor_setting->outer_loop_type & ANGLE_LOOP) && (!motor->daemon || !DaemonIsOnline(motor->daemon)))
        {
            DJIMotorResetController(motor);
            memset(sender_assignment[group].tx_buff + 2 * num, 0, sizeof(uint16_t));
            continue;
        }
        pid_ref = motor_controller->pid_ref; // 保存设定值,防止motor_controller->pid_ref在计算过程中被修改
        if (motor_setting->motor_reverse_flag == MOTOR_DIRECTION_REVERSE)
            pid_ref *= -1; // 设置反转

        // pid_ref会顺次通过被启用的闭环充当数据的载体
        // 计算位置环,只有启用位置环且外层闭环为位置时会计算速度环输出
        if ((motor_setting->close_loop_type & ANGLE_LOOP) && (motor_setting->outer_loop_type & ANGLE_LOOP))
        {
            if (motor_setting->angle_feedback_source == OTHER_FEED)
                pid_measure = *motor_controller->other_angle_feedback_ptr;
            else
                pid_measure = measure->total_angle; // MOTOR_FEED,对total angle闭环,防止在边界处出现突跃
            // 更新pid_ref进入下一个环
            pid_ref = PIDCalculate(&motor_controller->angle_PID, pid_measure, pid_ref);
        }

        // 计算速度环,(外层闭环为速度或位置)且(启用速度环)时会计算速度环
        if ((motor_setting->close_loop_type & SPEED_LOOP) && (motor_setting->outer_loop_type & (ANGLE_LOOP | SPEED_LOOP)))
        {
            if (motor_setting->feedforward_flag & SPEED_FEEDFORWARD)
                pid_ref += *motor_controller->speed_feedforward_ptr;

            if (motor_setting->speed_feedback_source == OTHER_FEED)
                pid_measure = *motor_controller->other_speed_feedback_ptr;
            else // MOTOR_FEED
                pid_measure = measure->speed_aps;
            // 更新pid_ref进入下一个环
            pid_ref = PIDCalculate(&motor_controller->speed_PID, pid_measure, pid_ref);
        }

        // 计算电流环,目前只要启用了电流环就计算,不管外层闭环是什么,并且电流只有电机自身传感器的反馈
        if (motor_setting->feedforward_flag & CURRENT_FEEDFORWARD)
            pid_ref += *motor_controller->current_feedforward_ptr;
        if (motor_setting->close_loop_type & CURRENT_LOOP)
        {
            pid_ref = PIDCalculate(&motor_controller->current_PID, measure->real_current, pid_ref);
        }

        if (motor_setting->feedback_reverse_flag == FEEDBACK_DIRECTION_REVERSE)
            pid_ref *= -1;

        // 获取最终输出
        set = (int16_t)pid_ref;

        // 分组填入发送数据
        group = motor->sender_group;
        num = motor->message_num;
        sender_assignment[group].tx_buff[2 * num] = (uint8_t)(set >> 8);         // 低八位
        sender_assignment[group].tx_buff[2 * num + 1] = (uint8_t)(set & 0x00ff); // 高八位

        // 若该电机处于停止状态,直接将buff置零
        if (motor->stop_flag == MOTOR_STOP)
            memset(sender_assignment[group].tx_buff + 2 * num, 0, sizeof(uint16_t));
    }

    // 遍历flag,检查是否要发送这一帧报文
    for (size_t i = 0; i < 6; ++i)
    {
        if (sender_enable_flag[i])
        {
            CANTransmit(&sender_assignment[i], 1);
        }
    }
}
