// Compile the MC02 adapter against the actual H723 HAL headers; fake only the peripheral HAL calls.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../motorbench-mc02/', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fdcan-'));
const env = { ...process.env };
if (process.platform === 'win32') env.PATH = `C:/msys64/mingw64/bin;${env.PATH}`;
try {
  fs.writeFileSync(path.join(tmp, 'test.c'), `
#include <assert.h>
#include <string.h>
#include "can.h"
static FDCAN_GlobalTypeDef registers[2];
FDCAN_HandleTypeDef hfdcan1 = {.Instance=&registers[0], .Init={.StdFiltersNbr=14}};
FDCAN_HandleTypeDef hfdcan2 = {.Instance=&registers[1], .Init={.StdFiltersNbr=14}};
static FDCAN_FilterTypeDef filters[2][14];
static uint32_t filter_writes[2], starts[2], notifications[2], pending[2], aborted[2];
static FDCAN_TxHeaderTypeDef transmitted;
static uint8_t transmitted_data[8];
static uint32_t latest = 4;
static HAL_StatusTypeDef tx_result = HAL_OK, rx_result = HAL_OK;
static FDCAN_RxHeaderTypeDef received;
static uint32_t fifo_count[2], callbacks[2];
static unsigned bus(FDCAN_HandleTypeDef *h) { return h == &hfdcan1 ? 0 : 1; }
HAL_StatusTypeDef HAL_FDCAN_ConfigGlobalFilter(FDCAN_HandleTypeDef *h, uint32_t s, uint32_t e, uint32_t rs, uint32_t re) {
    assert(s==FDCAN_REJECT && e==FDCAN_REJECT && rs==FDCAN_REJECT_REMOTE && re==FDCAN_REJECT_REMOTE); return HAL_OK;
}
HAL_StatusTypeDef HAL_FDCAN_ConfigFilter(FDCAN_HandleTypeDef *h, FDCAN_FilterTypeDef *f) {
    assert(f->FilterIndex<14); filters[bus(h)][f->FilterIndex]=*f; filter_writes[bus(h)]++; return HAL_OK;
}
HAL_StatusTypeDef HAL_FDCAN_Start(FDCAN_HandleTypeDef *h) { starts[bus(h)]++; h->State=HAL_FDCAN_STATE_BUSY; return HAL_OK; }
HAL_StatusTypeDef HAL_FDCAN_ActivateNotification(FDCAN_HandleTypeDef *h, uint32_t flags, uint32_t buffers) {
    assert(buffers==0); notifications[bus(h)] |= flags; return HAL_OK;
}
uint32_t HAL_FDCAN_GetTxFifoFreeLevel(FDCAN_HandleTypeDef *h) { return 2; }
uint32_t HAL_FDCAN_IsTxBufferMessagePending(FDCAN_HandleTypeDef *h, uint32_t mailbox) {
    return (pending[h==&hfdcan1?0:1] & mailbox) != 0;
}
HAL_StatusTypeDef HAL_FDCAN_AbortTxRequest(FDCAN_HandleTypeDef *h, uint32_t mailbox) {
    aborted[bus(h)] |= mailbox; pending[bus(h)] &= ~mailbox; return HAL_OK;
}
HAL_StatusTypeDef HAL_FDCAN_AddMessageToTxFifoQ(FDCAN_HandleTypeDef *h, FDCAN_TxHeaderTypeDef *header, uint8_t *data) {
    transmitted=*header; memcpy(transmitted_data,data,header->DataLength>>16); return tx_result;
}
uint32_t HAL_FDCAN_GetLatestTxFifoQRequestBuffer(FDCAN_HandleTypeDef *h) { return latest; }
HAL_StatusTypeDef HAL_FDCAN_GetRxMessage(FDCAN_HandleTypeDef *h, uint32_t fifo, FDCAN_RxHeaderTypeDef *header, uint8_t *data) {
    unsigned index = fifo == FDCAN_RX_FIFO0 ? 0 : 1;
    if (rx_result==HAL_OK && fifo_count[index]) fifo_count[index]--;
    *header=received;
    // Simulate even a malformed FD packet; caller's eight-byte buffer must survive.
    memset(data,0x5a,received.FDFormat==FDCAN_FD_CAN?64:8); return rx_result;
}
uint32_t HAL_FDCAN_GetRxFifoFillLevel(FDCAN_HandleTypeDef *h, uint32_t fifo) { return fifo_count[fifo == FDCAN_RX_FIFO0 ? 0 : 1]; }
void HAL_CAN_RxFifo0MsgPendingCallback(CAN_HandleTypeDef *h) {
    CAN_RxHeaderTypeDef header; uint8_t data[8]; callbacks[0]++; HAL_CAN_GetRxMessage(h,FDCAN_RX_FIFO0,&header,data);
}
void HAL_CAN_RxFifo1MsgPendingCallback(CAN_HandleTypeDef *h) {
    CAN_RxHeaderTypeDef header; uint8_t data[8]; callbacks[1]++; HAL_CAN_GetRxMessage(h,FDCAN_RX_FIFO1,&header,data);
}
int main(void) {
    assert(HAL_CAN_Start(&hcan1)==HAL_OK && HAL_CAN_Start(&hcan2)==HAL_OK);
    assert(starts[0]==1 && starts[1]==1 && filter_writes[0]==14 && filter_writes[1]==14);
    for(unsigned b=0;b<2;b++) for(unsigned i=0;i<14;i++) assert(filters[b][i].FilterConfig==FDCAN_FILTER_DISABLE);
    CAN_FilterTypeDef filter={.FilterBank=0,.FilterIdLow=0x302u<<5,.FilterActivation=1,.FilterFIFOAssignment=CAN_RX_FIFO1};
    assert(HAL_CAN_ConfigFilter(&hcan1,&filter)==HAL_OK);
    assert(filters[0][0].FilterID1==0x302 && filters[0][0].FilterID2==0x302 && filters[0][0].FilterConfig==FDCAN_FILTER_TO_RXFIFO1);
    filter.FilterBank=14; filter.FilterFIFOAssignment=CAN_RX_FIFO0;
    assert(HAL_CAN_ConfigFilter(&hcan2,&filter)==HAL_OK && filters[1][0].FilterConfig==FDCAN_FILTER_TO_RXFIFO0);
    assert(HAL_CAN_ConfigFilter(&hcan1,&filter)==HAL_ERROR);
    assert(HAL_CAN_Start(&hcan1)==HAL_OK && filter_writes[0]==15); // registration must not erase peers
    filter.FilterActivation=0;
    assert(HAL_CAN_ConfigFilter(&hcan2,&filter)==HAL_OK && filters[1][0].FilterConfig==FDCAN_FILTER_DISABLE);
    assert(filters[0][0].FilterID1==0x302); // independent pools
    assert(HAL_CAN_ActivateNotification(&hcan2,CAN_IT_RX_FIFO0_MSG_PENDING)==HAL_OK);
    assert(notifications[1] & FDCAN_IT_BUS_OFF);
    CAN_TxHeaderTypeDef tx={.StdId=0x200,.IDE=CAN_ID_STD,.RTR=CAN_RTR_DATA,.DLC=8};
    uint8_t bytes[8]={1,2,3,4,5,6,7,8}; uint32_t mailbox=0;
    assert(HAL_CAN_AddTxMessage(&hcan1,&tx,bytes,&mailbox)==HAL_OK && mailbox==4);
    assert(transmitted.Identifier==0x200 && transmitted.DataLength==FDCAN_DLC_BYTES_8 && transmitted.FDFormat==FDCAN_CLASSIC_CAN);
    assert(transmitted.BitRateSwitch==FDCAN_BRS_OFF && !memcmp(bytes,transmitted_data,8));
    tx.DLC=4; latest=2;
    assert(HAL_CAN_AddTxMessage(&hcan2,&tx,bytes,&mailbox)==HAL_OK && mailbox==2 && transmitted.DataLength==FDCAN_DLC_BYTES_4);
    tx.DLC=9; assert(HAL_CAN_AddTxMessage(&hcan2,&tx,bytes,&mailbox)==HAL_ERROR);
    tx.DLC=8; tx_result=HAL_ERROR; mailbox=99;
    assert(HAL_CAN_AddTxMessage(&hcan2,&tx,bytes,&mailbox)==HAL_ERROR && mailbox==99);
    pending[0]=4; pending[1]=2;
    assert(HAL_CAN_IsTxMessagePending(&hcan1,4) && !HAL_CAN_IsTxMessagePending(&hcan2,4));
    assert(HAL_CAN_GetTxMailboxesFreeLevel(&hcan1)==2);
    assert(HAL_CAN_AbortTxRequest(&hcan1,4)==HAL_OK && !pending[0] && pending[1]==2);
    received.Identifier=0x302; received.IdType=FDCAN_STANDARD_ID; received.RxFrameType=FDCAN_DATA_FRAME;
    received.FDFormat=FDCAN_CLASSIC_CAN; received.DataLength=FDCAN_DLC_BYTES_8;
    CAN_RxHeaderTypeDef rx; struct { uint8_t bytes[8]; uint32_t canary; } output={{0},0x12345678};
    assert(HAL_CAN_GetRxMessage(&hcan1,FDCAN_RX_FIFO0,&rx,output.bytes)==HAL_OK && rx.StdId==0x302 && rx.DLC==8 && output.bytes[7]==0x5a);
    received.FDFormat=FDCAN_FD_CAN; received.DataLength=FDCAN_DLC_BYTES_64;
    assert(HAL_CAN_GetRxMessage(&hcan1,FDCAN_RX_FIFO0,&rx,output.bytes)==HAL_ERROR && rx.StdId==0xffffffffu && output.canary==0x12345678);
    received.FDFormat=FDCAN_CLASSIC_CAN; received.DataLength=FDCAN_DLC_BYTES_8; received.IdType=FDCAN_EXTENDED_ID;
    assert(HAL_CAN_GetRxMessage(&hcan1,FDCAN_RX_FIFO0,&rx,output.bytes)==HAL_ERROR);
    received.IdType=FDCAN_STANDARD_ID; received.RxFrameType=FDCAN_REMOTE_FRAME;
    assert(HAL_CAN_GetRxMessage(&hcan1,FDCAN_RX_FIFO0,&rx,output.bytes)==HAL_ERROR);
    received.RxFrameType=FDCAN_DATA_FRAME; rx_result=HAL_ERROR;
    assert(HAL_CAN_GetRxMessage(&hcan1,FDCAN_RX_FIFO0,&rx,output.bytes)==HAL_ERROR && rx.StdId==0xffffffffu);
    rx_result=HAL_OK; fifo_count[0]=4; fifo_count[1]=3;
    HAL_FDCAN_RxFifo0Callback(&hcan1,FDCAN_IT_RX_FIFO0_NEW_MESSAGE);
    HAL_FDCAN_RxFifo1Callback(&hcan2,FDCAN_IT_RX_FIFO1_NEW_MESSAGE);
    assert(callbacks[0]==4 && callbacks[1]==3 && !fifo_count[0] && !fifo_count[1]);
    rx_result=HAL_ERROR; fifo_count[0]=4; fifo_count[1]=3;
    HAL_FDCAN_RxFifo0Callback(&hcan1,FDCAN_IT_RX_FIFO0_NEW_MESSAGE);
    HAL_FDCAN_RxFifo1Callback(&hcan2,FDCAN_IT_RX_FIFO1_NEW_MESSAGE);
    assert(callbacks[0]==8 && callbacks[1]==6 && fifo_count[0]==4 && fifo_count[1]==3); // bounded even if HAL cannot consume a frame
    registers[1].PSR=FDCAN_PSR_BO; registers[1].CCCR=FDCAN_CCCR_INIT;
    HAL_FDCAN_ErrorStatusCallback(&hcan2,FDCAN_IT_BUS_OFF);
    assert(!(registers[1].CCCR & FDCAN_CCCR_INIT) && !pending[1] && aborted[1]==7);
    assert(output.canary==0x12345678);
    return 0;
}
`);
  const includes = ['Core/Inc', 'Drivers/STM32H7xx_HAL_Driver/Inc',
    'Drivers/CMSIS/Device/ST/STM32H7xx/Include', 'Drivers/CMSIS/Include']
    .flatMap(p => ['-I', path.join(root, p)]);
  const exe = path.join(tmp, process.platform === 'win32' ? 'test.exe' : 'test');
  execFileSync('gcc', ['-std=gnu11', '-DSTM32H723xx', '-DUSE_HAL_DRIVER', '-O1', '-Wno-pointer-to-int-cast', '-Wno-int-to-pointer-cast',
    ...includes, path.join(tmp, 'test.c'), path.join(root, 'bsp/can/bsp_can_hal.c'), '-o', exe], { env, stdio: 'pipe' });
  execFileSync(exe, [], { env, stdio: 'pipe', timeout: 5000 });
  console.log('PASS MC02 adapter with actual H723 HAL types: independent/reusable filters, classic frames, TX masks/errors/abort, invalid RX buffer safety, FIFO draining and bus-off recovery');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
