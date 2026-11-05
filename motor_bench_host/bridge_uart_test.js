import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('bridge forwards continuous 50 Hz UART telemetry without waiting for a full buffer', () => {
  const source = fs.readFileSync(new URL('../esp32s3_wifi_bridge/main/main.c', import.meta.url), 'utf8');
  const task = source.match(/static void uart_to_tcp_task\(void \*arg\)\n\{[\s\S]*?\n\}/)?.[0];
  assert.ok(task, 'test must compile the actual bridge task');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-bridge-uart-'));
  const env = { ...process.env };
  if (process.platform === 'win32') {
    env.PATH = ['C:/msys64/mingw64/bin', 'C:/msys64/usr/bin', env.PATH].join(';');
  }
  const harness = `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <setjmp.h>
#define BRIDGE_UART 1
#define UART_BUFFER_SIZE 4096
#define portMAX_DELAY UINT32_MAX
#define pdMS_TO_TICKS(ms) (ms)
#define ESP_ERROR_CHECK(result) assert((result) == 0)
#define ESP_LOGI(...) ((void)0)
static size_t buffered, read_offset, forwarded;
static unsigned elapsed_ms, last_send_ms, sends;
static jmp_buf done;
static int64_t esp_timer_get_time(void) { return (int64_t)elapsed_ms * 1000; }

/* UART boundary: 29 bytes arrive every 20 ms. Like ESP-IDF, each wait
 * inside a read has its own timeout, rather than one total deadline. */
static int uart_read_bytes(int uart, void *out, uint32_t length, uint32_t timeout)
{
    uint8_t *bytes = out;
    size_t count = 0;
    while (count < length) {
        if (!buffered) {
            if (timeout < 20) break;
            elapsed_ms += 20;
            buffered = 29;
        }
        bytes[count++] = (uint8_t)(read_offset++ % 251);
        buffered--;
    }
    return (int)count;
}
static int uart_get_buffered_data_len(int uart, size_t *length)
{
    *length = buffered;
    return 0;
}
static int get_client(void) { return 7; }
static void send_to_client(int socket, const uint8_t *data, size_t length)
{
    assert(socket == 7);
    assert(length > 0 && length <= UART_BUFFER_SIZE);
    assert(elapsed_ms - last_send_ms <= 40);
    for (size_t i = 0; i < length; i++)
        assert(data[i] == (uint8_t)((forwarded + i) % 251));
    forwarded += length;
    last_send_ms = elapsed_ms;
    if (++sends == 100) longjmp(done, 1);
}
${task}
int main(int argc, char **argv)
{
    buffered = (size_t)atoi(argv[1]);
    if (!setjmp(done)) uart_to_tcp_task(NULL);
    assert(forwarded > 0);
    return 0;
}
`;
  try {
    const main = path.join(tmp, 'main.c');
    const exe = path.join(tmp, process.platform === 'win32' ? 'bridge-uart.exe' : 'bridge-uart');
    fs.writeFileSync(main, harness);
    execFileSync('gcc', ['-std=c11', main, '-o', exe], { env, stdio: 'pipe' });
    execFileSync(exe, ['0'], { env, stdio: 'pipe' });
    execFileSync(exe, ['6000'], { env, stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
