#include "bench_control.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>

int main(void)
{
    BenchControl state = {0}; float ref = 123;
    assert(BenchControlSelect(&state, 1, 2, 6000));
    assert(!BenchControlCanEnable(&state, 2));
    assert(BenchControlUpdate(&state, 1, 660, 1, 0, &ref) == BENCH_STOP);
    assert(!BenchControlCanEnable(&state, 2));
    assert(BenchControlUpdate(&state, 1, 0, 1, 0, &ref) == BENCH_STOP);
    assert(BenchControlCanEnable(&state, 2));
    assert(!BenchControlCanEnable(&state, 1));
    assert(BenchControlUpdate(&state, 1, 330, 1, 1, &ref) == BENCH_SET_REF && ref == 3000);
    assert(BenchControlUpdate(&state, 1, -660, 1, 1, &ref) == BENCH_SET_REF && ref == -6000);
    assert(BenchControlUpdate(&state, 1, 10, 1, 1, &ref) == BENCH_SET_REF && ref == 0);
    assert(BenchControlUpdate(&state, 0, 660, 1, 1, &ref) == BENCH_STOP);
    assert(!BenchControlCanEnable(&state, 2));
    assert(BenchControlUpdate(&state, 1, 660, 1, 0, &ref) == BENCH_STOP);
    assert(!BenchControlCanEnable(&state, 2));
    assert(BenchControlUpdate(&state, 1, 0, 2, 1, &ref) == BENCH_STOP);
    assert(!BenchControlCanEnable(&state, 2));
    assert(!BenchControlSelect(&state, 2, 0, 5000));
    assert(!BenchControlSelect(&state, 1, 8, 5000));
    assert(!BenchControlSelect(&state, 1, 0, NAN));
    assert(!BenchControlSelect(&state, 1, 0, -1));
    assert(BenchControlSelect(&state, 0, 0, 0));
    assert(BenchControlCanEnable(&state, 7));
    assert(BenchControlUpdate(&state, 0, 660, 2, 1, &ref) == BENCH_WEB);
    puts("PASS: source selection, neutral gate, speed mapping and loss/reconnect stop");
}
