/**
 * @file motor_bench_app.h
 * @brief 电机测试台应用层:把"实验室这块板上挂了哪些电机"这张配置表
 *        翻译成 DJIMotorInit/DMMotorInit 的调用,并登记给 motor_bench 模块。
 *
 * @note 为什么电机必须在固件里预先登记:
 *        CAN 过滤器(CAN1 用 0~13,共 14 个)、CANInstance(CAN_MX_REGISTER_CNT=16)、
 *        以及各串口的 RX DMA 都是有限且在启动期分配的资源,运行期无法凭空造出
 *        一颗新电机。因此"换电机"不是软件动作,而是改这张表后重新烧录一次;
 *        上位机只能在已登记的清单里做选择。
 *
 * @copyright Copyright (c) 2026 HNU YueLu EC all rights reserved
 */
#ifndef MOTOR_BENCH_APP_H
#define MOTOR_BENCH_APP_H

/**
 * @brief 电机测试台初始化:创建电机实例 + 登记清单 + 注册上位机串口
 *
 * @note 在 RobotInit() 中调用;会关闭中断完成初始化后自行恢复
 */
void MotorBenchAppInit(void);

/**
 * @brief 电机测试台周期任务,建议与 MotorControlTask 同频(500Hz)
 */
void MotorBenchAppTask(void);

/**
 * @brief 紧急停止全部电机(供板载按键或外部急停信号调用)
 */
void MotorBenchAppEmergencyStop(void);

#endif // MOTOR_BENCH_APP_H