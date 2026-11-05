#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <errno.h>
#include <sys/time.h>
#include <unistd.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"

#define WIFI_SSID "RM-MotorBench-ESP32"
#define WIFI_PASSWORD "motorbench"
#define TCP_PORT 7000

#define BRIDGE_UART UART_NUM_1
#define BRIDGE_UART_TX GPIO_NUM_17
#define BRIDGE_UART_RX GPIO_NUM_18
#define BRIDGE_UART_BAUD 115200
#define UART_BUFFER_SIZE 4096
#define TCP_BUFFER_SIZE 2048
#define CLIENT_IDLE_TIMEOUT_MS 5000

static const char *TAG = "motorbench_bridge";
static int client_socket = -1;
static SemaphoreHandle_t client_lock;
static const uint8_t HANDSHAKE[] = {0x4d, 0x42, 0x57, 0x31};
static const uint8_t HANDSHAKE_OK[] = {0x4d, 0x42, 0x4f, 0x4b};

static bool send_all(int socket_fd, const uint8_t *data, size_t length)
{
    size_t sent_total = 0;
    while (sent_total < length) {
        int sent = send(socket_fd, data + sent_total, length - sent_total, 0);
        if (sent <= 0) {
            ESP_LOGW(TAG, "TCP send failed: result=%d errno=%d sent=%u/%u", sent, errno,
                     (unsigned)sent_total, (unsigned)length);
            return false;
        }
        sent_total += sent;
    }
    return true;
}

static void close_client(void)
{
    xSemaphoreTake(client_lock, portMAX_DELAY);
    int socket_fd = client_socket;
    client_socket = -1;
    if (socket_fd >= 0) {
        shutdown(socket_fd, SHUT_RDWR);
        close(socket_fd);
    }
    xSemaphoreGive(client_lock);
    uart_flush_input(BRIDGE_UART);
}

static bool set_client(int socket_fd)
{
    xSemaphoreTake(client_lock, portMAX_DELAY);
    if (client_socket >= 0) {
        xSemaphoreGive(client_lock);
        return false;
    }
    client_socket = socket_fd;
    xSemaphoreGive(client_lock);
    return true;
}

static int get_client(void)
{
    xSemaphoreTake(client_lock, portMAX_DELAY);
    int socket_fd = client_socket;
    xSemaphoreGive(client_lock);
    return socket_fd;
}

static void send_to_client(int socket_fd, const uint8_t *data, size_t length)
{
    int64_t start_us = esp_timer_get_time();
    xSemaphoreTake(client_lock, portMAX_DELAY);
    if (client_socket == socket_fd && !send_all(socket_fd, data, length)) {
        shutdown(socket_fd, SHUT_RDWR);
    }
    xSemaphoreGive(client_lock);
    int64_t duration_ms = (esp_timer_get_time() - start_us) / 1000;
    if (duration_ms >= 100) ESP_LOGW(TAG, "TCP forwarding delayed: %lld ms bytes=%u", duration_ms, (unsigned)length);
}

static bool recv_handshake(int socket_fd)
{
    uint8_t received[sizeof(HANDSHAKE)];
    int count = recv(socket_fd, received, sizeof(received), MSG_WAITALL);
    return count == sizeof(received) && memcmp(received, HANDSHAKE, sizeof(HANDSHAKE)) == 0;
}

static void configure_keepalive(int socket_fd)
{
    int enabled = 1;
    int idle = 3;
    int interval = 2;
    int count = 3;
    setsockopt(socket_fd, SOL_SOCKET, SO_KEEPALIVE, &enabled, sizeof(enabled));
    setsockopt(socket_fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
    setsockopt(socket_fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval, sizeof(interval));
    setsockopt(socket_fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof(count));
}

static void tcp_server_task(void *arg)
{
    int server_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    ESP_ERROR_CHECK(server_socket >= 0 ? ESP_OK : ESP_FAIL);
    int reuse = 1;
    setsockopt(server_socket, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(TCP_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    ESP_ERROR_CHECK(bind(server_socket, (struct sockaddr *)&address, sizeof(address)) == 0 ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(listen(server_socket, 1) == 0 ? ESP_OK : ESP_FAIL);
    ESP_LOGI(TAG, "TCP server listening on %d", TCP_PORT);

    while (true) {
        struct sockaddr_storage peer;
        socklen_t peer_length = sizeof(peer);
        int socket_fd = accept(server_socket, (struct sockaddr *)&peer, &peer_length);
        if (socket_fd < 0) continue;
        configure_keepalive(socket_fd);
        struct timeval handshake_timeout = {.tv_sec = 5, .tv_usec = 0};
        setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &handshake_timeout, sizeof(handshake_timeout));
        bool valid = recv_handshake(socket_fd);
        if (!valid) {
            shutdown(socket_fd, SHUT_RDWR);
            close(socket_fd);
            continue;
        }
        if (!send_all(socket_fd, HANDSHAKE_OK, sizeof(HANDSHAKE_OK))) {
            shutdown(socket_fd, SHUT_RDWR);
            close(socket_fd);
            continue;
        }
        if (!set_client(socket_fd)) {
            shutdown(socket_fd, SHUT_RDWR);
            close(socket_fd);
            continue;
        }
        ESP_LOGI(TAG, "TCP client connected");

        struct timeval receive_timeout = {.tv_sec = 1, .tv_usec = 0};
        setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &receive_timeout, sizeof(receive_timeout));
        struct timeval send_timeout = {.tv_sec = 2, .tv_usec = 0};
        setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));
        int64_t last_received_us = esp_timer_get_time();
        uint32_t received_bytes = 0;
        uint8_t buffer[TCP_BUFFER_SIZE];
        while (get_client() == socket_fd) {
            int received = recv(socket_fd, buffer, sizeof(buffer), 0);
            if (received > 0) {
                last_received_us = esp_timer_get_time();
                received_bytes += received;
                int written = uart_write_bytes(BRIDGE_UART, (const char *)buffer, received);
                if (written != received)
                    ESP_LOGW(TAG, "UART write incomplete: written=%d expected=%d", written, received);
                continue;
            }
            if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                if (esp_timer_get_time() - last_received_us < CLIENT_IDLE_TIMEOUT_MS * 1000LL) continue;
                ESP_LOGW(TAG, "TCP client idle timeout");
            }
            if (received == 0) ESP_LOGI(TAG, "TCP peer closed connection");
            else if (errno != EAGAIN && errno != EWOULDBLOCK)
                ESP_LOGW(TAG, "TCP receive failed: errno=%d", errno);
            break;
        }
        close_client();
        ESP_LOGI(TAG, "TCP client disconnected: received_bytes=%u", (unsigned)received_bytes);
    }
}

