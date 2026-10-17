// Compile the real firmware control path; stub only hardware and time.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { FrameParser, FrameType, buildEnable, buildSetRef, buildMotorAdd, buildMotorRemove, buildAllStop, buildUnbind, buildHeartbeat, parseInventory, parseTelemetry, MotorKind } from './protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../motorbench-a');
const appSource = fs.readFileSync(path.join(root, 'application/motor_bench_app/motor_bench_app.c'), 'utf8');
const dmConfigBuilder = appSource.match(/static void BenchBuildDMConfig\([\s\S]*?\n\}/)?.[0];
assert.ok(dmConfigBuilder, 'DM tests must use the actual application defaults');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-motor-state-'));
const env = { ...process.env };
if (process.platform === 'win32') {
  env.PATH = ['C:/msys64/mingw64/bin', 'C:/msys64/usr/bin', env.PATH].join(';');
}
const stubs = {
  'main.h': `#pragma once
#include <stdint.h>
#include <stdlib.h>
#define __WFI() abort()
typedef struct { int gState; } UART_HandleTypeDef;
#define HAL_UART_STATE_READY 0
uint32_t HAL_GetTick(void);
`,
  'can.h': `#pragma once
#include "main.h"
typedef struct { int unused; } CAN_HandleTypeDef;
typedef struct { uint32_t StdId, IDE, RTR, DLC; } CAN_TxHeaderTypeDef;
extern CAN_HandleTypeDef hcan1, hcan2;
#define CAN_ID_STD 0
#define CAN_RTR_DATA 0
`,
  'arm_math.h': '#pragma once\n',
  'cmsis_os.h': '#pragma once\n',
  'bsp_dwt.h': `#pragma once
#include <stdint.h>
float DWT_GetDeltaT(uint32_t *last);
float DWT_GetTimeline_s(void);
void DWT_Delay(float seconds);
`,
  'bsp_usb.h': `#pragma once
#include <stdint.h>
typedef void (*USBCallback)(uint16_t);
typedef struct { USBCallback tx_cbk, rx_cbk; } USB_Init_Config_s;
uint8_t *USBInit(USB_Init_Config_s config);
uint8_t CDC_Transmit_FS(uint8_t *data, uint16_t len);
#define USBD_OK 0
`,
};
const harness = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "motor_bench.h"
#include "bsp_usart.h"
#include "bsp_usb.h"
#include "bsp_log.h"

CAN_HandleTypeDef hcan1, hcan2;
static uint32_t now = 1000;
static unsigned failures;
static uint8_t sent[2][3][8];
static uint8_t usb_buffer[256];
static uint8_t usb_output[1024];
static unsigned usb_output_len;
static USBCallback usb_receive;
static uint16_t factory_rx;
static DMMotorInstance *factory_motor;
static char log_output[4096];
static size_t log_used;
unsigned SEGGER_RTT_Write(unsigned index, const void *data, unsigned len) {
    (void)index;
    if (len < sizeof(log_output) - log_used) {
        memcpy(log_output + log_used, data, len);
        log_used += len;
        log_output[log_used] = '\0';
    }
    return len;
}
#define CHECK(expr) do { if (!(expr)) { \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); ++failures; } } while (0)

uint32_t HAL_GetTick(void) { return now; }
uint8_t CDC_Transmit_FS(uint8_t *data, uint16_t len) {
    CHECK(usb_output_len + len <= sizeof(usb_output));
    if (usb_output_len + len <= sizeof(usb_output)) {
        memcpy(usb_output + usb_output_len, data, len);
        usb_output_len += len;
    }
    return 0;
}
void USARTSend(USARTInstance *u, uint8_t *data, uint16_t len, USART_TRANSFER_MODE mode) {
    (void)u; (void)data; (void)len; (void)mode;
}
USARTInstance *USARTRegister(USART_Init_Config_s *c) { (void)c; return NULL; }
uint8_t *USBInit(USB_Init_Config_s c) { usb_receive = c.rx_cbk; return usb_buffer; }
uint8_t CANGetFilterFree(CAN_HandleTypeDef *c) { (void)c; return 14; }
float DWT_GetDeltaT(uint32_t *last) {
    float dt = (now - *last) / 1000.0f;
    *last = now;
    return dt;
}
float DWT_GetTimeline_s(void) { return now / 1000.0f; }
void DWT_Delay(float seconds) { now += (uint32_t)(seconds * 1000); }
CANInstance *CANRegister(CAN_Init_Config_s *config) {
    CANInstance *can = calloc(1, sizeof(*can));
    can->can_handle = config->can_handle;
    can->tx_id = config->tx_id;
    can->txconf.StdId = config->tx_id;
    can->rx_id = config->rx_id;
    can->id = config->id;
    can->can_module_callback = config->can_module_callback;
    return can;
}
uint8_t CANTransmit(CANInstance *can, uint8_t timeout) {
    (void)timeout;
    unsigned group = can->txconf.StdId == 0x200 ? 1 : can->txconf.StdId == 0x2ff ? 2 : 0;
    memcpy(sent[can->can_handle == &hcan2][group], can->tx_buff, 8);
    return 1;
}
DaemonInstance *DaemonRegister(Daemon_Init_Config_s *config) {
    DaemonInstance *d = calloc(1, sizeof(*d));
    d->reload_count = config->reload_count;
    return d;
}
void DaemonReload(DaemonInstance *d) { d->temp_count = d->reload_count; }
uint8_t DaemonIsOnline(DaemonInstance *d) { return d && d->temp_count; }

