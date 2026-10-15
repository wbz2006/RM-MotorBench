#include "bench_control.h"
#include <math.h>

int BenchControlSelect(BenchControl *state, uint8_t source, uint8_t channel, float max_ref)
{
    if (source > 1 || (source == 1 &&
        (channel >= 8 || !isfinite(max_ref) || max_ref <= 0 || max_ref > 12000)))
        return 0;
    state->source = source;
    state->channel = source ? channel : 0xff;
    state->max_ref = source ? max_ref : 0;
    state->ready = 0;
    state->reverse_mask = 0;
    for (int i = 0; i < 4; ++i) state->channels[i] = 0xff;
    return 1;
}

int BenchControlCanEnable(const BenchControl *state, uint8_t channel)
{
    return !state->source || (BenchControlContains(state, channel) && state->ready);
}

int BenchControlContains(const BenchControl *state, uint8_t channel)
{
    if (!state->source || channel >= 8) return 0;
    if (state->source == 1) return state->channel == channel;
    for (int i = 0; i < 4; ++i) if (state->channels[i] == channel) return 1;
    return 0;
}

int BenchControlSelectChassis(BenchControl *state, uint8_t source, const uint8_t channels[4], uint8_t reverse_mask, float max_ref)
{
    if ((source != 2 && source != 3) || !channels || reverse_mask > 15 ||
        !isfinite(max_ref) || max_ref <= 0 || max_ref > 12000) return 0;
    for (int i = 0; i < 4; ++i) {
        if (channels[i] >= 8) return 0;
        for (int j = 0; j < i; ++j) if (channels[i] == channels[j]) return 0;
    }
    state->source = source;
    state->channel = 0xff;
    state->ready = 0;
    state->max_ref = max_ref;
    state->reverse_mask = reverse_mask;
    for (int i = 0; i < 4; ++i) state->channels[i] = channels[i];
    return 1;
}

int BenchControlUpdateChassis(BenchControl *state, uint8_t online, const int16_t axes[3],
                              uint8_t switch_right, uint8_t enabled_mask, float refs[4])
{
    for (int i = 0; i < 4; ++i) refs[i] = 0;
    if (state->source < 2) return BENCH_WEB;
    int neutral = 1;
    for (int i = 0; i < 3; ++i) {
        if (axes[i] < -660 || axes[i] > 660) { state->ready = 0; return BENCH_STOP; }
        if (axes[i] < -10 || axes[i] > 10) neutral = 0;
    }
    if (!online || switch_right != 1) { state->ready = 0; return BENCH_STOP; }
    if (!enabled_mask) { state->ready = neutral; return BENCH_STOP; }
    if (enabled_mask != 15 || !state->ready) { state->ready = 0; return BENCH_STOP; }
    float x = axes[0] >= -10 && axes[0] <= 10 ? 0 : axes[0] / 660.0f;
    float y = axes[1] >= -10 && axes[1] <= 10 ? 0 : -axes[1] / 660.0f;
    float z = axes[2] >= -10 && axes[2] <= 10 ? 0 : -axes[2] / 660.0f;
    if (state->source == 2) {
        refs[0] = x - y - z; refs[1] = x + y + z;
        refs[2] = x + y - z; refs[3] = x - y + z;
    } else {
        /* Four tangential omni wheels at 45 degrees; normalized velocity axes. */
        refs[0] = -x + y + z; refs[1] = x + y + z;
        refs[2] = -x - y + z; refs[3] = x - y + z;
    }
    float peak = 1;
    for (int i = 0; i < 4; ++i) if (fabsf(refs[i]) > peak) peak = fabsf(refs[i]);
    for (int i = 0; i < 4; ++i)
        refs[i] *= state->max_ref / peak * ((state->reverse_mask & (1u << i)) ? -1 : 1);
    return BENCH_SET_REF;
}

int BenchControlUpdate(BenchControl *state, uint8_t online, int16_t rocker,
                       uint8_t switch_right, uint8_t enabled, float *ref)
{
    if (!state->source)
        return BENCH_WEB;
    if (!online || switch_right != 1 || rocker < -660 || rocker > 660) {
        state->ready = 0;
        return BENCH_STOP;
    }
    if (!enabled) {
        state->ready = rocker >= -10 && rocker <= 10;
        return BENCH_STOP;
    }
    if (!state->ready)
        return BENCH_STOP;
    *ref = rocker >= -10 && rocker <= 10 ? 0 : rocker * state->max_ref / 660.0f;
    return BENCH_SET_REF;
}
