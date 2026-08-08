$script:OverlayTileCommandSchema = 'narada.window_surface_overlay.tile_command.v1'

function Get-OverlayTileCommandPath([string]$StateRoot) {
    return Join-Path $StateRoot 'tile.command.json'
}

function Get-OverlayTileNativeBounds([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return $null }
    $rect = New-Object NaradaWindowSurfaceOverlayNative+RECT
    if (-not [NaradaWindowSurfaceOverlayNative]::GetWindowRect($Handle, [ref]$rect)) { return $null }
    [pscustomobject]@{
        left = [double]$rect.Left
        top = [double]$rect.Top
        right = [double]$rect.Right
        bottom = [double]$rect.Bottom
        width = [double]($rect.Right - $rect.Left)
        height = [double]($rect.Bottom - $rect.Top)
    }
}

function Get-OverlaySurfaceTileCandidates {
    param(
        [Parameter(Mandatory = $true)][string]$SurfaceRoot,
        [Parameter(Mandatory = $true)][string]$CurrentId,
        [Parameter(Mandatory = $true)][object]$CurrentWindow,
        [Parameter(Mandatory = $true)][object]$Monitor
    )
    $scale = [Math]::Max(1, [double]$Monitor.scale)
    $currentDimensions = Get-OverlayWindowDimensions $CurrentWindow
    $currentBounds = Get-OverlayTileNativeBounds (Get-OverlayWindowHandle)
    $anchorLeft = [double]$CurrentWindow.Left
    $anchorTop = [double]$CurrentWindow.Top
    $anchorWidth = [double]$currentDimensions.width
    $anchorHeight = [double]$currentDimensions.height
    if ($currentBounds) {
        $anchorLeft = $currentBounds.left / $scale
        $anchorTop = $currentBounds.top / $scale
        $anchorWidth = $currentBounds.width / $scale
        $anchorHeight = $currentBounds.height / $scale
    }
    $items = @([pscustomobject]@{
        id = $CurrentId
        state_root = $StateRoot
        left = $anchorLeft
        top = $anchorTop
        width = [Math]::Max(1, $anchorWidth)
        height = [Math]::Max(1, $anchorHeight)
        is_anchor = $true
    })
    foreach ($directory in @(Get-ChildItem -LiteralPath $SurfaceRoot -Directory -ErrorAction SilentlyContinue)) {
        if ($directory.Name -eq $CurrentId) { continue }
        $pidPath = Join-Path $directory.FullName 'overlay.pid'
        if (-not (Test-Path -LiteralPath $pidPath)) { continue }
        $memberPid = 0
        if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$memberPid) -or $memberPid -le 0) { continue }
        if (-not (Get-Process -Id $memberPid -ErrorAction SilentlyContinue)) { continue }
        $handle = [NaradaWindowSurfaceOverlayNative]::FindOverlayWindowForProcess([uint32]$memberPid, $script:OverlayWindowTitlePrefix)
        $bounds = Get-OverlayTileNativeBounds $handle
        if ($null -eq $bounds) { continue }
        $items += [pscustomobject]@{
            id = $directory.Name
            state_root = $directory.FullName
            left = $bounds.left / $scale
            top = $bounds.top / $scale
            width = [Math]::Max(1, ($bounds.width / $scale))
            height = [Math]::Max(1, ($bounds.height / $scale))
            is_anchor = $false
        }
    }
    return @($items)
}

function Get-OverlayTileOrderedSiblings {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object[]]$Others
    )
    $anchorCenterX = [double]$Anchor.left + ([double]$Anchor.width / 2)
    $anchorCenterY = [double]$Anchor.top + ([double]$Anchor.height / 2)
    return @($Others | ForEach-Object {
        $centerX = [double]$_.left + ([double]$_.width / 2)
        $centerY = [double]$_.top + ([double]$_.height / 2)
        [pscustomobject]@{
            item = $_
            distance = [Math]::Pow($centerX - $anchorCenterX, 2) + [Math]::Pow($centerY - $anchorCenterY, 2)
            top = [double]$_.top
            left = [double]$_.left
            id = [string]$_.id
        }
    } | Sort-Object distance, top, left, id | ForEach-Object { $_.item })
}

