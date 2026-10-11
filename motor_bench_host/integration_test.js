/**
 * integration_test.js —— 交叉校验:把固件的 crc_8() 用原生 C 编译成可执行程序,
 * 与 Node 侧 protocol.js 对同一批数据算 CRC,确认两端逐位一致。
 *
 * 这比"两边都自己写一遍 CRC"可靠得多:固件那份是从 crc8.c 原样编译来的。
 *
 * 运行:node integration_test.js
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc8, buildFrame, buildBind, buildSetRef, buildEnable, MotorKind, LoopType } from './protocol.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const firmwareCrc = path.join(
  repoRoot,
  'basic_framework_atype-master',
  'modules',
  'algorithm',
  'crc8.c',
);

if (!fs.existsSync(firmwareCrc)) {
  console.error(`找不到固件 CRC 源文件: ${firmwareCrc}`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-crc-'));

/* ---- 1. 编译固件 crc8.c + 一个测试 main ---- */
const mainC = `
#include <stdio.h>
#include <stdint.h>
#include "crc8.h"

int main(void)
{
    uint8_t buf[256];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), stdin)) > 0)
        printf("%u\\n", (unsigned)crc_8(buf, (uint16_t)n));
    return 0;
}
`;

const mainPath = path.join(tmp, 'main.c');
fs.writeFileSync(mainPath, mainC);

/*
 * crc8.h 里 #include "main.h"(STM32 工程头),原生编译没有它。
 * 真实 main.h 间接提供了 stdint.h,所以这里要一并带上,
 * 否则 crc8.c 里的 uint8_t/uint16_t 会全部找不到类型。
 */
fs.writeFileSync(
  path.join(tmp, 'main.h'),
  '/* stub for native build */\n#include <stdint.h>\n',
);

const exePath = path.join(tmp, 'crc_probe.exe');

/** 依次尝试本机可用的原生 C 编译器(MinGW/Clang/MSVC 不可,故只找 gcc 家族) */
function findNativeCompiler() {
  const candidates = ['gcc', 'cc', 'clang'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      return c;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

const cc = findNativeCompiler();
if (!cc) {
  console.error('本机没有原生 gcc/clang,无法交叉校验。');
  console.error('若只想验证协议自洽性,请运行: node selftest.js');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
}

try {
  execFileSync(cc, [
    '-O1',
    '-I', tmp, // 提供 stub main.h
    '-I', path.dirname(firmwareCrc),
    '-o', exePath,
    mainPath,
    firmwareCrc,
  ], { stdio: 'pipe' });
} catch (e) {
  console.error(`用 ${cc} 编译固件 crc8.c 失败:`, e.stderr?.toString() ?? e.message);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
}

/* ---- 2. 喂同一批数据给两端 ---- */
const cases = [
  [0x01],
  [0xff],
  [0x03, 0x02],
  [0x03, 0x05, 0x00, 0x07, 0x40, 0x48, 0xf2, 0xc5], // setref 1234.5
  [0x00, 0xa5, 0x5a, 0x7f, 0x80, 0xff],
  [0x02, 0x05, 0x00, 0x01, 0x01, 0x05, 0x02], // bind payload
];

// 把所有样本拼成一条输入,用换行分隔长度,逐条喂给 C 程序
let failures = 0;
for (const c of cases) {
  const buf = Buffer.from(c);
  const out = execFileSync(exePath, { input: buf });
  const fwCrc = parseInt(out.toString().trim(), 10);
  const jsCrc = crc8(buf);
  const ok = fwCrc === jsCrc;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  bytes=[${c.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]  fw=${fwCrc} js=${jsCrc}`,
  );
}

/* ---- 3. 再校验整帧:固件算的 CRC 放回帧里,Node 侧应认可 ---- */
const frame = buildBind(0, { kind: MotorKind.M3508, canBus: 1, motorId: 5, outerLoop: LoopType.SPEED_LOOP });
const checked = frame.subarray(1, 3 + frame[2]); // type+len+payload
const out = execFileSync(exePath, { input: checked });
const fwCrc = parseInt(out.toString().trim(), 10);
const frameOk = fwCrc === frame[3 + frame[2]];
if (!frameOk) failures++;
console.log(`  ${frameOk ? 'PASS' : 'FAIL'}  full frame CRC matches firmware`);

const setFrame = buildSetRef(1, -2500.5);
const checked2 = setFrame.subarray(1, 3 + setFrame[2]);
const fwCrc2 = parseInt(execFileSync(exePath, { input: checked2 }).toString().trim(), 10);
const setOk = fwCrc2 === setFrame[3 + setFrame[2]];
if (!setOk) failures++;
console.log(`  ${setOk ? 'PASS' : 'FAIL'}  setref frame CRC matches firmware`);

const enFrame = buildEnable(0, true);
const checked3 = enFrame.subarray(1, 3 + enFrame[2]);
const fwCrc3 = parseInt(execFileSync(exePath, { input: checked3 }).toString().trim(), 10);
const enOk = fwCrc3 === enFrame[3 + enFrame[2]];
if (!enOk) failures++;
console.log(`  ${enOk ? 'PASS' : 'FAIL'}  enable frame CRC matches firmware`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'CROSS-CHECK PASSED' : `${failures} MISMATCH`}`);
process.exit(failures === 0 ? 0 : 1);