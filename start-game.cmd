@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=C:\Users\zhouy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

powershell -NoProfile -Command "$pids=(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique; foreach($pid in $pids){ Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }" >nul 2>nul

start "FC Tank Battle Server" /min /d "%ROOT%" "%NODE%" "%ROOT%dev-server.js"
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 30;$i++){ try { Invoke-RestMethod -Uri 'http://127.0.0.1:8080/version' -TimeoutSec 1 | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 250 } }; if($ok){ exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo FC Tank Battle server failed to start.
  echo Please check whether port 8080 is blocked.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:8080/"
endlocal
