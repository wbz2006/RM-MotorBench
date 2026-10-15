#ifndef TEST_DWT_H
#define TEST_DWT_H
#include <stdint.h>
float DWT_GetTimeline_ms(void);
float DWT_GetTimeline_s(void);
float DWT_GetDeltaT(uint32_t *previous);
void DWT_Delay(float seconds);
#endif
