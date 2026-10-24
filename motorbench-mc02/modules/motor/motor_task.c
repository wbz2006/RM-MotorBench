#include "motor_task.h"
#include "LK9025.h"
#include "HT04.h"
#include "dji_motor.h"
#include "dmmotor.h"
#include "step_motor.h"
#include "servo_motor.h"
#include "power_control.h"
/*
 * 必须包含 robot_def.h:MOTOR_BENCH_APP / USB_PROBE_ENABLED 都定义在这里。
 * 若不包含,本文件里的条件编译会静默全部为假 —— 表现为
 * "改了开关却完全没效果",很难察觉。
 */
#include "robot_def.h"

#include "SEGGER_RTT.h"

#if defined(MOTOR_BENCH_APP)
#include "motor_bench_app.h"
#endif

void MotorControlTask()
{
    CANServiceTask();
    // static uint8_t cnt = 0; 设定不同电机的任务频率
    // if(cnt%5==0) //200hz
    // if(cnt%10==0) //100hz
    DJIMotorControl();
    DMMotorControl();
    PowerControl();
    /* 如果有对应的电机则取消注释,可以加入条件编译或者register对应的idx判断是否注册了电机 */
    LKMotorControl();

    // legacy support
    // 由于ht04电机的反馈方式为接收到一帧消息后立刻回传,以此方式连续发送可能导致总线拥塞
    // 为了保证高频率控制,HTMotor中提供了以任务方式启动控制的接口,可通过宏定义切换
    // HTMotorControl();
    // 将所有的CAN设备集中在一处发送,最高反馈频率仅能达到500Hz,为了更好的控制效果,应使用新的HTMotorControlInit()接口

    // StepMotorControl();

#if defined(MOTOR_BENCH_APP)
    /* 电机测试台模式:上报遥测(内部已节流至约 50Hz) */
    MotorBenchAppTask();
#endif

/*
 * 【运行期心跳】每约 20 秒从 500Hz 任务打一个点。
 *
 * @attention 频率必须很低。RTT 上行缓冲只有 1024 字节,
 *   而遥测 50Hz + 心跳应答本身就持续产生日志 ——
 *   曾经每 2 秒打一行,几秒就写满缓冲,把 [add]/[link] 等关键日志挤掉,
 *   表现为"日志突然消失",极易被误判为程序卡死。
 *   20 秒一次足以证明调度器在跑,又几乎不占带宽。
 *
 * @note 若需要更频繁的诊断,临时改小 5000 即可,别忘了同时减小其它日志。
 */
static uint16_t probe_cnt = 0;
if (++probe_cnt >= 10000)
{
    probe_cnt = 0;
    SEGGER_RTT_WriteString(0, "[P] motor task alive\r\n");
}
}
