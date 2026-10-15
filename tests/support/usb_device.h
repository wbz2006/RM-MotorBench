#ifndef TEST_USB_DEVICE_H
#define TEST_USB_DEVICE_H
#include <stdint.h>
typedef struct { void *pClassData; uint8_t dev_state; } USBD_HandleTypeDef;
#define USBD_STATE_CONFIGURED 3
extern USBD_HandleTypeDef hUsbDeviceFS;
#endif
