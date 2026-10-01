param([string]$PythonPath = $env:OD_BINANCE_PYTHON)
$ErrorActionPreference = 'Stop'
$taskProject = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskServer = Join-Path $taskProject 'ooapi-server'
$taskWeb = Join-Path $taskProject 'ooapi-web'
$taskData = Join-Path $taskServer 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
& (Join-Path $PSScriptRoot 'start-binance.ps1') -PythonPath $PythonPath
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Trading engine startup failed.' }
$taskNode = (Get-Command node -ErrorAction Stop).Source
if (-not (Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue)) {
    $taskConfig = if (Test-Path -LiteralPath (Join-Path $taskServer '.env.local')) { '.env.local' } else { '.env' }
    $taskProcess = Start-Process -FilePath $taskNode -WorkingDirectory $taskServer -ArgumentList @('--import','dotenv/config','src/index.js', "dotenv_config_path=$taskConfig") -RedirectStandardOutput (Join-Path $taskData 'local-server.log') -RedirectStandardError (Join-Path $taskData 'local-server-error.log') -WindowStyle Hidden -PassThru
    $taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskData 'local-server.pid')
}
if (-not (Test-Path -LiteralPath (Join-Path $taskWeb 'dist/index.html'))) { throw 'Run npm run build in ooapi-web first.' }
$taskListener = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
if ($taskListener) {
    $taskRunning = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskListener[0].OwningProcess)"
    if (-not $taskRunning -or $taskRunning.CommandLine -notmatch 'vite.*preview') { throw 'Port 3000 belongs to another application. Stop the previous standalone frontend first.' }
} else {
    $taskProcess = Start-Process -FilePath $taskNode -WorkingDirectory $taskWeb -ArgumentList @('node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','3000','--strictPort') -RedirectStandardOutput (Join-Path $taskData 'local-web.log') -RedirectStandardError (Join-Path $taskData 'local-web-error.log') -WindowStyle Hidden -PassThru
    $taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskData 'local-web.pid')
}
Write-Output 'OOAPI: http://localhost:3000/od-binance'
