@echo off
REM ---------------------------------------------------------------
REM Run WriteTool from source (no installer, no packaging).
REM
REM WHY THIS FILE EXISTS
REM   2026-10-15: the packaged build was being shipped while the
REM   product still did not work. This launches the app straight
REM   from source so every change takes effect on double-click.
REM
REM IMPORTANT - CLOSE THE INSTALLED APP FIRST.
REM   Both the installer build and this one use the SAME user data
REM   directory (%APPDATA%\writetool) and the SAME SQLite file.
REM   Two processes writing one database at once -> lock errors and
REM   half-written conversations.
REM
REM NOTE: keep this file pure ASCII. cmd.exe parses .cmd using the
REM   active ANSI code page, so non-ASCII comments turn into garbage
REM   tokens and the batch file fails to parse at all.
REM ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] node_modules missing. Run: npm install
  pause
  exit /b 1
)

REM Must be cleared. This environment sets ELECTRON_RUN_AS_NODE=1 as a
REM PROCESS-level variable; electron.exe would then start in plain-node
REM mode and require('electron') would return a path string instead of
REM the API object - app would be undefined and nothing would print.
set ELECTRON_RUN_AS_NODE=

echo [INFO] starting WriteTool from source...
echo [INFO] close this window only after you have closed the app window.
echo.
"%~dp0node_modules\electron\dist\electron.exe" .
echo.
echo [INFO] app exited with code %ERRORLEVEL%
echo [INFO] log: %TEMP%\writetool-debug.log
pause
