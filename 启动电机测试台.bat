@echo off
setlocal
title MotorBench Launcher

REM ============================================================
REM  RM Motor Bench - one-click launcher
REM
REM  cd to the host dir anchored on THIS file (%~dp0), so the
REM  service can never start from a stale copy elsewhere.
REM ============================================================

cd /d "%~dp0motor_bench_host"

echo.
echo  ==========================================
echo    RM Motor Bench   (A / C / MC02)
echo  ==========================================
echo.
echo  [1/4] Work dir: %CD%

REM ---- check node ----
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [ERROR] Node.js not found.
    echo  Please install from https://nodejs.org/ and run again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do set NODEVER=%%v
echo  [2/4] Node %NODEVER%

REM ---- check deps ----
if not exist "node_modules\serialport" (
    echo.
    echo  [3/4] First run: installing dependencies, 1-2 min...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. Check network and retry.
        echo.
        pause
        exit /b 1
    )
) else (
    echo  [3/4] Dependencies OK
)

REM ---- port already in use -> reuse, do not start a second one ----
echo  [4/4] Checking port 3000...
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo.
    echo  Server is already running - opening the page.
    echo.
    start "" "http://127.0.0.1:3000"
    timeout /t 2 >nul
    exit /b 0
)

REM ---- start the service in its own visible window ----
REM @attention no second cd here: we already cd above, and the
REM   cmd started by "start" inherits the current directory,
REM   so "node server.js" alone is enough.
REM   Writing cmd /k "cd /d "%~dp0..." && node server.js" nests two
REM   quote levels inside each other; cmd fails to parse it and the
REM   service silently never starts while the exit code stays 0.
REM @attention these REM lines must stay pure ASCII. Chinese here gets
REM   mangled to garbage bytes on write and cmd treats them as command
REM   names, e.g. "ejs.org is not recognized" - impossible to trace back.
echo.
echo  Starting server...
echo.
start "MotorBench Server - DO NOT CLOSE" cmd /k node server.js

REM ---- wait until the port is listening, then open the browser ----
echo  Waiting for the server to come up...
set READY=0
for /l %%i in (1,1,30) do (
    timeout /t 1 >nul
    netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul
    if not errorlevel 1 (
        set READY=1
        goto opened
    )
)
:opened
echo.
if "%READY%"=="1" (
    echo  Server is up:  http://127.0.0.1:3000
    echo.
    start "" "http://127.0.0.1:3000"
) else (
    echo  [WARN] Timed out. Check the server window for errors.
    echo.
)

echo.
echo  Close the "MotorBench Server" window to stop the service.
echo.
timeout /t 5 >nul
exit /b 0
