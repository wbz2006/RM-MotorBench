#include "motor_task.h"
#include "motor_bench_app.h"
#include "dji_motor.h"
#include "dmmotor.h"

void MotorControlTask(void)
{
    /* Process commands before output; no second task accesses the bench. */
    MotorBenchAppTask();
    DJIMotorControl();
    DMMotorControl();
}
