@echo off
REM Muestra las IP de esta PC. Solo hace falta para una tablet que imprime A TRAVES de esta PC desde el
REM navegador: la PC de caja se encuentra sola por 127.0.0.1 (el servicio escucha en todas sus redes).
setlocal

set SERVICE_NAME=YaloPrinterService
set LOCAL_PORT=3000

sc query %SERVICE_NAME% >nul
if %errorlevel% equ 1060 (
	echo El servicio %SERVICE_NAME% no esta instalado.
	pause
	exit /b
)

echo YaloPrinterService escucha en el puerto %LOCAL_PORT% de todas las redes de esta PC:
echo   http://127.0.0.1:%LOCAL_PORT%  (esta misma PC)
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /r /c:"IPv4"') do echo   http:%%a:%LOCAL_PORT%
echo.
echo Para ver si responde, abrir en el navegador: http://127.0.0.1:%LOCAL_PORT%/health

pause
