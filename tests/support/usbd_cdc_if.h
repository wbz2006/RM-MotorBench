#ifndef TEST_CDC_H
#define TEST_CDC_H
#include "usb_device.h"
typedef struct { uint32_t TxState; } USBD_CDC_HandleTypeDef;
#define USBD_OK 0
#define USBD_BUSY 1
#define USBD_FAIL 2
uint8_t CDC_Transmit_FS(uint8_t *bytes, uint16_t length);
#endif
