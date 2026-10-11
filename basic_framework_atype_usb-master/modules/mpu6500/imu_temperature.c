#include  "imu_temperature.h"
#include "bsp_pwm.h"
static PWMInstance *imu_pwm;
void IMU_Temperature_Init(void)
{
    PWM_Init_Config_s imu_config = {
        .htim = &htim3,
        .channel = TIM_CHANNEL_2,
        .period = 0.1,
        .dutyratio = 50,
    };
    imu_pwm = PWMRegister(&imu_config);
}


void IMU_Temperature_Update(float duty_ratio)
{
    PWMSetDutyRatio(imu_pwm, duty_ratio);
}
