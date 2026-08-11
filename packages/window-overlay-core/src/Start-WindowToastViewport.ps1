param(
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [int]$IdleTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
if ($IdleTimeoutSeconds -lt 1 -or $IdleTimeoutSeconds -gt 86400) { throw 'toast_viewport_idle_timeout_invalid' }
$stateRoot = [IO.Path]::GetFullPath($StateRoot)
$inbox = Join-Path $stateRoot 'inbox'
$pidPath = Join-Path $stateRoot 'viewport.pid'
$hostScript = Join-Path $PSScriptRoot 'window-toast-viewport.ps1'
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($stateRoot)) } finally { $sha.Dispose() }
$hashText = ([BitConverter]::ToString($hash)).Replace('-', '')
$mutexName = 'Local\NaradaWindowToastViewport_' + $hashText.Substring(0, 24)
$mutex = [Threading.Mutex]::new($false, $mutexName)

function Test-ToastHost([int]$CandidatePid) {
  if ($CandidatePid -le 0) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $CandidatePid" -ErrorAction SilentlyContinue
  return $null -ne $process -and $process.CommandLine -like '*window-toast-viewport.ps1*'
}

try {
  if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(10))) { throw 'toast_viewport_start_lock_timeout' }
  New-Item -ItemType Directory -Force -Path $inbox | Out-Null
  if (Test-Path -LiteralPath $pidPath) {
    $candidate = [int](Get-Content -LiteralPath $pidPath -Raw)
    if (Test-ToastHost $candidate) { exit 0 }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }

  # Toasts are transient projections. A cold host start never replays stale ingress.
  Get-ChildItem -LiteralPath $inbox -File -ErrorAction SilentlyContinue | Remove-Item -Force
  $stdout = Join-Path $stateRoot 'viewport.stdout.log'
  $stderr = Join-Path $stateRoot 'viewport.stderr.log'
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', $hostScript, '-StateRoot', $stateRoot, '-IdleTimeoutSeconds', $IdleTimeoutSeconds)
  Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 50
    if (Test-Path -LiteralPath $pidPath) {
      $candidate = [int](Get-Content -LiteralPath $pidPath -Raw)
      if (Test-ToastHost $candidate) { exit 0 }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'toast_viewport_start_timeout'
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
