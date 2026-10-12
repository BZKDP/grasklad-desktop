@echo off
setlocal EnableExtensions
set "PS=%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%WINDIR%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS=%WINDIR%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0install-printer.ps1" -RunId "installer" -AllowDisconnected
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
