#include "bench_control.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static void close4(const float *actual, const float *expected) {
    for (int i = 0; i < 4; ++i) assert(fabsf(actual[i] - expected[i]) < 0.01f);
}
int main(void) {
    BenchControl state = {0};
    const uint8_t channels[4] = {0, 2, 4, 6}, duplicate[4] = {0, 0, 4, 6};
    int16_t axes[3] = {0}; float refs[4] = {0};
    assert(BenchControlSelectChassis(&state, 2, channels, 0, 6000));
    assert(!BenchControlCanEnable(&state, 0));
    axes[0] = 330;
    assert(BenchControlUpdateChassis(&state, 1, axes, 1, 0, refs) == BENCH_STOP);
    assert(!state.ready);
    axes[0] = 0;
    assert(BenchControlUpdateChassis(&state, 1, axes, 1, 0, refs) == BENCH_STOP);
    assert(BenchControlCanEnable(&state, 6) && !BenchControlCanEnable(&state, 1));
    const int16_t input[][3] = {{660,0,0},{0,660,0},{0,0,660},{660,660,660},{-660,0,0}};
    const float mecanum[][4] = {{6000,6000,6000,6000},{6000,-6000,-6000,6000},
        {6000,-6000,6000,-6000},{6000,-2000,2000,2000},{-6000,-6000,-6000,-6000}};
    for (int i = 0; i < 5; ++i) {
        assert(BenchControlUpdateChassis(&state, 1, input[i], 1, 15, refs) == BENCH_SET_REF);
        close4(refs, mecanum[i]);
    }
    assert(BenchControlUpdateChassis(&state, 0, axes, 1, 15, refs) == BENCH_STOP && !state.ready);
    assert(BenchControlUpdateChassis(&state, 1, input[0], 1, 0, refs) == BENCH_STOP && !state.ready);
    assert(BenchControlUpdateChassis(&state, 1, axes, 1, 0, refs) == BENCH_STOP && state.ready);
    assert(BenchControlUpdateChassis(&state, 1, axes, 1, 7, refs) == BENCH_STOP && !state.ready);
    assert(BenchControlUpdateChassis(&state, 1, axes, 1, 0, refs) == BENCH_STOP && state.ready);
    const int16_t invalid[3] = {0, 661, 0};
    assert(BenchControlUpdateChassis(&state, 1, invalid, 1, 15, refs) == BENCH_STOP && !state.ready);
    assert(BenchControlUpdateChassis(&state, 1, axes, 2, 15, refs) == BENCH_STOP);
    assert(!BenchControlSelectChassis(&state, 2, duplicate, 0, 6000));
    assert(!BenchControlSelectChassis(&state, 1, channels, 0, 6000));
    assert(!BenchControlSelectChassis(&state, 2, channels, 16, 6000));
    assert(!BenchControlSelectChassis(&state, 2, channels, 0, NAN));
    assert(BenchControlSelectChassis(&state, 3, channels, 0, 6000));
    BenchControlUpdateChassis(&state, 1, axes, 1, 0, refs);
    const float omni[][4] = {{-6000,6000,-6000,6000},{-6000,-6000,6000,6000},{-6000,-6000,-6000,-6000}};
    for (int i = 0; i < 3; ++i) {
        assert(BenchControlUpdateChassis(&state, 1, input[i], 1, 15, refs) == BENCH_SET_REF);
        close4(refs, omni[i]);
    }
    assert(BenchControlSelectChassis(&state, 2, channels, 10, 6000));
    BenchControlUpdateChassis(&state, 1, axes, 1, 0, refs);
    BenchControlUpdateChassis(&state, 1, input[0], 1, 15, refs);
    const float reversed[4] = {6000,-6000,6000,-6000}; close4(refs, reversed);
    assert(BenchControlContains(&state, 2) && !BenchControlContains(&state, 3));
    puts("PASS: mecanum/omni mixing, ratio-preserving limit, wheel reversal and all-wheel safety gates");
}
