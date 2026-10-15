#define MB_BEHAVIOR_LIBRARY
#include "lifecycle_test.c"
#include "motor_bench.h"
#include "bsp_usb.h"
#include "bsp_usart.h"
#include "crc8.h"

static USBD_CDC_HandleTypeDef cdc;
USBD_HandleTypeDef hUsbDeviceFS = {&cdc, USBD_STATE_CONFIGURED};
static uint8_t rx_bytes[256], *tx_pointer;
static uint16_t tx_length;
static USB_Init_Config_s usb_callbacks;
static DJIMotorInstance *created;
static uint8_t remote_online = 1, remote_switch = 1;
static int16_t remote_rocker;
static int16_t remote_lateral, remote_yaw;
static char rtt_output[4096];
static unsigned rtt_used;

/* Replace only the debug-host I/O; run the production log macro and formatter. */
unsigned SEGGER_RTT_Write(unsigned index, const void *buffer, unsigned length) {
    (void)index;
    unsigned room = sizeof(rtt_output) - 1u - rtt_used;
    unsigned take = length < room ? length : room;
    memcpy(rtt_output + rtt_used, buffer, take);
    rtt_used += take;
    rtt_output[rtt_used] = 0;
    return length;
}

float DWT_GetTimeline_s(void) { return DWT_GetTimeline_ms() / 1000; }
uint32_t HAL_GetTick(void) { return 12345; }
uint8_t *USBInit(USB_Init_Config_s config) { usb_callbacks = config; return rx_bytes; }
USARTInstance *USARTRegister(USART_Init_Config_s *config) { (void)config; return NULL; }
void USARTSend(USARTInstance *instance, uint8_t *bytes, uint16_t length, int mode) {
    (void)instance; (void)bytes; (void)length; (void)mode;
}
uint8_t CDC_Transmit_FS(uint8_t *bytes, uint16_t length) {
    if (cdc.TxState) return USBD_BUSY;
    tx_pointer = bytes; tx_length = length; cdc.TxState = 1; return USBD_OK;
}
static void drain(void) {
    for (unsigned i = 0; cdc.TxState && i < 100; ++i) {
        cdc.TxState = 0; usb_callbacks.tx_cbk(tx_length);
    }
    assert(!cdc.TxState);
}
static void receive(uint8_t type, const uint8_t *body, uint8_t length) {
    rx_bytes[0] = 0xa5; rx_bytes[1] = type; rx_bytes[2] = length;
    if (length) memcpy(rx_bytes + 3, body, length);
    rx_bytes[3 + length] = crc_8(rx_bytes + 1, length + 2);
    rx_bytes[4 + length] = 0x5a;
    usb_callbacks.rx_cbk(length + 5); MotorBenchTask();
}
static uint8_t factory(MB_MotorKind_e kind, uint8_t bus, uint8_t id, void **instance) {
    (void)kind; Motor_Init_Config_s cfg = {0}; cfg.motor_type = M3508;
    cfg.can_init_config.can_handle = bus == 1 ? &hcan1 : &hcan2;
    cfg.can_init_config.tx_id = id;
    cfg.controller_setting_init_config.outer_loop_type = SPEED_LOOP;
    created = DJIMotorInit(&cfg); *instance = created;
    return created ? MB_OK : MB_ERR_NO_RESOURCE;
}
static void destroy(MB_MotorKind_e kind, void *instance) { (void)kind; DJIMotorDestroy(instance); }
static void remote(uint8_t *online, int16_t axes[3], uint8_t *sw) {
    *online = remote_online;
    axes[0] = remote_rocker; axes[1] = remote_lateral; axes[2] = remote_yaw;
    *sw = remote_switch;
}
int main(void) {
    lifecycle_suite();
    MotorBenchInitUSB(); MotorBenchSetMotorFactory(factory, destroy); MotorBenchSetRemoteReader(remote);
    receive(1, NULL, 0);
    assert(cdc.TxState && tx_length <= 64);
    /* Validate the actual firmware bytes, rather than a host-generated fixture. */
    assert(tx_pointer[0] == 0xa5 && tx_pointer[1] == 1);
    assert(tx_length == (uint16_t)(tx_pointer[2] + 5u));
    assert(tx_pointer[tx_length - 1u] == 0x5a);
    assert(crc_8(tx_pointer + 1, tx_pointer[2] + 2u) == tx_pointer[tx_length - 2u]);
    uint8_t saved[64]; uint16_t saved_length = tx_length;
    memcpy(saved, tx_pointer, saved_length);
    for (unsigned i = 0; i < 200; ++i) receive(1, NULL, 0);
    assert(memcmp(saved, tx_pointer, saved_length) == 0); /* Async pointer stays owned until completion. */
    hUsbDeviceFS.dev_state = 0; hUsbDeviceFS.pClassData = NULL; cdc.TxState = 0;
    for (unsigned i = 0; i < 20; ++i) MotorBenchTask();
    hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED; hUsbDeviceFS.pClassData = &cdc;
    receive(1, NULL, 0); assert(cdc.TxState);
    drain();
    uint8_t ch;
    assert(MotorBenchAddMotor(MB_MOTOR_M3508, 1, 1, &ch) == MB_OK);
    assert(MotorBenchBind(0, MB_MOTOR_M3508, 1, 1, SPEED_LOOP) == MB_OK);
    assert(MotorBenchBind(1, MB_MOTOR_M3508, 1, 1, ANGLE_LOOP) == MB_ERR_DUPLICATE);
    rtt_used = 0; rtt_output[0] = 0;
    assert(MotorBenchSetEnable(0, 1) == MB_OK);
    assert(strstr(rtt_output, "[en] ch=0") != NULL);
    assert(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 2.25f, 0.5f, 1.75f, 15000, 10000, 0) == MB_OK);
    assert(created->motor_controller.speed_PID.Kp == 2.25f);
    assert(created->motor_controller.speed_PID.Ki == 0.5f);
    assert(strstr(rtt_output, "pid set: ch=0 loop=0") != NULL);
    assert(MotorBenchSetEnable(0, 1) == MB_OK);
    assert(MotorBenchSetRef(0, 600) == MB_OK && created->motor_controller.pid_ref == 3600);
    for (unsigned i = 0; i < 160; ++i) { receive(6, NULL, 0); DaemonTask(); drain(); }
    MB_TelemetryItem_s measured;
    assert(MotorBenchGetMeasure(0, &measured) == MB_OK && !(measured.status & 2));
    receive(1, NULL, 0);
    uint8_t source[6] = {1, 0}; float limit = 6000; memcpy(source + 2, &limit, 4);
    receive(0x0d, source, 6); MotorBenchTask();
    assert(MotorBenchSetEnable(0, 1) == MB_OK);
    remote_rocker = 330; MotorBenchTask();
    assert(MotorBenchGetMeasure(0, &measured) == MB_OK && measured.ref == 3000);
    assert(MotorBenchUnbind(0) == MB_OK);
    assert(MotorBenchBind(0, MB_MOTOR_M3508, 1, 1, SPEED_LOOP) == MB_OK);
    remote_rocker = 660;
    assert(MotorBenchSetEnable(0, 1) == MB_OK);
    MotorBenchTask();
    assert(MotorBenchGetMeasure(0, &measured) == MB_OK && measured.ref == 0);
    assert(MotorBenchRemoveMotor(MB_MOTOR_M3508, 1, 1) == MB_OK);
    MotorBenchTask(); DJIMotorControl(); DaemonTask();
    assert(MotorBenchGetMeasure(0, &measured) == MB_ERR_BAD_PARAM);
    /* Exercise the actual decoder and four production motor instances on both boards. */
    for (uint8_t i = 0; i < 4; ++i) {
        assert(MotorBenchAddMotor(MB_MOTOR_M3508, 1, i + 1, &ch) == MB_OK);
        assert(MotorBenchBind(i, MB_MOTOR_M3508, 1, i + 1, SPEED_LOOP) == MB_OK);
        DaemonReload(created->daemon); /* Simulate a valid CAN reply from each wheel. */
    }
    remote_rocker = 0;
    uint8_t chassis[10] = {2,0,1,2,3,0}; memcpy(chassis + 6, &limit, 4);
    receive(0x0d, chassis, 10);
    uint8_t group_enable = 1;
    receive(0x0e, &group_enable, 1);
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && (measured.status & 2));
    remote_rocker = 330; MotorBenchTask();
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && measured.ref == 3000);
    assert(MotorBenchSetPid(0, MB_PID_LOOP_SPEED, 2.25f, 0.5f, 1.75f, 15000, 10000, 0) == MB_OK);
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && !(measured.status & 2) && measured.ref == 0);
    remote_rocker = 0; MotorBenchTask(); receive(0x0e, &group_enable, 1);
    remote_rocker = 330; MotorBenchTask();
    remote_online = 0; MotorBenchTask();
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && !(measured.status & 2) && measured.ref == 0);
    remote_online = 1; MotorBenchTask();
    receive(0x0e, &group_enable, 1);
    assert(MotorBenchGetMeasure(0, &measured) == MB_OK && !(measured.status & 2));
    remote_rocker = 0; MotorBenchTask();
    remote_rocker = 660; receive(0x0e, &group_enable, 1);
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && !(measured.status & 2) && measured.ref == 0);
    remote_rocker = 0; MotorBenchTask(); receive(0x0e, &group_enable, 1);
    remote_lateral = 660; MotorBenchTask();
    const float right[4] = {6000,-6000,-6000,6000};
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && measured.ref == right[i]);
    remote_lateral = 0; remote_yaw = 660; MotorBenchTask();
    const float clockwise[4] = {6000,-6000,6000,-6000};
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && measured.ref == clockwise[i]);
    created->daemon->temp_count = 0; MotorBenchTask();
    for (uint8_t i = 0; i < 4; ++i)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && !(measured.status & 2) && measured.ref == 0);
    DaemonReload(created->daemon); remote_yaw = 0; MotorBenchTask();
    receive(0x0e, &group_enable, 1); remote_rocker = 330; MotorBenchTask();
    assert(MotorBenchUnbind(2) == MB_OK);
    for (uint8_t i = 0; i < 4; ++i) if (i != 2)
        assert(MotorBenchGetMeasure(i, &measured) == MB_OK && !(measured.status & 2) && measured.ref == 0);
    for (uint8_t i = 0; i < 4; ++i) assert(MotorBenchRemoveMotor(MB_MOTOR_M3508, 1, i + 1) == MB_OK);
    puts("PASS: actual four-wheel mixer, group enable, RC loss, neutral rearm and member unbind stop");
    hUsbDeviceFS.dev_state = 0; hUsbDeviceFS.pClassData = NULL; cdc.TxState = 0;
    for (unsigned i = 0; i < 20; ++i) MotorBenchTask();
    hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED; hUsbDeviceFS.pClassData = &cdc;
    receive(1, NULL, 0); assert(cdc.TxState); drain();
    puts("PASS: async USB ownership, heartbeat-only timeout, rpm units, RC unbind and reconnect");
}
