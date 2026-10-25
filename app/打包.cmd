@echo off
cd /d "%~dp0"
echo.
echo ==========================================
echo   WriteTool build
echo ==========================================
echo.
echo   Make sure WriteTool is CLOSED first.
echo.
node package-all.js
echo.
echo Exit code: %errorlevel%
echo.
pause
