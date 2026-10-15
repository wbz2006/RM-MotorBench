#ifndef CTYPE_TEST_CAN_H
#define CTYPE_TEST_CAN_H
#include <stdint.h>

typedef struct {
    uint32_t Prescaler, Mode, SyncJumpWidth, TimeSeg1, TimeSeg2;
    uint32_t TimeTriggeredMode, AutoBusOff, AutoWakeUp, AutoRetransmission;
    uint32_t ReceiveFifoLocked, TransmitFifoPriority;
} CAN_InitTypeDef;
typedef struct { void *Instance; CAN_InitTypeDef Init; } CAN_HandleTypeDef;
typedef struct { uint32_t Pin, Mode, Pull, Speed, Alternate; } GPIO_InitTypeDef;
typedef struct { uint32_t StdId, ExtId, IDE, RTR, DLC, TransmitGlobalTime; } CAN_TxHeaderTypeDef;
typedef struct { uint32_t StdId, DLC; } CAN_RxHeaderTypeDef;
typedef struct {
    uint32_t FilterIdHigh, FilterIdLow, FilterMaskIdHigh, FilterMaskIdLow;
    uint32_t FilterFIFOAssignment, FilterBank, FilterMode, FilterScale;
    uint32_t FilterActivation, SlaveStartFilterBank;
} CAN_FilterTypeDef;
#define CAN_FILTERMODE_IDLIST 0
#define CAN_FILTERSCALE_16BIT 0
#define CAN_FILTER_DISABLE 0
#define CAN_FILTER_ENABLE 1
#define CAN_RX_FIFO0 0
#define CAN_RX_FIFO1 1
#define CAN_IT_RX_FIFO0_MSG_PENDING 1
#define CAN_IT_RX_FIFO1_MSG_PENDING 2
#define CAN_ID_STD 0
#define CAN_RTR_DATA 0

#define CAN1 ((void *)1)
#define CAN2 ((void *)2)
#define GPIOB ((void *)3)
#define GPIOD ((void *)4)
#define GPIO_PIN_0 (1u << 0)
#define GPIO_PIN_1 (1u << 1)
#define GPIO_PIN_5 (1u << 5)
#define GPIO_PIN_6 (1u << 6)
#define CAN_MODE_NORMAL 0
#define CAN_SJW_1TQ 1
#define CAN_BS1_10TQ 10
#define CAN_BS2_3TQ 3
#define GPIO_MODE_AF_PP 2
#define GPIO_NOPULL 0
#define GPIO_SPEED_FREQ_VERY_HIGH 3
#define GPIO_AF9_CAN1 9
#define GPIO_AF9_CAN2 9
#define CAN1_RX0_IRQn 20
#define CAN1_RX1_IRQn 21
#define CAN2_RX0_IRQn 63
#define CAN2_RX1_IRQn 64
#define DISABLE 0
#define ENABLE 1
#define HAL_OK 0
#define __HAL_RCC_CAN1_CLK_ENABLE() ((void)0)
#define __HAL_RCC_CAN2_CLK_ENABLE() ((void)0)
#define __HAL_RCC_CAN1_CLK_DISABLE() ((void)0)
#define __HAL_RCC_CAN2_CLK_DISABLE() ((void)0)
#define __HAL_RCC_GPIOD_CLK_ENABLE() ((void)0)
#define __HAL_RCC_GPIOB_CLK_ENABLE() ((void)0)

extern CAN_HandleTypeDef hcan1, hcan2;
void MX_CAN1_Init(void);
void MX_CAN2_Init(void);
void HAL_CAN_MspInit(CAN_HandleTypeDef *handle);
int HAL_CAN_Init(CAN_HandleTypeDef *handle);
void HAL_GPIO_Init(void *port, GPIO_InitTypeDef *config);
void HAL_GPIO_DeInit(void *port, uint32_t pins);
void HAL_NVIC_SetPriority(int irq, uint32_t priority, uint32_t subpriority);
void HAL_NVIC_EnableIRQ(int irq);
void HAL_NVIC_DisableIRQ(int irq);
void Error_Handler(void);
int HAL_CAN_ConfigFilter(CAN_HandleTypeDef *handle, CAN_FilterTypeDef *filter);
int HAL_CAN_Start(CAN_HandleTypeDef *handle);
int HAL_CAN_ActivateNotification(CAN_HandleTypeDef *handle, uint32_t notification);
uint32_t HAL_CAN_GetTxMailboxesFreeLevel(CAN_HandleTypeDef *handle);
int HAL_CAN_AddTxMessage(CAN_HandleTypeDef *handle, CAN_TxHeaderTypeDef *header, uint8_t *bytes, uint32_t *mailbox);
int HAL_CAN_GetRxMessage(CAN_HandleTypeDef *handle, uint32_t fifo, CAN_RxHeaderTypeDef *header, uint8_t *bytes);
#endif
