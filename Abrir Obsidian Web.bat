@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8765
set "PYTHON="
where py >nul 2>nul && set "PYTHON=py -3"
if not defined PYTHON (
  where python >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON (
  echo Se necesita Python 3.10 o posterior para servir la aplicacion.
  pause
  exit /b 1
)
%PYTHON% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo Se necesita Python 3.10 o posterior. Actualiza Python e intentalo otra vez.
  pause
  exit /b 1
)
echo Iniciando Obsidian Web en http://127.0.0.1:%PORT%/
start "Obsidian Web" /min %PYTHON% servidor.py --port %PORT%
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"
echo Para detenerlo, cierra la ventana minimizada "Obsidian Web".