static void uart_to_tcp_task(void *arg)
{
    static uint8_t buffer[UART_BUFFER_SIZE];
    uint32_t rx_bytes = 0;
    uint32_t batches = 0;
    size_t max_batch = 0;
    int64_t last_rx_us = esp_timer_get_time();
    int64_t last_report_us = last_rx_us;
    while (true) {
        // A large blocking read waits for a full batch under continuous telemetry.
        int count = uart_read_bytes(BRIDGE_UART, buffer, 1, pdMS_TO_TICKS(100));
        if (count > 0) {
            size_t buffered = 0;
            ESP_ERROR_CHECK(uart_get_buffered_data_len(BRIDGE_UART, &buffered));
            if (buffered > sizeof(buffer) - 1) buffered = sizeof(buffer) - 1;
            if (buffered > 0) {
                int extra = uart_read_bytes(BRIDGE_UART, buffer + 1, buffered, 0);
                if (extra > 0) count += extra;
            }
            last_rx_us = esp_timer_get_time();
            rx_bytes += count;
            batches++;
            if ((size_t)count > max_batch) max_batch = count;
            int socket_fd = get_client();
            if (socket_fd >= 0) send_to_client(socket_fd, buffer, count);
        }
        int64_t now_us = esp_timer_get_time();
        if (now_us - last_report_us >= 5000000) {
            ESP_LOGI(TAG, "UART stats: rx_bytes=%u batches=%u max_batch=%u idle_ms=%lld tcp_connected=%d",
                     (unsigned)rx_bytes, (unsigned)batches, (unsigned)max_batch,
                     (now_us - last_rx_us) / 1000, get_client() >= 0);
            last_report_us = now_us;
        }
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STACONNECTED) {
        ESP_LOGI(TAG, "Wi-Fi station connected");
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STADISCONNECTED) {
        const wifi_event_ap_stadisconnected_t *event = event_data;
        ESP_LOGW(TAG, "Wi-Fi station disconnected: reason=%u", event->reason);
        close_client();
    }
}

static void wifi_init_softap(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&config));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STACONNECTED, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_AP_STADISCONNECTED, &wifi_event_handler, NULL));

    wifi_config_t ap_config = {0};
    snprintf((char *)ap_config.ap.ssid, sizeof(ap_config.ap.ssid), "%s", WIFI_SSID);
    snprintf((char *)ap_config.ap.password, sizeof(ap_config.ap.password), "%s", WIFI_PASSWORD);
    ap_config.ap.ssid_len = strlen(WIFI_SSID);
    ap_config.ap.channel = 1;
    ap_config.ap.max_connection = 1;
    ap_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "SoftAP ready: SSID=%s address=192.168.4.1 port=%d", WIFI_SSID, TCP_PORT);
}

void app_main(void)
{
    ESP_LOGI(TAG, "Bridge boot: reset_reason=%d UART=%d baud=%d TX=%d RX=%d immediate_forward=1",
             esp_reset_reason(), BRIDGE_UART, BRIDGE_UART_BAUD, BRIDGE_UART_TX, BRIDGE_UART_RX);
    esp_err_t nvs_result = nvs_flash_init();
    if (nvs_result == ESP_ERR_NVS_NO_FREE_PAGES || nvs_result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(nvs_result);
    }

    uart_config_t uart_config = {
        .baud_rate = BRIDGE_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
    };
    ESP_ERROR_CHECK(uart_driver_install(BRIDGE_UART, UART_BUFFER_SIZE * 2, UART_BUFFER_SIZE * 2, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(BRIDGE_UART, &uart_config));
    ESP_ERROR_CHECK(uart_set_pin(BRIDGE_UART, BRIDGE_UART_TX, BRIDGE_UART_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    client_lock = xSemaphoreCreateMutex();
    wifi_init_softap();
    xTaskCreate(tcp_server_task, "tcp_server", 4096, NULL, 5, NULL);
    xTaskCreate(uart_to_tcp_task, "uart_to_tcp", 3072, NULL, 6, NULL);
}
