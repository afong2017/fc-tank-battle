@echo off
setlocal
set "ROOT=%~dp0"

powershell -NoProfile -Command "$root='%ROOT:\=\\%'; $stopped=0; $pids=(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique; foreach($pid in $pids){ try { $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" -ErrorAction Stop; if($p.CommandLine -like '*dev-server.js*' -and $p.CommandLine -like \"*$root*\"){ Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue; $stopped++ } } catch {} }; if($stopped -gt 0){ Write-Host \"FC Tank Battle server stopped.\" } else { Write-Host \"FC Tank Battle server was not running.\" }"

pause
endlocal
