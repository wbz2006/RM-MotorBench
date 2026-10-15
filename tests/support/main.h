#ifndef CTYPE_TEST_MAIN_H
#define CTYPE_TEST_MAIN_H
#include <stdint.h>
#include <stddef.h>
typedef struct { uint32_t gState; } UART_HandleTypeDef;
uint32_t HAL_GetTick(void);
#define HAL_UART_STATE_READY 0u
#define __get_PRIMASK() 0u
#define __disable_irq() ((void)0)
#define __enable_irq() ((void)0)
#define __set_PRIMASK(mask) ((void)(mask))
#define __WFI() ((void)0)
#endif
