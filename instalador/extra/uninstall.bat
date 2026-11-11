@echo off
set "params=%*"
cd /d "%~dp0" && ( if exist "%temp%\getadmin.vbs" del "%temp%\getadmin.vbs" ) && fsutil dirty query %systemdrive% 1>nul 2>nul || (  echo Set UAC = CreateObject^("Shell.Application"^) : UAC.ShellExecute "cmd.exe", "/k cd ""%~sdp0"" && %~s0 %params%", "", "runas", 1 >> "%temp%\getadmin.vbs" && "%temp%\getadmin.vbs" && exit /B )
NET STOP YaloPrinterService

netsh advfirewall firewall show rule name="YaloPrinterService" | find "YaloPrinterService" > nul
if %errorlevel% equ 0 (
    netsh advfirewall firewall delete rule name="YaloPrinterService"
)
netsh advfirewall firewall delete rule name="YaloPrinterService (programa)" >nul 2>nul

setlocal

cd ..

set RESOURCES_PATH=%cd%\resources
set SERVICE_NAME=YaloPrinterService
set INSTALL_DIR=%ProgramFiles%\Yalo\PrintAgent

set NSSM_PATH=%RESOURCES_PATH%\nssm.exe


"%NSSM_PATH%" remove "%SERVICE_NAME%"

REM El programa y las versiones bajadas. Los datos (cola, impresoras, vinculo con la nube) y los logs
REM quedan en %ProgramData%\Yalo\PrintAgent por si se vuelve a instalar.
timeout /t 3 /nobreak >nul
if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"

echo YaloPrinterService fue removido correctamente
