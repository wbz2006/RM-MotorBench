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
import { firmwareRoot } from './firmware_test_paths.js';
import { crc8, buildFrame, buildBind, buildSetRef, buildEnable, MotorKind, LoopType } from './protocol.js';

// Cross-check the CMake firmware used for current builds.
const firmwareCrc = path.join(
  firmwareRoot,
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

/**
 * 依次尝试本机可用的原生 C 编译器
 *
 * @attention 为什么必须注入 MSYS2 的 PATH:
 *   本机 gcc 来自 MSYS2(gcc 15.2.0,装在 C:\msys64\mingw64\bin),
 *   而 `gcc --version` 能跑通、一旦真编译就 **status=1 且 stderr 完全为空**。
 *   原因是 gcc 及其子进程(cc1/as/ld)依赖 C:\msys64\usr\bin 下的运行时
 *   (msys-2.0.dll 等),该目录**不在 PATH 里**;缺依赖时进程直接静默退出,
 *   连错误信息都没有 —— 只表现为"编译失败但说不出为什么"。
 *
 *   实测:把 C:/msys64/mingw64/bin 与 C:/msys64/usr/bin 注入子进程 env 后,
 *   同一个 gcc 立刻编译成功。
 *
 * @note 绝对路径候选也要保留:MSYS2 的 gcc 目录同样不在系统 PATH。
 */
function findNativeCompiler() {
  const candidates = [
    'gcc',
    'cc',
    'clang',
    // Windows 上常见的独立安装位置
    'C:\\msys64\\mingw64\\bin\\gcc.exe',
    'C:\\msys64\\ucrt64\\bin\\gcc.exe',
    'C:\\msys64\\usr\\bin\\gcc.exe',
    'C:\\mingw64\\bin\\gcc.exe',
    'C:\\MinGW\\bin\\gcc.exe',
    'C:\\ProgramData\\chocolatey\\bin\\gcc.exe',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe', env: compilerEnv() });
      console.log(`用原生编译器: ${c}`);
      return c;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

/**
 * 给子进程补上 MSYS2 / MinGW 的运行时目录
 *
 * @note 只在"该目录确实存在"时才加,避免污染其它编译器(如 Visual Studio)。
 */
function compilerEnv() {
  const env = { ...process.env };
  const extra = [
    'C:\\msys64\\mingw64\\bin',
    'C:\\msys64\\ucrt64\\bin',
    'C:\\msys64\\usr\\bin',
    'C:\\mingw64\\bin',
    'C:\\MinGW\\bin',
  ].filter((p) => fs.existsSync(p));
  if (extra.length) {
    env.PATH = `${extra.join(';')};${env.PATH ?? ''}`;
  }
  return env;
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
  ], { stdio: 'pipe', env: compilerEnv() });
} catch (e) {
  /*
   * @attention 必须把 stderr/stdout 都打出来。
   *   原实现只打 e.stderr,若编译器是"找不到"而非"编译错",
   *   e.stderr 为空 → 只输出「用 gcc 编译固件 crc8.c 失败: 」,
   *   后面什么都没有,排查时完全看不出是"没装 gcc"还是"源码有语法错"。
   */
  const detail = [e.stderr, e.stdout, e.message].filter(Boolean).map(String).join('\n').trim();
  console.error(`用 ${cc} 编译固件 crc8.c 失败:\n${detail || '(无任何输出 — 通常是编译器路径不存在)'}`);
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
