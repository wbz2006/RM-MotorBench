#include "robot.h"
#include "bsp_init.h"
#include "main.h"
#include "motor_bench_app.h"

void RobotInit(void)
{
    __disable_irq();
    BSPInit();
    MotorBenchAppInit();
    __enable_irq();
}

void RobotTask(void)
{
    MotorBenchAppTask();
}
