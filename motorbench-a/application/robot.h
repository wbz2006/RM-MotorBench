#ifndef ROBOT_H
#define ROBOT_H

/* Motor bench entry points. Whole-robot applications remain in the old project. */

/**
 * @brief 机器人初始化,请在开启rtos之前调用.这也是唯一需要放入main函数的函数
 * 
 */
void RobotInit();

/**
 * @brief 测试台任务入口。当前由 MotorControlTask 直接调用同一应用，勿重复调度。
 * 
 */
void RobotTask();

#endif
