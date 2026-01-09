@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================
REM ONEBOT FOUNDATION START (FROZEN)
REM - No modules list here
REM - No time/date formatting
REM - No log folder creation
REM - No hardcoded business commands
REM - Auto-restart only when exit code == 100
REM ============================================

set "BOT_NAME=ONEBOT"
set "CODE_ROOT=X:\OneBot"
set "DATA_ROOT=X:\OneData"

REM ---- Resolve Node (DO NOT rely on PATH) ----
set "NODE_EXE="
for %%F in (
  "%CODE_ROOT%\Software\node\node.exe"
  "%CODE_ROOT%\software\node\node.exe"
  "%CODE_ROOT%\node\node.exe"
) do (
  if exist "%%~F" set "NODE_EXE=%%~F"
)

if not defined NODE_EXE (
  echo.
  echo [FATAL] node.exe not found under CODE_ROOT.
  echo Expected one of:
  echo   %CODE_ROOT%\Software\node\node.exe
  echo   %CODE_ROOT%\node\node.exe
  echo.
  echo Fix: put portable Node inside X:\OneBot\Software\node\
  echo.
  pause
  exit /b 9009
)

if not exist "%CODE_ROOT%\Connector.js" (
  echo.
  echo [FATAL] Missing file: %CODE_ROOT%\Connector.js
  echo.
  pause
  exit /b 2
)

:LOOP
pushd "%CODE_ROOT%"

REM Export env for runtime (modules may read these)
set "ONEBOT_NAME=%BOT_NAME%"
set "ONEBOT_CODE_ROOT=%CODE_ROOT%"
set "ONEBOT_DATA_ROOT=%DATA_ROOT%"

"%NODE_EXE%" "%CODE_ROOT%\Connector.js"
set "EC=%ERRORLEVEL%"

popd

echo.
echo ===============================
echo ONEBOT EXIT CODE: %EC%
echo ===============================
echo.

if "%EC%"=="100" goto LOOP

echo Press any key to continue...
pause >nul
exit /b %EC%
