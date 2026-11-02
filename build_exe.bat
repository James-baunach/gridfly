@echo off
rem Builds dist\GridFly.exe (one file, bundles web\ and installer\). Needs Python 3 and internet for pip.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (set PY=py -3) else (set PY=python)
if not exist .build-venv\Scripts\python.exe (
  %PY% -m venv .build-venv || goto :fail
)
.build-venv\Scripts\python.exe -m pip install --upgrade pyinstaller || goto :fail
.build-venv\Scripts\python.exe -m PyInstaller --noconfirm --clean gridfly.spec || goto :fail
echo.
echo Built dist\GridFly.exe
exit /b 0
:fail
echo.
echo Build failed.
exit /b 1
