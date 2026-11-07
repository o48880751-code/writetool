@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==========================================
echo   打包 InkScroll
echo ==========================================
echo.
echo   打包前先把运行中的 InkScroll / WriteTool 全部退出。
echo   旧进程会占着 win-unpacked 里的文件，也会锁住同一个数据库。
echo.
node package-all.js
echo.
echo   （上面的 Exit code 为 0 就是成功；安装包路径和体积见倒数几行）
echo.
pause
