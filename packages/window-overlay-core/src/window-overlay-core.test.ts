import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERLAY_DOCUMENT_SCHEMA,
  createOverlayRuntimeState,
  createOverlayDocument,
  defaultLocalAppDataRoot,
  defaultOverlayStateRoot,
  deriveOverlayVisibilityDecision,
  normalizeOverlayEnvironment,
  normalizeOverlayVisibilityPolicy,
  overlayPaths,
  overlayStatus,
  reduceOverlayRuntimeState,
  requestOverlayFocus,
  setOverlayPresencePolicy,
  setOverlaySurfaceDefaultPresencePolicy,
} from './index.js';

test('creates a versioned generic document with controlled actions', () => {
  const document = createOverlayDocument({
    id: 'example',
    title: 'Example',
    rows: [{ label: 'State', value: 'ready', tone: 'success', tooltip: 'State details' }],
    actions: [
      { id: 'open', label: 'Open', kind: 'open_url', target: 'http://127.0.0.1:61729/' },
      { id: 'restart', label: 'Restart', icon: '↻', tooltip: 'Restart overlay', kind: 'restart' },
    ],
  });
  assert.equal(document.schema, OVERLAY_DOCUMENT_SCHEMA);
  assert.equal(document.rows[0].tone, 'success');
  assert.equal(document.rows[0].tooltip, 'State details');
  assert.equal(document.actions[0].kind, 'open_url');
  assert.equal(document.actions[1].kind, 'restart');
  assert.equal(document.actions[1].icon, '↻');
  assert.equal(document.actions[1].tooltip, 'Restart overlay');
});

test('surface FSM separates policy visibility from lifecycle, focus, and z-order', () => {
  assert.equal(normalizeOverlayVisibilityPolicy('windows-terminal'), 'terminal-group');
  assert.deepEqual(
    deriveOverlayVisibilityDecision('terminal-group', 'external'),
    { desired_visibility: 'hidden', reason: 'foreground_external' },
  );
  assert.deepEqual(
    deriveOverlayVisibilityDecision('terminal-group', 'overlay'),
    { desired_visibility: 'visible', reason: 'terminal_group_active' },
  );
  assert.deepEqual(
    deriveOverlayVisibilityDecision('always', 'external'),
    { desired_visibility: 'visible', reason: 'policy_always' },
  );
  assert.deepEqual(
    deriveOverlayVisibilityDecision('hidden', 'terminal'),
    { desired_visibility: 'hidden', reason: 'policy_hidden' },
  );

  let state = createOverlayRuntimeState('fsm-overlay', 'terminal-group', 42, 'normal');
  assert.equal(state.lifecycle, 'starting');
  assert.equal(state.visibility, 'unknown');
  assert.equal(state.z_order, 'normal');
  state = reduceOverlayRuntimeState(state, { type: 'started' });
  state = reduceOverlayRuntimeState(state, {
    type: 'visibility_desired',
    decision: { desired_visibility: 'visible', reason: 'terminal_group_active' },
  });
  state = reduceOverlayRuntimeState(state, { type: 'visibility_applied', visible: true });
  state = reduceOverlayRuntimeState(state, { type: 'focus_requested' });
  state = reduceOverlayRuntimeState(state, { type: 'focus_resolved', focused: true });
  assert.equal(state.lifecycle, 'running');
  assert.equal(state.visibility, 'visible');
  assert.equal(state.focus, 'focused');
  assert.equal(state.z_order, 'normal');
  state = reduceOverlayRuntimeState(state, { type: 'stopping' });
  state = reduceOverlayRuntimeState(state, { type: 'stopped' });
  assert.equal(state.lifecycle, 'stopped');
  assert.equal(state.visibility, 'hidden');
  assert.throws(
    () => reduceOverlayRuntimeState(createOverlayRuntimeState('invalid-fsm'), { type: 'stopped' }),
    /overlay_lifecycle_transition_invalid/,
  );
});

test('action runner records bounded durable completion only after readiness', async () => {
  const source = await readFile(new URL('./Invoke-WindowSurfaceOverlayAction.ps1', import.meta.url), 'utf8');
  assert.match(source, /narada\.window_surface_overlay\.action_state\.v1/);
  assert.match(source, /Move-Item -Path \$temporary -Destination \$StatePath -Force/);
  assert.match(source, /success_probe_url/);
  assert.match(source, /Write-ActionState 'succeeded'/);
});

