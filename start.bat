@echo off
rem Starts the GridFly helper and opens it in your browser.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py %*
) else (
  python server.py %*
)
if errorlevel 1 (
  echo.
  echo Could not start GridFly. Install Python 3 from https://www.python.org/downloads/ and try again.
  pause
)
