#ifndef BENCH_CONTROL_H
#define BENCH_CONTROL_H
#include <stdint.h>

typedef struct {
    uint8_t source; /* 0: web, 1: single motor, 2: mecanum X, 3: four-wheel omni X */
    uint8_t channel;
    uint8_t ready;
    float max_ref;
    uint8_t channels[4]; /* FL, FR, RL, RR */
    uint8_t reverse_mask;
} BenchControl;
enum { BENCH_WEB, BENCH_STOP, BENCH_SET_REF };
int BenchControlSelect(BenchControl *state, uint8_t source, uint8_t channel, float max_ref);
int BenchControlCanEnable(const BenchControl *state, uint8_t channel);
int BenchControlContains(const BenchControl *state, uint8_t channel);
int BenchControlSelectChassis(BenchControl *state, uint8_t source, const uint8_t channels[4], uint8_t reverse_mask, float max_ref);
int BenchControlUpdateChassis(BenchControl *state, uint8_t online, const int16_t axes[3], uint8_t switch_right, uint8_t enabled_mask, float refs[4]);
int BenchControlUpdate(BenchControl *state, uint8_t online, int16_t rocker,
                       uint8_t switch_right, uint8_t enabled, float *ref);
#endif
