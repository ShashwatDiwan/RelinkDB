@echo off
setlocal
set "APP_DIR=%~dp0"
set "PORTABLE_EXE=%APP_DIR%dist\portable\RelinkDB.exe"

if exist "%PORTABLE_EXE%" (
  start "" "%PORTABLE_EXE%"
  exit /b 0
)

start "" "%APP_DIR%node_modules\electron\dist\electron.exe" "%APP_DIR%"
