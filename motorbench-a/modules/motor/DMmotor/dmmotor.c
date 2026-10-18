#include "dmmotor.h"
#include "memory.h"
#include "general_def.h"
#include "user_lib.h"
#include "string.h"
#include "stdlib.h"
#include "bsp_log.h"
#include "bsp_dwt.h"
#include "main.h"

static uint8_t idx;
static DMMotorInstance *dm_motor_instance[DM_MOTOR_CNT];

static uint16_t float_to_uint(float x, float x_min, float x_max, uint8_t bits)
{
    float span = x_max - x_min;
    float offset = x_min;
    return (uint16_t)((x - offset) * ((float)((1 << bits) - 1)) / span);
}

static float uint_to_float(int x_int, float x_min, float x_max, int bits)
{
    float span = x_max - x_min;
    float offset = x_min;
    return ((float)x_int) * span / ((float)((1 << bits) - 1)) + offset;
}

static uint8_t DMMotorSetMode(DMMotor_Mode_e cmd, DMMotorInstance *motor)
{
    memset(motor->motor_can_instace->tx_buff, 0xff, 7);
    motor->motor_can_instace->tx_buff[7] = (uint8_t)cmd;
    return CANTransmit(motor->motor_can_instace, 1);
}

static uint8_t DMMotorQueryFeedback(DMMotorInstance *motor)
{
    /* Manufacturer read_motor_ctrl_fbdata: standard 0x7FF, DLC=4,
     * [CAN_ID low, CAN_ID high, 0xCC, 0]. Does not enable or set zero.
     * Source: dmBots/motor-control-routine, User/dm_motor_drv.c. */
    CANInstance query = {0};
    query.can_handle = motor->motor_can_instace->can_handle;
    query.txconf = motor->motor_can_instace->txconf;
    query.txconf.StdId = 0x7ff;
    query.txconf.DLC = 4;
    query.tx_buff[0] = motor->motor_can_instace->tx_id & 0xff;
    query.tx_buff[1] = (motor->motor_can_instace->tx_id >> 8) & 0x07;
    query.tx_buff[2] = 0xcc;
    return CANTransmit(&query, 0);
}

static void DMMotorDecode(CANInstance *motor_can)
{
    if (motor_can->rx_len != 8)
        return;
    uint16_t tmp;
    uint8_t *rxbuff = motor_can->rx_buff;
    DMMotorInstance *motor = (DMMotorInstance *)motor_can->id;
    DM_Motor_Measure_s *measure = &(motor->measure);
    if (motor->daemon)
        DaemonReload(motor->daemon);

    measure->last_position = measure->position;
    tmp = (uint16_t)((rxbuff[1] << 8) | rxbuff[2]);
    measure->position = uint_to_float(tmp, -motor->p_max, motor->p_max, 16);

    tmp = (uint16_t)((rxbuff[3] << 4) | rxbuff[4] >> 4);
    measure->velocity = uint_to_float(tmp, -motor->v_max, motor->v_max, 12);

    tmp = (uint16_t)(((rxbuff[4] & 0x0f) << 8) | rxbuff[5]);
    measure->torque = uint_to_float(tmp, -motor->t_max, motor->t_max, 12);

    measure->T_Mos = (float)rxbuff[6];
    measure->T_Rotor = (float)rxbuff[7];
}

void DMMotorCaliEncoder(DMMotorInstance *motor)
{
    DMMotorSetMode(DM_CMD_ZERO_POSITION, motor);
    DWT_Delay(0.1);
}

DMMotorInstance *DMMotorInit(Motor_Init_Config_s *config)
{
    return DMMotorInitWithModel(config, DM_MODEL_4310);
}

