#ifndef KEY_H
#define KEY_H

#define KEY_CNT 4

#include "stdint.h"
#include "bsp_gpio.h"

typedef enum
{
    PRESS_OFF = 0,
    PRESS_ON,
} Key_State_e;

typedef struct
{
    uint8_t key_cnt;
    Key_State_e key_state;
    GPIOInstance *key_gpio_ins;
} KeyInstance;

typedef struct
{
    GPIO_Init_Config_s key_gpio_config;
} Key_Config_s;

KeyInstance *KeyRegister(Key_Config_s *key_config);

void KeyDetectTask();

#endif // !KEY_H