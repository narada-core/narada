param([Parameter(Mandatory = $true)][string]$StateRoot)

$ErrorActionPreference = 'Stop'
$stateRoot = [IO.Path]::GetFullPath($StateRoot)
$pidPath = Join-Path $stateRoot 'viewport.pid'
$statePath = Join-Path $stateRoot 'viewport.state.json'
$inbox = Join-Path $stateRoot 'inbox'
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

if (Test-Path -LiteralPath $pidPath) {
  $candidate = [int](Get-Content -LiteralPath $pidPath -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate" -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.CommandLine -like '*window-toast-viewport.ps1*') {
    Stop-Process -Id $candidate -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $inbox) {
  Get-ChildItem -LiteralPath $inbox -File -ErrorAction SilentlyContinue | Remove-Item -Force
}
$state = [ordered]@{
  schema = 'narada.window_toast.viewport_state.v1'; lifecycle = 'stopped'; pid = $null
  visible = @(); queued = @(); dropped_total = 0; last_outcome = $null; last_error = $null
  updated_at = [DateTime]::UtcNow.ToString('o')
}
$temporary = "$statePath.$PID.tmp"
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
Move-Item -LiteralPath $temporary -Destination $statePath -Force
