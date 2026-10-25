@echo off
chcp 65001 >nul
cd /d "%~dp0"
if defined ELECTRON_RUN_AS_NODE set ELECTRON_RUN_AS_NODE=

echo.
echo  正在打包 WriteTool（约需 3-5 分钟）...
echo.

REM NSIS 工具链要单独下，国内走镜像否则大概率失败
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

if not exist dist\index.html call npm run build:renderer
if errorlevel 1 goto fail

call npx electron-builder --win nsis
if errorlevel 1 goto fail

echo.
echo  打包完成。
echo  安装包：release\WriteTool-0.1.0-setup.exe
echo  便携版：release\win-unpacked\WriteTool.exe
echo.
pause
exit /b 0

:fail
echo.
echo  打包失败。常见原因：
echo   · 首次打包要下载 NSIS 工具链，检查网络或代理设置
echo   · Electron 二进制缺失：cd node_modules\electron ^&^& node install.js
echo.
pause
exit /b 1