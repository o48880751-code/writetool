@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 关键：清掉 ELECTRON_RUN_AS_NODE。
REM 这个变量存在时 Electron 不初始化 GUI 运行时，require('electron') 只返回
REM 一个 exe 路径字符串，所有 app/BrowserWindow API 都是 undefined。
REM 见 README「环境踩过的坑」第 1 条。
if defined ELECTRON_RUN_AS_NODE set ELECTRON_RUN_AS_NODE=

if not exist node_modules\electron\dist\electron.exe (
  echo 首次运行，正在安装依赖...
  call npm install
)

if not exist dist\index.html (
  echo 正在构建渲染进程...
  call npm run build:renderer
)

start "" node_modules\electron\dist\electron.exe .
echo WriteTool 已启动。