function Test-OverlayTileSide {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object]$Item,
        [Parameter(Mandatory = $true)][ValidateSet('right', 'left', 'below', 'above')][string]$Direction,
        [double]$Gap = 8
    )
    $alignmentTolerance = [Math]::Max(16, $Gap * 2)
    switch ($Direction) {
        'right' {
            return ([Math]::Abs([double]$Item.top - [double]$Anchor.top) -le $alignmentTolerance) -and
                ([double]$Item.left -ge ([double]$Anchor.left + [double]$Anchor.width - $Gap))
        }
        'left' {
            return ([Math]::Abs([double]$Item.top - [double]$Anchor.top) -le $alignmentTolerance) -and
                (([double]$Item.left + [double]$Item.width) -le ([double]$Anchor.left + $Gap))
        }
        'below' {
            return ([Math]::Abs([double]$Item.left - [double]$Anchor.left) -le $alignmentTolerance) -and
                ([double]$Item.top -ge ([double]$Anchor.top + [double]$Anchor.height - $Gap))
        }
        default {
            return ([Math]::Abs([double]$Item.left - [double]$Anchor.left) -le $alignmentTolerance) -and
                (([double]$Item.top + [double]$Item.height) -le ([double]$Anchor.top + $Gap))
        }
    }
}

function Get-OverlayTilePreservedDirection {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object[]]$Others,
        [double]$Gap = 8
    )
    $directions = @('right', 'left', 'below', 'above')
    $bestDirection = $null
    $bestCount = 0
    foreach ($direction in $directions) {
        $count = @($Others | Where-Object {
            Test-OverlayTileSide -Anchor $Anchor -Item $_ -Direction $direction -Gap $Gap
        }).Count
        if ($count -gt $bestCount) {
            $bestDirection = $direction
            $bestCount = $count
        }
    }
    if ($bestCount -eq @($Others).Count -and $bestCount -gt 0) { return $bestDirection }
    return $null
}

function Get-OverlayTileSideCapacity {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object]$WorkArea,
        [double]$CellWidth,
        [double]$CellHeight,
        [double]$Gap = 8
    )
    $horizontalStep = [Math]::Max(1, [double]$CellWidth + $Gap)
    $verticalStep = [Math]::Max(1, [double]$CellHeight + $Gap)
    [pscustomobject]@{
        right = [Math]::Max(0, [int][Math]::Floor((([double]$WorkArea.right - ([double]$Anchor.left + [double]$Anchor.width)) / $horizontalStep)))
        left = [Math]::Max(0, [int][Math]::Floor((([double]$Anchor.left - [double]$WorkArea.left) / $horizontalStep)))
        below = [Math]::Max(0, [int][Math]::Floor((([double]$WorkArea.bottom - ([double]$Anchor.top + [double]$Anchor.height)) / $verticalStep)))
        above = [Math]::Max(0, [int][Math]::Floor((([double]$Anchor.top - [double]$WorkArea.top) / $verticalStep)))
        right_rows = [Math]::Max(0, [int][Math]::Floor((([double]$WorkArea.bottom - [double]$Anchor.top + $Gap) / $verticalStep)))
        left_rows = [Math]::Max(0, [int][Math]::Floor((([double]$WorkArea.bottom - [double]$Anchor.top + $Gap) / $verticalStep)))
        below_columns = [Math]::Max(0, [int][Math]::Floor((([double]$WorkArea.right - [double]$Anchor.left + $Gap) / $horizontalStep)))
        above_columns = [Math]::Max(0, [int][Math]::Floor((([double]$WorkArea.right - [double]$Anchor.left + $Gap) / $horizontalStep)))
    }
}

