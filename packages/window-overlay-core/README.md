# @narada-core/window-overlay-core

Reusable Windows overlay-window mechanics for Narada operator surfaces.

## Toast Viewport

The package also owns one lazy, user-local WPF toast viewport. It is a transient projection, not
a durable notification store: a cold start discards stale inbox files. Producers submit a
versioned `narada.window_toast.request.v1` request through `enqueueToast`; the returned ingress
receipt proves atomic admission to the viewport inbox, not that a notification was rendered.

The viewport shows at most three items and queues at most 32. Foreground items can displace the
oldest visible background item, dedupe keys replace an older matching item, hover pauses expiry,
and an idle empty host exits after five minutes. Supported actions are deliberately limited to
opening HTTP(S) URLs and copying text. Toasts are topmost and initially non-activating, but remain
independent of overlay presence, layer, focus, position, and tiling state. Each stack originates
from the bottom-left of the foreground operator window's monitor; physical monitor bounds are
converted to WPF coordinates so display scaling does not move the stack off-screen. A thin
semantic-tone lifetime line contracts smoothly until dismissal and pauses with expiry on hover.

CLI examples:

- `narada-window-overlay-core toast enqueue --title "Sync complete" --tone success`;
- `narada-window-overlay-core toast enqueue --request request.json`;
- `narada-window-overlay-core toast inspect`;
- `narada-window-overlay-core toast stop`.

This package owns the mechanics extracted from the quota-meter overlay:

- one overlay process per stable overlay id;
- user-local state for PID, document, presence policy, runtime visibility state, shared surface projection, focus ownership, refresh signal, position, opacity, and layer state; position is persisted as a nearest-corner anchor (`top-left`, `top-right`, `bottom-left`, or `bottom-right`) with monitor-work-area insets rather than absolute desktop coordinates;
- borderless, rounded WPF window with user-controlled z-order and drag-to-move;
- shared dark translucent chrome, compact icon actions, semantic row tones, hover states, opacity controls, and persisted layer/position preferences;
- explicit presence policies: `always` keeps the overlay visible, `terminal-group` shows it when Windows Terminal or any Narada overlay is foreground, and `hidden` keeps it hidden; the legacy `windows-terminal` spelling is accepted only at ingress and is normalized immediately. Each overlay can inherit the shared surface default or persist an override;
- refreshable JSON document rendering with semantic tones, ochre accent titles/actions, and validated clickable HTTP(S) row values;
- controlled actions: open an HTTP(S) URL, request refresh, close, or invoke an explicitly supplied local restart command. Actions may provide a presentation-only `icon` and `tooltip`; execution semantics remain defined by `kind`.

## Tiling

The header tile action replaces itself in place with a five-button cross. While the cross is open, the neighboring Presence and Layer actions retain their header slots but remain hidden until the cross collapses. The five cross buttons are intentionally compact (14x14 at 10pt) inside a 48px footprint with 16px cells, leaving only a 2px visual gap. The center button is intentionally unlabeled; its accent border is the affordance, and it means `Automatic (preserve current arrangement)`. The four arrow buttons mean `right`, `left`, `below`, and `above`, choosing the side on which the sibling grid grows. The clicked overlay remains the stable anchor and never moves. The explicit side is authoritative for that operation: if it cannot fit, tiling returns `no_fit` and emits no commands. The automatic choice preserves the existing side when possible and otherwise uses the deterministic fallback rules below. It enumerates other visible overlays on the shared surface, orders them deterministically by distance and id, and emits one short-lived `narada.window_surface_overlay.tile_command.v1` command per sibling. Each sibling consumes its command once, persists a `free` position, and removes the command; refresh and host restart therefore restore the tiled positions.

For one sibling, aligned sides are preserved when possible. Otherwise an overlap is resolved below or above according to the sibling's relative top edge; diagonal lower-left and lower-right siblings prefer right and left placement respectively, then fall back through right, left, below, and above. Larger sets use a deterministic compact grid while preserving the anchor. Native window bounds are normalized with the active monitor DPI and work area. If all native-sized siblings cannot fit without overlap, tiling returns `no_fit` and emits no position commands rather than clamping windows into one another. Tiling does not change presence, layer, focus, or document state.

It does not own provider/quota logic, operator-console authority, site discovery, or arbitrary command execution. A specialization supplies a versioned document and may explicitly supply one fixed restart command for a typed `restart` action; the overlay never accepts a command from the document itself.

The default state root is %LOCALAPPDATA%/Narada/window-surface-overlays. Set NARADA_WINDOW_SURFACE_OVERLAY_STATE_ROOT only for a deliberate test or isolated installation. A typed `restart` action uses the fixed command supplied by the owning specialization and never accepts executable details from the document.

On Windows, the Node boundary restores the lowercase `windir` environment alias from `SystemRoot`, derives `LOCALAPPDATA` from the user profile, and restores executable extensions in `PATHEXT` when an MCP carrier omits them. This keeps PowerShell/WPF startup deterministic for headless-stdio MCP launchers without requiring a carrier restart.

Position preferences are resolved against the work area of the monitor under the launch cursor, with the current monitor DPI applied before WPF coordinates are hydrated. Legacy `left`/`top` preferences are converted to the nearest corner on first hydration, and resolved positions are clamped into the visible work area. Drag completion persists the anchor immediately, so a forced host restart cannot discard the moved position.
