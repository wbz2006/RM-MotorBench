#include "can.h"
#include <string.h>

HAL_StatusTypeDef HAL_CAN_Start(CAN_HandleTypeDef *handle)
{
    if (handle->State == HAL_FDCAN_STATE_BUSY) return HAL_OK;
    /* Reject remote/unregistered traffic; dynamic registrations add exact IDs. */
    if (HAL_FDCAN_ConfigGlobalFilter(handle, FDCAN_REJECT, FDCAN_REJECT,
                                     FDCAN_REJECT_REMOTE, FDCAN_REJECT_REMOTE) != HAL_OK)
        return HAL_ERROR;
    for (uint32_t slot = 0; slot < handle->Init.StdFiltersNbr; ++slot)
    {
        FDCAN_FilterTypeDef filter = {0};
        filter.IdType = FDCAN_STANDARD_ID;
        filter.FilterIndex = slot;
        filter.FilterType = FDCAN_FILTER_DUAL;
        filter.FilterConfig = FDCAN_FILTER_DISABLE;
        if (HAL_FDCAN_ConfigFilter(handle, &filter) != HAL_OK) return HAL_ERROR;
    }
    return HAL_FDCAN_Start(handle);
}

HAL_StatusTypeDef HAL_CAN_ActivateNotification(CAN_HandleTypeDef *handle, uint32_t flags)
{
    return HAL_FDCAN_ActivateNotification(handle, flags | FDCAN_IT_BUS_OFF, 0);
}

HAL_StatusTypeDef HAL_CAN_ConfigFilter(CAN_HandleTypeDef *handle, CAN_FilterTypeDef *legacy)
{
    FDCAN_FilterTypeDef filter = {0};
    filter.IdType = FDCAN_STANDARD_ID;
    /* The shared registry uses banks 0..13 / 14..27; H7 owns separate pools. */
    uint32_t base = handle == &hcan1 ? 0u : 14u;
    if (legacy->FilterBank < base || legacy->FilterBank - base >= handle->Init.StdFiltersNbr)
        return HAL_ERROR;
    filter.FilterIndex = legacy->FilterBank - base;
    filter.FilterType = FDCAN_FILTER_DUAL;
    filter.FilterConfig = !legacy->FilterActivation ? FDCAN_FILTER_DISABLE :
        legacy->FilterFIFOAssignment == CAN_RX_FIFO0 ? FDCAN_FILTER_TO_RXFIFO0 : FDCAN_FILTER_TO_RXFIFO1;
    filter.FilterID1 = filter.FilterID2 = (legacy->FilterIdLow >> 5) & 0x7ffu;
    return HAL_FDCAN_ConfigFilter(handle, &filter);
}

uint32_t HAL_CAN_GetTxMailboxesFreeLevel(CAN_HandleTypeDef *handle)
{
    return HAL_FDCAN_GetTxFifoFreeLevel(handle);
}
uint32_t HAL_CAN_IsTxMessagePending(CAN_HandleTypeDef *handle, uint32_t mailbox)
{
    return HAL_FDCAN_IsTxBufferMessagePending(handle, mailbox);
}
HAL_StatusTypeDef HAL_CAN_AbortTxRequest(CAN_HandleTypeDef *handle, uint32_t mailbox)
{
    return HAL_FDCAN_AbortTxRequest(handle, mailbox);
}
HAL_StatusTypeDef HAL_CAN_AddTxMessage(CAN_HandleTypeDef *handle, CAN_TxHeaderTypeDef *legacy, uint8_t *data, uint32_t *mailbox)
{
    if (legacy->IDE != CAN_ID_STD || legacy->RTR != CAN_RTR_DATA || legacy->StdId > 0x7ffu || legacy->DLC > 8)
        return HAL_ERROR;
    FDCAN_TxHeaderTypeDef header = {0};
    header.Identifier = legacy->StdId;
    header.IdType = FDCAN_STANDARD_ID;
    header.TxFrameType = FDCAN_DATA_FRAME;
    header.DataLength = legacy->DLC << 16;
    header.ErrorStateIndicator = FDCAN_ESI_ACTIVE;
    header.BitRateSwitch = FDCAN_BRS_OFF;
    header.FDFormat = FDCAN_CLASSIC_CAN;
    header.TxEventFifoControl = FDCAN_NO_TX_EVENTS;
    HAL_StatusTypeDef result = HAL_FDCAN_AddMessageToTxFifoQ(handle, &header, data);
    if (result == HAL_OK) *mailbox = HAL_FDCAN_GetLatestTxFifoQRequestBuffer(handle);
    return result;
}
HAL_StatusTypeDef HAL_CAN_GetRxMessage(CAN_HandleTypeDef *handle, uint32_t fifo, CAN_RxHeaderTypeDef *legacy, uint8_t *data)
{
    FDCAN_RxHeaderTypeDef header = {0};
    uint8_t bytes[64];
    memset(legacy, 0, sizeof(*legacy));
    HAL_StatusTypeDef result = HAL_FDCAN_GetRxMessage(handle, fifo, &header, bytes);
    if (result != HAL_OK || header.IdType != FDCAN_STANDARD_ID || header.RxFrameType != FDCAN_DATA_FRAME ||
        header.FDFormat != FDCAN_CLASSIC_CAN || header.DataLength > FDCAN_DLC_BYTES_8)
    {
        legacy->StdId = 0xffffffffu; /* No registered receiver can match a failed/invalid read. */
        return HAL_ERROR;
    }
    legacy->StdId = header.Identifier;
    legacy->DLC = header.DataLength >> 16;
    memcpy(data, bytes, legacy->DLC);
    return HAL_OK;
}

void HAL_FDCAN_RxFifo0Callback(FDCAN_HandleTypeDef *handle, uint32_t flags)
{
    if (flags & FDCAN_IT_RX_FIFO0_NEW_MESSAGE)
    {
        /* A failed HAL read must not trap the CPU inside the interrupt. */
        uint32_t remaining = HAL_FDCAN_GetRxFifoFillLevel(handle, FDCAN_RX_FIFO0);
        while (remaining--)
            HAL_CAN_RxFifo0MsgPendingCallback(handle);
    }
}
void HAL_FDCAN_RxFifo1Callback(FDCAN_HandleTypeDef *handle, uint32_t flags)
{
    if (flags & FDCAN_IT_RX_FIFO1_NEW_MESSAGE)
    {
        uint32_t remaining = HAL_FDCAN_GetRxFifoFillLevel(handle, FDCAN_RX_FIFO1);
        while (remaining--)
            HAL_CAN_RxFifo1MsgPendingCallback(handle);
    }
}

void HAL_FDCAN_ErrorStatusCallback(FDCAN_HandleTypeDef *handle, uint32_t flags)
{
    if ((flags & FDCAN_IT_BUS_OFF) && (handle->Instance->PSR & FDCAN_PSR_BO))
    {
        /* H7 has no bxCAN automatic bus-off recovery. Discard old commands,
         * then request the controller's standard bus recovery sequence. */
        HAL_FDCAN_AbortTxRequest(handle, FDCAN_TX_BUFFER0 | FDCAN_TX_BUFFER1 | FDCAN_TX_BUFFER2);
        CLEAR_BIT(handle->Instance->CCCR, FDCAN_CCCR_INIT);
    }
}