test('inspect reconciles an abandoned running action as interrupted', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-overlay-action-'));
  try {
    const paths = overlayPaths('example', { stateRoot });
    await mkdir(paths.stateDirectory, { recursive: true });
    await writeFile(paths.actionState, JSON.stringify({
      schema: 'narada.window_surface_overlay.action_state.v1',
      action_id: 'restart',
      request_id: 'request-1',
      status: 'running',
      started_at: new Date().toISOString(),
      pid: 2147483647,
    }), 'utf8');
    const status = await overlayStatus('example', { stateRoot });
    assert.equal(status.action_state?.status, 'interrupted');
    assert.equal(status.action_state?.detail, 'The action process exited without recording a terminal result.');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('restart actions cannot carry executable targets', () => {
  assert.throws(() => createOverlayDocument({
    id: 'example',
    actions: [{ id: 'restart', label: 'Restart', kind: 'restart', target: 'pwsh' }],
  }), /overlay_restart_target_forbidden/);
});

test('rejects arbitrary open-url targets', () => {
  assert.throws(() => createOverlayDocument({
    id: 'example',
    actions: [{ id: 'open', label: 'Open', kind: 'open_url', target: 'file:///secret' }],
  }), /overlay_open_url_target_scheme_invalid/);
});

test('state root is user-local and overrideable', () => {
  const env = { LOCALAPPDATA: 'C:\\Local', NARADA_WINDOW_SURFACE_OVERLAY_STATE_ROOT: '' };
  assert.equal(defaultOverlayStateRoot(env), 'C:\\Local\\Narada\\window-surface-overlays');
  const paths = overlayPaths('example', { stateRoot: 'C:\\State' });
  assert.match(paths.document, /example[\\/]document\.json$/);
  assert.match(paths.actionState, /example[\\/]action-state\.json$/);
  assert.match(paths.focus, /example[\\/]focus\.signal$/);
});

test('presence policy persists independently from layer preferences', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-overlay-presence-'));
  try {
    const overlay = await setOverlayPresencePolicy('example', 'always', { stateRoot });
    assert.equal(overlay.schema, 'narada.window_surface_overlay.presence_policy.v1');
    assert.equal(overlay.source, 'overlay');
    assert.equal(overlay.policy, 'always');
    const paths = overlayPaths('example', { stateRoot });
    const stored = JSON.parse(await readFile(paths.presencePolicy, 'utf8'));
    assert.equal(stored.policy, 'always');
    const surface = await setOverlaySurfaceDefaultPresencePolicy('terminal-group', { stateRoot });
    assert.equal(surface.default_presence_policy, 'terminal-group');
    assert.match(paths.surfacePreferences, /surface\.preferences\.json$/);
    await setOverlayPresencePolicy('example', 'surface-default', { stateRoot });
    const inherited = JSON.parse(await readFile(paths.presencePolicy, 'utf8'));
    assert.deepEqual({ source: inherited.source, policy: inherited.policy }, { source: 'surface-default', policy: null });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('normalizes the Windows WPF environment without mutating the caller', () => {
  const input: NodeJS.ProcessEnv = { SystemRoot: 'C:\\WINDOWS' };
  const normalized = normalizeOverlayEnvironment(input);
  if (process.platform === 'win32') assert.equal(normalized.windir, 'C:\\WINDOWS');
  else assert.equal(normalized.windir, undefined);
  assert.equal(input.windir, undefined);
});

test('derives the Windows user-local AppData root when carriers omit LOCALAPPDATA', () => {
  assert.equal(defaultLocalAppDataRoot({ USERPROFILE: 'C:\\Users\\Carrier' }), 'C:\\Users\\Carrier\\AppData\\Local');
  if (process.platform === 'win32') {
    const normalized = normalizeOverlayEnvironment({ USERPROFILE: 'C:\\Users\\Carrier', PATHEXT: '.CPL' });
    assert.equal(normalized.LOCALAPPDATA, 'C:\\Users\\Carrier\\AppData\\Local');
    assert.equal(normalized.PATHEXT?.includes('.EXE'), true);
  }
});

test('PowerShell host owns presentation mechanics, not provider data logic', async () => {
  const source = await readFile(new URL('./window-surface-overlay.ps1', import.meta.url), 'utf8');
  const positionSource = await readFile(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url), 'utf8');
  const tilingSource = await readFile(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url), 'utf8');
  const coordinatorSource = await readFile(new URL('./WindowSurfaceOverlayCoordinator.ps1', import.meta.url), 'utf8');
  assert.match(source, /PresentationFramework/);
  assert.match(source, /ShowInTaskbar/);
  assert.match(source, /DragMove/);
  assert.match(source, /Opacity/);
  assert.match(source, /New-Brush 255 18 18 25/);
  assert.match(source, /'accent'/);
  assert.doesNotMatch(source, /\$value\.TextDecorations/);
  assert.match(source, /Start-Process -FilePath \$rowTarget/);
  assert.match(source, /\$titleText\.Foreground = Get-ToneBrush/);
  assert.match(source, /\$script:PresenceButton\.FontSize = 12/);
  assert.match(source, /\$script:LayerButton\.FontSize = 12/);
  assert.match(source, /\$script:TileButton/);
  assert.match(source, /Invoke-OverlaySurfaceTiling/);
  assert.match(source, /New-OverlayPresenceMenu/);
  assert.match(source, /New-OverlayTilingCross/);
  assert.match(source, /Toggle-OverlayTilingCross/);
  assert.match(source, /OverlayInteractionLayer/);
  assert.match(source, /OverlayInteractionLayer\.Add_MouseLeftButtonDown/);
  assert.match(source, /GetPosition\(\$script:TileCross\)/);
  assert.match(source, /Close-OverlayTilingCross/);
  assert.match(source, /SetCursorPos/);
  assert.match(source, /\$script:PresenceButton\.Visibility = \[Windows\.Visibility\]::Hidden/);
  assert.match(source, /\$script:LayerButton\.Visibility = \[Windows\.Visibility\]::Hidden/);
  assert.match(source, /\$script:PresenceButton\.Visibility = \[Windows\.Visibility\]::Visible/);
  assert.match(source, /\$script:LayerButton\.Visibility = \[Windows\.Visibility\]::Visible/);
  assert.match(source, /PreferredDirection/);
  assert.match(source, /Automatic: preserve current arrangement/);
  assert.match(source, /Place siblings above this anchor/);
  assert.match(source, /Place siblings below this anchor/);
  assert.match(source, /Place siblings to the left of this anchor/);
  assert.match(source, /Place siblings to the right of this anchor/);
  assert.match(source, /center = Add-Button \$cross '' 'Automatic: preserve current arrangement'/);
  assert.match(source, /-tone 'accent' -icon/);
  assert.match(source, /\$crossButtonSize = 14/);
  assert.match(source, /\$crossButtonFontSize = 10/);
  assert.match(source, /\$crossButton\.HorizontalAlignment = 'Center'/);
  assert.match(source, /\$crossButton\.VerticalAlignment = 'Center'/);
  assert.match(source, /\$cross\.Width = 48/);
  assert.match(source, /\$cross\.Height = 48/);
  assert.match(source, /\[Windows\.GridLength\]::new\(16\)/);
  assert.doesNotMatch(source, /New-OverlayTilingMenu/);
  assert.match(source, /Layer: Above other windows/);
  assert.match(source, /\$window\.Topmost = \$preferences\.layer -eq 'topmost'/);
  assert.doesNotMatch(source, /\bpinned\b/i);
  assert.match(source, /Get-OverlayPresencePolicyLabel/);
  assert.match(tilingSource, /narada\.window_surface_overlay\.tile_command\.v1/);
  assert.match(tilingSource, /Get-OverlayTileLayout/);
  assert.match(tilingSource, /GetWindowRect/);
  assert.match(coordinatorSource, /presence\.policy\.json/);
  assert.match(source, /CornerRadius\(10\)/);
  assert.match(source, /ControlTemplate/);
  assert.match(source, /MouseEnter/);
  assert.match(source, /FontFamily.*Consolas/);
  assert.match(source, /New-OpacityButton/);
  assert.match(source, /\$header\.ColumnDefinitions/);
  assert.match(source, /\$header\.Height = 36/);
  assert.match(source, /\$line\.ColumnDefinitions\[0\]\.Width = New-Object Windows\.GridLength\(1, \[Windows\.GridUnitType\]::Auto\)/);
  assert.match(source, /\$line\.ColumnDefinitions\[1\]\.Width = New-Object Windows\.GridLength\(1, \[Windows\.GridUnitType\]::Star\)/);
  assert.match(source, /\$value\.TextWrapping = 'Wrap'/);
  assert.match(source, /\$value\.TextTrimming = 'None'/);
  assert.match(source, /\$value\.HorizontalAlignment = 'Stretch'/);
  assert.match(source, /\$row\.tooltip/);
  assert.match(source, /\$header\.Cursor = \[Windows\.Input\.Cursors\]::SizeAll/);
  assert.match(source, /\$titlePanel\.Cursor = \[Windows\.Input\.Cursors\]::SizeAll/);
  assert.match(source, /\$headerActions\.HorizontalAlignment = 'Right'/);
  assert.match(source, /GetForegroundWindow/);
  assert.match(source, /GetWindowText/);
  assert.match(source, /ShowWindow/);
  assert.match(source, /SetForegroundWindow/);
  assert.match(source, /AttachThreadInput/);
  assert.match(source, /Restore-LaunchForegroundIfNeeded/);
  assert.match(source, /LaunchPreservedForeground/);
  assert.match(source, /ForceForegroundWindow/);
  assert.match(source, /function Focus-Overlay/);
  assert.match(source, /\$script:lastFocusStamp/);
  assert.match(source, /\$script:lastDocumentStamp/);
  assert.match(source, /\$script:lastRefreshStamp/);
  assert.match(source, /Remove-Item -LiteralPath \$focusPath/);
  assert.match(source, /GetWindowThreadProcessId/);
  assert.match(source, /WindowSurfaceOverlayCoordinator\.ps1/);
  assert.match(source, /OverlayWindowTitlePrefix/);
  assert.match(source, /function Set-OverlayVisibility/);
  assert.match(source, /Update-OverlaySurfaceProjection/);
  assert.match(source, /Get-OverlaySurfaceDecision/);
  assert.doesNotMatch(source, /-not \[bool\]\$window\.Topmost/);
  assert.match(source, /visibilityTimer/);
  assert.match(source, /New-Object Windows\.Application/);
  assert.match(source, /\$window\.Show\(\)/);
  assert.match(source, /\$application\.Run\(\)/);
  assert.match(source, /WindowSurfaceOverlayPosition\.ps1/);
  assert.match(source, /MonitorFromPoint/);
  assert.match(source, /GetDpiForMonitor/);
  assert.match(source, /Math\]::Max\(\[double\]1, \(\[double\]\$dpi \/ \[double\]96\.0\)/);
  assert.match(source, /public int WorkRight \{ get; set; \}/);
  assert.match(source, /Get-OverlayMonitor/);
  assert.match(source, /Get-NearestOverlayPositionPreference/);
  assert.match(source, /Restore-OverlayPosition/);
  assert.match(source, /if \(\$position\.kind -eq 'free'\)/);
  assert.match(source, /\$script:PositionPreference = \[pscustomobject\]@\{\s+kind = 'free'/);
  assert.match(source, /FindOverlayWindowForProcess/);
  assert.match(source, /Add_LocationChanged/);
  assert.match(source, /Drag-OverlayAndPersistPosition/);
  assert.match(positionSource, /narada\.window_surface_overlay\.preferences\.v3/);
  assert.match(positionSource, /top-left/);
  assert.match(positionSource, /top-right/);
  assert.match(positionSource, /bottom-left/);
  assert.match(positionSource, /bottom-right/);
  assert.match(positionSource, /Clamp-OverlayPosition/);
  assert.match(positionSource, /Read-OverlayPositionPreference/);
  assert.match(positionSource, /kind -eq 'free'/);
  assert.match(source, /PositionPreference = \$null/);
  assert.doesNotMatch(source, /\$window\.ShowDialog\(\)/);
  assert.match(source, /Start-RestartCommand/);
  assert.match(source, /Apply-ActionState/);
  assert.match(source, /window_surface_overlay_restart_already_running/);
  assert.match(source, /The prior restart runner is no longer active/);
  assert.match(source, /Console restarted/);
  assert.match(source, /DateTimeOffset\]::TryParse/);
  assert.match(source, /PositiveInfinity/);
  assert.doesNotMatch(source, /quota|provider|usage|remaining/);
});

test('PowerShell position helper anchors, clamps, and migrates legacy coordinates', { skip: process.platform !== 'win32' }, () => {
  const helperPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const escapedPath = helperPath.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapedPath}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1280.0; bottom = 720.0 }
    $topRight = Resolve-OverlayPosition (New-OverlayPositionPreference 'top-right' 20 20) 360 200 $work
    $bottomLeft = Resolve-OverlayPosition (New-OverlayPositionPreference 'bottom-left' 30 40) 360 200 $work
    $clamped = Resolve-OverlayPosition (New-OverlayPositionPreference 'top-left' 9999 9999) 360 200 $work
    $freeRaw = Read-OverlayPositionPreference ([pscustomobject]@{ position = [pscustomobject]@{ kind = 'free'; left = 500; top = 300 } })
    $free = Resolve-OverlayPosition $freeRaw 360 200 $work
    $legacyRaw = Read-OverlayPositionPreference ([pscustomobject]@{ left = 900; top = 20 })
    $legacy = Get-NearestOverlayPositionPreference $legacyRaw.left $legacyRaw.top 360 200 $work
    [pscustomobject]@{ schema = Get-OverlayPositionPreferencesSchema; topRight = $topRight; bottomLeft = $bottomLeft; clamped = $clamped; free = $freeRaw; freeResolved = $free; legacy = $legacy } | ConvertTo-Json -Compress -Depth 6
  `;
  const output = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  const result = JSON.parse(output.trim()) as {
    schema: string;
    topRight: { left: number; top: number };
    bottomLeft: { left: number; top: number };
    clamped: { left: number; top: number };
    free: { kind: string; left: number; top: number };
    freeResolved: { left: number; top: number };
    legacy: { kind: string; anchor: string; inset_x: number; inset_y: number };
  };
  assert.equal(result.schema, 'narada.window_surface_overlay.preferences.v3');
  assert.deepEqual(result.topRight, { left: 900, top: 20 });
  assert.deepEqual(result.bottomLeft, { left: 30, top: 480 });
  assert.deepEqual(result.clamped, { left: 920, top: 520 });
  assert.deepEqual(result.free, { kind: 'free', left: 500, top: 300 });
  assert.deepEqual(result.freeResolved, { left: 500, top: 300 });
  assert.deepEqual(result.legacy, { kind: 'anchor', anchor: 'top-right', inset_x: 20, inset_y: 20 });
});

test('PowerShell tiling keeps the clicked overlay as anchor and moves a lower-left sibling up and right', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1280.0; bottom = 720.0 }
    $anchor = [pscustomobject]@{ id = 'anchor'; left = 500.0; top = 300.0; width = 360.0; height = 200.0; is_anchor = $true }
    $sibling = [pscustomobject]@{ id = 'lower-left'; left = 100.0; top = 600.0; width = 360.0; height = 200.0; is_anchor = $false }
    $first = @(Get-OverlayTileLayout -Anchor $anchor -Others @($sibling) -WorkArea $work)
    $reanchored = [pscustomobject]@{ id = 'lower-left'; left = $first[1].left; top = $first[1].top; width = 360.0; height = 200.0; is_anchor = $true }
    $original = [pscustomobject]@{ id = 'anchor'; left = $first[0].left; top = $first[0].top; width = 360.0; height = 200.0; is_anchor = $false }
    [pscustomobject]@{ first = $first; second = @(Get-OverlayTileLayout -Anchor $reanchored -Others @($original) -WorkArea $work) } | ConvertTo-Json -Compress -Depth 5
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as {
    first: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
    second: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
  };
  assert.deepEqual(result.first, [
    { id: 'anchor', left: 500, top: 300, is_anchor: true },
    { id: 'lower-left', left: 868, top: 300, is_anchor: false },
  ]);
  assert.deepEqual(result.second, [
    { id: 'lower-left', left: 868, top: 300, is_anchor: true },
    { id: 'anchor', left: 500, top: 300, is_anchor: false },
  ]);
});

test('PowerShell tiling prefers below for a lower sibling when the toward-anchor side does not fit', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1920.0; bottom = 1080.0 }
    $anchor = [pscustomobject]@{ id = 'anchor'; left = 1000.0; top = 300.0; width = 540.0; height = 217.0; is_anchor = $true }
    $sibling = [pscustomobject]@{ id = 'lower-left'; left = 800.0; top = 520.0; width = 540.0; height = 287.0; is_anchor = $false }
    @(Get-OverlayTileLayout -Anchor $anchor -Others @($sibling) -WorkArea $work) | ConvertTo-Json -Compress -Depth 5
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
  assert.deepEqual(result, [
    { id: 'anchor', left: 1000, top: 300, is_anchor: true },
    { id: 'lower-left', left: 1000, top: 525, is_anchor: false },
  ]);
});

test('PowerShell tiling places an overlapping sibling below instead of falling left', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1920.0; bottom = 1080.0 }
    $anchor = [pscustomobject]@{ id = 'anchor'; left = 1400.0; top = 300.0; width = 500.0; height = 260.0; is_anchor = $true }
    $sibling = [pscustomobject]@{ id = 'under'; left = 1400.0; top = 300.0; width = 420.0; height = 220.0; is_anchor = $false }
    @(Get-OverlayTileLayout -Anchor $anchor -Others @($sibling) -WorkArea $work) | ConvertTo-Json -Compress -Depth 5
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
  assert.deepEqual(result, [
    { id: 'anchor', left: 1400, top: 300, is_anchor: true },
    { id: 'under', left: 1400, top: 568, is_anchor: false },
  ]);
});

test('PowerShell tiling preserves vertical stacking when re-anchoring near an edge', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1920.0; bottom = 1080.0 }
    $anchor = [pscustomobject]@{ id = 'operator'; left = 1400.0; top = 300.0; width = 500.0; height = 260.0; is_anchor = $true }
    $sibling = [pscustomobject]@{ id = 'quota'; left = 1500.0; top = 600.0; width = 420.0; height = 220.0; is_anchor = $false }
    $first = @(Get-OverlayTileLayout -Anchor $anchor -Others @($sibling) -WorkArea $work)
    $reanchored = [pscustomobject]@{ id = 'quota'; left = $first[1].left; top = $first[1].top; width = 420.0; height = 220.0; is_anchor = $true }
    $other = [pscustomobject]@{ id = 'operator'; left = $first[0].left; top = $first[0].top; width = 500.0; height = 260.0; is_anchor = $false }
    [pscustomobject]@{ first = $first; second = @(Get-OverlayTileLayout -Anchor $reanchored -Others @($other) -WorkArea $work) } | ConvertTo-Json -Compress -Depth 5
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as {
    first: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
    second: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
  };
  assert.deepEqual(result.first, [
    { id: 'operator', left: 1400, top: 300, is_anchor: true },
    { id: 'quota', left: 1400, top: 568, is_anchor: false },
  ]);
  assert.deepEqual(result.second, [
    { id: 'quota', left: 1400, top: 568, is_anchor: true },
    { id: 'operator', left: 1400, top: 300, is_anchor: false },
  ]);
});
test('PowerShell tiling covers cardinal, diagonal, overlap, and deterministic multi-sibling layouts', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1920.0; bottom = 1080.0 }
    $anchor = [pscustomobject]@{ id = 'anchor'; left = 700.0; top = 350.0; width = 320.0; height = 200.0; is_anchor = $true }
    function Get-SingleLayout([string]$id, [double]$left, [double]$top) {
      $item = [pscustomobject]@{ id = $id; left = $left; top = $top; width = 320.0; height = 200.0; is_anchor = $false }
      [pscustomobject]@{ id = $id; layout = @(Get-OverlayTileLayout -Anchor $anchor -Others @($item) -WorkArea $work) }
    }
    $singles = @(
      (Get-SingleLayout 'right' 1100.0 350.0),
      (Get-SingleLayout 'left' 200.0 350.0),
      (Get-SingleLayout 'below' 700.0 700.0),
      (Get-SingleLayout 'above' 700.0 100.0),
      (Get-SingleLayout 'lower-left' 300.0 700.0),
      (Get-SingleLayout 'lower-right' 1100.0 700.0),
      (Get-SingleLayout 'upper-left' 300.0 100.0),
      (Get-SingleLayout 'upper-right' 1100.0 100.0),
      (Get-SingleLayout 'overlap' 700.0 350.0)
    )
    $multiOthers = @(
      [pscustomobject]@{ id = 'one'; left = 100.0; top = 100.0; width = 320.0; height = 200.0; is_anchor = $false },
      [pscustomobject]@{ id = 'two'; left = 1100.0; top = 100.0; width = 320.0; height = 200.0; is_anchor = $false },
      [pscustomobject]@{ id = 'three'; left = 100.0; top = 800.0; width = 320.0; height = 200.0; is_anchor = $false }
    )
    $multi = @(Get-OverlayTileLayout -Anchor $anchor -Others $multiOthers -WorkArea $work)
    $multiRepeat = @(Get-OverlayTileLayout -Anchor $anchor -Others $multiOthers -WorkArea $work)
    [pscustomobject]@{ singles = $singles; multi = $multi; multiRepeat = $multiRepeat } | ConvertTo-Json -Compress -Depth 8
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as {
    singles: Array<{ id: string; layout: Array<{ id: string; left: number; top: number; is_anchor: boolean }> }>;
    multi: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
    multiRepeat: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
  };
  const expectedSiblingPositions: Record<string, { left: number; top: number }> = {
    right: { left: 1028, top: 350 },
    left: { left: 372, top: 350 },
    below: { left: 700, top: 558 },
    above: { left: 700, top: 142 },
    'lower-left': { left: 1028, top: 350 },
    'lower-right': { left: 372, top: 350 },
    'upper-left': { left: 1028, top: 350 },
    'upper-right': { left: 372, top: 350 },
    overlap: { left: 700, top: 558 },
  };
  for (const scenario of result.singles) {
    assert.deepEqual(scenario.layout[0], { id: 'anchor', left: 700, top: 350, is_anchor: true });
    assert.deepEqual(scenario.layout[1], { id: scenario.id, ...expectedSiblingPositions[scenario.id], is_anchor: false });
  }
  assert.deepEqual(result.multi, result.multiRepeat, 'multi-sibling tiling must be deterministic for identical input');
  assert.equal(result.multi.length, 4);
  assert.equal(result.multi.filter((item) => item.is_anchor).length, 1);
  assert.deepEqual(result.multi[0], { id: 'anchor', left: 700, top: 350, is_anchor: true });
  const boxes = result.multi.map((item) => ({ ...item, width: 320, height: 200 }));
  for (const box of boxes) {
    assert.ok(box.left >= 0 && box.top >= 0);
    assert.ok(box.left + box.width <= 1920 && box.top + box.height <= 1080);
  }
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const a = boxes[first];
      const b = boxes[second];
      assert.equal(
        a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top,
        false,
        `multi-sibling layout overlaps ${a.id} and ${b.id}: ${JSON.stringify(result.multi)}`,
      );
    }
  }
});

test('PowerShell tiling keeps dense grids in bounds and reports impossible layouts without overlap', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1920.0; bottom = 1080.0 }
    $anchor = [pscustomobject]@{ id = 'anchor'; left = 700.0; top = 350.0; width = 320.0; height = 200.0; is_anchor = $true }
    $denseOthers = @(1..6 | ForEach-Object {
      [pscustomobject]@{ id = "dense-$_"; left = 100.0 + ($_ * 13); top = 100.0 + ($_ * 17); width = 320.0; height = 200.0; is_anchor = $false }
    })
    $dense = @(Get-OverlayTileLayout -Anchor $anchor -Others $denseOthers -WorkArea $work)
    $tightWork = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1000.0; bottom = 800.0 }
    $tightAnchor = [pscustomobject]@{ id = 'tight-anchor'; left = 350.0; top = 250.0; width = 600.0; height = 400.0; is_anchor = $true }
    $tightSibling = [pscustomobject]@{ id = 'tight-sibling'; left = 350.0; top = 250.0; width = 600.0; height = 400.0; is_anchor = $false }
    $impossible = @(Get-OverlayTileLayout -Anchor $tightAnchor -Others @($tightSibling) -WorkArea $tightWork)
    [pscustomobject]@{ dense = $dense; impossible = $impossible } | ConvertTo-Json -Compress -Depth 8
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as {
    dense: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
    impossible: Array<{ id: string; left: number; top: number; is_anchor: boolean }>;
  };
  assert.equal(result.dense.length, 7);
  assert.equal(result.dense[0].id, 'anchor');
  const denseBoxes = result.dense.map((item) => ({ ...item, width: 320, height: 200 }));
  for (const box of denseBoxes) {
    assert.ok(box.left >= 0 && box.top >= 0);
    assert.ok(box.left + box.width <= 1920 && box.top + box.height <= 1080);
  }
  for (let first = 0; first < denseBoxes.length; first += 1) {
    for (let second = first + 1; second < denseBoxes.length; second += 1) {
      const a = denseBoxes[first];
      const b = denseBoxes[second];
      assert.equal(
        a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top,
        false,
        `dense layout overlaps ${a.id} and ${b.id}: ${JSON.stringify(result.dense)}`,
      );
    }
  }
  assert.deepEqual(result.impossible, []);
});

test('PowerShell tiling honors an explicit sibling direction and refuses an impossible preference', { skip: process.platform !== 'win32' }, () => {
  const positionPath = fileURLToPath(new URL('./WindowSurfaceOverlayPosition.ps1', import.meta.url));
  const tilingPath = fileURLToPath(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url));
  const escapePowerShellPath = (value: string) => value.replaceAll("'", "''");
  const command = `
    $ErrorActionPreference = 'Stop'
    . '${escapePowerShellPath(positionPath)}'
    . '${escapePowerShellPath(tilingPath)}'
    $work = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1920.0; bottom = 1080.0 }
    $anchor = [pscustomobject]@{ id = 'anchor'; left = 700.0; top = 350.0; width = 320.0; height = 200.0; is_anchor = $true }
    $item = [pscustomobject]@{ id = 'sibling'; left = 700.0; top = 350.0; width = 320.0; height = 200.0; is_anchor = $false }
    $directions = @('right', 'left', 'below', 'above') | ForEach-Object {
      [pscustomobject]@{ direction = $_; layout = @(Get-OverlayTileLayout -Anchor $anchor -Others @($item) -WorkArea $work -PreferredDirection $_) }
    }
    $tightWork = [pscustomobject]@{ left = 0.0; top = 0.0; right = 1000.0; bottom = 800.0 }
    $tightAnchor = [pscustomobject]@{ id = 'tight-anchor'; left = 350.0; top = 250.0; width = 600.0; height = 400.0; is_anchor = $true }
    $tightSibling = [pscustomobject]@{ id = 'tight-sibling'; left = 350.0; top = 250.0; width = 600.0; height = 400.0; is_anchor = $false }
    $noFit = @(Get-OverlayTileLayout -Anchor $tightAnchor -Others @($tightSibling) -WorkArea $tightWork -PreferredDirection 'right')
    [pscustomobject]@{ directions = $directions; no_fit_count = $noFit.Count } | ConvertTo-Json -Compress -Depth 8
  `;
  const output = execFileSync(process.env.NARADA_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const result = JSON.parse(output) as {
    directions: Array<{ direction: string; layout: Array<{ id: string; left: number; top: number; is_anchor: boolean }> }>;
    no_fit_count: number;
  };
  const expected: Record<string, { left: number; top: number }> = {
    right: { left: 1028, top: 350 },
    left: { left: 372, top: 350 },
    below: { left: 700, top: 558 },
    above: { left: 700, top: 142 },
  };
  for (const scenario of result.directions) {
    assert.deepEqual(scenario.layout[0], { id: 'anchor', left: 700, top: 350, is_anchor: true });
    assert.deepEqual(scenario.layout[1], { id: 'sibling', ...expected[scenario.direction], is_anchor: false });
  }
  assert.equal(result.no_fit_count, 0);
});

test('tiling command consumption is durable, one-shot, and orthogonal to visibility axes', async () => {
  const host = await readFile(new URL('./window-surface-overlay.ps1', import.meta.url), 'utf8');
  const tiling = await readFile(new URL('./WindowSurfaceOverlayTiling.ps1', import.meta.url), 'utf8');
  assert.match(tiling, /OverlayTileCommandSchema/);
  assert.ok(tiling.includes('request_id = $requestId'));
  assert.ok(tiling.includes('anchor_id = $CurrentId'));
  assert.ok(tiling.includes('preferred_direction = $PreferredDirection'));
  assert.match(tiling, /Write-OverlaySurfaceJsonAtomic/);
  assert.ok(host.includes('$script:lastTileRequestId'));
  assert.ok(host.includes('requestId -eq $script:lastTileRequestId'));
  assert.ok(host.includes("kind = 'free'"));
  assert.ok(host.includes('Save-Preferences $window'));
  assert.ok(host.includes('Remove-Item -LiteralPath $tileCommandPath'));
  assert.ok(host.includes('$visibilityTimer.Add_Tick({ Apply-OverlayTileCommand; Set-OverlayVisibility })'));
  assert.doesNotMatch(tiling, /Set-OverlayVisibility|Set-OverlayFocus|Topmost/);
});

test('re-render replaces document actions instead of appending duplicates', async () => {
  const source = await readFile(new URL('./window-surface-overlay.ps1', import.meta.url), 'utf8');
  assert.match(source, /\$documentActions\.Children\.Clear\(\)/);
  assert.match(source, /Add-Button \$documentActions/);
  assert.match(source, /Get-ActionLabel/);
});

test('PowerShell lifecycle scripts do not shadow the automatic PID variable', async () => {
  const start = await readFile(new URL('./Start-WindowSurfaceOverlay.ps1', import.meta.url), 'utf8');
  const stop = await readFile(new URL('./Stop-WindowSurfaceOverlay.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(start, /\$pid\s*=/);
  assert.doesNotMatch(stop, /\$pid\s*=/);
  assert.match(stop, /\$overlayPid/);
  assert.doesNotMatch(start, /\$focusPath/);
  assert.doesNotMatch(start, /Set-Content -Path \$focusPath/);
  assert.match(stop, /Remove-Item \$focusPath/);
});

test('existing overlay hosts are replaced when the requested visibility policy changes', async () => {
  const start = await readFile(new URL('./Start-WindowSurfaceOverlay.ps1', import.meta.url), 'utf8');
  const coordinator = await readFile(new URL('./WindowSurfaceOverlayCoordinator.ps1', import.meta.url), 'utf8');
  assert.match(start, /visibilityPolicyPath/);
  assert.match(start, /storedPolicy/);
  assert.match(start, /Stop-HostForPolicyChange \$existing/);
  assert.match(start, /window_surface_overlay_policy_change_timeout/);
  assert.match(start, /-VisibilityPolicy/);
  assert.match(start, /terminal-group/);
  assert.match(start, /effectivePolicy/);
  assert.match(start, /Read-OverlayPresencePolicySelection/);
  assert.ok(start.includes('[int]$StartupTimeoutSeconds = 30'));
  assert.ok(start.includes('AddSeconds($StartupTimeoutSeconds)'));
  assert.match(coordinator, /stateKey/);
  assert.match(coordinator, /focusKey/);
  assert.match(coordinator, /Write-OverlaySurfaceJsonAtomic/);
  assert.match(coordinator, /policy_hidden/);
  assert.match(coordinator, /surface.preferences.json/);
  const host = await readFile(new URL('./window-surface-overlay.ps1', import.meta.url), 'utf8');
  assert.match(host, /VisibilityReason = 'visibility_fault'/);
  assert.match(host, /-Lifecycle \$script:LifecycleState/);
  assert.match(host, /actual foreground window is authoritative/);
  assert.match(host, /Set-OverlayLifecycleState/);
  assert.match(host, /Set-OverlayVisibilityState/);
  assert.match(host, /Set-OverlayFocusState/);
});

test('focus requests refuse stopped overlays without leaving a signal', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'narada-overlay-focus-'));
  try {
    const paths = overlayPaths('stopped-overlay', { stateRoot });
    await assert.rejects(
      requestOverlayFocus('stopped-overlay', { stateRoot }),
      /overlay_not_running/,
    );
    await assert.rejects(
      readFile(paths.focus, 'utf8'),
      (error: any) => error?.code === 'ENOENT',
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('overlay host owns durable error logging without keeping its launcher attached', async () => {
  const start = await readFile(new URL('./Start-WindowSurfaceOverlay.ps1', import.meta.url), 'utf8');
  const host = await readFile(new URL('./window-surface-overlay.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(start, /-RedirectStandard(?:Output|Error)/);
  assert.match(host, /host\.stderr\.log/);
  assert.match(host, /trap \{/);
});

test('overlay launcher completion follows launcher exit rather than descendant stdio closure', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(source, /child\.once\('exit'/);
  assert.doesNotMatch(source, /child\.once\('close'/);
});

test('former Rust/AutoHotkey installation assumptions are gone', async () => {
  const source = await readFile(new URL('./Install-WindowSurfaceOverlay.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cargo|AutoHotkey|narada-window-surface-overlay\.exe/);
});
