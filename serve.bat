@echo off
setlocal
title ming-games local server
set "NODE_EXE=C:\Users\31474\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo.
echo   ming-games - local server
echo   Building products first (web + offline)...
echo.
"%NODE_EXE%" "%~dp0tools\build.mjs" --target=all
if errorlevel 1 (
  echo.
  echo   [!] Build failed. Fix the error above and retry.
  pause
  exit /b 1
)
echo.
echo   Open http://127.0.0.1:5390/ in your browser.
echo   For pure file:// offline play, double-click offline\index.html instead.
echo.
"%NODE_EXE%" "%~dp0server.mjs" --root=dist --port=5390
pause
