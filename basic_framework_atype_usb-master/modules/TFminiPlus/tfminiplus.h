#ifndef TFMINIPLUS_H
#define TFMINIPLUS_H

#include "bsp_usart.h"

#define TFMINIPLUS_FRAME_HEAD_1 0x59
#define TFMINIPLUS_FRAME_HEAD_2 0x59
#define TFMINIPLUS_RECV_SIZE 9u

typedef struct
{
    uint16_t distance;
    uint16_t strength;
    float temperature;
}TFminiPlus_Recv_s;

TFminiPlus_Recv_s *TFminiPlusInit(UART_HandleTypeDef *_handle);


#endif // !TFMINIPLUS_H