DMMotorInstance *DMMotorInitWithModel(Motor_Init_Config_s *config, DMMotorModel_e model)
{
    if (!config || (model != DM_MODEL_4310 && model != DM_MODEL_8009P))
        return NULL;
    if (idx >= DM_MOTOR_CNT)
        return NULL;
    DMMotorInstance *motor = (DMMotorInstance *)malloc(sizeof(DMMotorInstance));
    if (!motor)
        return NULL;
    memset(motor, 0, sizeof(DMMotorInstance));
    motor->p_max = DM_P_MAX;
    motor->v_max = DM_V_MAX;
    motor->t_max = model == DM_MODEL_8009P ? DM8009P_T_MAX : DM_T_MAX;
    
    motor->motor_settings = config->controller_setting_init_config;
    PIDInit(&motor->current_PID, &config->controller_param_init_config.current_PID);
    PIDInit(&motor->speed_PID, &config->controller_param_init_config.speed_PID);
    PIDInit(&motor->angle_PID, &config->controller_param_init_config.angle_PID);
    motor->other_angle_feedback_ptr = config->controller_param_init_config.other_angle_feedback_ptr;
    motor->other_speed_feedback_ptr = config->controller_param_init_config.other_speed_feedback_ptr;

    config->can_init_config.can_module_callback = DMMotorDecode;
    config->can_init_config.id = motor;
    motor->motor_can_instace = CANRegister(&config->can_init_config);

    /*
     * @attention CANRegister() 在 rx_id 冲突 / 过滤器耗尽 / 实例池满时返回 NULL。
     *   必须在注册守护和加入控制轮询之前检查，避免访问空实例。
     */
    if (motor->motor_can_instace == NULL)
    {
        LOGERROR("[dmmotor] CAN register failed (check rx_id / bus / filter bank)");
        free(motor);
        return NULL;
    }

    Daemon_Init_Config_s daemon_config = {.reload_count = 10}; /* 100ms at 100Hz */
    motor->daemon = DaemonRegister(&daemon_config);
    if (!motor->daemon)
    {
        CANUnregister(motor->motor_can_instace);
        free(motor);
        return NULL;
    }
    /* Discovery/recovery must not energize the motor or rewrite encoder zero. */
    motor->stop_flag = MOTOR_STOP;
    motor->last_disable_ms = HAL_GetTick() - 100u;
    motor->last_query_ms = HAL_GetTick() - 250u;
    dm_motor_instance[idx++] = motor;
    return motor;
}

void DMMotorDestroy(DMMotorInstance *motor)
{
    if (!motor)
        return;
    for (uint8_t i = 0; i < idx; i++)
    {
        if (dm_motor_instance[i] != motor)
            continue;
        DMMotorStop(motor);
        memmove(&dm_motor_instance[i], &dm_motor_instance[i + 1], (idx - i - 1) * sizeof(dm_motor_instance[0]));
        dm_motor_instance[--idx] = NULL;
        CANUnregister(motor->motor_can_instace);
        DaemonUnregister(motor->daemon);
        free(motor);
        return;
    }
}

void DMMotorSetRef(DMMotorInstance *motor, float ref)
{
    motor->pid_ref = ref;
}

void DMMotorEnable(DMMotorInstance *motor)
{
    if (motor->stop_flag == MOTOR_STOP)
    {
        PIDReset(&motor->speed_PID);
        PIDReset(&motor->angle_PID);
        PIDReset(&motor->current_PID);
        DMMotorSetMode(DM_CMD_MOTOR_MODE, motor);
    }
    motor->stop_flag = MOTOR_ENALBED;
}

void DMMotorStop(DMMotorInstance *motor)
{
    if (motor->stop_flag != MOTOR_STOP && DMMotorSetMode(DM_CMD_RESET_MODE, motor))
        motor->last_disable_ms = HAL_GetTick();
    motor->stop_flag = MOTOR_STOP;
    PIDReset(&motor->speed_PID);
    PIDReset(&motor->angle_PID);
    PIDReset(&motor->current_PID);
}

void DMMotorOuterLoop(DMMotorInstance *motor, Closeloop_Type_e type)
{
    DMMotorStop(motor);
    motor->pid_ref = 0;
    motor->motor_settings.outer_loop_type = type;
    motor->motor_settings.close_loop_type = (type & ANGLE_LOOP) ? (ANGLE_LOOP | SPEED_LOOP) : SPEED_LOOP;
}

