@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title 电机测试台 - 启动中

cd /d "%~dp0motor_bench_host"

echo.
echo  ==========================================
echo    大疆 A 板电机测试台
echo  ==========================================
echo.
echo  [1/4] 工作目录
echo        %CD%

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [错误] 未找到 Node.js
    echo.
    echo  请先安装 Node.js   https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do set NODEVER=%%v
echo  [2/4] Node 版本: %NODEVER%

if not exist "node_modules\serialport" (
    echo.
    echo  [3/4] 首次运行, 正在安装依赖, 约需 1-2 分钟...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [错误] 依赖安装失败, 请检查网络后重试。
        echo.
        pause
        exit /b 1
    )
) else (
    echo  [3/4] 依赖已就绪
)

echo  [4/4] 检查服务端口 3000...
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo.
    echo  服务已在运行, 直接打开页面。
    echo.
    start "" "http://127.0.0.1:3000"
    timeout /t 2 >nul
    exit /b 0
)

echo.
echo  正在启动服务...
echo.
start "MotorBench Server - DO NOT CLOSE" cmd /k "cd /d "%~dp0motor_bench_host" && node server.js"

echo  等待服务就绪, 请稍候...
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
    echo  服务已启动:  http://127.0.0.1:3000
    echo.
    start "" "http://127.0.0.1:3000"
) else (
    echo  [警告] 服务启动超时, 请查看服务窗口中的错误信息。
    echo.
)

echo.
echo  提示: 关闭"电机测试台服务"窗口即可停止服务。
echo.
timeout /t 5 >nul
exit /b 0
