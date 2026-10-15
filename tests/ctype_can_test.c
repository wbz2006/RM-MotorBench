#include "can.h"
#include "crc8.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *ports[2];
static GPIO_InitTypeDef configs[2];
static unsigned gpio_count, enabled_irqs;

int HAL_CAN_Init(CAN_HandleTypeDef *handle) { HAL_CAN_MspInit(handle); return HAL_OK; }
void HAL_GPIO_Init(void *port, GPIO_InitTypeDef *config) {
    assert(gpio_count < 2); ports[gpio_count] = port; configs[gpio_count++] = *config;
}
void HAL_GPIO_DeInit(void *port, uint32_t pins) { (void)port; (void)pins; }
void HAL_NVIC_SetPriority(int irq, uint32_t priority, uint32_t subpriority) {
    (void)irq; assert(priority == 5 && subpriority == 0);
}
void HAL_NVIC_EnableIRQ(int irq) { (void)irq; enabled_irqs++; }
void HAL_NVIC_DisableIRQ(int irq) { (void)irq; }
void Error_Handler(void) { abort(); }

int main(int argc, char **argv) {
    if (argc == 2) {
        uint8_t bytes[256]; size_t count = strlen(argv[1]) / 2;
        assert(strlen(argv[1]) % 2 == 0 && count <= sizeof(bytes));
        for (size_t i = 0; i < count; ++i) {
            char hex[3] = {argv[1][i * 2], argv[1][i * 2 + 1], 0};
            bytes[i] = (uint8_t)strtoul(hex, NULL, 16);
        }
        printf("%u\n", crc_8(bytes, (uint16_t)count));
        return 0;
    }
    MX_CAN1_Init(); MX_CAN2_Init();
    assert(gpio_count == 2 && enabled_irqs == 4);
    assert(ports[0] == GPIOD && configs[0].Pin == 0x0003);
    assert(ports[1] == GPIOB && configs[1].Pin == 0x0060);
    for (unsigned i = 0; i < 2; ++i) {
        assert(configs[i].Mode == GPIO_MODE_AF_PP && configs[i].Alternate == 9);
    }
    assert(hcan1.Init.Prescaler == 3 && hcan2.Init.Prescaler == 3);
    assert(hcan1.Init.TimeSeg1 == 10 && hcan1.Init.TimeSeg2 == 3);
    assert(hcan2.Init.TimeSeg1 == 10 && hcan2.Init.TimeSeg2 == 3);
    assert(hcan1.Init.AutoRetransmission == ENABLE && hcan2.Init.AutoRetransmission == ENABLE);
    puts("PASS: C board CAN pins, timing and interrupts");
    return 0;
}
