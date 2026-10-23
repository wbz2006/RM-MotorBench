#ifndef ROBOT_DEF_H
#define ROBOT_DEF_H

/* The bench owns motor instances; no chassis/gimbal/shoot application starts. */
#define MOTOR_BENCH_APP
#define MOTOR_BENCH_DEFAULT_CONFIG

/* Select exactly one host link. UART uses UART7 at 115200 baud. */
#define MOTOR_BENCH_LINK_USB
/* #define MOTOR_BENCH_LINK_UART */

#if defined(MOTOR_BENCH_LINK_USB) == defined(MOTOR_BENCH_LINK_UART)
#error "Select exactly one motor bench host link"
#endif

#define MOTOR_BENCH_QUIET_LOG
#define MOTOR_BENCH_DAEMON_RELOAD_COUNT 10

#endif
