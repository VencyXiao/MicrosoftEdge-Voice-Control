@echo off
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "DOCROOT=%HERE:~0,-1%"
if not defined DOCROOT set "DOCROOT=%HERE%"
if not exist "%HERE%speech.html" goto NOFILE
echo ================================================
echo  Voice host server : http://127.0.0.1:8765/speech.html
echo  Folder            : %DOCROOT%
echo  Keep this window open. Close it to stop.
echo ================================================
python -m http.server 8765 --bind 127.0.0.1 --directory "%DOCROOT%"
if errorlevel 1 echo [ERROR] Server exited. Check: python --version
pause
exit /b 0

:NOFILE
echo [ERROR] speech.html not found in: %DOCROOT%
echo Copy the whole "server" folder and run this bat inside it.
pause
exit /b 1
