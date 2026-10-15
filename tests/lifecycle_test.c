#include "bsp_can.h"
#include "dji_motor.h"
#include "dmmotor.h"
#include "daemon.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

CAN_HandleTypeDef hcan1, hcan2;
static unsigned transmissions;
static CAN_FilterTypeDef filters[28];
static uint8_t last_bytes[8];

int HAL_CAN_ConfigFilter(CAN_HandleTypeDef *handle, CAN_FilterTypeDef *filter) {
    (void)handle; assert(filter->SlaveStartFilterBank == 14);
    filters[filter->FilterBank] = *filter; return HAL_OK;
}
int HAL_CAN_Start(CAN_HandleTypeDef *handle) { (void)handle; return HAL_OK; }
int HAL_CAN_ActivateNotification(CAN_HandleTypeDef *handle, uint32_t notification) {
    (void)handle; (void)notification; return HAL_OK;
}
uint32_t HAL_CAN_GetTxMailboxesFreeLevel(CAN_HandleTypeDef *handle) { (void)handle; return 3; }
int HAL_CAN_AddTxMessage(CAN_HandleTypeDef *handle, CAN_TxHeaderTypeDef *header, uint8_t *bytes, uint32_t *mailbox) {
    (void)handle; (void)header; (void)mailbox; memcpy(last_bytes, bytes, 8); transmissions++; return HAL_OK;
}
int HAL_CAN_GetRxMessage(CAN_HandleTypeDef *handle, uint32_t fifo, CAN_RxHeaderTypeDef *header, uint8_t *bytes) {
    (void)handle; (void)fifo; memset(header, 0, sizeof(*header)); memset(bytes, 0, 8); return HAL_OK;
}
float DWT_GetTimeline_ms(void) { static float time; return time++; }
float DWT_GetDeltaT(uint32_t *previous) { (void)previous; return 0.002f; }
void DWT_Delay(float seconds) { (void)seconds; }
void PIDInit(PIDInstance *pid, PID_Init_Config_s *config) { memset(pid, 0, sizeof(*pid)); pid->Kp = config->Kp; }
float PIDCalculate(PIDInstance *pid, float measure, float ref) { (void)pid; return ref - measure; }

int lifecycle_suite(void) {
    CAN_Init_Config_s conf = {.can_handle = &hcan1, .tx_id = 1, .rx_id = 0x201};
    CANInstance *first = CANRegister(&conf);
    conf.rx_id++; CANInstance *second = CANRegister(&conf);
    conf.rx_id++; CANInstance *third = CANRegister(&conf);
    assert(first && second && third);
    unsigned live_bank = third->filter_bank;
    uint32_t live_id = filters[live_bank].FilterIdLow;
    assert(CANUnregister(first) == 0);
    conf.rx_id++; CANInstance *replacement = CANRegister(&conf);
    assert(replacement && replacement->filter_bank != live_bank);
    assert(filters[live_bank].FilterIdLow == live_id);
    CANUnregister(second); CANUnregister(third); CANUnregister(replacement);
    assert(CANGetFilterFree(&hcan1) == 14);
#ifndef LIFECYCLE_CAN_ONLY
    for (unsigned round = 0; round < 100; ++round) {
        Motor_Init_Config_s cfg = {0}; cfg.motor_type = M3508;
        cfg.can_init_config.can_handle = &hcan1; cfg.can_init_config.tx_id = 1;
        DJIMotorInstance *motor = DJIMotorInit(&cfg);
        assert(motor); DJIMotorDestroy(motor);
        transmissions = 0; DJIMotorControl(); DaemonTask();
        assert(transmissions == 0 && CANGetFilterFree(&hcan1) == 14);
        cfg.can_init_config.rx_id = 0; cfg.can_init_config.tx_id = 1;
        DMMotorInstance *dm = DMMotorInit(&cfg);
        assert(dm);
        dm->motor_settings.close_loop_type = SPEED_LOOP;
        dm->measure.velocity = 2;
        DMMotorSetRef(dm, 2); DMMotorEnable(dm); DMMotorControl();
        assert((((last_bytes[6] & 15) << 8) | last_bytes[7]) == 2047);
        DMMotorDestroy(dm);
        transmissions = 0; DMMotorControl();
        assert(transmissions == 0 && CANGetFilterFree(&hcan1) == 14);
    }
    Motor_Init_Config_s invalid = {0}; invalid.motor_type = M3508;
    invalid.can_init_config.can_handle = &hcan1; invalid.can_init_config.tx_id = 9;
    assert(DJIMotorInit(&invalid) == NULL);
#endif
    puts("PASS: filter reuse and 100 motor create/destroy cycles");
    return 0;
}
#ifndef MB_BEHAVIOR_LIBRARY
int main(void) { return lifecycle_suite(); }
#endif
