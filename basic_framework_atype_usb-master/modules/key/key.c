#include "key.h"
#include "string.h"
#include "stdlib.h"
#include "bsp_dwt.h"

static KeyInstance *key_instance[KEY_CNT] = {NULL};
static uint8_t idx = 0;

// 按键检测任务
void KeyDetectTask()
{
    KeyInstance *key;

    for(int i = 0; i < KEY_CNT; i++)
    {
        key = key_instance[i];

        if(key == NULL)
            return;

        if(GPIORead(key->key_gpio_ins))
        {
            DWT_Delay_ms(100);
            if(GPIORead(key->key_gpio_ins))
            {
                key->key_state = PRESS_ON;
                continue;
            }
        }
        key->key_state = PRESS_OFF;
    }
}

// 按键中断回调
static void KeyEXITCallback(GPIOInstance *_instance)
{
    KeyInstance *ins = (KeyInstance*)_instance->id;

    KeyDetectTask();
    if(ins->key_state == PRESS_ON)
        ins->key_cnt++;
}

// 按键注册函数
KeyInstance *KeyRegister(Key_Config_s *key_config)
{
    if(idx >= KEY_CNT)    // 超过最大实例数
        while(1)
        ;

    KeyInstance *instance = (KeyInstance*)malloc(sizeof(KeyInstance));
    memset(instance, 0, sizeof(KeyInstance));

    instance->key_cnt = 0;  // 按键计数初始化为0
    instance->key_state = PRESS_OFF;

    key_config->key_gpio_config.gpio_model_callback = KeyEXITCallback;
    key_config->key_gpio_config.id = instance;
    instance->key_gpio_ins = GPIORegister(&key_config->key_gpio_config);

    key_instance[idx++] = instance;
    return instance;
}
