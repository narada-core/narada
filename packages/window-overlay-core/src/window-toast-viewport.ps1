param(
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [int]$IdleTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase, System.Windows.Forms
. (Join-Path $PSScriptRoot 'WindowOverlayCloseButton.ps1')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NaradaToastNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$stateRoot = [IO.Path]::GetFullPath($StateRoot)
$inbox = Join-Path $stateRoot 'inbox'
$pidPath = Join-Path $stateRoot 'viewport.pid'
$statePath = Join-Path $stateRoot 'viewport.state.json'
New-Item -ItemType Directory -Force -Path $inbox | Out-Null
Set-Content -LiteralPath $pidPath -Value $PID -Encoding ascii

$visible = [Collections.ArrayList]::new()
$queued = [Collections.ArrayList]::new()
$droppedTotal = 0
$lastOutcome = $null
$lastError = $null
$lastActivity = [DateTime]::UtcNow
$renderDirty = $true
$workArea = $null
$timerLines = @{}

function New-Brush([string]$Hex) {
  return [Windows.Media.BrushConverter]::new().ConvertFromString($Hex)
}

$palette = @{
  background = New-Brush '#F21D2229'; border = New-Brush '#56616D'; text = New-Brush '#F3F6F8'
  muted = New-Brush '#AAB4BE'; accent = New-Brush '#5BB8FF'; success = New-Brush '#43C59E'
  warning = New-Brush '#F3B562'; danger = New-Brush '#F26D78'
}

function Get-ToneBrush([string]$Tone) {
  if ($palette.ContainsKey($Tone)) { return $palette[$Tone] }
  return $palette.accent
}

function Write-State([string]$Lifecycle = 'running') {
  $project = {
    param($Item)
    [ordered]@{
      id = $Item.request.id; phase = $Item.phase; attention = $Item.request.attention
      tone = $Item.request.tone; title = $Item.request.title; dedupe_key = $Item.request.dedupe_key
      remaining_ms = [Math]::Max(0, [int]$Item.remaining_ms)
    }
  }
  $state = [ordered]@{
    schema = 'narada.window_toast.viewport_state.v1'; lifecycle = $Lifecycle; pid = if ($Lifecycle -eq 'running') { $PID } else { $null }
    visible = @($visible | ForEach-Object { & $project $_ }); queued = @($queued | ForEach-Object { & $project $_ })
    dropped_total = $droppedTotal; last_outcome = $lastOutcome; last_error = $lastError
    updated_at = [DateTime]::UtcNow.ToString('o')
  }
  $temporary = "$statePath.$PID.tmp"
  $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Remove-ItemById([string]$Id, [string]$Phase) {
  foreach ($list in @($visible, $queued)) {
    for ($index = $list.Count - 1; $index -ge 0; $index--) {
      if ($list[$index].request.id -eq $Id) {
        $item = $list[$index]
        $list.RemoveAt($index)
        $item.phase = $Phase
        $script:lastOutcome = [ordered]@{ request_id = $Id; outcome = $Phase; at = [DateTime]::UtcNow.ToString('o') }
        $script:lastActivity = [DateTime]::UtcNow
        $script:renderDirty = $true
      }
    }
  }
}

function Promote-Queued {
  while ($visible.Count -lt 3 -and $queued.Count -gt 0) {
    $item = $queued[0]; $queued.RemoveAt(0); $item.phase = 'visible'; $item.last_tick = [DateTime]::UtcNow
    [void]$visible.Add($item)
  }
}

function Add-Request($Request) {
  if ($Request.schema -ne 'narada.window_toast.request.v1') { throw 'toast_request_schema_invalid' }
  if ($Request.dedupe_key) {
    foreach ($list in @($visible, $queued)) {
      for ($index = $list.Count - 1; $index -ge 0; $index--) {
        if ($list[$index].request.dedupe_key -eq $Request.dedupe_key) { $list.RemoveAt($index) }
      }
    }
  }
  if ($visible.Count -eq 0 -and $queued.Count -eq 0) {
    $foreground = [NaradaToastNative]::GetForegroundWindow()
    $script:workArea = if ($foreground -ne [IntPtr]::Zero) {
      [System.Windows.Forms.Screen]::FromHandle($foreground).WorkingArea
    } else {
      [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    }
  }
  $item = [pscustomobject]@{
    request = $Request; phase = 'queued'; remaining_ms = [int]$Request.duration_ms
    paused = $false; last_tick = [DateTime]::UtcNow
  }
  if ($Request.attention -eq 'foreground' -and $visible.Count -ge 3) {
    $background = @($visible | Where-Object { $_.request.attention -eq 'background' } | Select-Object -First 1)
    if ($background.Count -gt 0) {
      [void]$visible.Remove($background[0]); $background[0].phase = 'queued'; [void]$queued.Insert(0, $background[0])
    }
  }
  if ($visible.Count -lt 3) { $item.phase = 'visible'; [void]$visible.Add($item) }
  else { [void]$queued.Add($item) }
  while ($queued.Count -gt 32) {
    $dropIndex = -1
    for ($index = 0; $index -lt $queued.Count; $index++) {
      if ($queued[$index].request.attention -eq 'background') { $dropIndex = $index; break }
    }
    if ($dropIndex -lt 0) { $dropIndex = 0 }
    $queued.RemoveAt($dropIndex); $script:droppedTotal++
  }
  $script:lastActivity = [DateTime]::UtcNow
  $script:renderDirty = $true
}

$window = [Windows.Window]::new()
$window.Title = 'Narada notifications'
$window.Width = 380
$window.SizeToContent = 'Height'
$window.MaxHeight = 900
$window.WindowStyle = 'None'
$window.ResizeMode = 'NoResize'
$window.AllowsTransparency = $true
$window.Background = [Windows.Media.Brushes]::Transparent
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.Topmost = $true
$window.Visibility = 'Hidden'
$application = [Windows.Application]::new()
$application.ShutdownMode = [Windows.ShutdownMode]::OnExplicitShutdown
$stack = [Windows.Controls.StackPanel]::new()
$stack.Margin = [Windows.Thickness]::new(10)
$window.Content = $stack

function Invoke-ToastAction($Request) {
  try {
    if ($Request.action.kind -eq 'open_url') { Start-Process $Request.action.target }
    elseif ($Request.action.kind -eq 'copy_text') { [Windows.Clipboard]::SetText([string]$Request.action.text) }
    else { throw 'toast_action_kind_invalid' }
    Remove-ItemById $Request.id 'actioned'
  } catch {
    $script:lastError = $_.Exception.Message
    $script:lastOutcome = [ordered]@{ request_id = $Request.id; outcome = 'action_failed'; error = $script:lastError; at = [DateTime]::UtcNow.ToString('o') }
    Write-State
  }
}

function Render-Viewport {
  $stack.Children.Clear()
  $script:timerLines = @{}
  foreach ($item in @($visible)) {
    $request = $item.request
    $card = [Windows.Controls.Border]::new()
    $card.Tag = $request.id
    $card.Margin = [Windows.Thickness]::new(0, 0, 0, 8)
    $card.Padding = [Windows.Thickness]::new(14, 12, 12, 12)
    $card.CornerRadius = [Windows.CornerRadius]::new(7)
    $card.Background = $palette.background
    $card.BorderBrush = Get-ToneBrush $request.tone
    $card.BorderThickness = [Windows.Thickness]::new(1)
    [Windows.Automation.AutomationProperties]::SetLiveSetting($card, $(if ($request.attention -eq 'foreground') { 'Assertive' } else { 'Polite' }))
    $content = [Windows.Controls.Grid]::new()
    $content.RowDefinitions.Add([Windows.Controls.RowDefinition]::new())
    $timerRow = [Windows.Controls.RowDefinition]::new(); $timerRow.Height = [Windows.GridLength]::Auto
    $content.RowDefinitions.Add($timerRow)
    $content.ColumnDefinitions.Add([Windows.Controls.ColumnDefinition]::new())
    $closeColumn = [Windows.Controls.ColumnDefinition]::new(); $closeColumn.Width = [Windows.GridLength]::Auto
    $content.ColumnDefinitions.Add($closeColumn)
    $body = [Windows.Controls.StackPanel]::new()
    $title = [Windows.Controls.TextBlock]::new(); $title.Text = $request.title; $title.Foreground = $palette.text
    $title.FontSize = 14; $title.FontWeight = 'SemiBold'; $title.TextWrapping = 'Wrap'
    [void]$body.Children.Add($title)
    if ($request.description) {
      $description = [Windows.Controls.TextBlock]::new(); $description.Text = $request.description
      $description.Foreground = $palette.muted; $description.Margin = [Windows.Thickness]::new(0, 5, 0, 0)
      $description.FontSize = 12; $description.TextWrapping = 'Wrap'; [void]$body.Children.Add($description)
    }
    if ($request.action) {
      $action = [Windows.Controls.Button]::new(); $action.Content = $request.action.label; $action.Tag = $request
      $action.ToolTip = $request.action.alt_text; $action.HorizontalAlignment = 'Left'
      $action.Margin = [Windows.Thickness]::new(0, 10, 0, 0); $action.Padding = [Windows.Thickness]::new(9, 4, 9, 4)
      $action.Add_Click({ param($sender, $eventArgs) Invoke-ToastAction $sender.Tag })
      [void]$body.Children.Add($action)
    }
    [Windows.Controls.Grid]::SetColumn($body, 0); [void]$content.Children.Add($body)
    $close = New-NaradaOverlayCloseButton 'Dismiss notification'; $close.Tag = $request.id
    $close.Add_Click({ param($sender, $eventArgs) Remove-ItemById ([string]$sender.Tag) 'dismissed' })
    [Windows.Controls.Grid]::SetColumn($close, 1); [void]$content.Children.Add($close)
    $lifetime = [Windows.Controls.Border]::new()
    $lifetime.Height = 2; $lifetime.Margin = [Windows.Thickness]::new(0, 10, 0, 0)
    $lifetime.HorizontalAlignment = 'Stretch'; $lifetime.Background = Get-ToneBrush $request.tone
    $lifetime.Opacity = 0.75; $lifetime.RenderTransformOrigin = [Windows.Point]::new(0, 0.5)
    $lifetimeTransform = [Windows.Media.ScaleTransform]::new(1, 1)
    $lifetime.RenderTransform = $lifetimeTransform
    $lifetimeAnimation = [Windows.Media.Animation.DoubleAnimation]::new()
    $lifetimeAnimation.From = [Math]::Max(0, [Math]::Min(1, [double]$item.remaining_ms / [double]$request.duration_ms))
    $lifetimeAnimation.To = 0
    $lifetimeAnimation.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds([Math]::Max(1, [double]$item.remaining_ms)))
    $lifetimeAnimation.FillBehavior = [Windows.Media.Animation.FillBehavior]::HoldEnd
    $lifetimeClock = $lifetimeAnimation.CreateClock()
    $lifetimeTransform.ApplyAnimationClock([Windows.Media.ScaleTransform]::ScaleXProperty, $lifetimeClock)
    $lifetimeClock.Controller.Begin()
    [Windows.Controls.Grid]::SetRow($lifetime, 1); [Windows.Controls.Grid]::SetColumnSpan($lifetime, 2)
    [void]$content.Children.Add($lifetime)
    $script:timerLines[$request.id] = [pscustomobject]@{ item = $item; clock = $lifetimeClock }
    $card.Child = $content
    $card.Add_MouseEnter({ param($sender, $eventArgs) $entry = $visible | Where-Object { $_.request.id -eq $sender.Tag } | Select-Object -First 1; if ($entry) { $entry.paused = $true; $entry.phase = 'paused'; $timerLines[$sender.Tag].clock.Controller.Pause() } })
    $card.Add_MouseLeave({ param($sender, $eventArgs) $entry = $visible | Where-Object { $_.request.id -eq $sender.Tag } | Select-Object -First 1; if ($entry) { $entry.paused = $false; $entry.phase = 'visible'; $entry.last_tick = [DateTime]::UtcNow; $timerLines[$sender.Tag].clock.Controller.Resume() } })
    [void]$stack.Children.Add($card)
  }
  if ($visible.Count -eq 0) { $window.Hide(); $script:workArea = $null }
  else {
    $area = if ($null -ne $workArea) { $workArea } else { [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea }
    if (-not $window.IsVisible) { $window.Show() }
    $window.UpdateLayout()
    $source = [Windows.PresentationSource]::FromVisual($window)
    if ($null -ne $source -and $null -ne $source.CompositionTarget) {
      $topLeft = $source.CompositionTarget.TransformFromDevice.Transform([Windows.Point]::new($area.Left, $area.Top))
      $bottomRight = $source.CompositionTarget.TransformFromDevice.Transform([Windows.Point]::new($area.Right, $area.Bottom))
      $window.Left = $topLeft.X + 14
      $window.Top = $bottomRight.Y - $window.ActualHeight - 14
    } else {
      $window.Left = $area.Left + 14
      $window.Top = $area.Bottom - $window.ActualHeight - 14
    }
  }
  $script:renderDirty = $false
}

$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
  try {
    foreach ($file in @(Get-ChildItem -LiteralPath $inbox -Filter '*.json' -File | Sort-Object Name)) {
      try { Add-Request (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json) }
      catch { $script:lastError = $_.Exception.Message }
      finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
    }
    $now = [DateTime]::UtcNow
    foreach ($item in @($visible)) {
      if (-not $item.paused) {
        $item.remaining_ms -= [int]($now - $item.last_tick).TotalMilliseconds
        $item.last_tick = $now
        if ($item.remaining_ms -le 0) { Remove-ItemById $item.request.id 'expired' }
      }
    }
    Promote-Queued
    if ($renderDirty) { Render-Viewport }
    Write-State
    if ($visible.Count -eq 0 -and $queued.Count -eq 0 -and ($now - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) {
      $application.Shutdown()
    }
  } catch {
    $script:lastError = $_.Exception.Message
    try { Write-State 'failed' } catch {}
  }
})

try {
  Write-State 'running'
  $timer.Start()
  [void]$application.Run()
} finally {
  $timer.Stop()
  try { Write-State 'stopped' } catch {}
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}
