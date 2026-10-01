param(
    [string]$PythonPath = $env:OD_BINANCE_PYTHON,
    [string]$ConfigPath = '',
    [int]$Port = 8001,
    [int]$LegacyOwnerId = 0
)
$ErrorActionPreference = 'Stop'
$taskProject = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskEngine = Join-Path $taskProject 'ooapi-binance'
$taskData = Join-Path $taskProject 'ooapi-server/data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
if (-not $ConfigPath) { $ConfigPath = Join-Path $taskEngine '.env' }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Configure ooapi-binance/.env first (DATABASE_URL and SECRET_KEY). Preserve the existing encryption key when importing accounts.' }
if (-not $PythonPath -and (Test-Path -LiteralPath (Join-Path $taskData 'binance-python.txt'))) { $PythonPath = (Get-Content -LiteralPath (Join-Path $taskData 'binance-python.txt') -Raw).Trim() }
if (-not $PythonPath) { $PythonPath = Join-Path $taskEngine '.venv/Scripts/python.exe' }
if (-not (Test-Path -LiteralPath $PythonPath)) { throw 'Pass -PythonPath pointing to the existing trading Python environment.' }
(Resolve-Path -LiteralPath $PythonPath).Path | Set-Content -LiteralPath (Join-Path $taskData 'binance-python.txt')
$taskBridgeFile = Join-Path $taskData 'binance-bridge.key'
if (-not (Test-Path -LiteralPath $taskBridgeFile)) {
    $taskBytes = New-Object byte[] 48
    $taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRandom.GetBytes($taskBytes) } finally { $taskRandom.Dispose() }
    [System.IO.File]::WriteAllText($taskBridgeFile, [Convert]::ToBase64String($taskBytes))
}
$taskListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($taskListener) {
    $taskHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    if ($taskHealth.service -ne 'od-binance') { throw "Port $Port belongs to another service." }
    Write-Output "OD Binance already running on 127.0.0.1:$Port"
    exit 0
}
$env:OOAPI_MODE = 'true'
$env:OOAPI_BRIDGE_KEY_FILE = $taskBridgeFile
$env:OOAPI_LEGACY_OWNER_ID = [string]$LegacyOwnerId
$env:OD_BINANCE_ENV_FILE = (Resolve-Path -LiteralPath $ConfigPath).Path
$taskProcess = Start-Process -FilePath (Resolve-Path -LiteralPath $PythonPath).Path -WorkingDirectory $taskEngine -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port', [string]$Port) -RedirectStandardOutput (Join-Path $taskData 'binance.log') -RedirectStandardError (Join-Path $taskData 'binance-error.log') -WindowStyle Hidden -PassThru
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskData 'binance.pid')
for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
    if ($taskProcess.HasExited) { throw 'Trading engine failed to start. See ooapi-server/data/binance-error.log.' }
    try {
        $taskHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        if ($taskHealth.service -eq 'od-binance' -and $taskHealth.database -eq 'connected') { Write-Output "OD Binance running on 127.0.0.1:$Port"; exit 0 }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw 'Trading engine did not become ready. See ooapi-server/data/binance-error.log.'
