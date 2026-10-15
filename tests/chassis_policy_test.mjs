import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-chassis-'));
try {
  for (const board of ['atype', 'ctype']) {
    const moduleDir = path.join(root, `basic_framework_${board}_usb-master/modules/motor_bench`);
    for (const name of ['control_policy_test', 'chassis_policy_test']) {
      const binary = path.join(temp, `${board}-${name}.exe`);
      execFileSync(process.env.NATIVE_CC || 'gcc', ['-std=c11','-Wall','-Wextra','-Werror',
        '-I',moduleDir,path.join(root, `tests/${name}.c`),path.join(moduleDir,'bench_control.c'),'-o',binary], {stdio:'inherit'});
      process.stdout.write(`${board}: ${execFileSync(binary)}`);
    }
  }
} finally {
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('mb-chassis-'))
    throw Error('Unexpected test directory');
  fs.rmSync(temp, {recursive:true,force:true});
}
