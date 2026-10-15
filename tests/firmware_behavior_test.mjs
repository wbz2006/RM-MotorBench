import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-behavior-'));
try {
  for (const board of ['atype', 'ctype']) {
    const fw = path.join(root, `basic_framework_${board}_usb-master`);
    const dirs = ['bsp/can','modules/motor','modules/motor/DJImotor','modules/motor/DMmotor','modules/algorithm','modules/daemon','modules/motor_bench','modules','application','Middlewares/Third_Party/SEGGER/RTT','Middlewares/Third_Party/SEGGER/Config'];
    const sources = ['bsp/can/bsp_can.c','modules/motor/DJImotor/dji_motor.c','modules/motor/DMmotor/dmmotor.c','modules/daemon/daemon.c','modules/motor_bench/motor_bench.c','modules/motor_bench/bench_control.c','modules/algorithm/crc8.c','Middlewares/Third_Party/SEGGER/RTT/SEGGER_RTT_printf.c'];
    const binary = path.join(temp, `${board}.exe`);
    execFileSync(process.env.NATIVE_CC || 'gcc', ['-std=gnu11','-Wall','-Wno-unused-variable',
      `-DMB_TEST_LOG_HEADER="${path.join(fw,'bsp/log/bsp_log.h').replaceAll('\\','/')}"`,
      '-I',path.join(root,'tests/support'),...dirs.flatMap(d=>['-I',path.join(fw,d)]),
      path.join(root,'tests/firmware_behavior_test.c'),...sources.map(s=>path.join(fw,s)),'-o',binary], {stdio:'inherit'});
    process.stdout.write(`${board}: ${execFileSync(binary)}`);
  }
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
