# narada-managed-asset: windows-user-site.v1
[CmdletBinding()]
param(
  [switch]$Onboarding,
  [switch]$DryRun,
  [switch]$All,
  [switch]$NoWaitForEnterBeforeExec,
  [switch]$EnableNativeShell,
  [switch]$SiteOrientation,
  [switch]$VisibleRuntimeTerminal,
  [switch]$Smoke,
  [string[]]$ConfigPath,
  [string[]]$Site,
  [string[]]$Role,
  [string[]]$Agent,
  [string[]]$OperatorSurface,
  [string]$Runtime,
  [ValidateSet('node', 'bun', 'rust')]
  [string]$RuntimeEngine,
  [ValidateSet('all', 'host', 'user-site', 'local-site', 'none')]
  [string]$McpScope = 'all',
  [string]$RegistryPath,
  [ValidateSet('json', 'human', 'auto')]
  [string]$Format = 'auto',
  [string]$ResultPath,
  [switch]$SuppressResultOutput
)

$ErrorActionPreference = 'Stop'

function Import-NaradaLauncherEnvironment {
  $envPath = Join-Path $PSScriptRoot '.env'
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { return }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -match '^(NARADA_PROPER_ROOT|NARADA_CLI_PACKAGE_ROOT)=(.*)$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim().Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($name, 'Process') -and $value) {
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
      }
    }
  }
}

function Resolve-NaradaProperRoot {
  $candidates = @()
  if ($env:NARADA_PROPER_ROOT) { $candidates += $env:NARADA_PROPER_ROOT }
  if ($env:NARADA_CLI_PACKAGE_ROOT) { $candidates += (Join-Path $env:NARADA_CLI_PACKAGE_ROOT '..\..\..') }

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $rootPackagePath = Join-Path $candidate 'package.json'
    $cliPackagePath = Join-Path $candidate 'packages\layers\cli\package.json'
    if ((Test-Path -LiteralPath $rootPackagePath -PathType Leaf) -and (Test-Path -LiteralPath $cliPackagePath -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  throw 'narada_proper_root_missing: set NARADA_PROPER_ROOT to the Narada proper workspace root'
}

function Resolve-NaradaInvocation {
  Import-NaradaLauncherEnvironment
  $globalNarada = Get-Command narada -ErrorAction SilentlyContinue
  if ($null -ne $globalNarada) {
    return [pscustomobject]@{ Command = $globalNarada.Source; PrefixArgs = @() }
  }

  $properRoot = Resolve-NaradaProperRoot
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpm) {
    throw 'narada_cli_not_found: global narada is unavailable and pnpm could not be resolved for the configured Narada proper root'
  }

  return [pscustomobject]@{
    Command = $pnpm.Source
    PrefixArgs = @('--dir', $properRoot, 'exec', 'narada')
  }
}

$naradaInvocation = Resolve-NaradaInvocation
if ($Onboarding) {
  $args = @('onboarding', 'start', '--platform', 'windows', '--scope', 'user-site')
  if ($DryRun) { $args += '--no-exec' }
  $invocationArgs = @($naradaInvocation.PrefixArgs) + @($args)
  & $naradaInvocation.Command @invocationArgs
  exit $LASTEXITCODE
}

$args = @('launcher', 'workspace-launch')
if ($DryRun) { $args += '--dry-run' }
if ($All) { $args += '--all' }
if ($NoWaitForEnterBeforeExec) { $args += '--no-wait-for-enter-before-exec' }
if ($EnableNativeShell) { $args += '--enable-native-shell' }
if ($SiteOrientation) { $args += '--site-orientation' }
if ($VisibleRuntimeTerminal) { $args += '--visible-runtime-terminal' }
if ($Smoke) { $args += '--smoke' }
if ($SuppressResultOutput) { $args += '--suppress-result-output' }
foreach ($value in @($ConfigPath)) { if ($value) { $args += @('--config-path', $value) } }
if ($RegistryPath) { $args += @('--registry-path', $RegistryPath) }
if ($Format) { $args += @('--format', $Format) }
if ($Runtime) { $args += @('--runtime', $Runtime) }
if ($RuntimeEngine) { $args += @('--runtime-engine', $RuntimeEngine) }
if ($McpScope) { $args += @('--mcp-scope', $McpScope) }
if ($ResultPath) { $args += @('--result-path', $ResultPath) }
foreach ($value in @($Site)) { if ($value) { $args += @('--site', $value) } }
foreach ($value in @($Role)) { if ($value) { $args += @('--role', $value) } }
foreach ($value in @($Agent)) { if ($value) { $args += @('--agent', $value) } }
foreach ($value in @($OperatorSurface)) { if ($value) { $args += @('--operator-surface', $value) } }

$invocationArgs = @($naradaInvocation.PrefixArgs) + @($args)
& $naradaInvocation.Command @invocationArgs
exit $LASTEXITCODE
