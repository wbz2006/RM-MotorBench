#ifndef ROBOT_DEF_H
#define ROBOT_DEF_H

/* The bench owns motor instances; no chassis/gimbal/shoot application starts. */
#define MOTOR_BENCH_APP
#define MOTOR_BENCH_DEFAULT_CONFIG

/* C board snapshot: USB CDC is the only enabled host link. */
#define MOTOR_BENCH_LINK_USB

#if defined(MOTOR_BENCH_LINK_UART)
#error "C board motor bench supports USB CDC only"
#endif

#define MOTOR_BENCH_QUIET_LOG
#define MOTOR_BENCH_DAEMON_RELOAD_COUNT 10

#endif
