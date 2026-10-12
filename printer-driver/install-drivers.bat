@echo off
rem Ставит все вшитые драйверы (принтер Xprinter + CH340 сканера) через pnputil.
rem Находит свою папку через %~dp0 (работает при любом каталоге установки).
rem Не зависит от PowerShell ExecutionPolicy. Лог пишется рядом.
setlocal EnableExtensions EnableDelayedExpansion
set "LOG=%~dp0driver-install.log"
set "PNPUTIL=%WINDIR%\System32\pnputil.exe"
if exist "%WINDIR%\Sysnative\pnputil.exe" set "PNPUTIL=%WINDIR%\Sysnative\pnputil.exe"
set /a FAIL=0
echo [start] %DATE% %TIME% dir=%~dp0> "%LOG%"
if not exist "%PNPUTIL%" (
  echo [error] pnputil.exe not found: %PNPUTIL%>> "%LOG%"
  exit /b 2
)
for /r "%~dp0" %%f in (*.inf) do (
  echo --- %%f>> "%LOG%"
  "%PNPUTIL%" /add-driver "%%f" /install>> "%LOG%" 2>&1
  set "RC=!ERRORLEVEL!"
  echo EXITCODE=!RC!>> "%LOG%"
  if not "!RC!"=="0" if not "!RC!"=="259" if not "!RC!"=="3010" set /a FAIL+=1
)
if not "!FAIL!"=="0" (
  echo [failed] count=!FAIL!>> "%LOG%"
  endlocal & exit /b 1
)
echo [done] failed=0>> "%LOG%"
endlocal & exit /b 0
