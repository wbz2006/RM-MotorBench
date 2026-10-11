#include "tfminiplus.h"
#include "daemon.h"

static TFminiPlus_Recv_s tfminiplus_data;
static USARTInstance *tfminiplus_usart_instance;
static DaemonInstance *openmv_daemon_instance;

static void DecodeTFminiPlus()
{   
    DaemonReload(openmv_daemon_instance);
    uint8_t check_sum = 0;
    if( tfminiplus_usart_instance->recv_buff[0] == TFMINIPLUS_FRAME_HEAD_1 && 
        tfminiplus_usart_instance->recv_buff[1] == TFMINIPLUS_FRAME_HEAD_2)
    {
        for (uint8_t i = 0; i < TFMINIPLUS_RECV_SIZE-1; i++)
        {
            check_sum += tfminiplus_usart_instance->recv_buff[i];        
        }
        if(check_sum != tfminiplus_usart_instance->recv_buff[TFMINIPLUS_RECV_SIZE-1])
            return;
        tfminiplus_data.distance = (tfminiplus_usart_instance->recv_buff[2] |(uint16_t)tfminiplus_usart_instance->recv_buff[3]<<8);  
        tfminiplus_data.strength = (tfminiplus_usart_instance->recv_buff[4] |(uint16_t)tfminiplus_usart_instance->recv_buff[5]<<8);
        tfminiplus_data.temperature = (tfminiplus_usart_instance->recv_buff[6] |(uint16_t)tfminiplus_usart_instance->recv_buff[7]<<8)/8-256;      
    }
    else
    {
        return;
    }
}

static void TFminiPlusOffineCallback()
{
    USARTServiceInit(tfminiplus_usart_instance);
}

TFminiPlus_Recv_s *TFminiPlusInit(UART_HandleTypeDef *_handle)
{
    USART_Init_Config_s conf;
    conf.module_callback = DecodeTFminiPlus;
    conf.recv_buff_size = TFMINIPLUS_RECV_SIZE;
    conf.usart_handle = _handle;
    tfminiplus_usart_instance = USARTRegister(&conf);

    Daemon_Init_Config_s daemon_conf = {
        .callback = TFminiPlusOffineCallback,
        .owner_id = tfminiplus_usart_instance,
        .reload_count = 10,
    };
    openmv_daemon_instance = DaemonRegister(&daemon_conf);

    return &tfminiplus_data;
}