static void tick(void) { now += 2; DJIMotorControl(); }
static int16_t output(DJIMotorInstance *m) {
    uint8_t *b = sent[m->sender_group >= 3][m->sender_group % 3] + 2 * m->message_num;
    return (int16_t)((uint16_t)b[0] << 8 | b[1]);
}
static DJIMotorInstance *make_motor(uint8_t channel, uint8_t bus, uint8_t id) {
    Motor_Init_Config_s config = {0};
    config.motor_type = M3508;
    config.can_init_config.can_handle = bus == 1 ? &hcan1 : &hcan2;
    config.can_init_config.tx_id = id;
    config.controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    config.controller_setting_init_config.close_loop_type = SPEED_LOOP;
    config.controller_param_init_config.speed_PID = (PID_Init_Config_s){
        .Kp = 1, .Ki = 2, .Kd = 0.01f, .MaxOut = 16000,
        .IntegralLimit = 10000, .Improve = PID_Integral_Limit };
    DJIMotorInstance *m = DJIMotorInit(&config);
    CHECK(m != NULL);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_M3508, bus, id, 0, SPEED_LOOP, m) == MB_OK);
    CHECK(MotorBenchBind(channel, MB_MOTOR_M3508, bus, id, SPEED_LOOP) == MB_OK);
    return m;
}
static float ref(uint8_t ch) {
    MB_TelemetryItem_s t;
    CHECK(MotorBenchGetMeasure(ch, &t) == MB_OK);
    return t.ref;
}
static unsigned dm_torque(DMMotorInstance *m) {
    uint8_t *b = m->motor_can_instace->tx_buff;
    return ((unsigned)(b[6] & 15) << 8) | b[7];
}
static void dm_feedback(DMMotorInstance *m, unsigned speed) {
    CANInstance *can = m->motor_can_instace;
    uint8_t frame[8] = {6, 0x7f, 0xff, speed >> 4, (speed & 15) << 4 | 7, 0xff, 25, 25};
    memcpy(can->rx_buff, frame, 8);
    can->rx_len = 8;
    can->can_module_callback(can);
}
${dmConfigBuilder}
static int dm_stability(void) {
    /* A bounded regression model, not a substitute for loaded motor tuning:
     * J=0.0002..0.001 kg*m^2, 2 ms control and 1..2 samples of feedback delay. */
    for (unsigned test = 0; test < 3; ++test) {
        Motor_Init_Config_s config = {0};
        BenchBuildDMConfig(&config, &hcan1, (uint8_t)(test + 1), (uint16_t)(0x300 + test));
        DMMotorInstance *m = DMMotorInit(&config);
        DMMotorStop(m);
        DMMotorSetRef(m, 0);
        DMMotorEnable(m);
        const float inertia[] = {0.0002f, 0.0005f, 0.001f};
        unsigned delay = test == 0 ? 2 : 1;
        float history[3] = {0.2f, 0.2f, 0.2f};
        float velocity = 0.2f, peak = 0, tail_peak = 0, peak_torque = 0;
        for (unsigned n = 0; n < 1000; ++n) {
            float feedback = fmaxf(DM_V_MIN, fminf(DM_V_MAX, history[(n + 3 - delay) % 3]));
            unsigned raw = (unsigned)lroundf((feedback - DM_V_MIN) * 4095 / (DM_V_MAX - DM_V_MIN));
            dm_feedback(m, raw);
            now += 2;
            DMMotorControl();
            float torque = DM_T_MIN + dm_torque(m) * (DM_T_MAX - DM_T_MIN) / 4095;
            peak_torque = fmaxf(peak_torque, fabsf(torque));
            velocity += 0.002f * (torque - 0.001f * velocity) / inertia[test];
            history[n % 3] = velocity;
            peak = fmaxf(peak, fabsf(velocity));
            if (n > 900) tail_peak = fmaxf(tail_peak, fabsf(velocity));
        }
        CHECK(peak_torque <= 0.51f);
        CHECK(peak < 0.5f);
        CHECK(tail_peak < 0.2f);
        /* A large command must respect the commissioning torque limit too. */
        dm_feedback(m, 2048);
        DMMotorSetRef(m, 40);
        now += 2; DMMotorControl();
        float positive = DM_T_MIN + dm_torque(m) * (DM_T_MAX - DM_T_MIN) / 4095;
        CHECK(positive > 0 && positive <= 0.51f);
        DMMotorSetRef(m, -40);
        now += 2; DMMotorControl();
        float negative = DM_T_MIN + dm_torque(m) * (DM_T_MAX - DM_T_MIN) / 4095;
        CHECK(negative < 0 && negative >= -0.51f);
        DMMotorStop(m);
        printf("DM model %u: peak=%.3f tail=%.3f torque=%.3f\n", test, peak, tail_peak, peak_torque);
    }
    if (!failures) puts("PASS DM zero-speed stability with actual app defaults and delayed feedback");
    return failures ? 1 : 0;
}
static int mixed(void) {
    Motor_Init_Config_s config = {0};
    config.motor_type = M2006;
    config.can_init_config.can_handle = &hcan1;
    config.can_init_config.tx_id = 3;
    config.controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    config.controller_setting_init_config.close_loop_type = SPEED_LOOP;
    config.controller_param_init_config.speed_PID = (PID_Init_Config_s){.Kp=2, .MaxOut=5000};
    DJIMotorInstance *a = DJIMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_M2006, 1, 3, 0, SPEED_LOOP, a) == MB_OK);
    CHECK(MotorBenchBind(0, MB_MOTOR_M2006, 1, 3, SPEED_LOOP) == MB_OK);
    BenchBuildDMConfig(&config, &hcan1, 6, 0x302);
    DMMotorInstance *b = DMMotorInit(&config);
    CHECK(b->motor_can_instace->rx_id == 0x302);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, b) == MB_OK);
    CHECK(MotorBenchBind(1, MB_MOTOR_DM, 1, 6, SPEED_LOOP) == MB_OK);
    MB_TelemetryItem_s t;
    MotorBenchGetMeasure(1, &t);
    CHECK(!(t.status & 1)); /* No feedback must not be advertised as online. */
    dm_feedback(b, 2047);
    MotorBenchGetMeasure(1, &t);
    CHECK(t.status & 1);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(MotorBenchSetRef(0, 500) == MB_OK);
    tick();
    CHECK(output(a) != 0);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    CHECK(MotorBenchSetRef(1, 0) == MB_OK);
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    tick(); DMMotorControl();
    CHECK(output(a) == 0 && ref(1) == 0);
    CHECK(abs((int)dm_torque(b) - 2047) < 12); /* Quantized near-zero feedback. */
    CHECK(MotorBenchSetRef(1, 5) == MB_OK);
    tick(); DMMotorControl();
    CHECK(dm_torque(b) > 2047);
    CHECK(MotorBenchSetEnable(1, 0) == MB_OK);
    CHECK(b->motor_can_instace->tx_buff[7] == DM_CMD_RESET_MODE);
    CHECK(b->pid_ref == 0 && ref(1) == 0);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    tick();
    CHECK(output(a) == 0);
    now += 5000;
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    dm_feedback(b, 2500); /* Positive speed with zero target must brake. */
    tick(); DMMotorControl();
    CHECK(dm_torque(b) < 2047);
    CHECK(b->speed_PID.dt < 0.003f);
    dm_feedback(b, 2052); /* < 1 rad/s must still receive corrective torque. */
    tick(); DMMotorControl();
    CHECK(dm_torque(b) < 2047);
    b->daemon->temp_count = 0;
    CHECK(MotorBenchSetRef(1, 5) == MB_OK);
    tick(); DMMotorControl();
    CHECK(dm_torque(b) == 2047);
    if (!failures) puts("PASS mixed M2006 ID3 + DM4310 TX6/RX0x302, both directions");
    return failures ? 1 : 0;
}
static uint8_t create_dm(MB_MotorKind_e kind, uint8_t bus, uint8_t id, uint16_t rx, void **out) {
    CHECK(kind == MB_MOTOR_DM && bus == 1 && id == 6);
    factory_rx = rx;
    Motor_Init_Config_s c = {0};
    c.can_init_config.can_handle = &hcan1;
    c.can_init_config.tx_id = id;
    c.can_init_config.rx_id = rx;
    factory_motor = DMMotorInit(&c);
    *out = factory_motor;
    return MB_OK;
}
static void receive_hex(const char *hex) {
    unsigned len = (unsigned)strlen(hex) / 2;
    CHECK(len <= sizeof(usb_buffer));
    for (unsigned i = 0; i < len; ++i) {
        unsigned byte;
        sscanf(hex + 2*i, "%2x", &byte);
        usb_buffer[i] = (uint8_t)byte;
    }
    usb_receive((uint16_t)len);
    MotorBenchTask();
}
static void print_wire(const char *label) {
    printf("%s ", label);
    for (unsigned i = 0; i < usb_output_len; i++) printf("%02x", usb_output[i]);
    puts("");
    usb_output_len = 0;
}
static int dm_telemetry(void) {
    MotorBenchInitUSB();
    Motor_Init_Config_s config = {0};
    BenchBuildDMConfig(&config, &hcan1, 6, 0x302);
    DMMotorInstance *m = DMMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, m) == MB_OK);
    CHECK(MotorBenchBind(0, MB_MOTOR_DM, 1, 6, SPEED_LOOP) == MB_OK);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    /* Independent MIT feedback bytes: velocity=0x9ab / 0x678,
     * torque=0x345 / 0xabc. Opposite signs catch swapped fields. */
    const uint8_t frames[2][8] = {
        {6, 0x80, 0, 0x9a, 0xb3, 0x45, 25, 26},
        {6, 0x80, 0, 0x67, 0x8a, 0xbc, 25, 26},
    };
    const float speeds[] = {9.3956044f, -8.6043956f};
    const float torques[] = {-10.6417582f, 6.1582418f};
    for (unsigned n = 0; n < 2; ++n) {
        memcpy(m->motor_can_instace->rx_buff, frames[n], 8);
        m->motor_can_instace->rx_len = 8;
        m->motor_can_instace->can_module_callback(m->motor_can_instace);
        MB_TelemetryItem_s t;
        CHECK(MotorBenchGetMeasure(0, &t) == MB_OK);
        CHECK((t.status & 3) == 1); /* Feedback stays live while disabled. */
        CHECK(fabsf(t.measure_speed - speeds[n]) < 0.0001f);
        CHECK(fabsf(t.measure_torque - torques[n]) < 0.0001f);
        for (unsigned tick = 0; tick < 5; ++tick) {
            now += 2;
            MotorBenchTask();
        }
    }
    print_wire("DM_TELEMETRY_WIRE");
    return failures ? 1 : 0;
}
static int receive_add(const char *hex, const char *remove_hex) {
    MotorBenchInitUSB();
    MotorBenchSetMotorFactory(create_dm, NULL);
    receive_hex(hex);
    CHECK(factory_rx == 0x302);
    CHECK(factory_motor && factory_motor->motor_can_instace->rx_id == 0x302);
    CHECK(MotorBenchGetInventoryCount() == 1);
    MB_InventoryItemPublic_s item;
    CHECK(MotorBenchGetInventory(0, &item) == MB_OK && item.rx_id == 0x302);
    print_wire("ADD_WIRE");
    CHECK(MotorBenchRemoveMotor(MB_MOTOR_DM, 1, 6, 0x02) == MB_ERR_NOT_PROVISIONED);
    CHECK(MotorBenchGetInventoryCount() == 1);
    receive_hex(remove_hex);
    CHECK(MotorBenchGetInventoryCount() == 0);
    print_wire("REMOVE_WIRE");
    if (!failures) puts("PASS full RX 0x302 add, inventory round trip and remove; truncated RX rejected");
    return failures ? 1 : 0;
}
int main(int argc, char **argv) {
    if (argc == 4 && !strcmp(argv[1], "rx")) return receive_add(argv[2], argv[3]);
    if (argc == 4 && (!strcmp(argv[1], "reset") || !strcmp(argv[1], "reset-split"))) {
        MotorBenchInitUSB();
        receive_hex(argv[3]);
        DJIMotorInstance *a = make_motor(0, 1, 1);
        DJIMotorInstance *b = make_motor(7, 1, 2);
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        CHECK(MotorBenchSetRef(0, 1000) == MB_OK);
        CHECK(MotorBenchSetEnable(7, 1) == MB_OK);
        CHECK(MotorBenchSetRef(7, -500) == MB_OK);
        tick();
        CHECK(output(a) != 0 && output(b) != 0);
        if (!strcmp(argv[1], "reset-split")) {
            /* A 5-byte heartbeat before the 61-byte reset batch fills a 64-byte
             * USB packet after the first 59 reset bytes, splitting channel 7. */
            char prefix[256];
            unsigned chars = (unsigned)strlen(argv[2]) - 4;
            memcpy(prefix, argv[2], chars);
            prefix[chars] = '\0';
            receive_hex(prefix);
            receive_hex(argv[2] + chars);
            MB_TelemetryItem_s pending;
            CHECK(MotorBenchGetMeasure(7, &pending) == MB_OK);
            puts("PASS reproduced lost channel 7 when reset command crosses USB packet boundary");
            receive_hex(argv[2] + strlen(argv[2]) - 14);
        } else {
            /* Deliver the stop+first-unbind, then one acknowledged channel at
             * a time, matching the browser's current reset sequence. */
            char step[25];
            memcpy(step, argv[2], 24);
            step[24] = '\0';
            receive_hex(step);
            for (unsigned i = 0; i < 7; i++) {
                memcpy(step, argv[2] + 24 + i * 14, 14);
                step[14] = '\0';
                receive_hex(step);
            }
        }
        tick();
        CHECK(output(a) == 0 && output(b) == 0);
        CHECK(a->motor_controller.pid_ref == 0 && b->motor_controller.pid_ref == 0);
        MB_TelemetryItem_s item;
        for (unsigned i = 0; i < MB_CHANNEL_MAX; i++)
            CHECK(MotorBenchGetMeasure(i, &item) != MB_OK);
        CHECK(MotorBenchGetInventoryCount() == 2);
        print_wire("RESET_WIRE");
        CHECK(MotorBenchBind(0, MB_MOTOR_M3508, 1, 2, SPEED_LOOP) == MB_OK);
        CHECK(ref(0) == 0);
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        tick();
        CHECK(output(b) == 0);
        receive_hex(argv[2]);
        CHECK(MotorBenchGetInventoryCount() == 2);
        CHECK(MotorBenchGetMeasure(0, &item) != MB_OK);
        puts("PASS page reset stops and releases all eight channels, retains motor inventory and permits fresh zero-target binding");
        return failures ? 1 : 0;
    }
    if (argc != 2) return 2;
    if (!strcmp(argv[1], "dm-telemetry")) return dm_telemetry();
    if (!strcmp(argv[1], "dm-stability")) return dm_stability();
    if (!strcmp(argv[1], "mixed")) return mixed();
    DJIMotorInstance *a = make_motor(0, 1, 1);
    DJIMotorInstance *b = make_motor(1, 1, 2);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(MotorBenchSetRef(0, 1000) == MB_OK);
    for (int i = 0; i < 10; ++i) tick();
    CHECK(output(a) != 0);
    if (!strcmp(argv[1], "stop")) {
        CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
        CHECK(ref(0) == 0 && a->motor_controller.pid_ref == 0);
        CHECK(MotorBenchSetRef(0, 0) == MB_OK);
        CHECK(MotorBenchSetRef(0, 500) == MB_ERR_NOT_ENABLED);
        now += 10000;
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        tick();
        CHECK(output(a) == 0);
        CHECK(a->motor_controller.speed_PID.dt < 0.003f);
        CHECK(MotorBenchSetRef(0, 1000) == MB_OK);
        MotorBenchEmergencyStop();
        CHECK(ref(0) == 0 && a->motor_controller.pid_ref == 0);
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        tick();
        CHECK(output(a) == 0);
    } else if (!strcmp(argv[1], "windup")) {
        DJIMotorStop(a);
        CHECK(a->motor_controller.speed_PID.Iout == 0);
        a->measure.speed_aps = 600;
        for (int i = 0; i < 2000; ++i) tick();
        CHECK(a->motor_controller.speed_PID.Iout == 0);
        CHECK(a->motor_controller.speed_PID.Last_Err == 0);
        CHECK(output(a) == 0);
        a->measure.speed_aps = 0;
        DJIMotorSetRef(a, 0);
        DJIMotorEnable(a);
        tick();
        CHECK(output(a) == 0);
        CHECK(a->motor_controller.speed_PID.dt < 0.003f);
        CHECK(a->motor_controller.speed_PID.Kp == 1 && a->motor_controller.speed_PID.Ki == 2);
    } else if (!strcmp(argv[1], "binding")) {
        CHECK(MotorBenchBind(2, MB_MOTOR_M3508, 1, 1, SPEED_LOOP) == MB_ERR_DUPLICATE);
        CHECK(MotorBenchAttachInstance(1, MB_MOTOR_M3508, a) == MB_ERR_DUPLICATE);
        CHECK(a->stop_flag == MOTOR_ENALBED && ref(0) == 1000);
        CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
        CHECK(MotorBenchSetRef(1, 0) == MB_OK);
        tick();
        CHECK(output(a) != 0 && output(b) == 0);
    } else if (!strcmp(argv[1], "logging")) {
        CHECK(strstr(log_output, "[en] ch=0") != NULL);
        CHECK(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 2.5f, 0.1f, 0, 5000, 100, 0) == MB_OK);
        CHECK(strstr(log_output, "pid set: ch=0 loop=0") != NULL);
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        CHECK(MotorBenchSetRef(0, 0) == MB_OK);
        tick();
        CHECK(ref(0) == 0);
    } else if (!strcmp(argv[1], "peer")) {
        DJIMotorInstance *c = make_motor(2, 1, 5);
        DJIMotorInstance *d = make_motor(3, 2, 1);
        CHECK(MotorBenchSetEnable(2, 1) == MB_OK);
        CHECK(MotorBenchSetEnable(3, 1) == MB_OK);
        CHECK(MotorBenchSetRef(2, 100) == MB_OK);
        CHECK(MotorBenchSetRef(3, -100) == MB_OK);
        CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
        CHECK(MotorBenchSetRef(1, 0) == MB_OK);
        CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
        tick();
        CHECK(output(a) == 0 && output(b) == 0);
        CHECK(output(c) > 0 && output(d) < 0);
        CHECK(ref(2) == 100 && ref(3) == -100);
    } else return 2;
    if (!failures) printf("PASS %s\n", argv[1]);
    return failures ? 1 : 0;
}
`;

try {
  // Exercise the actual browser click handler and server command translator.
  const host = path.dirname(fileURLToPath(import.meta.url));
  const ui = fs.readFileSync(path.join(host, 'ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(host, 'server.js'), 'utf8');
  const clickBody = ui.match(/r\('enable'\)\.onclick = \(\) => \{([\s\S]*?)\n    \};/)[1];
  const handle = server.match(/function handleCommand\(cmd\) \{[\s\S]*?\n\}/)[0];
  const writes = [];
  const context = { Buffer, Number, buildEnable, buildSetRef,
    buildAllStop, buildUnbind,
    writeToSerial: (buf) => writes.push(buf), broadcast: () => {} };
  vm.runInNewContext(handle, context);
  let enabled = false;
  let accepted = true;
  const num = { value: '0' };
  const click = new Function('telemetryByChannel', 'i', 'num', 'confirm', 'send', 'canControlChannel', clickBody);
  const runClick = () => click(new Map([[1, { enabled }]]), 1, num, () => accepted,
    (cmd) => context.handleCommand(cmd), () => true);
  runClick();
  let frames = new FrameParser().push(writes.pop());
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, FrameType.MOTOR_ENABLE);
  assert.equal(frames[0].payload[0], 1);
  assert.equal(frames[1].type, FrameType.MOTOR_SET);
  assert.equal(frames[1].payload.readFloatLE(1), 0);
  num.value = '500'; accepted = false;
  runClick(); assert.equal(writes.length, 0);
  accepted = true; runClick();
  frames = new FrameParser().push(writes.pop());
  assert.equal(frames[1].payload.readFloatLE(1), 500);
  enabled = true; runClick();
  frames = new FrameParser().push(writes.pop());
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload[1], 0);
  console.log('PASS browser enable forwards the displayed zero/nonzero target, confirmation and stop');
  click(new Map(), 1, num, () => true, (cmd) => context.handleCommand(cmd), () => false);
  assert.equal(writes.length, 0, 'a fresh or unbound page must not enable an old board channel');
  context.handleCommand({ type: 'resetChannels' });
  const resetStart = writes.pop();
  const resetFrames = new FrameParser().push(resetStart);
  assert.equal(resetFrames[0].type, FrameType.ALL_STOP);
  assert.equal(resetFrames.length, 2, 'reset must start with only stop and channel 0');
  assert.deepEqual(resetFrames.slice(1).map(f => [f.type, f.payload[1]]),
    [[FrameType.MOTOR_UNBIND, 0]]);
  // Complete sequence for the native test, also reproduces the old 61-byte batch.
  const resetBytes = Buffer.concat([resetStart, ...Array.from({ length: 7 }, (_, i) => buildUnbind(i + 1))]);

  const resetFunction = ui.match(/function resetTestChannels\(\) \{[\s\S]*?\n\}/)?.[0];
  const resetStep = ui.match(/function sendResetChannel\(start = false\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resetFunction && resetStep);
  let resetTimeout = null;
  let resetNotice = '';
  const resetCommands = [];
  const resetContext = { serialConnected: true, channelResetPending: null, channelResetTimer: null, serverSupportsReset: false,
    channelResetError: '', channelResetAttempts: 0, clearTestChannels: () => {}, showRegistryMsg: () => {},
    setLink: (_ok, text) => { resetNotice = text; },
    clearTimeout: () => {},
    setTimeout: callback => { resetTimeout = callback; return 1; },
    send: command => resetCommands.push(command) };
  vm.runInNewContext(resetFunction + '\n' + resetStep, resetContext);
  resetContext.resetTestChannels();
  assert.equal(resetCommands.length, 0, 'old backends must not receive unsupported reset commands');
  assert.equal(resetTimeout, null, 'version mismatch must fail before entering the wait state');
  assert.match(resetNotice, /后台版本过旧/);
  resetContext.serverSupportsReset = true;
  resetContext.resetTestChannels();
  assert.equal(resetCommands[0].type, 'resetChannels');
  assert.equal(resetContext.channelResetPending.size, 8);
  for (let attempt = 0; attempt < 3; attempt++) resetTimeout();
  assert.equal(resetContext.channelResetPending, null);
  assert.match(resetNotice, /0、1、2、3、4、5、6、7.*清理超时/);
  assert.equal(resetCommands.length, 3, 'reset retries must be bounded');
  assert.ok(resetCommands.slice(1).every(c => c.type === 'unbind' && c.channelId === 0));
  resetContext.channelResetPending = new Set([7]);
  resetContext.channelResetAttempts = 0;
  resetContext.sendResetChannel();
  assert.equal(resetCommands.at(-1).channelId, 7, 'retry must target the unconfirmed channel only');
  console.log('PASS backend version check, per-channel reset retries, bounded timeout and missing channel 7 recovery');

  const heartbeatStart = server.match(/function startHeartbeat\(\) \{[\s\S]*?\n\}/)?.[0];
  const heartbeatStop = server.match(/function stopHeartbeat\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(heartbeatStart && heartbeatStop);
  const activeIntervals = new Map();
  let timerId = 0;
  const heartbeatContext = { heartbeatTimer: null, heartbeatBurstTimer: null, buildHeartbeat,
    writeToSerial: () => {}, setInterval: callback => { activeIntervals.set(++timerId, callback); return timerId; },
    clearInterval: id => activeIntervals.delete(id) };
  vm.runInNewContext(heartbeatStart + '\n' + heartbeatStop, heartbeatContext);
  heartbeatContext.startHeartbeat();
  assert.equal(activeIntervals.size, 2);
  heartbeatContext.stopHeartbeat();
  assert.equal(activeIntervals.size, 0, 'closing USB must cancel both startup and steady heartbeats');
  heartbeatContext.startHeartbeat();
  const burstCallback = activeIntervals.get(heartbeatContext.heartbeatBurstTimer);
  for (let i = 0; i < 8; i++) burstCallback();
  assert.equal(activeIntervals.size, 1);
  heartbeatContext.stopHeartbeat();
  assert.equal(activeIntervals.size, 0);

  const closeFunction = server.match(/async function closeSerial\(\) \{[\s\S]*?\n\}/)?.[0];
  let completeClose;
  const closeContext = { serialPort: { isOpen: true, close: callback => { completeClose = callback; } },
    stopHeartbeat: () => {} };
  vm.runInNewContext(closeFunction, closeContext);
  const closing = closeContext.closeSerial();
  assert.equal(closeContext.serialPort, null);
  const reopened = { isOpen: true };
  closeContext.serialPort = reopened;
  completeClose();
  await closing;
  assert.equal(closeContext.serialPort, reopened, 'a late close callback must not erase a new USB connection');
  console.log('PASS fast serial reconnect cancels old heartbeat timers and preserves the new port');

  for (const [name, content] of Object.entries(stubs)) fs.writeFileSync(path.join(tmp, name), content);
  const main = path.join(tmp, 'motor_state.c');
  fs.writeFileSync(main, harness);
  const compiler = ['gcc', 'clang', 'C:/msys64/mingw64/bin/gcc.exe'].find((cc) => {
    try { execFileSync(cc, ['--version'], { env, stdio: 'pipe' }); return true; } catch { return false; }
  });
  if (!compiler) throw new Error('Native gcc/clang is required for motor state regression tests');
  const includes = [tmp, 'modules', 'modules/motor', 'modules/motor/DJImotor',
    'modules/motor/DMmotor', 'modules/motor_bench', 'modules/algorithm',
    'modules/daemon', 'bsp/can', 'bsp/usart', 'bsp/log', 'application',
    'Middlewares/Third_Party/SEGGER/RTT', 'Middlewares/Third_Party/SEGGER/Config']
    .flatMap((p) => ['-I', path.isAbsolute(p) ? p : path.join(root, p)]);
  const sources = ['modules/motor_bench/motor_bench.c', 'modules/motor/DJImotor/dji_motor.c',
    'modules/motor/DMmotor/dmmotor.c', 'modules/algorithm/controller.c',
    'modules/algorithm/crc8.c', 'Middlewares/Third_Party/SEGGER/RTT/SEGGER_RTT_printf.c']
    .map((p) => path.join(root, p));
  const exe = path.join(tmp, 'motor_state.exe');
  execFileSync(compiler, ['-std=gnu11', '-O1', '-ffunction-sections', '-fdata-sections',
    ...includes, main, ...sources, '-Wl,--gc-sections', '-lm', '-o', exe], { env, stdio: 'pipe' });
  let failed = false;
  {
    const output = execFileSync(exe, ['dm-telemetry'], { env, encoding: 'utf8', stdio: 'pipe' });
    const hex = output.match(/DM_TELEMETRY_WIRE ([0-9a-f]+)/)?.[1];
    assert.ok(hex, 'capture real firmware telemetry after DM CAN feedback decoding');
    const frames = new FrameParser().push(Buffer.from(hex, 'hex')).filter(f => f.type === FrameType.TELEMETRY);
    assert.equal(frames.length, 1);
    const t = parseTelemetry(frames[0].payload).items[0];
    assert.equal(t.enabled, false);
    assert.equal(t.online, true);
    assert.ok(Math.abs(t.speed - 0.3956044) < 0.0001, `averaged speed was ${t.speed}`);
    assert.ok(Math.abs(t.torque - (-2.2417582)) < 0.0001, `averaged torque was ${t.torque}`);
    console.log('PASS independent MIT feedback vectors through real DM decoder, disabled telemetry averaging, USB framing and host parsing; speed/torque are not swapped');
  }
  for (const scenario of ['stop', 'windup', 'binding', 'peer', 'mixed', 'logging', 'dm-stability']) {
    try { process.stdout.write(execFileSync(exe, [scenario], { env, stdio: 'pipe' })); }
    catch (error) {
      failed = true;
      process.stderr.write(`FAIL ${scenario}: exit=${error.status} signal=${error.signal}\n`);
      if (error.stdout?.length) process.stdout.write(error.stdout);
      process.stderr.write(error.stderr?.length ? error.stderr : error.message);
    }
  }
  try {
    const output = execFileSync(exe, ['rx', buildMotorAdd(MotorKind.DM, 1, 6, 0x302).toString('hex'),
      buildMotorRemove(MotorKind.DM, 1, 6, 0x302).toString('hex')], { env, encoding: 'utf8', stdio: 'pipe' });
    for (const [tag, count] of [['ADD_WIRE', 1], ['REMOVE_WIRE', 0]]) {
      const hex = output.match(new RegExp(`${tag} ([0-9a-f]+)`))?.[1];
      assert.ok(hex, `${tag} must capture actual firmware USB output`);
      const report = new FrameParser().push(Buffer.from(hex, 'hex')).find(f => f.type === FrameType.INVENTORY_REPORT);
      assert.ok(report, `${tag} must include a valid inventory frame with CRC`);
      const inventory = parseInventory(report.payload);
      assert.equal(inventory.count, count);
      if (count) assert.equal(inventory.items[0].rxId, 0x302);
    }
    process.stdout.write(output.split('\n').filter(line => !line.includes('_WIRE')).join('\n'));
  } catch (error) { failed = true; process.stderr.write(error.stderr ?? error.message); }
  if (failed) process.exitCode = 1;
  for (const scenario of ['reset', 'reset-split']) {
    const resetOutput = execFileSync(exe, [scenario, resetBytes.toString('hex'), buildHeartbeat().toString('hex')],
      { env, encoding: 'utf8', stdio: 'pipe' });
    const wire = resetOutput.match(/RESET_WIRE ([0-9a-f]+)/)?.[1];
    assert.ok(wire, 'reset must receive real board acknowledgements');
    const resetAcks = new FrameParser().push(Buffer.from(wire, 'hex')).filter(f => f.type === FrameType.UNBIND_ACK);
    assert.equal(resetAcks.length, 8);
    assert.deepEqual(resetAcks.map(f => [f.payload[0], f.payload[1]]),
      Array.from({ length: 8 }, (_, i) => [i, i === 0 || i === 7 ? 0 : 1]));
    process.stdout.write(resetOutput.split('\n').filter(line => !line.includes('_WIRE')).join('\n'));
  }
} catch (error) {
  process.stderr.write(String(error.stderr ?? error.stack));
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
