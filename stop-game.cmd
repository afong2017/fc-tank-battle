@echo off
setlocal
set "ROOT=%~dp0"

powershell -NoProfile -Command "$stopped=0; try { $v=Invoke-RestMethod -Uri 'http://127.0.0.1:8080/version' -TimeoutSec 2; $isGame=$v.ai.files -contains 'ai-data.js' -and $v.game.files -contains 'game.js' } catch { $isGame=$false }; if($isGame){ $pids=(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique; foreach($pid in $pids){ try { $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" -ErrorAction Stop; if($p.CommandLine -like '*dev-server.js*'){ Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue; $stopped++ } } catch {} } }; if($stopped -gt 0){ Write-Host \"FC Tank Battle server stopped.\" } else { Write-Host \"FC Tank Battle server was not running.\" }"

pause
endlocal
