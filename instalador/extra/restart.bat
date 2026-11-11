@echo off
set "params=%*"
cd /d "%~dp0" && ( if exist "%temp%\getadmin.vbs" del "%temp%\getadmin.vbs" ) && fsutil dirty query %systemdrive% 1>nul 2>nul || (  echo Set UAC = CreateObject^("Shell.Application"^) : UAC.ShellExecute "cmd.exe", "/k cd ""%~sdp0"" && %~s0 %params%", "", "runas", 1 >> "%temp%\getadmin.vbs" && "%temp%\getadmin.vbs" && exit /B )

NET STOP YaloPrinterService
NET START YaloPrinterService

echo YaloPrinterService se reinicio. Escucha en el puerto 3000 de todas las redes de esta PC.
echo Para ver si responde: http://127.0.0.1:3000/health
