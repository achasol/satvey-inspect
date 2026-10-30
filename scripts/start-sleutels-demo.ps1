param([switch]$Seed)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { 'C:/Program Files/nodejs/node.exe' }
if (!(Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js 22.12 or newer to run the native demo frontend.' }
$cachePath = Join-Path $workspacePath '.cache'
New-Item -ItemType Directory -Path $cachePath -Force | Out-Null
Push-Location $workspacePath
try {
    & docker compose -f compose.yaml -f compose.demo.yaml up -d api
    if ($LASTEXITCODE -ne 0) { throw 'The API services could not be started.' }
    if (!(Test-Path -LiteralPath (Join-Path $workspacePath 'node_modules/vite/bin/vite.js'))) {
        $previousPath = $env:Path
        try {
            $env:Path = (Split-Path -Parent $nodePath) + ';' + $env:Path
            & $nodePath (Join-Path (Split-Path -Parent $nodePath) 'node_modules/npm/bin/npm-cli.js') ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Installing frontend dependencies failed.' }
        } finally { $env:Path = $previousPath }
    }
    $frontendReady = $false
    try { $frontendReady = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:5174/api/v1/health').StatusCode -eq 200 } catch {}
    if (!$frontendReady) {
        $previousProxy = $env:API_PROXY_TARGET
        try {
            $env:API_PROXY_TARGET = 'http://127.0.0.1:8088'
            $demoProcess = Start-Process -FilePath $nodePath -ArgumentList @('--max-old-space-size=512', 'node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '5174', '--strictPort') -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $cachePath 'sleutels-vite.log') -RedirectStandardError (Join-Path $cachePath 'sleutels-vite-error.log')
            $demoProcess.ProcessorAffinity = [IntPtr]1
            $demoProcess.PriorityClass = 'BelowNormal'
            Set-Content -LiteralPath (Join-Path $cachePath 'sleutels-vite.pid') -Value $demoProcess.Id
        } finally { $env:API_PROXY_TARGET = $previousProxy }
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 500
            try { $frontendReady = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:5174/api/v1/health').StatusCode -eq 200 } catch {}
            if ($frontendReady) { break }
            if ($demoProcess.HasExited) { throw "Frontend stopped. See .cache/sleutels-vite-error.log." }
        }
        if (!$frontendReady) { throw 'The demo frontend did not become ready. See .cache/sleutels-vite.log.' }
    }
    if ($Seed) {
        $existingDemo = & docker compose exec -T postgres psql -U satvey -d satvey -tAc "SELECT count(*) FROM organisations WHERE slug='desleutels-demo'"
        if ($LASTEXITCODE -ne 0) { throw 'Could not check the demo organisation.' }
        if ($existingDemo.Trim() -eq '0') {
            & docker compose exec -T -e BOOTSTRAP_EMAIL=demo@desleutels.local -e 'BOOTSTRAP_PASSWORD=SleutelsDemo2026!' -e BOOTSTRAP_ORG=desleutels-demo -e 'BOOTSTRAP_ORG_NAME=De Sleutels - Demo' -e 'BOOTSTRAP_NAME=Sanne de Vries (demo)' api /server bootstrap
            if ($LASTEXITCODE -ne 0) { throw 'Creating the demo organisation failed.' }
        }
        $previousDemoAPI = $env:DEMO_API_URL
        try {
            $env:DEMO_API_URL = 'http://127.0.0.1:8088/api/v1'
            & $nodePath scripts/seed-sleutels-demo.mjs
            if ($LASTEXITCODE -ne 0) { throw 'Preparing demo data failed.' }
        } finally { $env:DEMO_API_URL = $previousDemoAPI }
    }
    Write-Output 'Demo ready: http://localhost:5174/app'
    Write-Output 'Organisation: De Sleutels - Demo; email: demo@desleutels.local'
} finally { Pop-Location }
