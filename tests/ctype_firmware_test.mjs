import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { crc8 } from '../motor_bench_host/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firmware = path.join(root, 'basic_framework_ctype_usb-master');
assert.ok(fs.existsSync(path.join(firmware, 'Src/can.c')), 'C 板固件尚未提供可执行的 CAN 配置');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctype-test-'));
try {
  const binary = path.join(temp, process.platform === 'win32' ? 'can-test.exe' : 'can-test');
  execFileSync(process.env.NATIVE_CC || 'gcc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror',
    '-I', path.join(root, 'tests/support'),
    '-I', path.join(firmware, 'modules/algorithm'),
    path.join(root, 'tests/ctype_can_test.c'),
    path.join(firmware, 'Src/can.c'),
    path.join(firmware, 'modules/algorithm/crc8.c'), '-o', binary,
  ], { stdio: 'inherit' });
  process.stdout.write(execFileSync(binary));
  const fixtures = ['0100', '02050002020102', '03050100002045', '04020001', '0500', '080400020201', '0b0400000000'];
  for (const hex of fixtures) {
    const actual = Number(execFileSync(binary, [hex], { encoding: 'utf8' }).trim());
    assert.equal(actual, crc8(Buffer.from(hex, 'hex')), `C 板 CRC 与上位机不一致: ${hex}`);
  }
  console.log(`PASS: C board / host CRC agreement (${fixtures.length} fixtures)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
