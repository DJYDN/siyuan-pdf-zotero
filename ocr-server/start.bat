@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\python.exe" (
  "runtime\python.exe" "pz_ocr_server.py" 8891
) else (
  python "pz_ocr_server.py" 8891
)
