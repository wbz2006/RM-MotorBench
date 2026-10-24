// Compile the real firmware control path; stub only hardware and time.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { MotorKindLabel } from './protocol.js';
import assert from 'node:assert/strict';
import { firmwareRoot } from './firmware_test_paths.js';
import { FrameParser, FrameType, buildEnable, buildSetRef, buildPositionStep, parsePositionStepAck, buildMotorAdd, buildMotorRemove, buildAllStop, buildUnbind, buildHeartbeat, buildSetPid, buildSetLoop, parseHeartbeatAck, parseLoopSetAck, parsePidReport, parseInventory, parseTelemetry, MotorKind, PID_DEFAULTS } from './protocol.js';

const root = firmwareRoot;
const supportsAutoReconnect = fs.readFileSync(path.join(root, 'bsp/can/bsp_can.h'), 'utf8').includes('CANServiceTask');
const appSource = fs.readFileSync(path.join(root, 'application/motor_bench_app/motor_bench_app.c'), 'utf8');
const dmConfigBuilder = appSource.match(/static void BenchBuildDMConfig\([\s\S]*?\n\}/)?.[0];
const motorDestroy = appSource.match(/static void BenchMotorDestroy\([\s\S]*?\n\}/)?.[0];
const supportsDm8009p = appSource.includes('MB_MOTOR_DM8009P');
const supportsDmIntegralHold = fs.readFileSync(path.join(root, 'modules/algorithm/controller.h'), 'utf8').includes('PIDCalculateWithIntegralHold');
const supportsDmSpeedRamp = fs.readFileSync(path.join(root, 'modules/algorithm/controller.h'), 'utf8').includes('SpeedRampApply');
/*
 * 2026-10-19:LK/HT 接入后,工厂里新增了对 BenchBuildLKConfig /
 * BenchBuildHTConfig 的调用。harness 是按"从 app 源码里抽取函数原文"
 * 的方式编译的,所以这两个 builder 也必须一并抽取,否则报
 * implicit declaration。
 */
const lkConfigBuilder = appSource.match(/static void BenchBuildLKConfig\([\s\S]*?\n\}/)?.[0];
const htConfigBuilder = appSource.match(/static void BenchBuildHTConfig\([\s\S]*?\n\}/)?.[0];
const supportsLkHt = !!lkConfigBuilder && !!htConfigBuilder;
const motorFactory = appSource.match(/static uint8_t BenchMotorFactory\([\s\S]*?\n\}/)?.[0];
assert.ok(motorFactory, 'profile tests must use the actual application factory');
assert.ok(motorDestroy, 'deletion tests must use the actual application destructor');
assert.ok(dmConfigBuilder, 'DM tests must use the actual application defaults');
if (supportsLkHt) {
  assert.ok(lkConfigBuilder && htConfigBuilder, 'LK/HT builders must be extractable');
}
const djiConfigSection = appSource.slice(appSource.indexOf('#define BENCH_PID_TABLE_SIZE'), appSource.indexOf('static void BenchBuildDMConfig('));
assert.ok(djiConfigSection.includes('static void BenchBuildDJIConfig('));
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
static inline uint32_t __get_PRIMASK(void) { return 0; }
static inline void __disable_irq(void) {}
static inline void __set_PRIMASK(uint32_t value) { (void)value; }
typedef struct { int gState; } UART_HandleTypeDef;
#define HAL_UART_STATE_READY 0
uint32_t HAL_GetTick(void);
`,
  'can.h': `#pragma once
#include "main.h"
typedef struct { int unused; } CAN_HandleTypeDef;
#define HAL_OK 0
#define HAL_ERROR 1
#define CAN_TX_MAILBOX0 1u
#define CAN_TX_MAILBOX1 2u
#define CAN_TX_MAILBOX2 4u
typedef struct { uint32_t StdId, IDE, RTR, DLC; } CAN_TxHeaderTypeDef;
typedef CAN_TxHeaderTypeDef CAN_RxHeaderTypeDef;
typedef struct { uint32_t FilterMode, FilterScale, FilterFIFOAssignment, SlaveStartFilterBank,
    FilterIdLow, FilterIdHigh, FilterMaskIdLow, FilterMaskIdHigh, FilterBank, FilterActivation; } CAN_FilterTypeDef;
extern CAN_HandleTypeDef hcan1, hcan2;
#define CAN_ID_STD 0
#define CAN_RTR_DATA 0
#define CAN_FILTERMODE_IDLIST 1
#define CAN_FILTERSCALE_16BIT 0
#define CAN_FILTER_ENABLE 1
#define CAN_FILTER_DISABLE 0
#define CAN_RX_FIFO0 0
#define CAN_RX_FIFO1 1
#define CAN_IT_RX_FIFO0_MSG_PENDING 2
#define CAN_IT_RX_FIFO1_MSG_PENDING 4
void HAL_CAN_Start(CAN_HandleTypeDef *can);
void HAL_CAN_ActivateNotification(CAN_HandleTypeDef *can, uint32_t flags);
void HAL_CAN_ConfigFilter(CAN_HandleTypeDef *can, CAN_FilterTypeDef *filter);
uint32_t HAL_CAN_GetTxMailboxesFreeLevel(CAN_HandleTypeDef *can);
int HAL_CAN_AddTxMessage(CAN_HandleTypeDef *can, CAN_TxHeaderTypeDef *header, uint8_t *bytes, uint32_t *mailbox);
uint32_t HAL_CAN_IsTxMessagePending(CAN_HandleTypeDef *can, uint32_t mailbox);
int HAL_CAN_AbortTxRequest(CAN_HandleTypeDef *can, uint32_t mailbox);
void HAL_CAN_GetRxMessage(CAN_HandleTypeDef *can, uint32_t fifo, CAN_RxHeaderTypeDef *header, uint8_t *bytes);
`,
  'arm_math.h': '#pragma once\n',
  /*
   * cmsis_os.h stub —— 2026-10-19 扩展。
   *
   * HT04.c 的 HTMotorControlInit() 用 osThreadDef / osThreadCreate
   * 给每颗 HT 电机建任务,而原来的 stub 只有 vTaskSuspendAll /
   * xTaskResumeAll,远远不够。这里补上 CMSIS-RTOS v1 的线程 API 桩
   * (返回 NULL / 空实现),让 HT04.c 能链上;
   * 测试并不真正跑那些任务,只是需要符号存在。
   */
  'cmsis_os.h': `#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
typedef void *osThreadId;
typedef void (*os_pthread)(void const *);
#define osPriorityNormal 0
static inline void vTaskSuspendAll(void) {}
static inline void xTaskResumeAll(void) {}
void test_os_delay(uint32_t ms);
static inline void osDelay(uint32_t ms) { test_os_delay(ms); }
/* HT04.c 用 __itoa();本机工具链是 MinGW,没有这个 newlib 符号,补一个桩 */
static inline char *__itoa(int value, char *buf, int radix) { (void)radix; sprintf(buf, "%d", value); return buf; }
/* HT04.c 用 osThreadDef(name,fn,prio,inst,stack) 定义一个线程描述符,
 * 再用 osThread(name) 取它、交给 osThreadCreate。测试不真跑这些任务,
 * 只要符号能链上即可,故 osThreadCreate 直接返回 NULL。 */
#define osThreadDef(name, thread, priority, instances, stacksz) \\
  static const struct { const char *n; os_pthread f; } os_##name = { #name, thread }
#define osThread(name) (&os_##name)
static inline osThreadId osThreadCreate(const void *td, void const *arg) { (void)td; (void)arg; return NULL; }
`,
  'bsp_dwt.h': `#pragma once
#include <stdint.h>
float DWT_GetDeltaT(uint32_t *last);
float DWT_GetTimeline_s(void);
float DWT_GetTimeline_ms(void);
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
${supportsAutoReconnect ? '#define MB_AUTO_RECONNECT_TEST 1' : ''}

