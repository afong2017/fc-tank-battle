@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if not exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    echo Node.js was not found.
    echo Start the game from Codex once, or install Node.js.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $c){exit 1}; try { $v=Invoke-RestMethod -Uri 'http://127.0.0.1:8080/version' -TimeoutSec 2; if($v.ai.files -contains 'ai-data.js' -and $v.game.files -contains 'game.js'){exit 0} } catch {}; exit 2" >nul 2>nul
set "SERVER_STATE=%ERRORLEVEL%"
if "%SERVER_STATE%"=="0" goto open_game
if "%SERVER_STATE%"=="2" (
  echo Port 8080 is already used by another program.
  echo Close that program or change PORT in the game .env file.
  pause
  exit /b 1
)

powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList '%ROOT%dev-server.js' -WorkingDirectory '%ROOT%' -WindowStyle Hidden" >nul 2>nul
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 30;$i++){ try { Invoke-RestMethod -Uri 'http://127.0.0.1:8080/version' -TimeoutSec 1 | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 250 } }; if($ok){ exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo FC Tank Battle server failed to start.
  echo Check dev-server.js, Node.js, and port 8080.
  pause
  exit /b 1
)

:open_game
start "" "http://127.0.0.1:8080/"
endlocal