void DMMotorControl()
{
    float pid_ref, set;
    DMMotorInstance *motor;
    Motor_Control_Setting_s *setting;
    DMMotor_Send_s motor_send_mailbox;

    for (size_t i = 0; i < idx; i++)
    {
        motor = dm_motor_instance[i];
        setting = &motor->motor_settings;
        if (motor->stop_flag != MOTOR_STOP && (!motor->daemon || !DaemonIsOnline(motor->daemon)))
        {
            DMMotorStop(motor);
            motor->pid_ref = 0.0f;
        }
        if (motor->stop_flag == MOTOR_STOP)
        {
            uint32_t now = HAL_GetTick();
            /* Bounded retries keep a reconnected motor stopped, without a
             * 500 Hz disable flood starving peers or USB telemetry. */
            if ((uint32_t)(now - motor->last_disable_ms) >= 100u &&
                DMMotorSetMode(DM_CMD_RESET_MODE, motor))
                motor->last_disable_ms = now;
            uint32_t interval = DaemonIsOnline(motor->daemon) ? 50u : 250u;
            if ((uint32_t)(now - motor->last_query_ms) >= interval && DMMotorQueryFeedback(motor))
                motor->last_query_ms = now;
            continue;
        }

        pid_ref = motor->pid_ref;
        set = pid_ref;

        if (setting->motor_reverse_flag == MOTOR_DIRECTION_REVERSE)
            set *= -1;

        /* Never drive against missing/stale feedback. Reset history as well. */
        if (!motor->daemon || !DaemonIsOnline(motor->daemon))
        {
            set = 0;
            PIDReset(&motor->speed_PID);
            PIDReset(&motor->angle_PID);
        }
        /* MIT torque commands are the inner loop; speed targets are rad/s,
         * matching this driver's feedback and the host's DM unit label. */
        else
        {
            if (setting->outer_loop_type & ANGLE_LOOP)
                set = PIDCalculate(&motor->angle_PID, motor->measure.position * RAD_2_DEGREE, set);
            if (setting->outer_loop_type & (ANGLE_LOOP | SPEED_LOOP))
                set = PIDCalculate(&motor->speed_PID, motor->measure.velocity, set);
        }

        LIMIT_MIN_MAX(set, -motor->t_max, motor->t_max);

        motor_send_mailbox.position_des = float_to_uint(0, -motor->p_max, motor->p_max, 16);
        motor_send_mailbox.velocity_des = float_to_uint(0, -motor->v_max, motor->v_max, 12);
        motor_send_mailbox.torque_des = float_to_uint(set, -motor->t_max, motor->t_max, 12);
        motor_send_mailbox.Kp = 0;
        motor_send_mailbox.Kd = 0;

        motor->motor_can_instace->tx_buff[0] = (uint8_t)(motor_send_mailbox.position_des >> 8);
        motor->motor_can_instace->tx_buff[1] = (uint8_t)(motor_send_mailbox.position_des);
        motor->motor_can_instace->tx_buff[2] = (uint8_t)(motor_send_mailbox.velocity_des >> 4);
        motor->motor_can_instace->tx_buff[3] = (uint8_t)(((motor_send_mailbox.velocity_des & 0xF) << 4) | (motor_send_mailbox.Kp >> 8));
        motor->motor_can_instace->tx_buff[4] = (uint8_t)(motor_send_mailbox.Kp);
        motor->motor_can_instace->tx_buff[5] = (uint8_t)(motor_send_mailbox.Kd >> 4);
        motor->motor_can_instace->tx_buff[6] = (uint8_t)(((motor_send_mailbox.Kd & 0xF) << 4) | (motor_send_mailbox.torque_des >> 8));
        motor->motor_can_instace->tx_buff[7] = (uint8_t)(motor_send_mailbox.torque_des);

        CANTransmit(motor->motor_can_instace, 1);
    }
}
