import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  overlayPaths,
  overlayStatus,
  requestOverlayFocus,
  setOverlayPresencePolicy,
  setOverlaySurfaceDefaultPresencePolicy,
  startOverlay,
  stopOverlay,
  enqueueToast,
  inspectToastViewport,
  stopToastViewport,
} from './index.js';

test('live toast viewport admits, renders, expires, and stops as one shared host', { skip: process.platform !== 'win32' }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-toast-live-'));
  try {
    const first = await enqueueToast({
      title: 'First live toast', attention: 'background', tone: 'success', duration_ms: 1_200,
      dedupe_key: 'live:dedupe',
    }, { stateRoot, idleTimeoutSeconds: 30 });
    const second = await enqueueToast({
      title: 'Replacement live toast', attention: 'foreground', tone: 'warning', duration_ms: 1_200,
      dedupe_key: 'live:dedupe',
    }, { stateRoot, idleTimeoutSeconds: 30 });
    assert.equal(first.viewport_pid, second.viewport_pid);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const running = await inspectToastViewport({ stateRoot });
    assert.equal(running.state, 'running');
    assert.deepEqual(running.viewport?.visible.map((item) => item.title), ['Replacement live toast']);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const expired = await inspectToastViewport({ stateRoot });
    assert.equal(expired.viewport?.visible.length, 0);
    assert.equal(expired.viewport?.last_outcome?.outcome, 'expired');
  } finally {
    await stopToastViewport({ stateRoot }).catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

type NativeWindowSnapshot = {
  TargetPid: number;
  Windows: Array<{ Visible: boolean; Title: string }>;
  ForegroundPid: number;
  ForegroundTitle: string;
};

const OVERLAY_WINDOW_TITLE_PREFIX = 'Narada Overlay: ';
const overlayWindowTitle = (id: string) => `${OVERLAY_WINDOW_TITLE_PREFIX}${id}`;

type NativeWindowGeometry = {
  found: boolean;
  Left: number;
  Top: number;
  Width: number;
  Height: number;
  WorkArea: { Left: number; Top: number; Right: number; Bottom: number };
};

const NATIVE_WINDOW_GEOMETRY = String.raw`
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NaradaWindowOverlayLiveGeometry {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
  public static object Read(uint targetPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      var title = new StringBuilder(256);
      GetWindowText(hWnd, title, title.Capacity);
      if (pid == targetPid && IsWindowVisible(hWnd) && title.ToString().StartsWith("Narada Overlay: ", StringComparison.Ordinal)) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return new { found = false };
    RECT rect;
    if (!GetWindowRect(found, out rect)) return new { found = false };
    var info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    var monitor = MonitorFromWindow(found, 2);
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return new { found = false };
    return new {
      found = true,
      Left = rect.Left, Top = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top,
      WorkArea = new { Left = info.rcWork.Left, Top = info.rcWork.Top, Right = info.rcWork.Right, Bottom = info.rcWork.Bottom },
    };
  }
}
'@;
Add-Type -TypeDefinition $code;
[NaradaWindowOverlayLiveGeometry]::Read([uint32]__PID_VALUE__) | ConvertTo-Json -Depth 5
`;

const NATIVE_WINDOW_POSITION = String.raw`
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NaradaWindowOverlayLivePosition {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  public static bool Place(uint targetPid, int left, int top) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      var title = new StringBuilder(256);
      GetWindowText(hWnd, title, title.Capacity);
      if (pid == targetPid && IsWindowVisible(hWnd) && title.ToString().StartsWith("Narada Overlay: ", StringComparison.Ordinal)) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    return SetWindowPos(found, IntPtr.Zero, left, top, 0, 0, 0x0001 | 0x0004 | 0x0010);
  }
}
'@;
Add-Type -TypeDefinition $code;
[NaradaWindowOverlayLivePosition]::Place([uint32]__PID_VALUE__, [int]__LEFT_VALUE__, [int]__TOP_VALUE__) | ConvertTo-Json
`;

const NATIVE_UI_AUTOMATION = String.raw`
Add-Type -AssemblyName UIAutomationClient;
Add-Type -AssemblyName UIAutomationTypes;
$root = [System.Windows.Automation.AutomationElement]::RootElement;
$windowCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]__PID_VALUE__);
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button);
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition);
foreach ($window in $windows) {
  foreach ($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)) {
    if ($button.Current.Name -eq '⊞' -or $button.Current.Name -eq 'Tile overlays from this anchor' -or $button.Current.HelpText -eq 'Tile overlays from this anchor') {
      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);
      $pattern.Invoke();
      Start-Sleep -Milliseconds 100;
      $crossButtons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition));
      $expectedHelpTexts = @(
        'Automatic: preserve current arrangement',
        'Place siblings above this anchor',
        'Place siblings below this anchor',
        'Place siblings to the left of this anchor',
        'Place siblings to the right of this anchor'
      );
      foreach ($expectedHelpText in $expectedHelpTexts) {
        if (@($crossButtons | Where-Object { $_.Current.HelpText -eq $expectedHelpText }).Count -eq 0) {
          $false | ConvertTo-Json;
          exit 0;
        }
      }
      $visibleSideButtons = @($crossButtons | Where-Object {
        -not $_.Current.IsOffscreen -and (
          $_.Current.HelpText -in @('Presence', 'Layer: Above other windows', 'Layer: Normal z-order')
        )
      });
      if ($visibleSideButtons.Count -gt 0) {
        $false | ConvertTo-Json;
        exit 0;
      }
      foreach ($crossButton in $crossButtons) {
        if ($crossButton.Current.HelpText -eq 'Automatic: preserve current arrangement') {
          $crossPattern = $crossButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);
          $crossPattern.Invoke();
            $true | ConvertTo-Json;
            exit 0;
        }
      }
      $false | ConvertTo-Json;
      exit 0;
    }
  }
}
$false | ConvertTo-Json;
`;

const NATIVE_UI_DISMISS = String.raw`
Add-Type -AssemblyName UIAutomationClient;
Add-Type -AssemblyName UIAutomationTypes;
$mouseCode = @'
using System;
using System.Runtime.InteropServices;
public static class NaradaWindowOverlayLiveMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@;
Add-Type -TypeDefinition $mouseCode;
$root = [System.Windows.Automation.AutomationElement]::RootElement;
$windowCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]__PID_VALUE__);
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button);
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition);
foreach ($window in $windows) {
  foreach ($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)) {
    if ($button.Current.Name -eq '⊞' -or $button.Current.Name -eq 'Tile overlays from this anchor' -or $button.Current.HelpText -eq 'Tile overlays from this anchor') {
      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);
      $pattern.Invoke();
      Start-Sleep -Milliseconds 100;
      $crossHelpTexts = @(
        'Automatic: preserve current arrangement',
        'Place siblings above this anchor',
        'Place siblings below this anchor',
        'Place siblings to the left of this anchor',
        'Place siblings to the right of this anchor'
      );
      $visibleCrossButtons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition) | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.HelpText -in $crossHelpTexts
      });
      if ($visibleCrossButtons.Count -ne 5) {
        $false | ConvertTo-Json;
        exit 0;
      }
      $rectangle = $window.Current.BoundingRectangle;
      [NaradaWindowOverlayLiveMouse]::SetCursorPos([int][Math]::Round($rectangle.Left + 20), [int][Math]::Round($rectangle.Top + 20)) | Out-Null;
      [NaradaWindowOverlayLiveMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero);
      [NaradaWindowOverlayLiveMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero);
      Start-Sleep -Milliseconds 100;
      $remainingCrossButtons = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition) | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.HelpText -in $crossHelpTexts
      });
      ($remainingCrossButtons.Count -eq 0) | ConvertTo-Json;
      exit 0;
    }
  }
}
$false | ConvertTo-Json;
`;

function dismissOverlayTilingCross(pid: number): boolean {
  const command = NATIVE_UI_DISMISS.replace('__PID_VALUE__', String(pid));
  try {
    return JSON.parse(execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8' }).trim()) === true;
  } catch {
    return false;
  }
}
const NATIVE_WINDOW_PROBE = String.raw`
$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NaradaWindowOverlayLiveProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static object Read(uint targetPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    var rows = new List<object>();
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid) {
        var text = new StringBuilder(512);
        GetWindowText(hWnd, text, text.Capacity);
        rows.Add(new { Visible = IsWindowVisible(hWnd), Title = text.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    var foreground = GetForegroundWindow();
    uint foregroundPid;
    GetWindowThreadProcessId(foreground, out foregroundPid);
    var foregroundText = new StringBuilder(512);
    GetWindowText(foreground, foregroundText, foregroundText.Capacity);
    return new { TargetPid = targetPid, Windows = rows.ToArray(), ForegroundPid = foregroundPid, ForegroundTitle = foregroundText.ToString() };
  }
}
'@;
Add-Type -TypeDefinition $code;
[NaradaWindowOverlayLiveProbe]::Read([uint32]${'${PID_VALUE}'}) | ConvertTo-Json -Depth 5
`;

const NATIVE_WINDOW_ACTIVATE = String.raw`
$code = @'
using System;
using System.Runtime.InteropServices;
public static class NaradaWindowOverlayLiveActivation {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static bool Activate(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd)) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    uint ignoredProcessId;
    var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignoredProcessId);
    var targetThread = GetWindowThreadProcessId(found, out ignoredProcessId);
    var currentThread = GetCurrentThreadId();
    var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread
      && AttachThreadInput(foregroundThread, currentThread, true);
    var attachedTarget = targetThread != 0 && targetThread != currentThread
      && AttachThreadInput(targetThread, currentThread, true);
    try {
      ShowWindow(found, 9);
      BringWindowToTop(found);
      SetForegroundWindow(found);
      return GetForegroundWindow() == found;
    } finally {
      if (attachedTarget) AttachThreadInput(targetThread, currentThread, false);
      if (attachedForeground) AttachThreadInput(foregroundThread, currentThread, false);
    }
  }
}
'@;
Add-Type -TypeDefinition $code;
[NaradaWindowOverlayLiveActivation]::Activate([uint32]${'${PID_VALUE}'}) | ConvertTo-Json
`;

function readNativeWindowSnapshot(pid: number): NativeWindowSnapshot | null {
  const command = NATIVE_WINDOW_PROBE.replace('${PID_VALUE}', String(pid));
  try {
    return JSON.parse(execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8' }).trim()) as NativeWindowSnapshot;
  } catch {
    return null;
  }
}

function activateNativeProcess(pid: number): boolean {
  const command = NATIVE_WINDOW_ACTIVATE.replace('${PID_VALUE}', String(pid));
  try {
    return JSON.parse(execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8' }).trim()) === true;
  } catch {
    return false;
  }
}

function readNativeWindowGeometry(pid: number): NativeWindowGeometry | null {
  const command = NATIVE_WINDOW_GEOMETRY.replace('__PID_VALUE__', String(pid));
  try {
    return JSON.parse(execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8' }).trim()) as NativeWindowGeometry;
  } catch {
    return null;
  }
}

function placeNativeWindow(pid: number, left: number, top: number): boolean {
  const command = NATIVE_WINDOW_POSITION
    .replace('__PID_VALUE__', String(pid))
    .replace('__LEFT_VALUE__', String(Math.round(left)))
    .replace('__TOP_VALUE__', String(Math.round(top)));
  try {
    return JSON.parse(execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8' }).trim()) === true;
  } catch {
    return false;
  }
}

function invokeOverlayTileButton(pid: number): boolean {
  const command = NATIVE_UI_AUTOMATION.replace('__PID_VALUE__', String(pid));
  try {
    return JSON.parse(execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { encoding: 'utf8' }).trim()) === true;
  } catch {
    return false;
  }
}

async function waitForGeometry(
  pid: number,
  predicate: (geometry: NativeWindowGeometry) => boolean,
  timeoutMs = 7_000,
): Promise<NativeWindowGeometry> {
  const deadline = Date.now() + timeoutMs;
  let lastGeometry: NativeWindowGeometry | null = null;
  while (Date.now() < deadline) {
    lastGeometry = readNativeWindowGeometry(pid);
    if (lastGeometry?.found && predicate(lastGeometry)) return lastGeometry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`overlay_live_geometry_expectation_failed:${JSON.stringify(lastGeometry)}`);
}

function boxesOverlap(first: NativeWindowGeometry, second: NativeWindowGeometry): boolean {
  return first.Left < second.Left + second.Width
    && first.Left + first.Width > second.Left
    && first.Top < second.Top + second.Height
    && first.Top + first.Height > second.Top;
}

function geometryForPid(pid: number): NativeWindowGeometry {
  const geometry = readNativeWindowGeometry(pid);
  assert.ok(geometry?.found, `overlay geometry must be available for PID ${pid}`);
  return geometry;
}

function windowsTerminalPid(): number | null {
  try {
    const output = execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$process = Get-Process -Name WindowsTerminal,WindowsTerminalPreview -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1; if ($process) { $process.Id }',
    ], { encoding: 'utf8' }).trim();
    const pid = Number.parseInt(output, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const EXTERNAL_WINDOW_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$window = New-Object System.Windows.Forms.Form
$window.Text = 'Narada external foreground'
$window.Width = 420
$window.Height = 220
$window.StartPosition = 'CenterScreen'
$window.ShowInTaskbar = $true
$window.TopMost = $false
$window.Controls.Add((New-Object System.Windows.Forms.Label -Property @{ Text = 'External foreground test window'; AutoSize = $true; Left = 20; Top = 20 }))
$window.Add_Shown({ $window.Activate(); $window.Focus() })
[System.Windows.Forms.Application]::Run($window)
`;

function startExternalForegroundProcess(scriptPath: string) {
  let stderr = '';
  const child = spawn('pwsh', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Normal',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ], { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  if (!child.pid) throw new Error('external_foreground_process_start_failed');
  return { pid: child.pid, child, getStderr: () => stderr };
}

function stopExternalForegroundProcess(pid: number): void {
  try {
    execFileSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ], { encoding: 'utf8' });
  } catch {
    // The test cleanup is best effort if the fixture already exited.
  }
}

let livePid = 0;

async function waitForSnapshot(
  pid: number,
  predicate: (snapshot: NativeWindowSnapshot) => boolean,
  timeoutMs = 7_000,
): Promise<NativeWindowSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: NativeWindowSnapshot | null = null;
  while (Date.now() < deadline) {
    lastSnapshot = readNativeWindowSnapshot(pid);
    if (lastSnapshot && predicate(lastSnapshot)) return lastSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`overlay_live_window_expectation_failed:${JSON.stringify(lastSnapshot)}`);
}

test('live tiling invokes the tile button, resolves overlap below, and remains stable across refresh', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-tiling-live-'));
  let anchorPid = 0;
  let siblingPid = 0;
  try {
    const anchor = await startOverlay({
      id: 'tiling-anchor-live',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Tiling anchor live overlay',
        rows: [{ label: 'Role', value: 'anchor', tone: 'accent' }],
      },
    });
    anchorPid = anchor.pid ?? 0;
    assert.ok(anchorPid > 0, 'tiling anchor must expose a host PID');

    const sibling = await startOverlay({
      id: 'tiling-sibling-live',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Tiling sibling live overlay',
        rows: [{ label: 'Role', value: 'sibling', tone: 'success' }],
      },
    });
    siblingPid = sibling.pid ?? 0;
    assert.ok(siblingPid > 0, 'tiling sibling must expose a host PID');

    await waitForSnapshot(anchorPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('tiling-anchor-live'),
    ));
    await waitForSnapshot(siblingPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('tiling-sibling-live'),
    ));

    const initialAnchor = geometryForPid(anchorPid);
    const initialSibling = geometryForPid(siblingPid);
    const work = initialAnchor.WorkArea;
    const physicalGap = 24;
    const safeTop = Math.max(
      work.Top + 8,
      Math.min(work.Top + 80, work.Bottom - initialAnchor.Height - initialSibling.Height - physicalGap - 8),
    );
    assert.ok(
      safeTop + initialAnchor.Height + initialSibling.Height + physicalGap <= work.Bottom,
      `the active work area must fit the two-overlay tiling fixture: ${JSON.stringify({ work, initialAnchor, initialSibling })}`,
    );
    const safeLeft = Math.max(work.Left + 8, work.Right - initialAnchor.Width - 8);
    assert.ok(placeNativeWindow(anchorPid, safeLeft, safeTop), 'the anchor must be positionable');
    assert.ok(placeNativeWindow(siblingPid, safeLeft, safeTop), 'the sibling must be positionable');
    const overlappedAnchor = await waitForGeometry(anchorPid, (geometry) =>
      Math.abs(geometry.Left - safeLeft) <= 4 && Math.abs(geometry.Top - safeTop) <= 4,
    );
    const overlappedSibling = await waitForGeometry(siblingPid, (geometry) =>
      Math.abs(geometry.Left - safeLeft) <= 4 && Math.abs(geometry.Top - safeTop) <= 4,
    );
    assert.ok(boxesOverlap(overlappedAnchor, overlappedSibling), 'the fixture must begin overlapped');

    assert.ok(invokeOverlayTileButton(anchorPid), 'UIAutomation must invoke the anchor tile button');
    const tiledSibling = await waitForGeometry(siblingPid, (geometry) =>
      Math.abs(geometry.Left - overlappedAnchor.Left) <= 6
        && geometry.Top >= overlappedAnchor.Top + overlappedAnchor.Height + 4,
    );
    const anchorAfterTile = geometryForPid(anchorPid);
    assert.ok(Math.abs(anchorAfterTile.Left - overlappedAnchor.Left) <= 6, 'tiling must preserve anchor left');
    assert.ok(Math.abs(anchorAfterTile.Top - overlappedAnchor.Top) <= 6, 'tiling must preserve anchor top');
    assert.equal(boxesOverlap(anchorAfterTile, tiledSibling), false, 'tiling must remove overlap');

    const firstStableAnchor = geometryForPid(anchorPid);
    const firstStableSibling = geometryForPid(siblingPid);
    assert.ok(dismissOverlayTilingCross(anchorPid), 'clicking outside the cross must dismiss it');
    assert.ok(invokeOverlayTileButton(anchorPid), 'repeated UIAutomation tiling must be accepted');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const repeatedAnchor = geometryForPid(anchorPid);
    const repeatedSibling = geometryForPid(siblingPid);
    assert.ok(Math.abs(repeatedAnchor.Left - firstStableAnchor.Left) <= 6);
    assert.ok(Math.abs(repeatedAnchor.Top - firstStableAnchor.Top) <= 6);
    assert.ok(Math.abs(repeatedSibling.Left - firstStableSibling.Left) <= 6);
    assert.ok(Math.abs(repeatedSibling.Top - firstStableSibling.Top) <= 6);

    assert.ok(invokeOverlayTileButton(siblingPid), 'the lower sibling must also be a valid tile anchor');
    const reanchoredAnchor = await waitForGeometry(anchorPid, (geometry) =>
      geometry.Top + geometry.Height <= repeatedSibling.Top + 6
        && Math.abs(geometry.Left - repeatedSibling.Left) <= 6,
    );
    assert.ok(reanchoredAnchor.Top < repeatedSibling.Top, 're-anchoring below must preserve the vertical stack');

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const stableAnchor = geometryForPid(anchorPid);
    const stableSibling = geometryForPid(siblingPid);
    assert.ok(Math.abs(stableAnchor.Left - reanchoredAnchor.Left) <= 6);
    assert.ok(Math.abs(stableAnchor.Top - reanchoredAnchor.Top) <= 6);
    assert.ok(Math.abs(stableSibling.Left - repeatedSibling.Left) <= 6);
    assert.ok(Math.abs(stableSibling.Top - repeatedSibling.Top) <= 6);

    await stopOverlay({ id: 'tiling-sibling-live', stateRoot });
    await stopOverlay({ id: 'tiling-anchor-live', stateRoot });

    const restartedAnchor = await startOverlay({
      id: 'tiling-anchor-live',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Tiling anchor live overlay',
        rows: [{ label: 'Role', value: 'anchor', tone: 'accent' }],
      },
    });
    anchorPid = restartedAnchor.pid ?? 0;
    assert.ok(anchorPid > 0, 'restarted tiling anchor must expose a host PID');

    const restartedSibling = await startOverlay({
      id: 'tiling-sibling-live',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Tiling sibling live overlay',
        rows: [{ label: 'Role', value: 'sibling', tone: 'success' }],
      },
    });
    siblingPid = restartedSibling.pid ?? 0;
    assert.ok(siblingPid > 0, 'restarted tiling sibling must expose a host PID');

    await waitForSnapshot(anchorPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('tiling-anchor-live'),
    ));
    await waitForSnapshot(siblingPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('tiling-sibling-live'),
    ));

    const restoredAnchor = await waitForGeometry(anchorPid, (geometry) =>
      Math.abs(geometry.Left - stableAnchor.Left) <= 6
        && Math.abs(geometry.Top - stableAnchor.Top) <= 6,
    );
    const restoredSibling = await waitForGeometry(siblingPid, (geometry) =>
      Math.abs(geometry.Left - stableSibling.Left) <= 6
        && Math.abs(geometry.Top - stableSibling.Top) <= 6,
    );
    assert.equal(boxesOverlap(restoredAnchor, restoredSibling), false, 'restart must preserve non-overlap');
  } finally {
    if (siblingPid > 0) await stopOverlay({ id: 'tiling-sibling-live', stateRoot }).catch(() => undefined);
    if (anchorPid > 0) await stopOverlay({ id: 'tiling-anchor-live', stateRoot }).catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live WPF overlay remains visible and focusable through its native HWND', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-live-'));
  try {
    const started = await startOverlay({
      id: 'live-overlay-e2e',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Live overlay E2E',
        rows: [{ label: 'State', value: 'running', tone: 'success' }],
      },
    });
    livePid = started.pid ?? 0;
    assert.ok(livePid > 0, 'live overlay must expose a host PID');

    const status = await overlayStatus('live-overlay-e2e', { stateRoot });
    assert.equal(status.visibility_state?.lifecycle, 'running');
    assert.equal(status.visibility_state?.policy, 'always');
    assert.equal(status.visibility_state?.desired_visibility, 'visible');
    assert.equal(status.visibility_state?.visibility, 'visible');
    assert.equal(status.visibility_state?.z_order, 'topmost');
    assert.equal(status.surface_snapshot?.schema, 'narada.window_surface_overlay.surface_snapshot.v1');
    assert.ok(status.surface_snapshot?.members.some((member) => member.id === 'live-overlay-e2e'));

    const visibleAfterStart = await waitForSnapshot(livePid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('live-overlay-e2e'),
    ));
    assert.notEqual(visibleAfterStart.ForegroundPid, 0, 'the live desktop must have a foreground window');

    await requestOverlayFocus('live-overlay-e2e', { stateRoot });
    const focusedAfterRequest = await waitForSnapshot(livePid, (snapshot) => snapshot.ForegroundPid === livePid);
    assert.equal(focusedAfterRequest.ForegroundPid, livePid);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const stable = readNativeWindowSnapshot(livePid);
    assert.ok(stable, 'overlay host must remain probeable after the visibility timer runs');
    assert.ok(stable.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('live-overlay-e2e'),
    ), 'overlay HWND must remain visible under the always policy');
  } finally {
    await stopOverlay({ id: 'live-overlay-e2e', stateRoot }).catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live always visibility is independent from normal z-order', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-z-order-live-'));
  let overlayPid = 0;
  try {
    const paths = overlayPaths('normal-z-order-overlay', { stateRoot });
    await mkdir(paths.stateDirectory, { recursive: true });
    await writeFile(paths.preferences, JSON.stringify({ position: null, opacity: 1, layer: 'normal' }) + '\n', 'utf8');
    const started = await startOverlay({
      id: 'normal-z-order-overlay',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Normal z-order overlay',
        rows: [{ label: 'State', value: 'visible', tone: 'success' }],
      },
    });
    overlayPid = started.pid ?? 0;
    assert.ok(overlayPid > 0);
    const status = await overlayStatus('normal-z-order-overlay', { stateRoot });
    assert.equal(status.visibility_state?.z_order, 'normal');
    assert.equal(status.visibility_state?.desired_visibility, 'visible');
    await waitForSnapshot(overlayPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('normal-z-order-overlay'),
    ));
  } finally {
    if (overlayPid > 0) await stopOverlay({ id: 'normal-z-order-overlay', stateRoot }).catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live terminal-group visibility follows terminal and external foreground transitions', {
  skip: process.platform !== 'win32',
}, async () => {
  const terminalPid = windowsTerminalPid();
  assert.ok(terminalPid, 'terminal-group live coverage requires a visible Windows Terminal window');
  assert.ok(activateNativeProcess(terminalPid), 'Windows Terminal must be activatable for live policy coverage');

  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-terminal-group-live-'));
  let overlayPid = 0;
  let externalProcess: ReturnType<typeof spawn> | null = null;
  let externalPid = 0;
  try {
    const started = await startOverlay({
      id: 'terminal-group-live-overlay',
      stateRoot,
      visibilityPolicy: 'terminal-group',
      refreshSeconds: 1,
      document: {
        title: 'Terminal group live overlay',
        rows: [{ label: 'Policy', value: 'terminal-group', tone: 'accent' }],
      },
    });
    overlayPid = started.pid ?? 0;
    assert.ok(overlayPid > 0);
    await waitForSnapshot(overlayPid, (snapshot) => snapshot.ForegroundPid === terminalPid && snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('terminal-group-live-overlay'),
    ));

    const externalScriptPath = join(stateRoot, 'external-window.ps1');
    await writeFile(externalScriptPath, EXTERNAL_WINDOW_SCRIPT, 'utf8');
    const external = startExternalForegroundProcess(externalScriptPath);
    externalProcess = external.child;
    externalPid = external.pid;
    const externalDeadline = Date.now() + 7_000;
    while (Date.now() < externalDeadline && !activateNativeProcess(externalPid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(activateNativeProcess(externalPid), `external foreground process must expose an activatable window: ${JSON.stringify({ snapshot: readNativeWindowSnapshot(externalPid), exitCode: externalProcess.exitCode, signalCode: externalProcess.signalCode, stderr: external.getStderr() })}`);
    let externalStatus = await overlayStatus('terminal-group-live-overlay', { stateRoot });
    const hiddenStateDeadline = Date.now() + 7_000;
    while (Date.now() < hiddenStateDeadline && (
      externalStatus.visibility_state?.desired_visibility !== 'hidden'
      || externalStatus.visibility_state?.visibility !== 'hidden'
    )) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      externalStatus = await overlayStatus('terminal-group-live-overlay', { stateRoot });
    }
    assert.equal(externalStatus.visibility_state?.desired_visibility, 'hidden', JSON.stringify(externalStatus.visibility_state));
    assert.equal(externalStatus.visibility_state?.visibility, 'hidden', JSON.stringify(externalStatus.visibility_state));
    await waitForSnapshot(overlayPid, (snapshot) => snapshot.Windows.some(
      (window) => !window.Visible && window.Title === overlayWindowTitle('terminal-group-live-overlay'),
    ));

    assert.ok(activateNativeProcess(terminalPid), 'Windows Terminal must be restorable after external focus');
    await waitForSnapshot(overlayPid, (snapshot) => snapshot.ForegroundPid === terminalPid && snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('terminal-group-live-overlay'),
    ));
  } finally {
    if (overlayPid > 0) await stopOverlay({ id: 'terminal-group-live-overlay', stateRoot }).catch(() => undefined);
    if (externalProcess) externalProcess.kill();
    if (externalPid > 0) stopExternalForegroundProcess(externalPid);
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live start applies a changed visibility policy to an existing host', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-policy-live-'));
  let firstPid = 0;
  let secondPid = 0;
  try {
    const first = await startOverlay({
      id: 'live-overlay-policy',
      stateRoot,
      visibilityPolicy: 'terminal-group',
      refreshSeconds: 1,
      document: {
        title: 'Live policy overlay',
        rows: [{ label: 'Policy', value: 'terminal-scoped', tone: 'warning' }],
      },
    });
    firstPid = first.pid ?? 0;
    assert.ok(firstPid > 0, 'initial overlay must expose a host PID');

    const second = await startOverlay({
      id: 'live-overlay-policy',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Live policy overlay',
        rows: [{ label: 'Policy', value: 'always-visible', tone: 'success' }],
      },
    });
    secondPid = second.pid ?? 0;
    assert.ok(secondPid > 0, 'replacement overlay must expose a host PID');
    assert.notEqual(secondPid, firstPid, 'a changed visibility policy must replace the old host');

    const visible = await waitForSnapshot(secondPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('live-overlay-policy'),
    ));
    assert.ok(visible.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('live-overlay-policy'),
    ));
  } finally {
    if (secondPid > 0) await stopOverlay({ id: 'live-overlay-policy', stateRoot }).catch(() => undefined);
    if (firstPid > 0 && firstPid !== secondPid) {
      await stopOverlay({ id: 'live-overlay-policy', stateRoot }).catch(() => undefined);
    }
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live presence selection changes independently from layer state', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-presence-live-'));
  let overlayPid = 0;
  try {
    const started = await startOverlay({
      id: 'presence-layer-live-overlay',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Presence and layer live overlay',
        rows: [{ label: 'State', value: 'visible', tone: 'success' }],
      },
    });
    overlayPid = started.pid ?? 0;
    assert.ok(overlayPid > 0);
    await waitForSnapshot(overlayPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('presence-layer-live-overlay'),
    ));

    await setOverlaySurfaceDefaultPresencePolicy('hidden', { stateRoot });
    await setOverlayPresencePolicy('presence-layer-live-overlay', 'surface-default', { stateRoot });
    let status = await overlayStatus('presence-layer-live-overlay', { stateRoot });
    const hiddenDeadline = Date.now() + 7_000;
    while (Date.now() < hiddenDeadline && status.visibility_state?.visibility !== 'hidden') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await overlayStatus('presence-layer-live-overlay', { stateRoot });
    }
    assert.equal(status.visibility_state?.policy, 'hidden', JSON.stringify(status.visibility_state));
    assert.equal(status.visibility_state?.visibility, 'hidden', JSON.stringify(status.visibility_state));
    assert.equal(status.visibility_state?.z_order, 'topmost', JSON.stringify(status.visibility_state));

    await setOverlayPresencePolicy('presence-layer-live-overlay', 'always', { stateRoot });
    status = await overlayStatus('presence-layer-live-overlay', { stateRoot });
    const visibleDeadline = Date.now() + 7_000;
    while (Date.now() < visibleDeadline && status.visibility_state?.visibility !== 'visible') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await overlayStatus('presence-layer-live-overlay', { stateRoot });
    }
    assert.equal(status.visibility_state?.policy, 'always', JSON.stringify(status.visibility_state));
    assert.equal(status.visibility_state?.visibility, 'visible', JSON.stringify(status.visibility_state));
    assert.equal(status.visibility_state?.z_order, 'topmost', JSON.stringify(status.visibility_state));
  } finally {
    if (overlayPid > 0) await stopOverlay({ id: 'presence-layer-live-overlay', stateRoot }).catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live overlays share visibility when a sibling owns focus', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-siblings-live-'));
  let firstPid = 0;
  let secondPid = 0;
  try {
    const first = await startOverlay({
      id: 'visibility-sibling-first',
      stateRoot,
      visibilityPolicy: 'terminal-group',
      refreshSeconds: 1,
      document: {
        title: 'Visibility sibling first',
        rows: [{ label: 'State', value: 'ready', tone: 'success' }],
      },
    });
    firstPid = first.pid ?? 0;
    assert.ok(firstPid > 0, 'first sibling must expose a host PID');
    await requestOverlayFocus('visibility-sibling-first', { stateRoot });
    await waitForSnapshot(firstPid, (snapshot) => snapshot.ForegroundPid === firstPid);

    const second = await startOverlay({
      id: 'visibility-sibling-second',
      stateRoot,
      visibilityPolicy: 'terminal-group',
      refreshSeconds: 1,
      document: {
        title: 'Visibility sibling second',
        rows: [{ label: 'State', value: 'focused', tone: 'accent' }],
      },
    });
    secondPid = second.pid ?? 0;
    assert.ok(secondPid > 0, 'second sibling must expose a host PID');
    await requestOverlayFocus('visibility-sibling-second', { stateRoot });
    await waitForSnapshot(secondPid, (snapshot) => snapshot.ForegroundPid === secondPid);

    const firstVisible = await waitForSnapshot(firstPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('visibility-sibling-first'),
    ));
    const secondVisible = await waitForSnapshot(secondPid, (snapshot) => snapshot.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('visibility-sibling-second'),
    ));
    assert.ok(firstVisible.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('visibility-sibling-first'),
    ));
    assert.ok(secondVisible.Windows.some(
      (window) => window.Visible && window.Title === overlayWindowTitle('visibility-sibling-second'),
    ));
  } finally {
    if (secondPid > 0) {
      await stopOverlay({ id: 'visibility-sibling-second', stateRoot }).catch(() => undefined);
    }
    if (firstPid > 0) {
      await stopOverlay({ id: 'visibility-sibling-first', stateRoot }).catch(() => undefined);
    }
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live focus requests are one-shot and do not keep stealing later operator focus', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-focus-once-live-'));
  let overlayPid = 0;
  let inputSurfacePid = 0;
  try {
    const overlay = await startOverlay({
      id: 'focus-one-shot-overlay',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Focus one-shot overlay',
        rows: [{ label: 'State', value: 'running', tone: 'accent' }],
      },
    });
    overlayPid = overlay.pid ?? 0;
    assert.ok(overlayPid > 0, 'focus overlay must expose a host PID');
    await requestOverlayFocus('focus-one-shot-overlay', { stateRoot });
    await waitForSnapshot(overlayPid, (snapshot) => snapshot.ForegroundPid === overlayPid);
    const focusedStatus = await overlayStatus('focus-one-shot-overlay', { stateRoot });
    assert.equal(focusedStatus.focus_owner?.id, 'focus-one-shot-overlay');

    const inputSurface = await startOverlay({
      id: 'focus-one-shot-input-surface',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Focus one-shot input surface',
        rows: [{ label: 'State', value: 'ready', tone: 'success' }],
      },
    });
    inputSurfacePid = inputSurface.pid ?? 0;
    assert.ok(inputSurfacePid > 0, 'input surface must expose a host PID');
    await requestOverlayFocus('focus-one-shot-input-surface', { stateRoot });
    await waitForSnapshot(inputSurfacePid, (snapshot) => snapshot.ForegroundPid === inputSurfacePid);
    const replacedFocusStatus = await overlayStatus('focus-one-shot-input-surface', { stateRoot });
    assert.equal(replacedFocusStatus.focus_owner?.id, 'focus-one-shot-input-surface');

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const stable = readNativeWindowSnapshot(inputSurfacePid);
    assert.ok(stable, 'input surface must remain probeable after multiple focus timer cycles');
    assert.equal(
      stable.ForegroundPid,
      inputSurfacePid,
      'a consumed focus request must not keep stealing focus from the later operator surface',
    );
  } finally {
    if (inputSurfacePid > 0) {
      await stopOverlay({ id: 'focus-one-shot-input-surface', stateRoot }).catch(() => undefined);
    }
    if (overlayPid > 0) {
      await stopOverlay({ id: 'focus-one-shot-overlay', stateRoot }).catch(() => undefined);
    }
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});

test('live overlay launch preserves an existing operator input surface focus', {
  skip: process.platform !== 'win32',
}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-window-overlay-focus-live-'));
  let inputSurfacePid = 0;
  let overlayPid = 0;
  try {
    const inputSurface = await startOverlay({
      id: 'operator-input-surface',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Operator input surface',
        rows: [{ label: 'State', value: 'ready', tone: 'success' }],
      },
    });
    inputSurfacePid = inputSurface.pid ?? 0;
    assert.ok(inputSurfacePid > 0, 'input surface must expose a host PID');
    await requestOverlayFocus('operator-input-surface', { stateRoot });
    await waitForSnapshot(inputSurfacePid, (snapshot) => snapshot.ForegroundPid === inputSurfacePid);

    const overlay = await startOverlay({
      id: 'operator-console-overlay',
      stateRoot,
      visibilityPolicy: 'always',
      refreshSeconds: 1,
      document: {
        title: 'Operator console overlay',
        rows: [{ label: 'State', value: 'running', tone: 'accent' }],
      },
    });
    overlayPid = overlay.pid ?? 0;
    assert.ok(overlayPid > 0, 'overlay must expose a host PID');

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const afterOverlayLaunch = readNativeWindowSnapshot(inputSurfacePid);
    assert.ok(afterOverlayLaunch, 'input surface must remain probeable after overlay launch');
    assert.equal(
      afterOverlayLaunch.ForegroundPid,
      inputSurfacePid,
      'launching an overlay must not steal focus from the existing operator input surface',
    );
  } finally {
    if (overlayPid > 0) {
      await stopOverlay({ id: 'operator-console-overlay', stateRoot }).catch(() => undefined);
    }
    if (inputSurfacePid > 0) {
      await stopOverlay({ id: 'operator-input-surface', stateRoot }).catch(() => undefined);
    }
    await rm(stateRoot, { recursive: true, force: true });
    livePid = 0;
  }
});