#include <setjmp.h>
static jmp_buf ht_iteration_end;
static int ht_step_active;
void test_os_delay(uint32_t ms) { (void)ms; if (ht_step_active) longjmp(ht_iteration_end, 1); }
extern void HTMotorTask(void const *argument);
static void ht_step(HTMotorInstance *m) {
    if (setjmp(ht_iteration_end) == 0) { ht_step_active = 1; HTMotorTask(m); }
    ht_step_active = 0;
}
CAN_HandleTypeDef hcan1, hcan2;
static uint32_t now = 1000;
static uint8_t override_dt;
static float injected_dt;
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
float DWT_GetDeltaT(uint32_t *last) {
    float dt = (now - *last) / 1000.0f;
    *last = now;
    return override_dt ? injected_dt : dt;
}
float DWT_GetTimeline_s(void) { return now / 1000.0f; }
static float poll_elapsed;
static uint32_t poll_tick;
float DWT_GetTimeline_ms(void) {
    if (poll_tick != now) { poll_tick = now; poll_elapsed = 0; }
    poll_elapsed += 0.01f;
    return now + poll_elapsed;
}
void DWT_Delay(float seconds) { now += (uint32_t)(seconds * 1000); }
static CAN_FilterTypeDef hardware_filters[28];
void HAL_CAN_Start(CAN_HandleTypeDef *can) { (void)can; }
void HAL_CAN_ActivateNotification(CAN_HandleTypeDef *can, uint32_t flags) { (void)can; (void)flags; }
void HAL_CAN_ConfigFilter(CAN_HandleTypeDef *can, CAN_FilterTypeDef *filter) {
    (void)can; CHECK(filter->FilterBank < 28);
    if (filter->FilterBank < 28) hardware_filters[filter->FilterBank] = *filter;
}
static unsigned pending_tx[2], aborted_tx[2], hold_tx[2], tx_fail[2], release_after[2];
static unsigned mode_count[256];
static unsigned query_count[2];
static uint8_t last_query[2][4];
uint32_t HAL_CAN_GetTxMailboxesFreeLevel(CAN_HandleTypeDef *can) {
    unsigned bus = can == &hcan2;
    if (release_after[bus] && !--release_after[bus]) pending_tx[bus] &= ~1u;
    unsigned mask = pending_tx[bus];
    return 3 - !!(mask & 1) - !!(mask & 2) - !!(mask & 4);
}
uint32_t HAL_CAN_IsTxMessagePending(CAN_HandleTypeDef *can, uint32_t mailbox) {
    return !!(pending_tx[can == &hcan2] & mailbox);
}
int HAL_CAN_AbortTxRequest(CAN_HandleTypeDef *can, uint32_t mailbox) {
    pending_tx[can == &hcan2] &= ~mailbox;
    aborted_tx[can == &hcan2] |= mailbox;
    return HAL_OK;
}
int HAL_CAN_AddTxMessage(CAN_HandleTypeDef *can, CAN_TxHeaderTypeDef *header, uint8_t *bytes, uint32_t *mailbox) {
    unsigned bus = can == &hcan2;
    if (tx_fail[bus]) return HAL_ERROR;
    *mailbox = 0;
    for (unsigned i = 0; i < 3; i++) if (!(pending_tx[bus] & (1u << i))) {
        *mailbox = 1u << i; break;
    }
    if (!*mailbox) return HAL_ERROR;
    if (hold_tx[bus]) pending_tx[bus] |= *mailbox;
    if (header->StdId == 0x7ff) {
        CHECK(header->DLC == 4);
        query_count[bus]++; memcpy(last_query[bus], bytes, 4);
    }
    if (bytes[0] == 0xff && bytes[1] == 0xff && bytes[6] == 0xff) mode_count[bytes[7]]++;
    unsigned group = header->StdId == 0x200 ? 1 : header->StdId == 0x2ff ? 2 : 0;
    memcpy(sent[can == &hcan2][group], bytes, 8);
    return HAL_OK;
}
void HAL_CAN_GetRxMessage(CAN_HandleTypeDef *can, uint32_t fifo, CAN_RxHeaderTypeDef *header, uint8_t *bytes) {
    (void)can; (void)fifo; memset(header, 0, sizeof(*header)); memset(bytes, 0, 8);
}

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
    DaemonReload(m->daemon); /* A real motor reports before the user enables. */
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
${djiConfigSection}
${dmConfigBuilder}
${supportsLkHt ? lkConfigBuilder : ''}
${supportsLkHt ? htConfigBuilder : ''}
${motorDestroy}
${supportsDm8009p ? motorFactory : ''}
static int lifecycle(void) {
    MotorBenchSetMotorFactory(NULL, BenchMotorDestroy);
    DJIMotorInstance *peer = make_motor(7, 1, 2);
    uint8_t peer_bank = peer->motor_can_instance->filter_bank;
    CHECK(MotorBenchSetEnable(7, 1) == MB_OK);
    CHECK(MotorBenchSetRef(7, 100) == MB_OK);
    for (unsigned round = 0; round < 100; round++) {
        DJIMotorInstance *a = make_motor(0, 1, 1);
        Motor_Init_Config_s config = {0};
        BenchBuildDMConfig(&config, &hcan1, 6, 0x302);
        DMMotorInstance *b = DMMotorInit(&config);
        CHECK(b != NULL);
        CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, b) == MB_OK);
        CHECK(MotorBenchBind(1, MB_MOTOR_DM, 1, 6, SPEED_LOOP) == MB_OK);
        dm_feedback(b, 2047);
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        CHECK(MotorBenchSetRef(0, 1000) == MB_OK);
        CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
        CHECK(MotorBenchSetRef(1, 1) == MB_OK);
        DaemonReload(peer->daemon); MotorBenchReloadLink();
        tick(); DMMotorControl();
        CHECK(output(a) != 0 && output(peer) != 0);
        uint8_t dm_bank = b->motor_can_instace->filter_bank;
        CHECK(MotorBenchRemoveMotor(MB_MOTOR_M3508, 1, 1, 0) == MB_OK);
        MB_TelemetryItem_s t;
        CHECK(MotorBenchGetMeasure(0, &t) == MB_ERR_BAD_PARAM);
        CHECK(MotorBenchGetMeasure(1, &t) == MB_OK);
        CHECK(CANGetFilterFree(&hcan1) == 12);
        /* Add into the freed middle bank; DM and peer filters must survive. */
        DJIMotorInstance *c = make_motor(0, 1, 3);
        CHECK(c != NULL);
        CHECK(hardware_filters[dm_bank].FilterIdLow == (0x302u << 5));
        CHECK(hardware_filters[peer_bank].FilterIdLow == (0x202u << 5));
        tick(); DMMotorControl(); DaemonTask();
        CHECK(output(peer) != 0 && ref(7) == 100);
        CHECK(MotorBenchRemoveMotor(MB_MOTOR_M3508, 1, 3, 0) == MB_OK);
        CHECK(MotorBenchRemoveMotor(MB_MOTOR_DM, 1, 6, 0x302) == MB_OK);
        CHECK(MotorBenchGetMeasure(1, &t) == MB_ERR_BAD_PARAM);
        CHECK(MotorBenchGetInventoryCount() == 1 && CANGetFilterFree(&hcan1) == 13);
        tick(); DMMotorControl(); DaemonTask();
        CHECK(output(peer) != 0);
    }
    CHECK(MotorBenchRemoveMotor(MB_MOTOR_M3508, 1, 2, 0) == MB_OK);
    CHECK(MotorBenchGetInventoryCount() == 0 && CANGetFilterFree(&hcan1) == 14);
    tick(); DMMotorControl(); DaemonTask();
    puts("PASS 100 actual DJI/DM add/remove cycles: freed channel bindings, driver/daemon registries, reusable middle filter banks and uninterrupted peer channel 7");
    return failures ? 1 : 0;
}
static int dm_stability(void) {
    /* Tests the shared low-gain builder, not the user-selected factory profile:
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
        CHECK(peak_torque <= 3.01f);
        CHECK(peak < 0.5f);
        CHECK(tail_peak < 0.2f);
        /* A large command must respect the commissioning torque limit too. */
        dm_feedback(m, 2048);
        DMMotorSetRef(m, 100);
        now += 2; DMMotorControl();
        float positive = DM_T_MIN + dm_torque(m) * (DM_T_MAX - DM_T_MIN) / 4095;
        CHECK(positive > 0 && positive <= 3.01f);
        DMMotorSetRef(m, -100);
        now += 2; DMMotorControl();
        float negative = DM_T_MIN + dm_torque(m) * (DM_T_MAX - DM_T_MIN) / 4095;
        CHECK(negative < 0 && negative >= -3.01f);
        DMMotorStop(m);
        printf("DM model %u: peak=%.3f tail=%.3f torque=%.3f\n", test, peak, tail_peak, peak_torque);
    }
    if (!failures) puts("PASS DM shared low-torque baseline zero-speed stability with delayed feedback");
    return failures ? 1 : 0;
}
static int dm_zero_integral(void) {
    for (unsigned model = 0; model < 2; ++model) {
        Motor_Init_Config_s config = {0};
        BenchBuildDMConfig(&config, &hcan1, model + 1, 0x300 + model);
        config.controller_param_init_config.speed_PID = (PID_Init_Config_s){
            .Kp = 0.55f, .Ki = 5, .MaxOut = 7, .IntegralLimit = 100,
            .Improve = PID_Integral_Limit };
        DMMotorInstance *m = DMMotorInitWithModel(&config, model ? DM_MODEL_8009P : DM_MODEL_4310);
        CHECK(m != NULL);
        dm_feedback(m, 2047);
        DMMotorEnable(m);
        DMMotorSetRef(m, 0);
        for (unsigned raw = 2047; raw <= 2048; ++raw) {
            PIDReset(&m->speed_PID);
            // One minute at either nearest-to-zero code must not build torque.
            for (unsigned n = 0; n < 30000; ++n) {
                dm_feedback(m, raw);
                now += 2; DMMotorControl();
            }
            CHECK(m->speed_PID.Iout == 0);
            CHECK(fabsf(m->speed_PID.Output) < 0.01f);
            CHECK(m->speed_PID.Ki == 5 && m->measure.velocity != 0);
            for (int direction = -1; direction <= 1; direction += 2) {
                m->speed_PID.Iout = direction * 0.6f;
                for (unsigned n = 0; n < 1000; ++n) {
                    dm_feedback(m, raw);
                    now += 2; DMMotorControl();
                }
                CHECK(fabsf(m->speed_PID.Iout - direction * 0.6f) < 0.00001f);
                CHECK(fabsf(m->speed_PID.Output - direction * 0.6f) < 0.01f);
            }
        }
        // Exact zero and a configured PID deadband must also retain holding torque.
        m->measure.velocity = 0;
        m->speed_PID.DeadBand = 0.02f;
        now += 2; DMMotorControl();
        CHECK(fabsf(m->speed_PID.Output - 0.6f) < 0.00001f);
        m->speed_PID.DeadBand = 0;
        for (unsigned raw = 2046; raw <= 2049; raw += 3) {
            PIDReset(&m->speed_PID);
            dm_feedback(m, raw);
            now += 2; DMMotorControl();
            CHECK(m->speed_PID.Iout * m->measure.velocity < 0);
        }
        // Even a small nonzero command must keep its normal integral action.
        PIDReset(&m->speed_PID);
        dm_feedback(m, 2047);
        DMMotorSetRef(m, 0.001f);
        now += 2; DMMotorControl();
        CHECK(m->speed_PID.Iout > 0);
        // The speed loop in the position cascade uses the same rule.
        DMMotorOuterLoop(m, ANGLE_AND_SPEED_LOOP);
        DMMotorEnable(m);
        DMMotorSetRef(m, m->measure.position * RAD_2_DEGREE);
        now += 2; DMMotorControl();
        CHECK(m->speed_PID.Iout == 0);
        DMMotorSetRef(m, m->pid_ref + 1);
        now += 2; DMMotorControl();
        CHECK(m->speed_PID.Iout > 0);
        DMMotorStop(m);
        CHECK(m->speed_PID.Iout == 0);
    }
    if (!failures) puts("PASS DM4310/DM8009P Ki=5: 60s at both zero codes, retained holding torque, real motion/nonzero targets and position cascade");
    return failures ? 1 : 0;
}
static int dm_invalid_control(void) {
    Motor_Init_Config_s config = {0};
    BenchBuildDMConfig(&config, &hcan1, 1, 0x11);
    DMMotorInstance *m = DMMotorInitWithModel(&config, DM_MODEL_8009P);
    CHECK(m != NULL);
    const float intervals[] = {0, -0.002f, NAN, INFINITY, 1.0f};
    for (unsigned i = 0; i < sizeof(intervals) / sizeof(intervals[0]); ++i) {
        dm_feedback(m, 2047);
        DMMotorEnable(m);
        DMMotorSetRef(m, 0);
        override_dt = 1; injected_dt = intervals[i];
        now += 2; DMMotorControl();
        override_dt = 0;
        CHECK(m->stop_flag == MOTOR_STOP);
        CHECK(isfinite(m->speed_PID.Output) && m->speed_PID.Output == 0);
        CHECK(m->motor_can_instace->tx_buff[7] == DM_CMD_RESET_MODE);
        now += 2; DMMotorControl();
        CHECK(m->stop_flag == MOTOR_STOP); // No automatic restart after recovery.
    }
    // An invalid state or reference must never reach a float-to-CAN conversion.
    for (unsigned test = 0; test < 4; ++test) {
        dm_feedback(m, 2047);
        DMMotorEnable(m);
        DMMotorSetRef(m, test == 0 ? NAN : 0);
        if (test == 1) m->speed_PID.Iout = NAN;
        if (test == 2) m->measure.velocity = NAN;
        if (test == 3) m->speed_PID.Iout = INFINITY;
        now += 2; DMMotorControl();
        CHECK(m->stop_flag == MOTOR_STOP);
        CHECK(m->motor_can_instace->tx_buff[7] == DM_CMD_RESET_MODE);
    }
    // Normal timing must still produce a bounded finite command.
    dm_feedback(m, 2047);
    DMMotorEnable(m);
    DMMotorSetRef(m, 0);
    now += 2; DMMotorControl();
    CHECK(m->stop_flag == MOTOR_ENALBED);
    CHECK(isfinite(m->speed_PID.Output) && fabsf(m->speed_PID.Output) < 0.01f);
    DMMotorStop(m);
    if (!failures) puts("PASS invalid PID dt (zero/negative/NaN/Inf/long gap) and nonfinite control stop DM before CAN encoding; recovery stays stopped");
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
    DaemonReload(a->daemon);
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
    ${supportsAutoReconnect ? 'CHECK(b->stop_flag == MOTOR_STOP && b->pid_ref == 0); CHECK(b->motor_can_instace->tx_buff[7] == DM_CMD_RESET_MODE);' : 'CHECK(dm_torque(b) == 2047);'}
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
static int loop_switch(void) {
    MotorBenchInitUSB();
    DJIMotorInstance *a = make_motor(0, 1, 3);
    DJIMotorInstance *peer = make_motor(7, 2, 1);
    Motor_Init_Config_s config = {0};
    BenchBuildDMConfig(&config, &hcan1, 6, 0x302);
    DMMotorInstance *b = DMMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, b) == MB_OK);
    CHECK(MotorBenchBind(1, MB_MOTOR_DM, 1, 6, SPEED_LOOP) == MB_OK);
    dm_feedback(b, 2047);
    CHECK(MotorBenchSetEnable(7, 1) == MB_OK);
    CHECK(MotorBenchSetRef(7, 100) == MB_OK);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 1.5f, 0, 0, 1000, 0, 0) == MB_OK);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 2.5f, 0, 0, 1000, 0, 0) == MB_OK);
    CHECK(a->motor_controller.speed_PID.Kp == 2.5f);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_ANGLE, 3, 0, 0, 100, 0, 0) == MB_OK);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_ANGLE, 4.5f, 0, 0, 100, 0, 0) == MB_OK);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(MotorBenchSetRef(0, 300) == MB_OK);
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    CHECK(MotorBenchSetRef(1, 3) == MB_OK);
    tick(); DMMotorControl();
    a->motor_controller.speed_PID.Iout = 250;
    b->speed_PID.Iout = 0.2f;
    receive_hex("${buildHeartbeat().toString('hex')}");
    receive_hex("${buildSetLoop(0, 7).toString('hex')}");
    CHECK(a->stop_flag == MOTOR_STOP && ref(0) == 0);
    CHECK(a->motor_settings.outer_loop_type == ALL_THREE_LOOP);
    CHECK(a->motor_controller.speed_PID.Iout == 0 && a->motor_controller.pid_ref == 0);
    CHECK(a->motor_controller.speed_PID.Kp == 2.5f);
    CHECK(a->motor_controller.angle_PID.Kp == 4.5f);
    a->daemon->temp_count = 10;
    a->measure.total_angle = 1800;
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(a->motor_controller.pid_ref == 1800);
    receive_hex("${buildSetLoop(0, 3).toString('hex')}");
    CHECK(a->stop_flag == MOTOR_STOP && a->motor_controller.pid_ref == 0);
    CHECK(a->motor_settings.outer_loop_type == SPEED_AND_CURRENT_LOOP);
    receive_hex("${buildSetLoop(1, 7).toString('hex')}");
    CHECK(b->stop_flag == MOTOR_STOP && b->speed_PID.Iout == 0 && b->pid_ref == 0);
    CHECK(b->motor_settings.outer_loop_type == ALL_THREE_LOOP);
    b->measure.position = 2;
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    CHECK(fabsf(b->pid_ref - 114.591559f) < 0.001f);
    receive_hex("${buildSetLoop(1, 3).toString('hex')}");
    CHECK(b->stop_flag == MOTOR_STOP && b->pid_ref == 0);
    receive_hex("${buildSetLoop(1, 1).toString('hex')}");
    CHECK(b->motor_settings.outer_loop_type == SPEED_AND_CURRENT_LOOP);
    receive_hex("${buildSetLoop(0, 5).toString('hex')}");
    receive_hex("${buildSetLoop(8, 3).toString('hex')}");
    CHECK(a->motor_settings.outer_loop_type == SPEED_AND_CURRENT_LOOP);
    CHECK(MotorBenchGetInventoryCount() == 3);
    MB_TelemetryItem_s t;
    CHECK(MotorBenchGetMeasure(0, &t) == MB_OK);
    CHECK(MotorBenchGetMeasure(1, &t) == MB_OK);
    CHECK(MotorBenchGetMeasure(7, &t) == MB_OK && (t.status & 2));
    tick(); CHECK(output(peer) != 0 && ref(7) == 100);
    print_wire("LOOP_WIRE");
    puts("PASS bound DJI/DM speed-position switches: stop, zero target/history, preserve PID/bindings, fresh enable origin and uninterrupted peer; repeated PID edits need no unbind");
    return failures ? 1 : 0;
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
    const float speeds[] = {6.26373626f, -5.73626374f};
    const float torques[] = {-5.91208791f, 3.42124542f};
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
static int feeder_steps(void) {
    MotorBenchInitUSB();
    Motor_Init_Config_s config = {0};
    BenchBuildDJIConfig(&config, M2006, &hcan1, 3);
    DJIMotorInstance *a = DJIMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_M2006, 1, 3, 0, SPEED_LOOP, a) == MB_OK);
    /* Feeder step path must preserve large geared moves and reject mid-move retriggers. */
    CHECK(MotorBenchBind(0, MB_MOTOR_M2006, 1, 3, ALL_THREE_LOOP) == MB_OK);
    a->daemon->temp_count = 10;
    float feeder_target = 0;
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_ERR_NOT_ENABLED);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    float feeder_origin = a->measure.total_angle;
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_OK && feeder_target == 45);
    CHECK(fabsf(a->motor_controller.pid_ref - feeder_origin - 1620) < 0.01f);
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_ERR_POSITION_BUSY);
    a->measure.total_angle = feeder_origin + 1620;
    CHECK(MotorBenchPositionStep(0, 90, &feeder_target) == MB_OK && feeder_target == 135);
    a->measure.total_angle = feeder_origin + 4860;
    CHECK(MotorBenchPositionStep(0, -45, &feeder_target) == MB_OK && feeder_target == 90);
    a->measure.total_angle = feeder_origin + 3240;
    for (unsigned n = 0; n < 8; ++n) {
        CHECK(MotorBenchPositionStep(0, 1620, &feeder_target) == MB_OK);
        a->measure.total_angle = feeder_origin + feeder_target * 36;
    }
    CHECK(feeder_target > 12000); /* No silent truncation by the generic reference limit. */
    CHECK(MotorBenchPositionStep(0, NAN, &feeder_target) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchPositionStep(0, 0, &feeder_target) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchPositionStep(0, 36001, &feeder_target) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchPositionStep(0, 45, NULL) == MB_ERR_BAD_PARAM);
    a->daemon->temp_count = 0;
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_ERR_FEEDBACK_UNAVAILABLE);
    a->daemon->temp_count = 10;
    CHECK(MotorBenchSetRef(0, 10000) == MB_OK && ref(0) == 360); /* Manual guard retained. */
    a->measure.total_angle = feeder_origin + 360 * 36;
    receive_hex("${buildHeartbeat().toString('hex')}");
    receive_hex("${buildPositionStep(0, 123, 45).toString('hex')}");
    CHECK(ref(0) == 405);
    print_wire("POSITION_STEP_WIRE");
    /* A real low-gain position loop stopped ~0.81 output degrees short.
     * Retrigger must use output degrees like browser completion, not 5 rotor degrees. */
    a->measure.total_angle = feeder_origin + (405.0f - 0.81f) * 36.0f;
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_OK);
    CHECK(fabsf(feeder_target - 449.19f) < 0.01f);
    CHECK(fabsf(a->motor_controller.pid_ref - feeder_origin - feeder_target * 36) < 0.05f);
    a->measure.total_angle = feeder_origin + (feeder_target - 1.1f) * 36.0f;
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_ERR_POSITION_BUSY);
    /* Shared feeder tolerance stops end-of-step crawling. New actions retain
     * the nominal pitch instead of accumulating a small residual every shot. */
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    float extended_origin = a->measure.total_angle;
    CHECK(MotorBenchPositionStepWithTolerance(0, 45, 2.25f, &feeder_target) == MB_OK);
    CHECK(feeder_target == 45 && a->position_deadband == 81);
    a->measure.total_angle = extended_origin + (45 - 1.5f) * 36;
    a->measure.speed_aps = 0;
    a->motor_controller.angle_PID.Kp = 10;
    a->motor_controller.angle_PID.Iout = 100;
    tick();
    CHECK(a->motor_controller.angle_PID.Output == 0 && a->motor_controller.angle_PID.Iout == 0);
    CHECK(a->motor_controller.speed_PID.Ref == 0); /* speed loop still brakes */
    CHECK(ref(0) == 45); /* preserve exact nominal position */
    CHECK(MotorBenchPositionStepWithTolerance(0, 90, 4.5f, &feeder_target) == MB_OK && feeder_target == 135);
    a->measure.total_angle = extended_origin + (135 - 4.6f) * 36;
    tick();
    CHECK(a->motor_controller.angle_PID.Output > 0);
    CHECK(MotorBenchPositionStepWithTolerance(0, 45, 2.25f, &feeder_target) == MB_ERR_POSITION_BUSY);
    a->measure.total_angle = extended_origin + (135 - 4.0f) * 36;
    CHECK(MotorBenchPositionStepWithTolerance(0, -45, 2.25f, &feeder_target) == MB_OK && feeder_target == 90);
    float preserved_ref = ref(0), preserved_deadband = a->position_deadband;
    CHECK(MotorBenchPositionStepWithTolerance(0, 45, NAN, &feeder_target) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchPositionStepWithTolerance(0, 45, 0, &feeder_target) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchPositionStepWithTolerance(0, 45, 5, &feeder_target) == MB_ERR_BAD_PARAM);
    CHECK(ref(0) == preserved_ref && a->position_deadband == preserved_deadband);
    CHECK(MotorBenchSetRef(0, 90) == MB_OK && a->position_deadband == 0);
    a->measure.total_angle = extended_origin + 90 * 36;
    receive_hex("${buildPositionStep(0, 124, 45, 2.25).toString('hex')}");
    CHECK(ref(0) == 135 && a->position_deadband == 81);
    print_wire("POSITION_TOLERANCE_WIRE");
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    CHECK(a->position_deadband == 0);
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_ERR_NOT_ENABLED);
    CHECK(MotorBenchSetLoop(0, SPEED_LOOP) == MB_OK);
    CHECK(MotorBenchPositionStep(0, 45, &feeder_target) == MB_ERR_UNSUPPORTED);
    /* Raw encoder history must not invalidate a fresh relative zero. */
    for (int direction = -1; direction <= 1; direction += 2) {
        CHECK(MotorBenchSetLoop(0, ALL_THREE_LOOP) == MB_OK);
        a->measure.total_angle = direction * 2160000.0f;
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        MB_TelemetryItem_s t;
        CHECK(MotorBenchGetMeasure(0, &t) == MB_OK && t.measure_angle == 0 && t.ref == 0);
        float raw_origin = a->measure.total_angle;
        CHECK(MotorBenchPositionStep(0, 2880, &feeder_target) == MB_OK);
        CHECK(feeder_target == 2880);
        CHECK(a->motor_controller.pid_ref == raw_origin + 2880 * 36);
        CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    }
    CHECK(MotorBenchSetLoop(0, ALL_THREE_LOOP) == MB_OK);
    a->measure.total_angle = 0;
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    for (unsigned group = 0; group < 16; ++group) {
        CHECK(MotorBenchPositionStep(0, 2880, &feeder_target) == MB_OK);
        CHECK(feeder_target == (group + 1) * 2880);
        a->measure.total_angle = feeder_target * 36;
    }
    CHECK(a->measure.total_angle > MB_POSITION_TARGET_MAX_DEG);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(MotorBenchPositionStep(0, 80, &feeder_target) == MB_OK && feeder_target == 80);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    /* Retain the relative session limit even after removing the raw-history limit. */
    CHECK(MotorBenchSetLoop(0, ALL_THREE_LOOP) == MB_OK);
    a->measure.total_angle = 0;
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    for (unsigned group = 0; group < 27; ++group) {
        CHECK(MotorBenchPositionStep(0, 36000, &feeder_target) == MB_OK);
        a->measure.total_angle = feeder_target * 36;
    }
    float retained_ref = ref(0), retained_driver_ref = a->motor_controller.pid_ref;
    CHECK(MotorBenchPositionStep(0, 36000, &feeder_target) == MB_ERR_POSITION_RANGE);
    CHECK(ref(0) == retained_ref && a->motor_controller.pid_ref == retained_driver_ref);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    CHECK(MotorBenchUnbind(0) == MB_OK);
    /* A physical MIT span still bounds DM steps even though DJI raw history no longer does. */
    memset(&config, 0, sizeof(config));
    BenchBuildDMConfig(&config, &hcan1, 6, 0x302);
    DMMotorInstance *d = DMMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, d) == MB_OK);
    CHECK(MotorBenchBind(1, MB_MOTOR_DM, 1, 6, ALL_THREE_LOOP) == MB_OK);
    d->daemon->temp_count = 10;
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    float held_dm_ref = d->pid_ref;
    CHECK(MotorBenchPositionStep(1, d->p_max * RAD_2_DEGREE + 1, &feeder_target) == MB_ERR_POSITION_RANGE);
    CHECK(d->pid_ref == held_dm_ref && ref(1) == 0);
    CHECK(MotorBenchSetEnable(1, 0) == MB_OK);
    CHECK(MotorBenchUnbind(1) == MB_OK);
    return failures ? 1 : 0;
}
static int position_control(const char *speed_pid, const char *angle_pid, const char *bad_pid) {
    MotorBenchInitUSB();
    Motor_Init_Config_s config = {0};
    BenchBuildDJIConfig(&config, M2006, &hcan1, 3);
    DJIMotorInstance *a = DJIMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_M2006, 1, 3, 0, SPEED_LOOP, a) == MB_OK);
    const Closeloop_Type_e masks[] = {ANGLE_LOOP, ANGLE_AND_SPEED_LOOP, ALL_THREE_LOOP};
    for (unsigned n = 0; n < 3; ++n) {
        CHECK(MotorBenchBind(0, MB_MOTOR_M2006, 1, 3, masks[n]) == MB_OK);
        if (n == 0) {
            CHECK(MotorBenchQueryPid(0) == MB_OK);
            print_wire("M2006_DEFAULTS_WIRE");
        }
        a->daemon->temp_count = 0;
        CHECK(MotorBenchSetEnable(0, 1) == MB_ERR_BAD_PARAM);
        const uint8_t frame[8] = {0x0d, 0xac, 0, 0, 0, 0, 25, 0};
        memcpy(a->motor_can_instance->rx_buff, frame, 8);
        a->motor_can_instance->rx_len = 8;
        a->motor_can_instance->can_module_callback(a->motor_can_instance);
        a->measure.total_angle += 36000.0f; /* Prior speed test, many turns. */
        float origin = a->measure.total_angle;
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        CHECK(fabsf(a->motor_controller.pid_ref - origin) < 0.01f);
        CHECK(MotorBenchSetRef(0, 30) == MB_OK);
        tick();
        CHECK(fabsf(a->motor_controller.angle_PID.Err - 1080) < 0.01f);
        CHECK(a->motor_controller.speed_PID.Ref > 4320 && a->motor_controller.speed_PID.Ref <= 5320);
        CHECK(a->motor_controller.angle_PID.Iout > 0 && a->motor_controller.angle_PID.Iout <= 1000);
        CHECK(output(a) > 0); /* Position PID executes with every legal mask. */
        a->measure.total_angle = origin + 30 * 36;
        a->measure.real_current = 0;
        tick();
        CHECK(a->motor_controller.angle_PID.Output == 0);
        CHECK(abs(output(a)) < 2);
        a->measure.total_angle = origin + 40 * 36;
        tick(); CHECK(output(a) < 0); /* Overshoot must reverse correction. */
        MB_TelemetryItem_s t;
        CHECK(MotorBenchGetMeasure(0, &t) == MB_OK);
        CHECK(fabsf(t.measure_angle - 40) < 0.01f && t.ref == 30);
        CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
        a->measure.total_angle += 200;
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        CHECK(MotorBenchGetMeasure(0, &t) == MB_OK && t.measure_angle == 0 && t.ref == 0);
        tick(); CHECK(abs(output(a)) < 2);
        CHECK(MotorBenchSetRef(0, -20) == MB_OK);
        tick(); CHECK(output(a) < 0);
        a->daemon->temp_count = 0;
        tick(); CHECK(output(a) == 0);
        CHECK(MotorBenchUnbind(0) == MB_OK);
    }
    memset(&config, 0, sizeof(config));
    BenchBuildDMConfig(&config, &hcan1, 6, 0x302);
    DMMotorInstance *b = DMMotorInit(&config);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, b) == MB_OK);
    CHECK(MotorBenchBind(1, MB_MOTOR_DM, 1, 6, ALL_THREE_LOOP) == MB_OK);
    dm_feedback(b, 2047);
    float origin = b->measure.position * 57.2957795f;
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    CHECK(MotorBenchSetRef(1, 30) == MB_OK);
    now += 2; DMMotorControl();
    CHECK(fabsf(b->angle_PID.Err - 30) < 0.001f);
    CHECK(fabsf(b->speed_PID.Ref - 2) < 0.001f);
    CHECK(dm_torque(b) > 2047);
    b->measure.position = (origin + 30) / 57.2957795f;
    now += 2; DMMotorControl();
    CHECK(fabsf(b->angle_PID.Output) < 0.001f);
    CHECK(abs((int)dm_torque(b) - 2047) <= 1);
    b->measure.position = (origin + 45) / 57.2957795f;
    now += 2; DMMotorControl(); CHECK(dm_torque(b) < 2047);
    CHECK(MotorBenchSetEnable(1, 0) == MB_OK);
    b->measure.position += 1;
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    MB_TelemetryItem_s t;
    CHECK(MotorBenchGetMeasure(1, &t) == MB_OK && fabsf(t.measure_angle) < 0.001f && t.ref == 0);
    now += 2; DMMotorControl(); CHECK(abs((int)dm_torque(b) - 2047) <= 1);
    CHECK(MotorBenchSetRef(1, -30) == MB_OK);
    now += 2; DMMotorControl(); CHECK(dm_torque(b) < 2047);
    receive_hex("${buildHeartbeat().toString('hex')}");
    receive_hex("${buildSetPid(1, 0, { Kp: 0.05, Ki: 0, Kd: 0, MaxOut: 7, IntegralLimit: 0, scaledLimits: true }).toString('hex')}");
    CHECK(fabsf(b->speed_PID.MaxOut - 7.0f) < 0.0001f);
    receive_hex("${buildSetPid(1, 2, { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 20.94, IntegralLimit: 0, scaledLimits: true }).toString('hex')}");
    CHECK(fabsf(b->angle_PID.MaxOut - 20.94f) < 0.0001f);
    receive_hex(speed_pid);
    receive_hex(angle_pid);
    CHECK(fabsf(b->speed_PID.MaxOut - 0.375f) < 0.0001f);
    CHECK(fabsf(b->angle_PID.MaxOut - 1.75f) < 0.0001f);
    CHECK(b->stop_flag == MOTOR_STOP && ref(1) == 0);
    /* Screenshot reproduction: overrange is BAD_PARAM, not unsupported motor. */
    receive_hex("${buildSetPid(1, 0, { Kp: 0.7, Ki: 5, Kd: 0, MaxOut: 200, IntegralLimit: 100, scaledLimits: true }).toString('hex')}");
    CHECK(fabsf(b->speed_PID.Kp - 0.05f) < 0.0001f);
    CHECK(fabsf(b->speed_PID.MaxOut - 0.375f) < 0.0001f);
    receive_hex("${buildSetPid(1, 2, { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 200, IntegralLimit: 0, scaledLimits: true }).toString('hex')}");
    CHECK(fabsf(b->angle_PID.MaxOut - 1.75f) < 0.0001f);
    receive_hex(bad_pid);
    CHECK(MotorBenchQueryPid(1) == MB_OK);
    print_wire("POSITION_WIRE");
    puts("PASS real M2006/DM position cascade, all DJI masks, relative enable origins, correction signs, zero-target hold and stale-feedback rejection");
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
#ifdef DM8009P_T_MAX
static DMMotorInstance *profile_motors[2];
static uint8_t create_profile(MB_MotorKind_e kind, uint8_t bus, uint8_t id, uint16_t rx, void **out) {
    uint8_t result = BenchMotorFactory(kind, bus, id, rx, out);
    if (result == MB_OK) profile_motors[kind == MB_MOTOR_DM8009P] = *out;
    return result;
}
static int dm_profiles(void) {
    MotorBenchInitUSB();
    MotorBenchSetMotorFactory(create_profile, BenchMotorDestroy);
    uint8_t slot;
    CHECK(MotorBenchAddMotor(MB_MOTOR_DM, 1, 6, 0x302, &slot) == MB_OK && slot == 0);
    CHECK(MotorBenchAddMotor(MB_MOTOR_DM8009P, 1, 1, 0, &slot) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchAddMotor(MB_MOTOR_DM8009P, 1, 6, 0x11, &slot) == MB_ERR_DUPLICATE);
    CHECK(MotorBenchAddMotor(MB_MOTOR_DM8009P, 1, 1, 0x11, &slot) == MB_OK && slot == 1);
    CHECK(MotorBenchGetInventoryCount() == 2 && CANGetFilterFree(&hcan1) == 12);
    CHECK(MotorBenchBind(0, MB_MOTOR_DM, 1, 6, SPEED_LOOP) == MB_OK);
    CHECK(MotorBenchBind(1, MB_MOTOR_DM8009P, 1, 1, SPEED_LOOP) == MB_OK);
    DMMotorInstance *a = profile_motors[0], *b = profile_motors[1];
    CHECK(a && b && a->t_max == 10 && b->t_max == 54);
    CHECK(a->p_max == 12.5f && b->p_max == 12.5f && a->v_max == 30 && b->v_max == 45);
    CHECK(a->speed_PID.Kp == 0.55f && a->speed_PID.Ki == 0.5f && a->speed_PID.Kd == 0.0f);
    CHECK(a->speed_PID.MaxOut == 7.0f && a->speed_PID.IntegralLimit == 100.0f);
    CHECK(b->speed_PID.Kp == 0.55f && b->speed_PID.Ki == 5.0f && b->speed_PID.Kd == 0.0f);
    CHECK(b->speed_PID.MaxOut == 17.5f && b->speed_PID.IntegralLimit == 100.0f);
    CHECK(MotorBenchQueryPid(0) == MB_OK && MotorBenchQueryPid(1) == MB_OK);
    print_wire("DM_DEFAULTS_WIRE");
    CHECK(b->motor_can_instace->tx_id == 1 && b->motor_can_instace->rx_id == 0x11);
    const uint8_t frame[8] = {1, 0x80, 0, 0x9a, 0xb3, 0x45, 25, 26};
    DMMotorInstance *motors[] = {a, b};
    for (unsigned i = 0; i < 2; i++) {
        CANInstance *can = motors[i]->motor_can_instace;
        memcpy(can->rx_buff, frame, 8);
        can->rx_len = 8;
        can->can_module_callback(can);
    }
    CHECK(fabsf(a->measure.velocity - 6.26373626f) < 0.0001f);
    CHECK(fabsf(a->measure.torque - (-5.91208791f)) < 0.0001f);
    CHECK(fabsf(b->measure.velocity - 9.3956044f) < 0.0001f);
    CHECK(fabsf(b->measure.torque - 5.4f * a->measure.torque) < 0.0001f);
    CHECK(fabsf(b->measure.torque - (-31.9252746f)) < 0.0001f);
    MB_TelemetryItem_s feedback;
    CHECK(MotorBenchGetMeasure(1, &feedback) == MB_OK && (feedback.status & 1));
    CHECK(fabsf(feedback.measure_torque - b->measure.torque) < 0.0001f);
    /* At 30 rad/s error, 4310 saturates at 7 N*m; 8009P requests 16.8 N*m.
     * Keep the independently configured MIT spans: 4310=10, 8009P=54.
     * Bypass the trajectory for this encoding test; test its rate separately. */
#ifdef MB_SPEED_ACCEL_RAD
    CHECK(a->speed_ramp.rate == MB_SPEED_ACCEL_RAD && b->speed_ramp.rate == MB_SPEED_ACCEL_RAD);
    b->speed_ramp.rate = 0;
    a->speed_ramp.rate = 0;
#endif
    for (unsigned i = 0; i < 2; i++) {
        motors[i]->measure.velocity = 0;
        CHECK(MotorBenchSetEnable(i, 1) == MB_OK);
        CHECK(MotorBenchSetRef(i, 30) == MB_OK);
    }
    now += 2; DMMotorControl();
    CHECK(dm_torque(a) == 3480 && dm_torque(b) == 2684);
    CHECK(fabsf(a->speed_PID.Output - 7.0f) < 0.0001f);
    CHECK(fabsf(b->speed_PID.Output - 16.8f) < 0.0001f);
    CHECK(a->pid_ref == 20.94f && b->pid_ref == 30);
    MB_TelemetryItem_s capped;
    CHECK(MotorBenchGetMeasure(0, &capped) == MB_OK && capped.ref == 20.94f);
    CHECK(MotorBenchSetRef(0, -30) == MB_OK && a->pid_ref == -20.94f);
    CHECK(MotorBenchGetMeasure(0, &capped) == MB_OK && capped.ref == -20.94f);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK && MotorBenchSetEnable(1, 0) == MB_OK);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 1, 0, 0, 7.001f, 0, 0) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 1, 0, 0, 10, 0, 0) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_ANGLE, 0.1f, 0, 0, 20.941f, 0, 0) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchSetPid(0, MB_PID_LOOP_ANGLE, 0.1f, 0, 0, 20.94f, 0, 0) == MB_OK);
    CHECK(MotorBenchSetPid(1, MB_PID_LOOP_SPEED, 1, 0, 0, 54, 0, 0) == MB_OK);
    CHECK(MotorBenchSetPid(1, MB_PID_LOOP_SPEED, 1, 0, 0, 54.001f, 0, 0) == MB_ERR_BAD_PARAM);
    CHECK(b->speed_PID.MaxOut == 54 && a->speed_PID.MaxOut == 7.0f);
    CHECK(MotorBenchSetPid(1, MB_PID_LOOP_ANGLE, 0.1f, 0, 0, 45, 0, 0) == MB_OK);
    CHECK(MotorBenchSetPid(1, MB_PID_LOOP_ANGLE, 0.1f, 0, 0, 45.001f, 0, 0) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchSetPid(1, MB_PID_LOOP_CURRENT, 0, 0, 0, 1, 0, 0) == MB_ERR_UNSUPPORTED);
    CHECK(MotorBenchQueryPid(1) == MB_OK);
    print_wire("DM8009P_PID_WIRE");
    CHECK(MotorBenchSetLoop(1, ANGLE_AND_SPEED_LOOP) == MB_OK);
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    CHECK(MotorBenchSetRef(1, 30) == MB_OK);
    CHECK(fabsf(b->pid_ref - b->measure.position * RAD_2_DEGREE - 30) < 0.0001f);
    CHECK(MotorBenchSetLoop(1, SPEED_LOOP) == MB_OK);
    CHECK(MotorBenchSetLoop(1, CURRENT_LOOP) == MB_ERR_UNSUPPORTED);
    for (unsigned i = 0; i < 2; i++) {
        CHECK(MotorBenchSetPid(i, MB_PID_LOOP_SPEED, 1, 0, 0, i == 0 ? 7 : 10, 0, 0) == MB_OK);
        motors[i]->measure.velocity = 0;
        DaemonReload(motors[i]->daemon);
        CHECK(MotorBenchSetEnable(i, 1) == MB_OK);
        CHECK(MotorBenchSetRef(i, 6) == MB_OK);
    }
    now += 2; DMMotorControl();
    CHECK(dm_torque(a) == 3276 && dm_torque(b) == 2275);
    /* Even a direct driver user bypassing the PID setter cannot command
     * more than the 4310 manual's peak torque. Keep MIT encoding at +/-10. */
    a->speed_PID.MaxOut = 100;
    DMMotorSetRef(a, 100);
    now += 2; DMMotorControl();
    CHECK(dm_torque(a) == 3480); /* +7 N*m in the real +/-10 MIT span. */
    DMMotorSetRef(a, -100);
    now += 2; DMMotorControl();
    CHECK(dm_torque(a) == 614); /* -7 N*m, within one encoding step. */
    CHECK(MotorBenchRemoveMotor(MB_MOTOR_DM8009P, 1, 1, 0x11) == MB_OK);
    CHECK(MotorBenchGetInventoryCount() == 1 && CANGetFilterFree(&hcan1) == 13);
    CHECK(MotorBenchGetMeasure(1, &feedback) != MB_OK);
    CHECK(MotorBenchGetMeasure(0, &feedback) == MB_OK && (feedback.status & 2));
    CHECK(MotorBenchRemoveMotor(MB_MOTOR_DM, 1, 6, 0x302) == MB_OK);
    CHECK(CANGetFilterFree(&hcan1) == 14);
    if (!failures) puts("PASS actual factory DM4310 + DM8009P coexistence, independent MIT spans, torque encoding/decoding, PID bounds, loops, TX collision and deletion");
    return failures ? 1 : 0;
}
#ifdef MB_SPEED_ACCEL_RAD
static int shared_speed_ramp(unsigned kind) {
    void *instance = NULL;
    unsigned id = kind == MB_MOTOR_DM ? 6 : 1;
    unsigned rx = kind == MB_MOTOR_DM ? 0x302 : kind == MB_MOTOR_DM8009P ? 0x11 : kind == MB_MOTOR_HT ? 0x22 : 0;
    CHECK(BenchMotorFactory(kind, 1, id, rx, &instance) == MB_OK);
    SpeedRamp_s *ramp = NULL;
    PIDInstance *speed = NULL;
    Motor_Control_Setting_s *setting = NULL;
    Motor_Working_Type_e *stop = NULL;
    DaemonInstance *daemon = NULL;
    float scale = 1, target_scale = 1;
    if (kind <= MB_MOTOR_M2006) {
        DJIMotorInstance *m = instance;
        ramp = &m->speed_ramp; speed = &m->motor_controller.speed_PID;
        setting = &m->motor_settings; stop = &m->stop_flag; daemon = m->daemon;
        scale = 6; target_scale = 200;
    } else if (kind == MB_MOTOR_DM || kind == MB_MOTOR_DM8009P) {
        DMMotorInstance *m = instance;
        ramp = &m->speed_ramp; speed = &m->speed_PID;
        setting = &m->motor_settings; stop = &m->stop_flag; daemon = m->daemon;
    } else if (kind == MB_MOTOR_LK) {
        LKMotorInstance *m = instance;
        ramp = &m->speed_ramp; speed = &m->speed_PID;
        setting = &m->motor_settings; stop = &m->stop_flag; daemon = m->daemon;
    } else if (kind == MB_MOTOR_HT) {
        HTMotorInstance *m = instance;
        ramp = &m->speed_ramp; speed = &m->speed_PID;
        setting = &m->motor_settings; stop = &m->stop_flag; daemon = m->motor_daemon;
        scale = RAD_2_DEGREE;
    }
    CHECK(ramp && speed && setting && stop && daemon);
    CHECK(fabsf(ramp->rate - (kind <= MB_MOTOR_M2006 ? 30000 : 100) * scale) < 0.01f);
    CHECK(ramp->zero_rate == 2 * ramp->rate);
    CHECK(MotorBenchRegisterMotor(kind, 1, id, rx, SPEED_LOOP, instance) == MB_OK);
    CHECK(MotorBenchBind(0, kind, 1, id, SPEED_LOOP) == MB_OK);
    DaemonReload(daemon);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    const float targets[] = {3, -3, 4, 0};
    const unsigned intervals[] = {1, 2, 5};
    float previous = 0;
    for (unsigned i = 0; i < 4; i++) {
        float target = targets[i] * target_scale * scale;
        speed->Iout = 0.25f;
        CHECK(MotorBenchSetRef(0, targets[i] * target_scale) == MB_OK);
        CHECK(speed->Iout == 0.25f);
        uint32_t started = now;
        float expected_ms = fabsf(target - previous) / (target == 0 ? ramp->zero_rate : ramp->rate) * 1000;
        for (unsigned n = 0; n < 500 && previous != target; n++) {
            unsigned ms = intervals[n % 3];
            now += ms; DaemonReload(daemon);
            DJIMotorControl(); DMMotorControl(); LKMotorControl();
            if (kind == MB_MOTOR_HT) ht_step(instance);
            CHECK(*stop == MOTOR_ENALBED);
            float current = speed->Ref;
            float rate = target == 0 ? ramp->zero_rate : ramp->rate;
            CHECK(fabsf(current - previous) <= rate * ms / 1000 + 0.001f);
            CHECK(fabsf(current - ramp->ref) < 0.001f);
            CHECK((current - previous) * (target - previous) >= -0.001f);
            CHECK(fabsf(target-current) <= fabsf(target-previous) + 0.001f);
            previous = current;
        }
        CHECK(previous == target);
        CHECK(now - started <= expected_ms + 5);
        if (target == 0) {
            MB_TelemetryItem_s feedback;
            CHECK(MotorBenchGetMeasure(0, &feedback) == MB_OK && (feedback.status & 2) && feedback.ref == 0);
        }
    }
    CHECK(MotorBenchSetRef(0, 3 * target_scale) == MB_OK);
    now += 2; DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    CHECK(ramp->ref > 0);
    CHECK(MotorBenchSetEnable(0, 0) == MB_OK);
    CHECK(*stop == MOTOR_STOP && ramp->ref == 0);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(MotorBenchSetRef(0, 3 * target_scale) == MB_OK);
    override_dt = 1; injected_dt = 0;
    now += 2; DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    override_dt = 0;
    CHECK(*stop == MOTOR_STOP && ramp->ref == 0);
    MotorBenchTask();
    MB_TelemetryItem_s feedback;
    CHECK(MotorBenchGetMeasure(0, &feedback) == MB_OK && !(feedback.status & 2) && feedback.ref == 0);
    now += 2; DaemonReload(daemon); DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    CHECK(*stop == MOTOR_STOP);
    // Feedback loss discards the trajectory; returned feedback cannot restart it.
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(MotorBenchSetRef(0, 3 * target_scale) == MB_OK);
    for (unsigned n = 0; n < 12; n++) DaemonTask();
    now += 2; DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    CHECK(*stop == MOTOR_STOP && ramp->ref == 0);
    MotorBenchTask(); DaemonReload(daemon);
    now += 2; DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    CHECK(*stop == MOTOR_STOP);
    // Fresh enable starts at measured motion in the driver's own speed units.
    float moving = 3 * target_scale;
    if (kind <= MB_MOTOR_M2006) ((DJIMotorInstance *)instance)->measure.speed_aps = moving * scale;
    else if (kind == MB_MOTOR_DM || kind == MB_MOTOR_DM8009P) ((DMMotorInstance *)instance)->measure.velocity = moving;
    else if (kind == MB_MOTOR_LK) ((LKMotorInstance *)instance)->measure.speed_rads = moving;
    else ((HTMotorInstance *)instance)->measure.speed_rads = moving;
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    CHECK(fabsf(ramp->ref - moving * scale) < 0.001f);
    CHECK(MotorBenchSetRef(0, 0) == MB_OK);
    now += 2; DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    CHECK(fabsf(ramp->ref - (moving * scale - ramp->zero_rate * 0.002f)) < 0.001f);
    CHECK(*stop == MOTOR_ENALBED);
    CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
    setting->outer_loop_type = ANGLE_AND_SPEED_LOOP;
    setting->close_loop_type = ANGLE_AND_SPEED_LOOP;
    ramp->ref = 123;
    now += 2; DJIMotorControl(); DMMotorControl(); LKMotorControl();
    if (kind == MB_MOTOR_HT) ht_step(instance);
    CHECK(ramp->ref == 123 && *stop == MOTOR_ENALBED);
    if (kind <= MB_MOTOR_M2006) {
        CHECK(MotorBenchSetLoop(0, CURRENT_LOOP) == MB_OK);
        CHECK(MotorBenchSetEnable(0, 1) == MB_OK);
        ramp->ref = 456;
        CHECK(MotorBenchSetRef(0, 2) == MB_OK);
        now += 2; DJIMotorControl();
        CHECK(ramp->ref == 456);
    }
    printf("PASS kind %u: actual factory/driver units, reverse/zero rates, retained integral, enabled zero, stop reset, invalid dt latch, position/current bypass\n",kind);
    return failures ? 1 : 0;
}
static int dm_speed_ramp(void) {
    void *instance = NULL;
    CHECK(BenchMotorFactory(MB_MOTOR_DM, 1, 6, 0x302, &instance) == MB_OK);
    DMMotorInstance *m = instance;
    dm_feedback(m, 2047);
    DMMotorEnable(m);
    float previous = 0;
    const float targets[] = {20.94f, 2, 10, 3, -3, 0};
    const unsigned intervals[] = {1, 2, 5};
    for (unsigned target = 0; target < sizeof(targets) / sizeof(targets[0]); ++target) {
        m->speed_PID.Iout = 0.25f;
        DMMotorSetRef(m, targets[target]);
        CHECK(m->speed_PID.Iout == 0.25f); // Target edits retain load compensation.
        uint32_t started = now;
        for (unsigned n = 0; n < 1000 && previous != targets[target]; ++n) {
            unsigned ms = intervals[n % 3];
            unsigned raw = (unsigned)lroundf((previous + 30) * 4095 / 60);
            dm_feedback(m, raw);
            now += ms; DMMotorControl();
            float current = m->speed_PID.Ref;
            CHECK(m->stop_flag == MOTOR_ENALBED);
            float rate = targets[target] == 0 ? 200 : 100;
            CHECK(fabsf(current - previous) <= rate * ms / 1000.0f + 0.00001f);
            CHECK((current - previous) * (targets[target] - previous) >= 0);
            CHECK(fabsf(targets[target] - current) <= fabsf(targets[target] - previous));
            previous = current;
        }
        CHECK(previous == targets[target]);
        if (target == 0) CHECK(now - started <= 215); // Full range no longer takes 2 s.
        if (targets[target] == 0) CHECK(now - started <= 20); // -3 -> 0 brakes faster.
    }
    // An immediate stop interrupts a ramp; recovery must not resume its target.
    dm_feedback(m, 2047);
    DMMotorSetRef(m, 10);
    now += 2; DMMotorControl();
    CHECK(fabsf(m->speed_PID.Ref - 0.2f) < 0.00001f);
    DMMotorSetRef(m, -10); // Replace the target before the old ramp completes.
    now += 2; DMMotorControl();
    CHECK(fabsf(m->speed_PID.Ref) < 0.00001f);
    CHECK(m->stop_flag == MOTOR_ENALBED);
    DMMotorStop(m);
    CHECK(m->stop_flag == MOTOR_STOP && m->motor_can_instace->tx_buff[7] == DM_CMD_RESET_MODE);
    now += 2; DMMotorControl();
    CHECK(m->stop_flag == MOTOR_STOP && m->speed_PID.Output == 0);
    // Re-enabling a moving motor starts from fresh feedback, not the old ramp.
    dm_feedback(m, 2116);
    DMMotorEnable(m);
    DMMotorSetRef(m, 0);
    now += 2; DMMotorControl();
    CHECK(fabsf(m->speed_PID.Ref - (m->measure.velocity - 0.4f)) < 0.00001f);
    CHECK(m->stop_flag == MOTOR_ENALBED); // Zero is active braking, not disable.
    // Position cascade bypasses speed-target shaping.
    DMMotorOuterLoop(m, ANGLE_AND_SPEED_LOOP);
    dm_feedback(m, 2047);
    DMMotorEnable(m);
    DMMotorSetRef(m, m->measure.position * RAD_2_DEGREE + 10);
    now += 2; DMMotorControl();
    CHECK(fabsf(m->speed_PID.Ref - 1) < 0.0001f);
    DMMotorStop(m);
    DMMotorOuterLoop(m, SPEED_LOOP);
    const float invalid_dt[] = {0, -0.002f, NAN, INFINITY, 1};
    for (unsigned i = 0; i < sizeof(invalid_dt) / sizeof(invalid_dt[0]); ++i) {
        dm_feedback(m, 2047); DMMotorEnable(m); DMMotorSetRef(m, 1);
        override_dt = 1; injected_dt = invalid_dt[i];
        now += 2; DMMotorControl(); override_dt = 0;
        CHECK(m->stop_flag == MOTOR_STOP && m->pid_ref == 0 && m->speed_ramp.ref == 0);
        CHECK(m->motor_can_instace->tx_buff[7] == DM_CMD_RESET_MODE);
        now += 2; DMMotorControl();
        CHECK(m->stop_flag == MOTOR_STOP);
    }
    dm_feedback(m, 2047); DMMotorEnable(m); DMMotorSetRef(m, NAN);
    now += 2; DMMotorControl();
    CHECK(m->stop_flag == MOTOR_STOP && m->pid_ref == 0);
    // Lost feedback interrupts the trajectory and recovery stays disabled.
    dm_feedback(m, 2047); DMMotorEnable(m); DMMotorSetRef(m, 5);
    now += 2; DMMotorControl();
    for (unsigned i = 0; i < 11; ++i) DaemonTask();
    now += 2; DMMotorControl();
    CHECK(m->stop_flag == MOTOR_STOP && m->speed_ramp.ref == 0 && m->pid_ref == 0);
    dm_feedback(m, 2047); now += 2; DMMotorControl();
    CHECK(m->stop_flag == MOTOR_STOP);
    CHECK(BenchMotorFactory(MB_MOTOR_DM8009P, 1, 1, 0x11, &instance) == MB_OK);
    m = instance;
    dm_feedback(m, 2047);
    DMMotorEnable(m); DMMotorSetRef(m, 4);
    now += 2; DMMotorControl();
    CHECK(fabsf(m->speed_PID.Ref - 0.2f) < 0.00001f);
    DMMotorStop(m);
    if (!failures) puts("PASS actual DM4310 factory: bounded acceleration/deceleration/reversal/zero at variable dt, retained integral, immediate stop, fresh enable, position isolation and 8009P shared ramp");
    return failures ? 1 : 0;
}
#endif
#endif
#ifdef MB_AUTO_RECONNECT_TEST
static void dji_feedback(DJIMotorInstance *m) {
    CANInstance *can = m->motor_can_instance;
    memset(can->rx_buff, 0, 8); can->rx_len = 8;
    can->can_module_callback(can);
}
static int reconnect(void) {
    MotorBenchInitUSB();
    DJIMotorInstance *a = make_motor(0, 1, 3);
    DJIMotorInstance *peer = make_motor(7, 1, 2);
    Motor_Init_Config_s c = {0}; BenchBuildDMConfig(&c, &hcan1, 6, 0x302);
    unsigned enabled = mode_count[0xfc], zeroed = mode_count[0xfe];
    DMMotorInstance *b = DMMotorInit(&c);
    CHECK(mode_count[0xfc] == enabled && mode_count[0xfe] == zeroed);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM, 1, 6, 0x302, SPEED_LOOP, b) == MB_OK);
    CHECK(MotorBenchBind(1, MB_MOTOR_DM, 1, 6, SPEED_LOOP) == MB_OK);
    BenchBuildDMConfig(&c, &hcan2, 1, 0x11);
    c.can_init_config.tx_id = 0x101; /* Exercise the protocol's upper ID bits. */
    DMMotorInstance *other = DMMotorInitWithModel(&c, DM_MODEL_8009P);
    CHECK(MotorBenchRegisterMotor(MB_MOTOR_DM8009P, 2, 1, 0x11, SPEED_LOOP, other) == MB_OK);
    CHECK(MotorBenchBind(2, MB_MOTOR_DM8009P, 2, 1, SPEED_LOOP) == MB_OK);
    CHECK(MotorBenchSetEnable(1, 1) == MB_ERR_BAD_PARAM);
    CHECK(MotorBenchSetEnable(7, 1) == MB_OK);
    CHECK(MotorBenchSetRef(7, 100) == MB_OK);
    /* Stopped unplug/replug; running unplug also must latch stopped. */
    for (unsigned running = 0; running < 2; running++) {
        dji_feedback(a); dm_feedback(b, 2047); dm_feedback(other, 2047);
        for (unsigned ch = 0; ch < 3; ch++) {
            CHECK(MotorBenchSetEnable(ch, 1) == MB_OK);
            CHECK(MotorBenchSetRef(ch, 5) == MB_OK);
            if (!running) CHECK(MotorBenchSetEnable(ch, 0) == MB_OK);
        }
        a->daemon->temp_count = b->daemon->temp_count = other->daemon->temp_count = 0;
        unsigned q1 = query_count[0], q2 = query_count[1];
        unsigned stops = mode_count[0xfd]; enabled = mode_count[0xfc];
        for (unsigned i = 0; i < 500; i++) {
            now += 2; MotorBenchReloadLink(); dji_feedback(peer);
            CANServiceTask(); DJIMotorControl(); DMMotorControl(); MotorBenchTask();
            usb_output_len = 0;
        }
        CHECK(query_count[0] - q1 >= 3 && query_count[0] - q1 <= 5);
        CHECK(query_count[1] - q2 >= 3 && query_count[1] - q2 <= 5);
        CHECK(last_query[0][0] == 6 && !last_query[0][1] && last_query[0][2] == 0xcc && !last_query[0][3]);
        CHECK(last_query[1][0] == 1 && last_query[1][1] == 1 && last_query[1][2] == 0xcc && !last_query[1][3]);
        CHECK(mode_count[0xfd] - stops <= 24);
        CHECK(mode_count[0xfc] == enabled && mode_count[0xfe] == zeroed);
        CHECK(a->stop_flag == MOTOR_STOP && !a->motor_controller.pid_ref && !output(a));
        CHECK(b->stop_flag == MOTOR_STOP && !b->pid_ref && other->stop_flag == MOTOR_STOP && !other->pid_ref);
        CHECK(MotorBenchSetEnable(0, 1) == MB_ERR_BAD_PARAM);
        CHECK(MotorBenchSetEnable(1, 1) == MB_ERR_BAD_PARAM);
        CHECK(MotorBenchSetEnable(2, 1) == MB_ERR_BAD_PARAM);
        CHECK(output(peer) != 0 && ref(7) == 100);
        dji_feedback(a); dm_feedback(b, 2047); dm_feedback(other, 2047);
        now += 2; DJIMotorControl(); DMMotorControl(); MotorBenchTask(); usb_output_len = 0;
        for (unsigned ch = 0; ch < 3; ch++) {
            MB_TelemetryItem_s t; CHECK(MotorBenchGetMeasure(ch, &t) == MB_OK);
            CHECK((t.status & 3) == 1 && t.ref == 0);
            CHECK(MotorBenchSetRef(ch, 10) == MB_ERR_NOT_ENABLED);
        }
        CHECK(MotorBenchGetInventoryCount() == 4);
    }
    CHECK(MotorBenchSetLoop(1, ANGLE_AND_SPEED_LOOP) == MB_OK);
    b->measure.position = 2; dm_feedback(b, 2047);
    CHECK(MotorBenchSetEnable(1, 1) == MB_OK);
    CHECK(fabsf(b->pid_ref - b->measure.position * RAD_2_DEGREE) < 0.001f);
    CHECK(b->speed_PID.Kp == 0.05f && other->t_max == 54);
    /* Real BSP: a missing ACK fills three mailboxes, expires only that bus,
     * queues fresh frames, and reports HAL failure instead of fake success. */
    CANInstance *can = b->motor_can_instace;
    now += 20; CANServiceTask();
    hold_tx[0] = hold_tx[1] = 1;
    for (unsigned i = 0; i < 3; i++) CHECK(CANTransmit(can, 1));
    release_after[0] = 5;
    CHECK(CANTransmit(can, 1)); /* Fourth motor gets a freshly ACKed mailbox. */
    CHECK(!CANTransmit(can, 1));
    CHECK(poll_elapsed < 0.4f); /* Full unplugged bus cannot block indefinitely. */
    now += 5; CHECK(CANTransmit(other->motor_can_instace, 1));
    now += 5; CANServiceTask();
    CHECK(!pending_tx[0] && pending_tx[1] == 1 && aborted_tx[0] == 7 && !aborted_tx[1]);
    CHECK(CANTransmit(can, 1));
    tx_fail[0] = 1; CHECK(!CANTransmit(can, 1));
    if (!failures) puts("PASS automatic reconnect: actual DJI/DM4310/DM8009P drivers, safe discovery, bounded queries, stop latch, retained bindings/PID, peer isolation and stale CAN expiry");
    return failures ? 1 : 0;
}
#endif
int main(int argc, char **argv) {
#ifdef MB_AUTO_RECONNECT_TEST
    if (argc == 2 && !strcmp(argv[1], "reconnect")) return reconnect();
#endif
#ifdef DM8009P_T_MAX
    if (argc == 2 && !strcmp(argv[1], "dm-profiles")) return dm_profiles();
#ifdef MB_SPEED_ACCEL_RAD
    if (argc == 2 && !strcmp(argv[1], "dm-speed-ramp")) return dm_speed_ramp();
    if (argc == 3 && !strcmp(argv[1], "shared-speed-ramp")) return shared_speed_ramp(atoi(argv[2]));
#endif
#endif
    if (argc == 2 && !strcmp(argv[1], "feeder-steps")) return feeder_steps();
    if (argc == 5 && !strcmp(argv[1], "position")) return position_control(argv[2], argv[3], argv[4]);
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
    if (!strcmp(argv[1], "lifecycle")) return lifecycle();
    if (!strcmp(argv[1], "loop-switch")) return loop_switch();
    if (!strcmp(argv[1], "dm-telemetry")) return dm_telemetry();
    if (!strcmp(argv[1], "dm-stability")) return dm_stability();
    if (!strcmp(argv[1], "dm-zero-integral")) return dm_zero_integral();
    if (!strcmp(argv[1], "dm-invalid-control")) return dm_invalid_control();
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
  {
    const source = ui.match(/function pidOutputSpec\(kind, loop\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source);
    const motorSpec = ui.match(/const MOTOR_SPEC = \{[\s\S]*?\n\};/)?.[0];
    assert.ok(motorSpec);
    const context = { MotorKind, MotorKindLabel, needsRxId: kind => [MotorKind.DM, MotorKind.DM8009P].includes(kind) };
    vm.runInNewContext(motorSpec + '\n' + source, context);
    assert.equal(context.pidOutputSpec(MotorKind.DM, 0).max, 7);
    assert.equal(context.pidOutputSpec(MotorKind.DM, 2).max, 20.94);
    assert.equal(context.pidOutputSpec(MotorKind.DM8009P, 0).max, 54);
    assert.equal(context.pidOutputSpec(MotorKind.DM8009P, 2).max, 17.6);
    console.log('PASS browser PID bounds: DM4310 peak 7 N*m / speed limit 20.94; DM8009P 54 N*m / speed limit 17.6 rad/s');
  }
  {
    const editStart = ui.indexOf('    const stopForPidEdit = () => {');
    const edit = ui.slice(editStart, ui.indexOf('    for (const role of', editStart));
    const ackStart = ui.indexOf("    case 'pidAck': {");
    const ack = ui.slice(ackStart, ui.indexOf("    case 'error': {", ackStart));
    const send = ui.slice(ui.indexOf('function send(obj)'), ui.indexOf('/* ---------------- 自动转速输出'));
    const cleanup = ui.slice(ui.indexOf('function cancelPidResume'), ui.indexOf('function clearTestChannels'));
    assert.ok(editStart > 0 && ackStart > 0);
    const commands = [], stops = [], pending = new Map();
    const message = {textContent:'',className:''};
    const state = {
      i:0, MotorKind, pidMsg:message, pendingPidApplies:pending,
      MotorKindLabel, LoopType:{ANGLE_LOOP:4}, boundLoopMasks:new Map([[0,2]]),
      MOTOR_SPEC:{[MotorKindLabel[MotorKind.DM]]:{range:20.94}},
      pendingLoopChanges:new Map(), pendingUnbindChannels:new Set(),
      ws:{readyState:1,send:value=>commands.push(JSON.parse(value))}, channelCalculators:new Map(),
      serialConnected:true, boardOnline:true, document:{hidden:false},
      performance:{now:()=>100}, clearTimeout:()=>{},
      telemetryByChannel:new Map([[0,{online:true,receivedAt:99}]]),
      canControlChannel:()=>true, currentChannelKind:()=>MotorKind.DM,
      ch:()=>({querySelector:()=>message}), renderChannel:()=>{},
      setDisplayedRef:(i,value)=>{state.displayedRef=value;},
      stopProgram:i=>stops.push(i), stopAllPrograms:()=>{},
      MBResult:{OK:0,BAD_PARAM:1,UNSUPPORTED:5}, MBResultText:{},
      pidOutputSpec:()=>({unit:'N·m',max:7}),
    };
    vm.runInNewContext(cleanup + send + edit +
      'globalThis.editPid=stopForPidEdit; function receivePid(data) {const msg={data}; switch ("pidAck") {' + ack + '}}', state);
    state.editPid();
    assert.deepEqual(commands,[{type:'enable',channelId:0,enable:false},{type:'setRef',channelId:0,ref:0}]);
    assert.equal(state.displayedRef,0);
    assert.deepEqual(stops,[0]);
    const receiveAck=(loop=0,result=0)=>state.receivePid({channelId:0,loop,result});
    const enables=()=>commands.filter(c=>c.type==='enable'&&c.enable);
    commands.length=0;
    pending.set(0,{loop:0,resume:true});
    receiveAck(2); assert.equal(enables().length,0); assert.equal(pending.size,1);
    receiveAck(); assert.deepEqual(enables(),[{type:'enable',channelId:0,enable:true,ref:0}]);
    receiveAck(); assert.equal(enables().length,1,'duplicate ACK must not enable again');
    for (const cmd of [
      {type:'stopAll'}, {type:'resetChannels'}, {type:'closeSerial'},
      {type:'enable',channelId:0,enable:false}, {type:'unbind',channelId:0},
      {type:'setLoop',channelId:0,mask:7}, {type:'removeMotor'},
    ]) {
      commands.length=0; pending.set(0,{loop:0,resume:true});
      state.send(cmd); receiveAck();
      assert.equal(enables().length,0,cmd.type+' cancels automatic enable');
    }
    commands.length=0; pending.set(0,{loop:0,resume:true});
    state.editPid(); receiveAck();
    assert.equal(enables().length,0,'editing again cancels automatic enable');
    pending.set(0,{loop:0,resume:true}); receiveAck(0,1);
    assert.equal(enables().length,0,'failed application stays stopped');
    pending.set(0,{loop:0,resume:true}); state.document.hidden=true; receiveAck();
    assert.equal(enables().length,0,'background application stays stopped');
    state.document.hidden=false; pending.set(0,{loop:0,resume:true});
    state.telemetryByChannel.set(0,{online:true,receivedAt:-1000}); receiveAck();
    assert.equal(enables().length,0,'stale feedback stays stopped');
    console.log('PASS PID edits stop/zero; matching ACK enables at zero; failures, stop, edit, background and stale feedback prevent late enable');
  }
  const clickBody = ui.match(/r\('enable'\)\.onclick = \(\) => \{([\s\S]*?)\n    \};/)[1];
  const handle = server.match(/function handleCommand\(cmd\) \{[\s\S]*?\n\}/)[0];
  const writes = [];
  const context = { Buffer, Number, buildEnable, buildSetRef, buildPositionStep,
    buildAllStop, buildUnbind,
    writeToSerial: (buf) => writes.push(buf), broadcast: () => {} };
  vm.runInNewContext(handle, context);
  context.handleCommand({type:'positionStep',channelId:0,requestId:5,delta:45,tolerance:2.25});
  const extendedStep = new FrameParser().push(writes.pop())[0];
  assert.equal(extendedStep.payload.length, 11);
  assert.equal(extendedStep.payload.readFloatLE(7), 2.25, 'backend forwards shared tolerance to firmware');
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

  const loopRoute = server.match(/else if \(cmd.type === 'setLoop'\) \{([\s\S]*?)\n    \} else if \(cmd.type === 'pidSet'/)?.[1];
  assert.ok(loopRoute);
  const route = new Function('cmd', 'ws', 'writeToSerial', 'buildSetLoop', 'MBResult', loopRoute);
  const loopWrites = [], replies = [];
  const socket = { send: value => replies.push(JSON.parse(value)) };
  route({ channelId: 1, mask: 7 }, socket, frame => { loopWrites.push(frame); return true; }, buildSetLoop, { BAD_PARAM: 1 });
  assert.deepEqual(loopWrites, [buildSetLoop(1, 7)]);
  assert.equal(replies.length, 0);
  for (const cmd of [{channelId:8, mask:3}, {channelId:0, mask:5}, {channelId:0, mask:256}, {channelId:0, mask:'7'}])
    route(cmd, socket, () => { throw new Error('invalid loop request reached serial'); }, buildSetLoop, { BAD_PARAM: 1 });
  assert.equal(replies.length, 4);
  route({channelId:1, mask:7}, socket, () => false, buildSetLoop, { BAD_PARAM: 1 });
  assert.deepEqual(replies.at(-1), {type:'loopAck', data:{channelId:1, mask:7, result:1}});
  console.log('PASS backend loop switch framing, input validation and serial-write failure acknowledgement');

  for (const [name, content] of Object.entries(stubs)) fs.writeFileSync(path.join(tmp, name), content);
  const main = path.join(tmp, 'motor_state.c');
  fs.writeFileSync(main, harness);
  const compiler = ['gcc', 'clang', 'C:/msys64/mingw64/bin/gcc.exe'].find((cc) => {
    try { execFileSync(cc, ['--version'], { env, stdio: 'pipe' }); return true; } catch { return false; }
  });
  if (!compiler) throw new Error('Native gcc/clang is required for motor state regression tests');
  const dwtSource = path.join(root, 'bsp/dwt/bsp_dwt.c');
  if (fs.readFileSync(dwtSource, 'utf8').includes('DWT_ReadCycles')) {
    // Compile the real clock code with register stubs to simulate debugger detach.
    const dir = path.join(tmp, 'dwt');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'main.h'), `#pragma once
#include <stdint.h>
typedef struct { volatile uint32_t CTRL, CYCCNT, LAR; } DwtRegisters;
typedef struct { volatile uint32_t DEMCR; } DebugRegisters;
extern DwtRegisters dwt;
extern DebugRegisters debug;
#define DWT (&dwt)
#define CoreDebug (&debug)
#define CoreDebug_DEMCR_TRCENA_Msk (1u << 24)
#define DWT_CTRL_CYCCNTENA_Msk 1u
`);
    fs.writeFileSync(path.join(dir, 'test.c'), `#include <assert.h>
#include <math.h>
#include "bsp_dwt.h"
DwtRegisters dwt;
DebugRegisters debug;
int main(void) {
    DWT_Init(168);
    assert(dwt.LAR == 0xC5ACCE55u);
    uint32_t last = 0;
    dwt.CYCCNT = 168000; dwt.CTRL = 0; debug.DEMCR = 0;
    assert(fabsf(DWT_GetDeltaT(&last) - 0.001f) < 0.000001f);
    assert(dwt.CTRL & 1); assert(debug.DEMCR & (1u << 24));
    assert(dwt.CYCCNT == 168000);
    dwt.CYCCNT = 336000; dwt.CTRL = 0; debug.DEMCR = 0;
    assert(fabs(DWT_GetDeltaT64(&last) - 0.001) < 0.000001);
    assert(dwt.CTRL & 1); assert(debug.DEMCR & (1u << 24));
    dwt.CTRL = 0; debug.DEMCR = 0;
    assert(fabsf(DWT_GetTimeline_ms() - 2) < 0.001f);
    assert(dwt.CTRL & 1); assert(debug.DEMCR & (1u << 24));
    dwt.CTRL = 0; debug.DEMCR = 0;
    DWT_Delay(0); DWT_Delay_ms(0);
    assert(dwt.CTRL & 1); assert(debug.DEMCR & (1u << 24));
    assert(dwt.CYCCNT == 336000);
    return 0;
}
`);
    const clockTest = path.join(dir, process.platform === 'win32' ? 'test.exe' : 'test');
    execFileSync(compiler, ['-std=gnu11', '-D__CORTEX_M=7', '-O1', '-I', dir, '-I', path.dirname(dwtSource),
      path.join(dir, 'test.c'), dwtSource, '-lm', '-o', clockTest], { env, stdio: 'pipe' });
    execFileSync(clockTest, [], { env, stdio: 'pipe' });
    console.log('PASS actual DWT clock restores debugger-cleared enables for delta/timeline/delay without resetting its cycle count');
  }
  /*
   * include 路径必须覆盖 motor_bench.h 实际 include 的所有头文件。
   * @note 2026-10-19:motor_bench.h 新增 LK9025.h / HT04.h
   *   (LK/HT 接入测试台),所以补上这两个目录 —— 少一个就是
   *   "fatal error: LK9025.h: No such file or directory"。
   */
  const includes = [tmp, 'modules', 'modules/motor', 'modules/motor/DJImotor',
    'modules/motor/DMmotor', 'modules/motor/LKmotor', 'modules/motor/HTmotor',
    'modules/motor_bench', 'modules/algorithm',
    'modules/daemon', 'bsp/can', 'bsp/usart', 'bsp/log', 'application',
    'Middlewares/Third_Party/SEGGER/RTT', 'Middlewares/Third_Party/SEGGER/Config']
    .flatMap((p) => ['-I', path.isAbsolute(p) ? p : path.join(root, p)]);
  /*
   * 2026-10-19:motor_bench.c 新增了 LK/HT 的分发调用,
   * 所以链接列表要带上这两个库,否则 undefined reference。
   */
  const sources = ['modules/motor_bench/motor_bench.c', 'modules/motor/DJImotor/dji_motor.c',
    'modules/motor/DMmotor/dmmotor.c', 'modules/motor/LKmotor/LK9025.c',
    'modules/motor/HTmotor/HT04.c',
    'modules/algorithm/controller.c', 'modules/algorithm/user_lib.c',
    'modules/algorithm/crc8.c', 'modules/daemon/daemon.c', 'bsp/can/bsp_can.c',
    'Middlewares/Third_Party/SEGGER/RTT/SEGGER_RTT_printf.c']
    .map((p) => path.join(root, p));
  const exe = path.join(tmp, 'motor_state.exe');
  const board = path.basename(path.resolve(root));
  const boardFlag = { 'motorbench-a': 0x20, 'motorbench-c': 0x40, 'motorbench-mc02': 0x60 }[board];
  const mcu = { 'motorbench-a': 'STM32F427xx', 'motorbench-c': 'STM32F407xx', 'motorbench-mc02': 'STM32H723xx' }[board];
  execFileSync(compiler, ['-std=gnu11', `-D${mcu}`, '-O1', '-ffunction-sections', '-fdata-sections',
    ...includes, main, ...sources, '-Wl,--gc-sections', '-lm', '-o', exe], { env, stdio: 'pipe' });
  {
    const output = execFileSync(exe, ['feeder-steps'], { env, encoding: 'utf8', stdio: 'pipe' });
    const stepWire = output.match(/POSITION_STEP_WIRE ([0-9a-f]+)/)?.[1];
    const stepFrames = new FrameParser().push(Buffer.from(stepWire, 'hex'));
    assert.deepEqual(stepFrames.filter(f => f.type === FrameType.POSITION_STEP_ACK).map(f => parsePositionStepAck(f.payload)),
      [{ channelId: 0, requestId: 123, result: 0, target: 405 }]);
    assert.equal(parseHeartbeatAck(stepFrames.find(f => f.type === FrameType.HEARTBEAT).payload).boardFlags & 30, 30);
    const extendedFrames = new FrameParser().push(Buffer.from(output.match(/POSITION_TOLERANCE_WIRE ([0-9a-f]+)/)[1], 'hex'));
    assert.ok(extendedFrames.some(f => f.type === FrameType.POSITION_STEP_ACK && parsePositionStepAck(f.payload).requestId === 124 && parsePositionStepAck(f.payload).target === 135));
    console.log('PASS single/double large-angle position steps, reverse, busy/offline/stopped guards, firmware ACK, 0.81 output-degree residual, repeated double shots across 1M rotor degrees, large origins, relative limit and retained manual limit');
  }
  if (!process.argv.includes('--feeder-only')) {
  let failed = false;
  if (supportsDmSpeedRamp) {
    for (const kind of [1, 2, 3, 4, 5, 6, 7])
      process.stdout.write(execFileSync(exe, ['shared-speed-ramp', String(kind)], { env, stdio: 'pipe' }));
  }
  if (supportsDm8009p) {
    const output = execFileSync(exe, ['dm-profiles'], { env, encoding: 'utf8', stdio: 'pipe' });
    const defaultHex = output.match(/DM_DEFAULTS_WIRE ([0-9a-f]+)/)?.[1];
    assert.ok(defaultHex);
    const defaults = new FrameParser().push(Buffer.from(defaultHex, 'hex'))
      .filter(f => f.type === FrameType.PID_REPORT).map(f => parsePidReport(f.payload));
    assert.equal(defaults.length, 2);
    for (const report of defaults) {
      for (const loop of ['speed', 'current', 'angle'])
        assert.deepEqual(report[loop], PID_DEFAULTS[report.kind][loop], `${MotorKind[report.kind]} ${loop} defaults must match firmware`);
    }
    console.log('PASS firmware factory / USB readback / browser PID defaults agree; DM4310 0.55/0.5/0/7/100 and DM8009P 0.55/5/0/17.5/100');
    const hex = output.match(/DM8009P_PID_WIRE ([0-9a-f]+)/)?.[1];
    assert.ok(hex);
    const frames = new FrameParser().push(Buffer.from(hex, 'hex'));
    const report = parsePidReport(frames.find(f => f.type === FrameType.PID_REPORT).payload);
    assert.equal(report.kind, MotorKind.DM8009P);
    assert.equal(report.speed.MaxOut, 54);
    assert.equal(report.angle.MaxOut, 45);
    console.log(output.split('\n').filter(line => !line.includes('_WIRE')).join('\n'));
  }
  {
    const speed = buildSetPid(1, 0, { Kp: 0.05, Ki: 0, Kd: 0, MaxOut: 0.375, IntegralLimit: 0.125, scaledLimits: true });
    const angle = buildSetPid(1, 2, { Kp: 0.1, Ki: 0, Kd: 0, MaxOut: 1.75, IntegralLimit: 0.25, scaledLimits: true });
    const bad = buildSetPid(1, 1, { Kp: 0, Ki: 0, Kd: 0, MaxOut: 0, IntegralLimit: 0, scaledLimits: true });
    const output = execFileSync(exe, ['position', speed.toString('hex'), angle.toString('hex'), bad.toString('hex')], { env, encoding: 'utf8', stdio: 'pipe' });
    const defaultFrames = new FrameParser().push(Buffer.from(output.match(/M2006_DEFAULTS_WIRE ([0-9a-f]+)/)[1], 'hex'));
    const m2006Defaults = parsePidReport(defaultFrames.find(f => f.type === FrameType.PID_REPORT).payload);
    assert.deepEqual(m2006Defaults.angle, {Kp:4, Ki:5, Kd:0, MaxOut:6000, IntegralLimit:1000, improve:1});
    assert.deepEqual(m2006Defaults.angle, PID_DEFAULTS[MotorKind.M2006].angle, 'M2006 factory and browser restore defaults match the commissioned parameters');
    const hex = output.match(/POSITION_WIRE ([0-9a-f]+)/)?.[1];
    const frames = new FrameParser().push(Buffer.from(hex, 'hex'));
    const report = parsePidReport(frames.find(f => f.type === FrameType.PID_REPORT).payload);
    assert.equal(report.speed.MaxOut, 0.375);
    assert.equal(report.speed.IntegralLimit, 0.125);
    assert.equal(report.angle.MaxOut, 1.75);
    assert.equal(report.angle.IntegralLimit, 0.25);
    assert.deepEqual(frames.filter(f => f.type === FrameType.PID_SET_ACK).map(f => f.payload[2]), [0, 0, 0, 0, 1, 1, 5]);
    console.log(output.split('\n').filter(line => !line.includes('_WIRE')).join('\n'));
    console.log('PASS DM fractional PID round trip, protocol boundaries, overrange BAD_PARAM preserves old gains, and unsupported current-loop acknowledgement');
  }
  {
    const output = execFileSync(exe, ['dm-telemetry'], { env, encoding: 'utf8', stdio: 'pipe' });
    const hex = output.match(/DM_TELEMETRY_WIRE ([0-9a-f]+)/)?.[1];
    assert.ok(hex, 'capture real firmware telemetry after DM CAN feedback decoding');
    const frames = new FrameParser().push(Buffer.from(hex, 'hex')).filter(f => f.type === FrameType.TELEMETRY);
    assert.equal(frames.length, 1);
    const t = parseTelemetry(frames[0].payload).items[0];
    assert.equal(t.enabled, false);
    assert.equal(t.online, true);
    assert.ok(Math.abs(t.speed - 0.26373626) < 0.0001, `averaged speed was ${t.speed}`);
    assert.ok(Math.abs(t.torque - (-1.24542125)) < 0.0001, `averaged torque was ${t.torque}`);
    console.log('PASS independent MIT feedback vectors through real DM decoder, disabled telemetry averaging, USB framing and host parsing; speed/torque are not swapped');
  }
  {
    const output = execFileSync(exe, ['loop-switch'], { env, encoding: 'utf8', stdio: 'pipe' });
    const hex = output.match(/LOOP_WIRE ([0-9a-f]+)/)?.[1];
    const wire = Buffer.from(hex, 'hex');
    const wireFrames = new FrameParser().push(wire);
    const heartbeat = wireFrames.find(f => f.type === FrameType.HEARTBEAT);
    assert.ok(heartbeat, 'actual firmware heartbeat must survive frame length, CRC and tail validation');
    const fwHeader = fs.readFileSync(path.join(root, 'modules/motor_bench/motor_bench.h'), 'utf8');
    const fwMajor = Number(fwHeader.match(/#define MB_FW_VERSION_MAJOR (\d+)/)[1]);
    const fwMinor = Number(fwHeader.match(/#define MB_FW_VERSION_MINOR (\d+)/)[1]);
    assert.equal(heartbeat.payload.length, 8);
    assert.deepEqual(parseHeartbeatAck(heartbeat.payload), {
      fwVersion: `${fwMajor}.${fwMinor}`, inventoryCount: 3, boardFlags: 159 | boardFlag,
      anyMotorOnline: true, uptimeS: 1, seq: heartbeat.payload.readUInt16LE(6),
    });
    const fragments = new FrameParser();
    const fragmented = [];
    for (const byte of wire) fragmented.push(...fragments.push(Buffer.from([byte])));
    assert.equal(fragmented.filter(f => f.type === FrameType.HEARTBEAT).length, 1, 'bytewise USB stream retains heartbeat');
    const acks = wireFrames
      .filter(f => f.type === FrameType.LOOP_SET_ACK).map(f => parseLoopSetAck(f.payload));
    assert.deepEqual(acks, [
      {channelId:0, mask:7, result:0}, {channelId:0, mask:3, result:0},
      {channelId:1, mask:7, result:0}, {channelId:1, mask:3, result:0},
      {channelId:1, mask:1, result:5}, {channelId:0, mask:5, result:1},
      {channelId:8, mask:3, result:1},
    ]);
    assert.equal(parseLoopSetAck(Buffer.from([0, 7])), null);
    console.log(output.split('\n').filter(line => !line.includes('_WIRE')).join('\n'));
    console.log('PASS actual firmware heartbeat framing and parsed version, including bytewise USB input');
  }
  for (const scenario of ['stop', 'windup', 'binding', 'peer', 'mixed', 'logging', 'dm-stability', ...(supportsDmIntegralHold ? ['dm-zero-integral', 'dm-invalid-control'] : []), ...(supportsDmSpeedRamp ? ['dm-speed-ramp'] : []), 'lifecycle', ...(supportsAutoReconnect ? ['reconnect'] : [])]) {
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
  }
} catch (error) {
  process.stderr.write(String(error.stderr ?? error.stack));
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