function Test-OverlayTileDirectionFits {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object[]]$Others,
        [Parameter(Mandatory = $true)][object]$WorkArea,
        [Parameter(Mandatory = $true)][ValidateSet('right', 'left', 'below', 'above')][string]$Direction,
        [double]$Gap = 8
    )
    $itemCount = @($Others).Count
    if ($itemCount -eq 0) { return $false }
    if ($itemCount -eq 1) {
        $item = @($Others)[0]
        switch ($Direction) {
            'right' { return (([double]$Anchor.left + [double]$Anchor.width + $Gap + [double]$item.width) -le [double]$WorkArea.right) }
            'left' { return (([double]$Anchor.left - $Gap - [double]$item.width) -ge [double]$WorkArea.left) }
            'below' { return (([double]$Anchor.top + [double]$Anchor.height + $Gap + [double]$item.height) -le [double]$WorkArea.bottom) }
            default { return (([double]$Anchor.top - $Gap - [double]$item.height) -ge [double]$WorkArea.top) }
        }
    }
    $all = @($Others) + @($Anchor)
    $cellWidth = [Math]::Max(1, [double](($all | Measure-Object -Property width -Maximum).Maximum))
    $cellHeight = [Math]::Max(1, [double](($all | Measure-Object -Property height -Maximum).Maximum))
    $capacity = Get-OverlayTileSideCapacity -Anchor $Anchor -WorkArea $WorkArea -CellWidth $cellWidth -CellHeight $cellHeight -Gap $Gap
    $desiredColumns = [Math]::Max(1, [int][Math]::Ceiling([Math]::Sqrt($itemCount + 1)))
    if ($Direction -in @('right', 'left')) {
        $columnCapacity = [int]$capacity.$Direction
        $rowCapacity = if ($Direction -eq 'right') { [int]$capacity.right_rows } else { [int]$capacity.left_rows }
    } else {
        $columnCapacity = if ($Direction -eq 'below') { [int]$capacity.below_columns } else { [int]$capacity.above_columns }
        $rowCapacity = [int]$capacity.$Direction
    }
    if ($columnCapacity -le 0 -or $rowCapacity -le 0) { return $false }
    $columns = [Math]::Min($desiredColumns, $columnCapacity)
    $rows = [int][Math]::Ceiling($itemCount / [double]$columns)
    return $rows -le $rowCapacity
}
function Get-OverlayTileDirectionOrder {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object]$Item
    )
    $anchorCenterX = [double]$Anchor.left + ([double]$Anchor.width / 2)
    $anchorCenterY = [double]$Anchor.top + ([double]$Anchor.height / 2)
    $itemCenterX = [double]$Item.left + ([double]$Item.width / 2)
    $itemCenterY = [double]$Item.top + ([double]$Item.height / 2)
    $horizontalOverlap = ([double]$Item.left -lt ([double]$Anchor.left + [double]$Anchor.width)) -and
        (([double]$Item.left + [double]$Item.width) -gt [double]$Anchor.left)
    $verticalOverlap = ([double]$Item.top -lt ([double]$Anchor.top + [double]$Anchor.height)) -and
        (([double]$Item.top + [double]$Item.height) -gt [double]$Anchor.top)

    if ($horizontalOverlap -and $verticalOverlap) {
        if ([double]$Item.top -ge [double]$Anchor.top) { return @('below', 'right', 'left', 'above') }
        return @('above', 'right', 'left', 'below')
    }

    if ($itemCenterY -gt $anchorCenterY) {
        if ($horizontalOverlap) { return @('below', 'right', 'left', 'above') }
        if ($itemCenterX -lt $anchorCenterX) { return @('right', 'below', 'left', 'above') }
        return @('left', 'below', 'right', 'above')
    }
    if ($itemCenterY -lt $anchorCenterY) {
        if ($horizontalOverlap) { return @('above', 'right', 'left', 'below') }
        if ($itemCenterX -lt $anchorCenterX) { return @('right', 'above', 'left', 'below') }
        return @('left', 'above', 'right', 'below')
    }
    if ($verticalOverlap -and $itemCenterX -lt $anchorCenterX) { return @('right', 'left', 'below', 'above') }
    if ($verticalOverlap -and $itemCenterX -gt $anchorCenterX) { return @('left', 'right', 'below', 'above') }
    return @('right', 'left', 'below', 'above')
}

