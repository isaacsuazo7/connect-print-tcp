@echo off
REM Muestra las IP de esta PC. Para soporte: configurar a mano el servidor de impresoras en el POS. La PC
REM de caja se encuentra sola por 127.0.0.1 y el servicio solo atiende a esta PC (OBS-14).
setlocal

set SERVICE_NAME=YaloPrinterService
set LOCAL_PORT=3000

sc query %SERVICE_NAME% >nul
if %errorlevel% equ 1060 (
	echo El servicio %SERVICE_NAME% no esta instalado.
	pause
	exit /b
)

echo IP de esta PC (YaloPrinterService, puerto %LOCAL_PORT%, solo atiende a esta PC):
echo   http://127.0.0.1:%LOCAL_PORT%  (esta misma PC)
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /r /c:"IPv4"') do echo   http:%%a:%LOCAL_PORT%
echo.
echo Para ver si responde, abrir en el navegador: http://127.0.0.1:%LOCAL_PORT%/health

pause
