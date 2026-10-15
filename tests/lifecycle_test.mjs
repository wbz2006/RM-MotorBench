import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-lifecycle-'));
try {
  for (const board of ['atype', 'ctype']) {
    const fw = path.join(root, `basic_framework_${board}_usb-master`);
    const onlyCan = process.argv.includes('--can-only');
    const dirs = ['bsp/can', 'modules/motor', 'modules/motor/DJImotor', 'modules/motor/DMmotor', 'modules/algorithm', 'modules/daemon', 'modules', 'application'];
    const sources = ['bsp/can/bsp_can.c'];
    if (!onlyCan) sources.push('modules/motor/DJImotor/dji_motor.c', 'modules/motor/DMmotor/dmmotor.c', 'modules/daemon/daemon.c');
    const binary = path.join(temp, `${board}.exe`);
    execFileSync(process.env.NATIVE_CC || 'gcc', ['-std=gnu11', '-Wall', '-Wno-unused-variable',
      '-I', path.join(root, 'tests/support'), ...dirs.flatMap(d => ['-I', path.join(fw, d)]),
      ...(onlyCan ? ['-DLIFECYCLE_CAN_ONLY'] : []), path.join(root, 'tests/lifecycle_test.c'),
      ...sources.map(s => path.join(fw, s)), '-o', binary], { stdio: 'inherit' });
    process.stdout.write(`${board}: ${execFileSync(binary)}`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
