/**
 * 生成「启动电机测试台.bat」
 *
 * 为什么用 Node 而不是 PowerShell 写:
 *   1. bat 需要 **CRLF** 换行。PowerShell 的 Set-Content/WriteAllText 组合
 *      在本机把 LF 写进了文件,cmd.exe 解析时会把行从中间截断,
 *      报出 "'ejs.org' is not recognized" 这类莫名其妙的错误 ——
 *      实测踩过这个坑。
 *   2. 内容一律纯 ASCII。中文提示在 chcp 936/65001 下都曾出现
 *      "中文被当成命令名"的问题;标题里带中文还会与前后的引号形成
 *      嵌套,导致整条 start 命令失效。纯 ASCII 从根上避免这一类问题。
 *   3. 文件名保留中文(用户双击时看得懂),文件名由 NTFS 以 UTF-16 存储,
 *      与文件内容的编码无关,不受影响。
 *
 * 运行:node make_launcher.js
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '启动电机测试台.bat');

/* 纯 ASCII 内容。每行不带 \n,统一在最后按 CRLF 拼接。 */
const LINES = [
  '@echo off',
  'setlocal',
  'title MotorBench Launcher',
  '',
  'REM ============================================================',
  'REM  RM Motor Bench - one-click launcher',
  'REM',
  'REM  cd to the host dir anchored on THIS file (%~dp0), so the',
  'REM  service can never start from a stale copy elsewhere.',
  'REM ============================================================',
  '',
  'cd /d "%~dp0motor_bench_host"',
  '',
  'echo.',
  'echo  ==========================================',
  'echo    RM Motor Bench   (DJI A-board)',
  'echo  ==========================================',
  'echo.',
  'echo  [1/4] Work dir: %CD%',
  '',
  'REM ---- check node ----',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '    echo.',
  '    echo  [ERROR] Node.js not found.',
  '    echo  Please install from https://nodejs.org/ and run again.',
  '    echo.',
  '    pause',
  '    exit /b 1',
  ')',
  'for /f "tokens=*" %%v in (\'node --version 2^>^&1\') do set NODEVER=%%v',
  'echo  [2/4] Node %NODEVER%',
  '',
  'REM ---- check deps ----',
  'if not exist "node_modules\\serialport" (',
  '    echo.',
  '    echo  [3/4] First run: installing dependencies, 1-2 min...',
  '    echo.',
  '    call npm install',
  '    if errorlevel 1 (',
  '        echo.',
  '        echo  [ERROR] npm install failed. Check network and retry.',
  '        echo.',
  '        pause',
  '        exit /b 1',
  '    )',
  ') else (',
  '    echo  [3/4] Dependencies OK',
  ')',
  '',
  'REM ---- port already in use -> reuse, do not start a second one ----',
  'echo  [4/4] Checking port 3000...',
  'netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul',
  'if not errorlevel 1 (',
  '    echo.',
  '    echo  Server is already running - opening the page.',
  '    echo.',
  '    start "" "http://127.0.0.1:3000"',
  '    timeout /t 2 >nul',
  '    exit /b 0',
  ')',
  '',
  'REM ---- start the service in its own visible window ----',
  'REM @attention no second cd here: we already cd above, and the',
  'REM   cmd started by "start" inherits the current directory,',
  'REM   so "node server.js" alone is enough.',
  'REM   Writing cmd /k "cd /d "%~dp0..." && node server.js" nests two',
  'REM   quote levels inside each other; cmd fails to parse it and the',
  'REM   service silently never starts while the exit code stays 0.',
  'REM @attention these REM lines must stay pure ASCII. Chinese here gets',
  'REM   mangled to garbage bytes on write and cmd treats them as command',
  'REM   names, e.g. "ejs.org is not recognized" - impossible to trace back.',
  'echo.',
  'echo  Starting server...',
  'echo.',
  'start "MotorBench Server - DO NOT CLOSE" cmd /k node server.js',
  '',
  'REM ---- wait until the port is listening, then open the browser ----',
  'echo  Waiting for the server to come up...',
  'set READY=0',
  'for /l %%i in (1,1,30) do (',
  '    timeout /t 1 >nul',
  '    netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul',
  '    if not errorlevel 1 (',
  '        set READY=1',
  '        goto opened',
  '    )',
  ')',
  ':opened',
  'echo.',
  'if "%READY%"=="1" (',
  '    echo  Server is up:  http://127.0.0.1:3000',
  '    echo.',
  '    start "" "http://127.0.0.1:3000"',
  ') else (',
  '    echo  [WARN] Timed out. Check the server window for errors.',
  '    echo.',
  ')',
  '',
  'echo.',
  'echo  Close the "MotorBench Server" window to stop the service.',
  'echo.',
  'timeout /t 5 >nul',
  'exit /b 0',
  '',
];

const content = LINES.join('\r\n');
fs.writeFileSync(OUT, content, { encoding: 'ascii' });

/* ---- 自校验:编码与换行都必须正确,否则 cmd 会解析失败 ---- */
const buf = fs.readFileSync(OUT);
const text = buf.toString('ascii');

const checks = [
  ['written as pure ASCII (no byte > 127)', buf.every((b) => b <= 127)],
  ['uses CRLF line endings', text.includes('\r\n') && !/[^\r]\n/.test(text)],
  ['no lone LF', !/[^\r]\n/.test(text)],
  ['first line is @echo off', text.startsWith('@echo off\r\n')],
  ['anchors on %~dp0', text.includes('cd /d "%~dp0motor_bench_host"')],
  ['start line has no nested quotes',
    /start "MotorBench Server[^"]*" cmd \/k node server\.js/.test(text)],
  ['reuses an already-running server', text.includes('Server is already running')],
  ['opens the browser after the port is listening', text.includes('Server is up:')],
];

let bad = 0;
console.log(`已写入 ${OUT}`);
console.log(`  ${buf.length} 字节, ${LINES.length} 行\n`);
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) bad++;
}
console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : `${bad} CHECK(S) FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
