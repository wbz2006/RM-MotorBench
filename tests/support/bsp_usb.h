#ifndef TEST_USB_H
#define TEST_USB_H
#include "usbd_cdc_if.h"
typedef void (*USBCallback)(uint16_t);
typedef struct { USBCallback tx_cbk, rx_cbk; } USB_Init_Config_s;
uint8_t *USBInit(USB_Init_Config_s config);
#endif
