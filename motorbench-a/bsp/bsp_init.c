#include "bsp_init.h"
#include "bsp_log.h"
#include "bsp_dwt.h"
#include "tim.h"
// CAN和串口会在注册实例的时候自动初始化,不注册不初始化
void BSPInit()
{
    DWT_Init(168);
    BSPLogInit();
}