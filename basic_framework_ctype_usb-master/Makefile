# STM32F407 C board motor bench. Build from PowerShell, cmd or a POSIX shell.
TARGET = basic_framework_CTYPE
BUILD_DIR ?= build
DEBUG ?= 1
OPT ?= -Og
PREFIX = arm-none-eabi-
CC = $(PREFIX)gcc
AS = $(PREFIX)gcc -x assembler-with-cpp
CP = $(PREFIX)objcopy
SZ = $(PREFIX)size

HAL_DIR = Drivers/STM32F4xx_HAL_Driver
USB_DIR = Middlewares/ST/STM32_USB_Device_Library
RTOS_DIR = Middlewares/Third_Party/FreeRTOS/Source
RTT_DIR = Middlewares/Third_Party/SEGGER
DSP_DIR = Middlewares/ST/ARM/DSP
BSP_DIRS = bsp/can bsp/usart bsp/usb bsp/dwt bsp/log
APP_DIRS = application application/motor_bench_app
MODULE_DIRS = modules/algorithm modules/daemon modules/motor modules/motor/DJImotor modules/motor/DMmotor
MODULE_DIRS += modules/remote

C_SOURCES = $(wildcard Src/*.c) $(wildcard $(HAL_DIR)/Src/*.c) \
 $(wildcard $(USB_DIR)/Core/Src/*.c) $(wildcard $(USB_DIR)/Class/CDC/Src/*.c) \
 $(wildcard $(RTOS_DIR)/*.c) $(RTOS_DIR)/CMSIS_RTOS/cmsis_os.c \
 $(RTOS_DIR)/portable/GCC/ARM_CM4F/port.c $(RTOS_DIR)/portable/MemMang/heap_4.c \
 $(RTT_DIR)/RTT/SEGGER_RTT.c $(RTT_DIR)/RTT/SEGGER_RTT_printf.c \
 $(foreach dir,$(BSP_DIRS) $(APP_DIRS) $(MODULE_DIRS),$(wildcard $(dir)/*.c)) \
 bsp/bsp_init.c bsp/bsp_memory.c modules/motor_bench/motor_bench.c modules/motor_bench/bench_control.c
ASM_SOURCES = startup_stm32f407xx.s

INCLUDE_DIRS = Inc bsp modules modules/motor_bench $(BSP_DIRS) $(APP_DIRS) $(MODULE_DIRS) \
 $(HAL_DIR)/Inc $(HAL_DIR)/Inc/Legacy Drivers/CMSIS/Include Drivers/CMSIS/Device/ST/STM32F4xx/Include \
 $(USB_DIR)/Core/Inc $(USB_DIR)/Class/CDC/Inc \
 $(RTOS_DIR)/include $(RTOS_DIR)/CMSIS_RTOS $(RTOS_DIR)/portable/GCC/ARM_CM4F \
 $(RTT_DIR)/RTT $(RTT_DIR)/Config $(DSP_DIR)/Include

MCU = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
CFLAGS = $(MCU) $(OPT) -std=gnu11 -Wall -ffunction-sections -fdata-sections \
 -DUSE_HAL_DRIVER -DSTM32F407xx -DARM_MATH_CM4 $(addprefix -I,$(INCLUDE_DIRS)) -MMD -MP
ifeq ($(DEBUG),1)
CFLAGS += -g3
endif
LDFLAGS = $(MCU) -specs=nano.specs -TSTM32F407IGHx_FLASH.ld \
 -L$(DSP_DIR)/Lib -Wl,-Map=$(BUILD_DIR)/$(TARGET).map,--cref,--gc-sections,--print-memory-usage
LIBS = -l:libCMSISDSP.a -lc -lm -lnosys

OBJECTS = $(addprefix $(BUILD_DIR)/,$(notdir $(C_SOURCES:.c=.o))) \
 $(addprefix $(BUILD_DIR)/,$(notdir $(ASM_SOURCES:.s=.o)))
vpath %.c $(sort $(dir $(C_SOURCES)))
vpath %.s $(sort $(dir $(ASM_SOURCES)))

.PHONY: all test clean download_dap download_jlink
all: $(BUILD_DIR)/$(TARGET).elf $(BUILD_DIR)/$(TARGET).hex $(BUILD_DIR)/$(TARGET).bin
$(BUILD_DIR)/%.o: %.c Makefile | $(BUILD_DIR)
	$(CC) -c $(CFLAGS) $< -o $@
$(BUILD_DIR)/%.o: %.s Makefile | $(BUILD_DIR)
	$(AS) -c $(MCU) $(OPT) $< -o $@
$(BUILD_DIR)/$(TARGET).elf: $(OBJECTS) STM32F407IGHx_FLASH.ld
	$(CC) $(OBJECTS) $(LDFLAGS) $(LIBS) -o $@
	$(SZ) $@
$(BUILD_DIR)/%.hex: $(BUILD_DIR)/%.elf
	$(CP) -O ihex $< $@
$(BUILD_DIR)/%.bin: $(BUILD_DIR)/%.elf
	$(CP) -O binary -S $< $@
$(BUILD_DIR):
	mkdir $(BUILD_DIR)
test:
	node ../tests/ctype_firmware_test.mjs
download_dap:
	openocd -f openocd_dap.cfg -c "program $(BUILD_DIR)/$(TARGET).elf verify reset exit"
download_jlink:
	JFlash -openprj'stm32.jflash' -open'$(BUILD_DIR)/$(TARGET).hex',0x8000000 -auto -startapp -exit
-include $(wildcard $(BUILD_DIR)/*.d)
