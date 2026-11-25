@echo off
REM Instala (o actualiza a mano) YaloPrinterService como servicio de Windows.
REM Brief 6.2.1: arranque retardado (no arranca antes que la red), reinicio solo si se cae,
REM firewall abierto para el puerto, logs en %ProgramData%\Yalo\PrintAgent y auto-actualizacion.
REM
REM El programa queda en %ProgramFiles%\Yalo\PrintAgent (solo un administrador puede escribir ahi): ahi
REM mismo la auto-actualizacion guarda las versiones nuevas (versions\<version>\). Instalar a mano un
REM paquete siempre manda: borra las versiones bajadas y arranca con la de este paquete.

REM Pedir permisos de administrador antes de tocar el servicio.
set "params=%*"
cd /d "%~dp0" && ( if exist "%temp%\getadmin.vbs" del "%temp%\getadmin.vbs" ) && fsutil dirty query %systemdrive% 1>nul 2>nul || (  echo Set UAC = CreateObject^("Shell.Application"^) : UAC.ShellExecute "cmd.exe", "/k cd ""%~sdp0"" && %~s0 %params%", "", "runas", 1 >> "%temp%\getadmin.vbs" && "%temp%\getadmin.vbs" && exit /B )

setlocal

set RESOURCES_PATH=%~dp0resources
set SERVICE_NAME=YaloPrinterService
set INSTALL_DIR=%ProgramFiles%\Yalo\PrintAgent
set SERVICE_EXE=%INSTALL_DIR%\YaloPrinterService.exe
set NSSM_PATH=%INSTALL_DIR%\nssm.exe
set LOCAL_PORT=3000
set LOG_DIR=%ProgramData%\Yalo\PrintAgent

if not exist "%RESOURCES_PATH%\YaloPrinterService.exe" (
    echo Falta resources\YaloPrinterService.exe en el paquete.
    pause
    exit /b 1
)

REM Si ya estaba instalado (version anterior), quitarlo primero: la version vieja escucha en una sola IP
REM y Windows deja que convivan dos procesos en el 3000; la vieja ganaria en esa IP.
sc query %SERVICE_NAME% >nul 2>nul
if %errorlevel% equ 0 (
    NET STOP %SERVICE_NAME% >nul 2>nul
    "%RESOURCES_PATH%\nssm.exe" remove "%SERVICE_NAME%" confirm
    REM Windows tarda un momento en soltar el .exe despues de parar el servicio.
    timeout /t 3 /nobreak >nul
)

REM Copiar el programa a su carpeta fija. Las versiones bajadas por la auto-actualizacion se borran.
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if exist "%INSTALL_DIR%\versions" rmdir /s /q "%INSTALL_DIR%\versions"
if exist "%INSTALL_DIR%\actualizacion.json" del /q "%INSTALL_DIR%\actualizacion.json"
copy /y "%RESOURCES_PATH%\YaloPrinterService.exe" "%SERVICE_EXE%" >nul
if %errorlevel% neq 0 (
    echo No se pudo copiar el programa a "%INSTALL_DIR%". Cerrar YaloPrinterService si esta abierto y volver a intentar.
    pause
    exit /b 1
)
copy /y "%RESOURCES_PATH%\nssm.exe" "%NSSM_PATH%" >nul

"%NSSM_PATH%" install "%SERVICE_NAME%" "%SERVICE_EXE%"
"%NSSM_PATH%" set "%SERVICE_NAME%" AppDirectory "%INSTALL_DIR%"

REM Arranque automatico retardado: espera a que la red este lista despues de un apagon.
"%NSSM_PATH%" set "%SERVICE_NAME%" Start SERVICE_DELAYED_AUTO_START

REM Si el programa se cierra, nssm lo vuelve a levantar a los 5 s.
"%NSSM_PATH%" set "%SERVICE_NAME%" AppExit Default Restart
"%NSSM_PATH%" set "%SERVICE_NAME%" AppRestartDelay 5000

REM Si el servicio entero cae, Windows lo reinicia: a los 5 s, 15 s y 60 s (el contador se reinicia cada dia).
sc failure %SERVICE_NAME% reset= 86400 actions= restart/5000/restart/15000/restart/60000

REM Logs (para soporte), rotando a 1 MB. Misma carpeta que los datos del agente (cola, impresoras).
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
"%NSSM_PATH%" set "%SERVICE_NAME%" AppStdout "%LOG_DIR%\servicio.log"
"%NSSM_PATH%" set "%SERVICE_NAME%" AppStderr "%LOG_DIR%\servicio.log"
"%NSSM_PATH%" set "%SERVICE_NAME%" AppRotateFiles 1
"%NSSM_PATH%" set "%SERVICE_NAME%" AppRotateOnline 1
"%NSSM_PATH%" set "%SERVICE_NAME%" AppRotateBytes 1048576

REM Firewall por puerto: cubre tambien las versiones que baje la auto-actualizacion (otra carpeta).
netsh advfirewall firewall show rule name="%SERVICE_NAME%" > nul
if %errorlevel% neq 0 (
    netsh advfirewall firewall add rule name="%SERVICE_NAME%" dir=in action=allow protocol=TCP localport=%LOCAL_PORT%
)
REM Regla por programa: se rehace porque antes apuntaba a la carpeta donde se descomprimia el paquete.
netsh advfirewall firewall delete rule name="%SERVICE_NAME% (programa)" >nul 2>nul
netsh advfirewall firewall add rule name="%SERVICE_NAME% (programa)" dir=in action=allow program="%SERVICE_EXE%" enable=yes

NET START %SERVICE_NAME%

echo.
echo YaloPrinterService quedo instalado en "%INSTALL_DIR%" (puerto %LOCAL_PORT%). Solo atiende a esta PC.
echo Se actualiza solo cuando Yalo publica una version nueva.
echo El POS de esta PC lo encuentra solo: no hace falta copiar ninguna IP.
echo Abre el POS en esta PC y toca Reconectar impresoras en Configuracion - Dispositivos.
