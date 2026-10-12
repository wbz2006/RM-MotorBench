#include "bsp_init.h"
#include "robot.h"
#include "robot_def.h"
#include "motor_bench_app.h"

#if defined(MOTOR_BENCH_APP)
/* 电机测试台模式:只初始化测试台,不初始化底盘/云台/发射 */
#else

#if defined(ONE_BOARD) || defined(GIMBAL_BOARD)
#include "gimbal.h"
#include "shoot.h"
#include "robot_cmd.h"
#endif

#if defined(ONE_BOARD) || defined(CHASSIS_BOARD)
#include "chassis.h"
#endif

#endif /* MOTOR_BENCH_APP */

void RobotInit()
{
    // 关闭中断,防止在初始化过程中发生中断
    // 请不要在初始化过程中使用中断和延时函数！
    // 若必须,则只允许使用DWT_Delay()
    __disable_irq();

    BSPInit();

#if defined(MOTOR_BENCH_APP)

    MotorBenchAppInit();

#else

#if defined(ONE_BOARD) || defined(GIMBAL_BOARD)
    RobotCMDInit();
    GimbalInit();
    ShootInit();
#endif

#if defined(ONE_BOARD) || defined(CHASSIS_BOARD)
    ChassisInit();
#endif

#endif /* MOTOR_BENCH_APP */

    // 初始化完成,开启中断
    __enable_irq();
}

void RobotTask()
{
#if defined(MOTOR_BENCH_APP)

    MotorBenchAppTask();

#else

#if defined(ONE_BOARD) || defined(GIMBAL_BOARD)
    RobotCMDTask();
    GimbalTask();
    ShootTask();
#endif

#if defined(ONE_BOARD) || defined(CHASSIS_BOARD)
    ChassisTask();
#endif

#endif /* MOTOR_BENCH_APP */
}