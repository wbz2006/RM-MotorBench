// Exercise the real MC02 CDC interface and HAL/library types, without USB hardware.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../motorbench-mc02/', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mc02-usb-'));
const env = { ...process.env };
if (process.platform === 'win32') env.PATH = `C:/msys64/mingw64/bin;${env.PATH}`;
try {
  fs.writeFileSync(path.join(tmp, 'test.c'), `
#include <assert.h>
#include <string.h>
#include "usbd_cdc_if.h"
USBD_HandleTypeDef hUsbDeviceHS;
static USBD_CDC_HandleTypeDef cdc;
static uint8_t *rx_buffer, *tx_buffer;
static uint16_t tx_length, received_length, completed_length;
static unsigned armed, sent, received;
uint8_t USBD_CDC_SetTxBuffer(USBD_HandleTypeDef *dev, uint8_t *buffer, uint32_t length) {
    assert(dev==&hUsbDeviceHS); tx_buffer=buffer; tx_length=length; return USBD_OK;
}
uint8_t USBD_CDC_SetRxBuffer(USBD_HandleTypeDef *dev, uint8_t *buffer) {
    assert(dev==&hUsbDeviceHS); rx_buffer=buffer; return USBD_OK;
}
uint8_t USBD_CDC_ReceivePacket(USBD_HandleTypeDef *dev) { armed++; return USBD_OK; }
uint8_t USBD_CDC_TransmitPacket(USBD_HandleTypeDef *dev) { sent++; cdc.TxState=1; return USBD_OK; }
static void receive(uint16_t length) {
    assert(armed==0 && rx_buffer[0]==0xa5 && rx_buffer[12]==0x5a);
    received++; received_length=length;
}
static void complete(uint16_t length) { completed_length=length; }
int main(void) {
    uint8_t *buffer=CDCInitRxbufferNcallback(complete,receive);
    assert(buffer && USBD_Interface_fops_HS.Init()==USBD_OK && rx_buffer==buffer);
    uint8_t coding[7]={0};
    USBD_Interface_fops_HS.Control(CDC_GET_LINE_CODING,coding,7);
    const uint8_t expected[7]={0,0xc2,1,0,0,0,8}; assert(!memcmp(coding,expected,7));
    const uint8_t changed[7]={0,0x84,3,0,0,0,8}; memcpy(coding,changed,7);
    USBD_Interface_fops_HS.Control(CDC_SET_LINE_CODING,coding,7);
    memset(coding,0,7); USBD_Interface_fops_HS.Control(CDC_GET_LINE_CODING,coding,7);
    assert(!memcmp(coding,changed,7));
    buffer[0]=0xa5; buffer[12]=0x5a; uint32_t length=13;
    USBD_Interface_fops_HS.Receive(buffer,&length);
    assert(received==1 && received_length==13 && armed==1);
    // Neither missing class data nor an unconfigured/busy device may start TX.
    assert(CDC_Transmit_FS(buffer,13)==USBD_BUSY && !sent);
    hUsbDeviceHS.pClassData=&cdc; hUsbDeviceHS.pClassDataCmsit[0]=&cdc;
    assert(CDC_Transmit_FS(buffer,13)==USBD_BUSY && !sent);
    hUsbDeviceHS.dev_state=USBD_STATE_CONFIGURED; cdc.TxState=1;
    assert(CDC_Transmit_FS(buffer,13)==USBD_BUSY && !sent);
    cdc.TxState=0;
    assert(CDC_Transmit_FS(buffer,13)==USBD_OK && sent==1 && tx_buffer==buffer && tx_length==13);
    assert(CDC_Transmit_FS(buffer,13)==USBD_BUSY && sent==1);
    cdc.TxState=0; USBD_Interface_fops_HS.TransmitCplt(buffer,&length,1);
    assert(completed_length==13);
    assert(CDC_Transmit_FS(buffer,13)==USBD_OK && sent==2);
    assert(USBD_Interface_fops_HS.DeInit()==USBD_OK);
    return 0;
}
`);
  const includes = ['Core/Inc', 'Drivers/STM32H7xx_HAL_Driver/Inc',
    'Drivers/CMSIS/Device/ST/STM32H7xx/Include', 'Drivers/CMSIS/Include',
    'USB_DEVICE/App', 'USB_DEVICE/Target', 'Middlewares/ST/STM32_USB_Device_Library/Core/Inc',
    'Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc']
    .flatMap(p => ['-I', path.join(root, p)]);
  const exe = path.join(tmp, process.platform === 'win32' ? 'test.exe' : 'test');
  execFileSync('gcc', ['-std=gnu11', '-DSTM32H723xx', '-DUSE_HAL_DRIVER', '-O1',
    '-Wno-pointer-to-int-cast', '-Wno-int-to-pointer-cast', ...includes,
    path.join(tmp, 'test.c'), path.join(root, 'USB_DEVICE/App/usbd_cdc_if.c'), '-o', exe], { env, stdio: 'pipe' });
  execFileSync(exe, [], { env, stdio: 'pipe', timeout: 5000 });
  console.log('PASS MC02 USB CDC: real H723/library types, line coding, RX callback before rearm, TX readiness/busy guard and completion callback');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
