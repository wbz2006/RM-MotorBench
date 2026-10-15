#include "robot.h"
#include "main.h"
#include "bsp_init.h"
#include "motor_bench_app.h"

void RobotInit(void)
{
    __disable_irq();
    BSPInit();
    MotorBenchAppInit();
    __enable_irq();
}

/* The bench is serviced exclusively by the motor task. */
void RobotTask(void) {}
