@echo off
chcp 65001 >nul
cd /d "%~dp0"
if defined ELECTRON_RUN_AS_NODE set ELECTRON_RUN_AS_NODE=
call npm run dev
