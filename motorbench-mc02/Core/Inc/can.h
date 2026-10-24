#pragma once
/* Legacy motor API over H723 classic FDCAN. No bxCAN registers are used. */
#include "fdcan.h"

typedef FDCAN_HandleTypeDef CAN_HandleTypeDef;
#define hcan1 hfdcan1
#define hcan2 hfdcan2
typedef struct { uint32_t StdId, ExtId, IDE, RTR, DLC, TransmitGlobalTime; } CAN_TxHeaderTypeDef;
typedef struct { uint32_t StdId, ExtId, IDE, RTR, DLC; } CAN_RxHeaderTypeDef;
typedef struct {
    uint32_t FilterIdHigh, FilterIdLow, FilterMaskIdHigh, FilterMaskIdLow;
    uint32_t FilterFIFOAssignment, FilterBank, FilterMode, FilterScale, FilterActivation, SlaveStartFilterBank;
} CAN_FilterTypeDef;
#define CAN_ID_STD 0u
#define CAN_RTR_DATA 0u
#define CAN_RX_FIFO0 FDCAN_RX_FIFO0
#define CAN_RX_FIFO1 FDCAN_RX_FIFO1
#define CAN_FILTERMODE_IDLIST 0u
#define CAN_FILTERSCALE_16BIT 0u
#define CAN_FILTER_DISABLE 0u
#define CAN_FILTER_ENABLE 1u
#define CAN_IT_RX_FIFO0_MSG_PENDING FDCAN_IT_RX_FIFO0_NEW_MESSAGE
#define CAN_IT_RX_FIFO1_MSG_PENDING FDCAN_IT_RX_FIFO1_NEW_MESSAGE
#define CAN_TX_MAILBOX0 1u

HAL_StatusTypeDef HAL_CAN_Start(CAN_HandleTypeDef *handle);
HAL_StatusTypeDef HAL_CAN_ActivateNotification(CAN_HandleTypeDef *handle, uint32_t flags);
HAL_StatusTypeDef HAL_CAN_ConfigFilter(CAN_HandleTypeDef *handle, CAN_FilterTypeDef *filter);
uint32_t HAL_CAN_GetTxMailboxesFreeLevel(CAN_HandleTypeDef *handle);
uint32_t HAL_CAN_IsTxMessagePending(CAN_HandleTypeDef *handle, uint32_t mailbox);
HAL_StatusTypeDef HAL_CAN_AbortTxRequest(CAN_HandleTypeDef *handle, uint32_t mailbox);
HAL_StatusTypeDef HAL_CAN_AddTxMessage(CAN_HandleTypeDef *handle, CAN_TxHeaderTypeDef *header, uint8_t *data, uint32_t *mailbox);
HAL_StatusTypeDef HAL_CAN_GetRxMessage(CAN_HandleTypeDef *handle, uint32_t fifo, CAN_RxHeaderTypeDef *header, uint8_t *data);
void HAL_CAN_RxFifo0MsgPendingCallback(CAN_HandleTypeDef *handle);
void HAL_CAN_RxFifo1MsgPendingCallback(CAN_HandleTypeDef *handle);
