@echo off
REM ---------------------------------------------------------------
REM Electron launcher wrapper.
REM
REM WHY THIS FILE EXISTS:
REM   This execution environment sets ELECTRON_RUN_AS_NODE=1 as a
REM   PROCESS-level env var. electron.exe then starts in plain-Node
REM   mode: require('electron') returns the binary path STRING
REM   instead of the API object, so app / BrowserWindow are undefined.
REM
REM   The symptom is extremely misleading: the script prints NOTHING
REM   and exits 0. It looks like "the script never ran", when in fact
REM   require() already threw. (Cost three wasted rounds on
REM   2026-10-12: suspected my script, the file name, then a broken
REM   electron.exe.)
REM
REM NOTE: keep this file pure ASCII. cmd.exe parses .cmd as the
REM   active ANSI codepage, so non-ASCII comments become garbage
REM   tokens and the batch file fails to parse at all.
REM
REM Usage: electron-run.cmd <script.js>
REM ---------------------------------------------------------------
set ELECTRON_RUN_AS_NODE=
"%~dp0node_modules\electron\dist\electron.exe" %*
