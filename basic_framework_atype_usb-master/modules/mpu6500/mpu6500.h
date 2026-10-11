#ifndef _MPU6500_H_
#define _MPU6500_H_
#include "bsp_dwt.h"
#define MPU_DELAY(x) DWT_Delay_ms(x)

#define GxOFFSET 0.00744561851f
#define GyOFFSET -0.00123410253f
#define GzOFFSET -0.00820527598f
#define gNORM 9.373390995f
typedef struct
{
    float Gyro[3];  // 角速度
    float Accel[3]; // 加速度
    // 还需要增加角速度数据
    float Roll;
    float Pitch;
    float Yaw;
    float YawTotalAngle;
} attitude_t; // 最终解算得到的角度,以及yaw转动的总角度(方便多圈控制)
typedef struct
{
	float Accel[3];

    float Gyro[3];

    float TempWhenCali;
    float Temperature;

    float AccelScale;
    float GyroOffset[3];

    float gNorm;
} mpu_data_t;

typedef struct
{
	float q[4]; // 四元数估计值

    float MotionAccel_b[3]; // 机体坐标加速度
    float MotionAccel_n[3]; // 绝对系加速度

    float AccelLPF; // 加速度低通滤波系数

    // bodyframe在绝对系的向量表示
    float xn[3];
    float yn[3];
    float zn[3];

    // 加速度在机体系和XY两轴的夹角
    // float atanxz;
    // float atanyz;

    // IMU量测值
    float Gyro[3];  // 角速度
    float Accel[3]; // 加速度
    // 位姿
    float Roll;
    float Pitch;
    float Yaw;
    float YawTotalAngle;

    uint8_t init;
} INS_t;
/* 用于修正安装误差的参数 */
typedef struct
{
    uint8_t flag;

    float scale[3];

    float Yaw;
    float Pitch;
    float Roll;
} IMU_Param_t;
attitude_t *INS_Init(void);

void INS_Task(void);

#endif 
