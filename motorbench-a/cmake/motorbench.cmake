# Motor bench only: keep the reusable motor/control layer, without robot apps.
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    application/robot.c
    application/motor_bench_app/motor_bench_app.c
    bsp/bsp_init.c
    bsp/can/bsp_can.c
    bsp/dwt/bsp_dwt.c
    bsp/log/bsp_log.c
    bsp/pwm/bsp_pwm.c
    bsp/usart/bsp_usart.c
    bsp/usb/bsp_usb.c
    modules/algorithm/controller.c
    modules/algorithm/crc8.c
    modules/algorithm/user_lib.c
    modules/daemon/daemon.c
    modules/motor/motor_task.c
    modules/motor/power_control.c
    modules/motor/DJImotor/dji_motor.c
    modules/motor/DMmotor/dmmotor.c
    modules/motor/HTmotor/HT04.c
    modules/motor/LKmotor/LK9025.c
    modules/motor/servo_motor/servo_motor.c
    modules/motor/step_motor/step_motor.c
    modules/motor_bench/motor_bench.c
    Middlewares/Third_Party/SEGGER/RTT/SEGGER_RTT.c
    Middlewares/Third_Party/SEGGER/RTT/SEGGER_RTT_printf.c
    Middlewares/Third_Party/SEGGER/RTT/SEGGER_RTT_ASM_ARMv7M.s
)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    application
    application/motor_bench_app
    bsp
    bsp/can
    bsp/dwt
    bsp/log
    bsp/pwm
    bsp/usart
    bsp/usb
    modules
    modules/algorithm
    modules/daemon
    modules/motor
    modules/motor/DJImotor
    modules/motor/DMmotor
    modules/motor/HTmotor
    modules/motor/LKmotor
    modules/motor/servo_motor
    modules/motor/step_motor
    modules/motor_bench
    Middlewares/Third_Party/SEGGER/RTT
    Middlewares/Third_Party/SEGGER/Config
)

target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE
    ARM_MATH_CM4
    ARM_MATH_MATRIX_CHECK
    ARM_MATH_ROUNDING
)
