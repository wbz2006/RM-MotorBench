import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardLabelFromFlags } from './protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test('all three board identities survive capability/online flags; legacy stays generic', () => {
  for (let lowBits = 0; lowBits < 32; lowBits++) {
    for (const toleranceCapability of [0, 0x80]) {
      const capabilities = lowBits | toleranceCapability;
      assert.equal(boardLabelFromFlags(0x20 | capabilities), 'A 板');
      assert.equal(boardLabelFromFlags(0x40 | capabilities), 'C 板');
      assert.equal(boardLabelFromFlags(capabilities), '控制板');
      assert.equal(boardLabelFromFlags(0x60 | capabilities), 'MC02 板');
    }
  }
});

test('MC02 retains shared control sources with explicit H723 hardware adaptations', () => {
  const a = sources('motorbench-a'), mc02 = sources('motorbench-mc02');
  assert.ok(mc02.delete('bsp/can/bsp_can_hal.c'), 'H723 needs a real FDCAN adapter');
  assert.deepEqual([...a.keys()].sort(), [...mc02.keys()].sort());
  for (const [file, source] of a) {
    let left = source, right = mc02.get(file);
    if (file === 'application/motor_bench_app/motor_bench_app.c') {
      assert.equal(right.trim(), sources('motorbench-c').get(file).trim(), 'MC02 uses the USB-only application');
      continue;
    }
    if (file === 'bsp/bsp_init.c') {
      assert.match(right, /DWT_Init\(SystemCoreClock \/ 1000000u\)/);
      right = right.replace('SystemCoreClock / 1000000u', '168');
    } else if (file === 'bsp/pwm/bsp_pwm.h') {
      right = right.replace('stm32h7xx_hal_rcc.h', 'stm32f4xx_hal_rcc.h').replace('stm32h723xx.h', 'stm32f427xx.h');
    } else if (file === 'bsp/pwm/bsp_pwm.c') {
      // Only the MCU-specific timer clock selector may differ.
      const selector = /static uint32_t PWMSelectTclk\(TIM_HandleTypeDef \*htim\s*\)\s*\{[\s\S]*$/;
      assert.match(right.match(selector)?.[0] ?? '', /HAL_RCC_GetClockConfig/);
      assert.match(right.match(selector)?.[0] ?? '', /clocks.APB2CLKDivider == RCC_APB2_DIV1/);
      left = left.replace(selector, 'BOARD_TIMER_CLOCK_SELECTOR');
      right = right.replace(selector, 'BOARD_TIMER_CLOCK_SELECTOR');
    } else if (file === 'modules/motor_bench/usb_probe.c') {
      right = right.replaceAll('stm32h723xx.h', 'stm32f427xx.h')
        .replaceAll('USB_OTG_HS', 'USB_OTG_FS').replace('USB OTG HS registers', 'USB OTG FS registers')
        .replace('AHB1ENR USB1OTGHSEN', 'AHB2ENR bit17 = OTGFSCLKEN')
        .replace('RCC->AHB1ENR=0x%08X OTGHSCLKEN=%d', 'RCC->AHB2ENR=0x%08X OTGFSCLEN=%d')
        .replace('(unsigned)RCC->AHB1ENR, (int)((RCC->AHB1ENR & RCC_AHB1ENR_USB1OTGHSEN) != 0)',
          '(unsigned)RCC->AHB2ENR, (int)((RCC->AHB2ENR >> 17) & 1)');
    }
    assert.equal(left.trim(), right.trim(), `${file}: migrate behavior to MC02`);
  }
});
function sources(board) {
  const files = new Map();
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, board, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.[ch]$/.test(file)) files.set(file, fs.readFileSync(path.join(root, board, file), 'utf8').replaceAll('\r\n', '\n'));
    }
  }
  for (const dir of ['application', 'modules', 'bsp']) visit(dir);
  return files;
}

test('A/C control, protocol, defaults and recovery logic stay aligned with explicit board exceptions', () => {
  const a = sources('motorbench-a'), c = sources('motorbench-c');
  assert.deepEqual([...a.keys()].sort(), [...c.keys()].sort(), 'new control sources must be migrated to both boards');
  for (const [file, aSource] of a) {
    let left = aSource, right = c.get(file);
    if (file === 'bsp/pwm/bsp_pwm.h' || file === 'modules/motor_bench/usb_probe.c') {
      assert.match(left, /#include "stm32f427xx.h"/);
      assert.match(right, /#include "stm32f407xx.h"/);
      left = left.replace('stm32f427xx.h', 'BOARD_MCU.h');
      right = right.replace('stm32f407xx.h', 'BOARD_MCU.h');
    } else if (file === 'application/motor_bench_app/motor_bench_app.c') {
      // A supports an optional UART7 transport; C uses its own USB hardware.
      assert.match(left, /#elif defined\(MOTOR_BENCH_LINK_UART\)/);
      assert.doesNotMatch(right, /MotorBenchInit\(&huart7\)/);
      left = left.replace(/#if defined\(MOTOR_BENCH_LINK_USB\)[\s\S]*?#endif/, 'MotorBenchInitUSB();');
      left = left.replace(/\/\*[\s\S]*?\*\//g, '');
      right = right.replace(/\/\*[\s\S]*?\*\//g, '');
      left = left.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
      right = right.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    }
    assert.equal(left.trim(), right.trim(), `${file}: review and migrate the missing behavior`);
  }
});
