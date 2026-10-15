#ifndef TEST_USART_H
#define TEST_USART_H
#include "main.h"
typedef struct { uint8_t recv_buff[256], recv_buff_size; uint16_t recv_len;
    UART_HandleTypeDef *usart_handle; void (*module_callback)(void); } USARTInstance;
typedef struct { uint8_t recv_buff_size; UART_HandleTypeDef *usart_handle;
    void (*module_callback)(void); } USART_Init_Config_s;
#define USART_TRANSFER_DMA 3
USARTInstance *USARTRegister(USART_Init_Config_s *config);
void USARTSend(USARTInstance *instance, uint8_t *bytes, uint16_t length, int mode);
#endif
