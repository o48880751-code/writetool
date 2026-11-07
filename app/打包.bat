@echo off
chcp 65001 >nul
cd /d "%~dp0"
if defined ELECTRON_RUN_AS_NODE set ELECTRON_RUN_AS_NODE=

echo.
echo  正在打包（约需 3-5 分钟）...
echo.

REM NSIS 工具链要单独下，国内走镜像否则大概率失败
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

REM ⚠ 统一走 package-all.js，不再在这里另写一遍流程。
REM   原来这里有两处坑（2026-11-07）：
REM     ① `if not exist dist\index.html` 才 build —— 改了源码但 dist 已存在时
REM        会跳过编译，打出来的包是旧的，而且一路显示"成功"；
REM     ② 末尾把安装包路径写死成 release\WriteTool-0.1.0-setup.exe
REM        （品牌改名前 + 版本号占位值），实际产物是 InkScroll-2.0.5-setup.exe。
REM        照着那句提示去 release 里找，找不到，看起来就像"打包失败"。
REM     ③ `electron-builder --win nsis` 一步到底，绕过了分步等待 ——
REM        package-all.js 里那两段 2.5s/1.5s 是为了躲 signtool 的句柄占用，
REM        合成一步就会随机失败。
REM   现在路径由 package-all.js 从 package.json 的 artifactName 推导并当场校验。
call node package-all.js
if errorlevel 1 goto fail

pause
exit /b 0

:fail
echo.
echo  打包失败。常见原因：
echo   · 还在跑 InkScroll / WriteTool —— 先全部关掉（会占着 win-unpacked 里的文件）
echo   · 首次打包要下载 NSIS 工具链，检查网络或代理设置
echo   · Electron 二进制缺失：cd node_modules\electron 然后 node install.js
echo.
echo  上面最后几行才是真实原因，EBUSY / EPERM / 占用 基本都是没关进程。
echo.
pause
exit /b 1
