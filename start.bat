@echo off
title 同声传译 - 英译中
cd /d "%~dp0"
cls

echo.
echo   ==========================================
echo      同声传译 - 英译中
echo   ==========================================
echo.

if not exist "server.js" (
    echo   [X] 这个文件夹里没有 server.js
    echo.
    echo       请把 start.bat 和 server.js 放在同一层,
    echo       不要放进 public 文件夹里。
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo   [X] 没找到 Node.js
    echo.
    echo       先去 https://nodejs.org 下载安装 LTS 版本,
    echo       装完关掉这个窗口,重新双击本文件。
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo   Node.js %NODEV%   OK

if not exist "node_modules\ws" (
    echo.
    echo   首次运行,正在安装依赖,请稍等 ...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [X] 依赖装不上。多半是网络问题,换个国内源再试:
        echo.
        echo       npm config set registry https://registry.npmmirror.com
        echo.
        pause
        exit /b 1
    )
)

echo.
echo   ------------------------------------------
echo   浏览器会自动打开 http://localhost:8787
echo   没打开的话,手动在浏览器里输入这个地址。
echo.
echo   注意:不要双击 public\index.html 打开,
echo         那样没有中转服务,用不了。
echo.
echo   要停止服务,直接关掉这个窗口。
echo   ------------------------------------------
echo.

start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://localhost:8787"
node server.js

echo.
echo   服务已停止。
pause
