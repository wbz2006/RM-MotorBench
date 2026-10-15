#include "main.h"
#include <errno.h>
#include <stddef.h>
#include <stdint.h>

/* Newlib heap lies between the linked BSS and the reserved main stack. */
extern char end, _estack, _Min_Stack_Size;
void *_sbrk(ptrdiff_t increment)
{
    static uintptr_t heap_end;
    uintptr_t base = (uintptr_t)&end;
    uintptr_t limit = (uintptr_t)&_estack - (uintptr_t)&_Min_Stack_Size;
    uint32_t mask = __get_PRIMASK();
    __disable_irq();
    if (!heap_end)
        heap_end = base;
    if ((increment >= 0 && (uintptr_t)increment > limit - heap_end) ||
        (increment < 0 && (uintptr_t)(-(increment + 1)) + 1 > heap_end - base)) {
        __set_PRIMASK(mask);
        errno = ENOMEM;
        return (void *)-1;
    }
    void *previous = (void *)heap_end;
    heap_end += increment;
    __set_PRIMASK(mask);
    return previous;
}
