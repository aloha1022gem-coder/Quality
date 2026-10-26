@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (
  echo 未找到 Python，请先安装 Python 3.9 或以上版本：https://www.python.org/downloads/
  echo 安装时请勾选 "Add Python to PATH"。
  pause
  exit /b 1
)
%PY% run.py %*
pause