function Get-OverlayTileLayout {
    param(
        [Parameter(Mandatory = $true)][object]$Anchor,
        [Parameter(Mandatory = $true)][object[]]$Others,
        [Parameter(Mandatory = $true)][object]$WorkArea,
        [double]$Gap = 8,
        [ValidateSet('auto', 'right', 'left', 'below', 'above')][string]$PreferredDirection = 'auto'
    )
    $orderedOthers = Get-OverlayTileOrderedSiblings -Anchor $Anchor -Others $Others
    $all = @($Anchor) + @($orderedOthers)
    if ($all.Count -le 1) { return @() }

    $cellWidth = [Math]::Max(1, [double](($all | Measure-Object -Property width -Maximum).Maximum))
    $cellHeight = [Math]::Max(1, [double](($all | Measure-Object -Property height -Maximum).Maximum))
    $desiredColumns = [Math]::Max(1, [int][Math]::Ceiling([Math]::Sqrt($all.Count)))
    $capacity = Get-OverlayTileSideCapacity -Anchor $Anchor -WorkArea $WorkArea -CellWidth $cellWidth -CellHeight $cellHeight -Gap $Gap
    $direction = $null
    if ($PreferredDirection -ne 'auto') {
        if (-not (Test-OverlayTileDirectionFits -Anchor $Anchor -Others $orderedOthers -WorkArea $WorkArea -Direction $PreferredDirection -Gap $Gap)) {
            return @()
        }
        $direction = $PreferredDirection
    } else {
        $preservedDirection = Get-OverlayTilePreservedDirection -Anchor $Anchor -Others $orderedOthers -Gap $Gap
        if ($preservedDirection -and (Test-OverlayTileDirectionFits -Anchor $Anchor -Others $orderedOthers -WorkArea $WorkArea -Direction $preservedDirection -Gap $Gap)) {
            $direction = $preservedDirection
        } else {
            $directionOrder = if ($orderedOthers.Count -eq 1) {
                Get-OverlayTileDirectionOrder -Anchor $Anchor -Item @($orderedOthers)[0]
            } else {
                @('right', 'left', 'below', 'above')
            }
            foreach ($candidate in @($directionOrder)) {
                if (Test-OverlayTileDirectionFits -Anchor $Anchor -Others $orderedOthers -WorkArea $WorkArea -Direction $candidate -Gap $Gap) {
                    $direction = $candidate
                    break
                }
            }
        }
    }
    if ($null -eq $direction) { return @() }

    if ($direction -eq 'right') {
        $columnCapacity = [int]$capacity.right
        $rowCapacity = [int]$capacity.right_rows
    } elseif ($direction -eq 'left') {
        $columnCapacity = [int]$capacity.left
        $rowCapacity = [int]$capacity.left_rows
    } elseif ($direction -eq 'below') {
        $columnCapacity = [int]$capacity.below_columns
        $rowCapacity = [int]$capacity.below
    } else {
        $columnCapacity = [int]$capacity.above_columns
        $rowCapacity = [int]$capacity.above
    }
    if ($columnCapacity -le 0 -or $rowCapacity -le 0) { return @() }

    $columns = [Math]::Max(1, [Math]::Min($desiredColumns, $columnCapacity))
    $rows = [int][Math]::Ceiling($orderedOthers.Count / [double]$columns)
    if ($rows -gt $rowCapacity) { return @() }

    $horizontalStep = $cellWidth + $Gap
    $verticalStep = $cellHeight + $Gap
    $result = @()
    for ($index = 0; $index -lt $all.Count; $index++) {
        $item = $all[$index]
        if ($index -eq 0) {
            $left = [double]$Anchor.left
            $top = [double]$Anchor.top
        } else {
            $offset = $index - 1
            $row = [int][Math]::Floor($offset / $columns)
            $column = $offset % $columns
            if ($direction -eq 'right') {
                $left = [double]$Anchor.left + (($column + 1) * $horizontalStep)
                $top = [double]$Anchor.top + ($row * $verticalStep)
            } elseif ($direction -eq 'left') {
                $left = [double]$Anchor.left - (($column + 1) * $horizontalStep) + ($cellWidth - [double]$item.width)
                $top = [double]$Anchor.top + ($row * $verticalStep)
            } elseif ($direction -eq 'below') {
                $left = [double]$Anchor.left + ($column * $horizontalStep)
                $top = [double]$Anchor.top + [double]$Anchor.height + $Gap + ($row * $verticalStep)
            } else {
                $left = [double]$Anchor.left + ($column * $horizontalStep)
                $top = [double]$Anchor.top - $Gap - [double]$item.height - ($row * $verticalStep)
            }
        }
        $clamped = if ($index -eq 0) {
            [pscustomobject]@{ left = $left; top = $top }
        } else {
            Clamp-OverlayPosition $left $top ([double]$item.width) ([double]$item.height) $WorkArea
        }
        $result += [pscustomobject]@{
            id = [string]$item.id
            left = [double]$clamped.left
            top = [double]$clamped.top
            is_anchor = [bool]$item.is_anchor
        }
    }
    return @($result)
}
function Invoke-OverlaySurfaceTiling {
    param(
        [Parameter(Mandatory = $true)][string]$SurfaceRoot,
        [Parameter(Mandatory = $true)][string]$CurrentId,
        [Parameter(Mandatory = $true)][object]$CurrentWindow,
        [ValidateSet('auto', 'right', 'left', 'below', 'above')][string]$PreferredDirection = 'auto'
    )
    $monitor = Get-OverlayMonitor
    if ($null -eq $monitor) { return [pscustomobject]@{ status = 'not_available'; reason = 'monitor_unavailable' } }
    $items = Get-OverlaySurfaceTileCandidates -SurfaceRoot $SurfaceRoot -CurrentId $CurrentId -CurrentWindow $CurrentWindow -Monitor $monitor
    $anchor = @($items | Where-Object { $_.id -eq $CurrentId }) | Select-Object -First 1
    $others = @($items | Where-Object { $_.id -ne $CurrentId })
    if ($null -eq $anchor -or $others.Count -eq 0) {
        return [pscustomobject]@{ status = 'no_change'; anchor_id = $CurrentId; moved_count = 0 }
    }
    $layout = @(Get-OverlayTileLayout -Anchor $anchor -Others $others -WorkArea $monitor.work_area -PreferredDirection $PreferredDirection)
    if ($layout.Count -eq 0) {
        return [pscustomobject]@{ status = 'no_fit'; reason = 'work_area_capacity'; anchor_id = $CurrentId; preferred_direction = $PreferredDirection; moved_count = 0 }
    }
    $requestId = [Guid]::NewGuid().ToString('N')
    $issuedAt = [DateTime]::UtcNow.ToString('o')
    $moved = @()
    foreach ($target in @($layout | Where-Object { -not $_.is_anchor })) {
        $member = @($items | Where-Object { $_.id -eq $target.id }) | Select-Object -First 1
        if ($null -eq $member) { continue }
        $commandPath = Get-OverlayTileCommandPath $member.state_root
        Write-OverlaySurfaceJsonAtomic $commandPath ([ordered]@{
            schema = $script:OverlayTileCommandSchema
            request_id = $requestId
            anchor_id = $CurrentId
            preferred_direction = $PreferredDirection
            issued_at = $issuedAt
            target = [ordered]@{ left = [double]$target.left; top = [double]$target.top }
        })
        $moved += [pscustomobject]@{ id = $target.id; left = $target.left; top = $target.top }
    }
    return [pscustomobject]@{
        schema = $script:OverlayTileCommandSchema
        status = 'accepted'
        request_id = $requestId
        anchor_id = $CurrentId
        preferred_direction = $PreferredDirection
        moved_count = $moved.Count
        moved = @($moved)
    }
}
