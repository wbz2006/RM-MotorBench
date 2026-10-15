#ifndef ROBOT_DEF_H
#define ROBOT_DEF_H

/* Dedicated C-board motor bench; this firmware does not run the RC/robot apps. */
#define MOTOR_BENCH_APP
#define MOTOR_BENCH_RC_UART (&huart3)
#define MOTOR_BENCH_DEFAULT_CONFIG
#define MOTOR_BENCH_LINK_USB
/* Optional UART transport uses the reference board's USART6 (115200, RX DMA). */
/* #define MOTOR_BENCH_LINK_UART */
#define MOTOR_BENCH_QUIET_LOG
#define MOTOR_BENCH_DAEMON_RELOAD_COUNT 10

#if defined(MOTOR_BENCH_LINK_USB) == defined(MOTOR_BENCH_LINK_UART)
#error "Select exactly one motor bench transport"
#endif
#endif
