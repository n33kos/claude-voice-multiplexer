# vmux-overlay — Implementation Plan

A lightweight cross-platform system tray overlay that wraps the existing
Voice Multiplexer web app in a native window with keyboard shortcuts,
screen/position settings, and direct mic control from the desktop.

---

## Architecture

```
vmuxd (daemon, always running)
  └── relay-server, whisper, kokoro, livekit

vmux-overlay (new process, starts on login)
  ├── pystray — system tray icon + click menu
  ├── pynput  — global keyboard shortcut capture
  └── pywebview — native frameless window loading localhost:3100
        └── evaluate_js() → dispatches vmux:command events in the web app
```

The overlay process is **separate from vmuxd**. It manages only the window
and hotkeys — it does not start or stop any services.

---

## Installation

The overlay is **not installed by default** with the main plugin.

Install via the `vmux` CLI:

```bash
vmux install-overlay    # install deps, register startup item, generate config
vmux uninstall-overlay  # remove startup item, clean up
```

This adds a `vmux install-overlay` subcommand to the existing `vmux` CLI script.
Internally it:

1. Installs Python deps into a dedicated `overlay/.venv` (via uv)
2. Generates the monochrome tray icon (white-only version of the existing SVG)
3. Writes default `overlay.json` to `~/.claude/voice-multiplexer/overlay.json`
4. Registers the startup item:
   - macOS: `~/Library/LaunchAgents/com.vmux.overlay.plist`
   - Linux: `~/.config/systemd/user/vmux-overlay.service`
5. Starts the overlay process

No changes to `scripts/install.sh` — the overlay install is entirely separate.

---

## New Files

```
overlay/
  overlay.py          # main entry point
  pyproject.toml      # uv-managed deps: pystray, pynput, pywebview, screeninfo
  icon.svg            # monochrome (white) version of the existing app icon
```

Config file (generated on install, not in repo):
```
~/.claude/voice-multiplexer/overlay.json
```

Web app change (small):
```
web/src/main.tsx                      # expose window.vmuxCommand() dispatcher
web/src/components/.../MicControls.tsx # listen for vmux:command event
```

---

## overlay.json (default config)

Stored at `~/.claude/voice-multiplexer/overlay.json`.

```json
{
  "relay_url": "http://localhost:3100",
  "position": "right",
  "screen": 0,
  "width": 420,
  "opacity": 0.96,
  "always_on_top": true,
  "shortcut_toggle_window": "ctrl+shift+v",
  "shortcut_toggle_mic": "ctrl+shift+m"
}
```

All fields user-editable. Changed at runtime via tray menu (writes back to
`overlay.json` and applies immediately without restart).

---

## Tray Icon

Monochrome white version of the existing app icon SVG (colors stripped,
fills set to `#FFFFFF`). Works on both dark and light system themes.

### Click Behavior

**All clicks (left or right) open the same context menu.** No distinction
between click types — avoids platform inconsistencies (some Linux DEs
treat left and right click identically on tray icons).

### Context Menu

```
[ Show / Hide ]          ← toggles window visibility
─────────────────
  Position ▶
    ● Right edge         ← checked = current
      Left edge
      Center
─────────────────
  Screen ▶
    ● Screen 1 (primary) ← dynamically listed via screeninfo
      Screen 2
      Screen 3
─────────────────
  Opacity ▶
    ● 96%                ← checked = current
      80%
      60%
      40%
─────────────────
  Shortcuts ▶
    Toggle window: Ctrl+Shift+V  [click to rebind]
    Toggle mic:    Ctrl+Shift+M  [click to rebind]
─────────────────
  Restart overlay
  Quit
```

### Shortcut Rebinding

Clicking a shortcut entry opens a small capture dialog (a tiny pywebview
window or native dialog):

1. Dialog shows "Press your key combination..."
2. User presses keys (e.g., `Ctrl+F12` or a special media key)
3. pynput captures the combo and displays it
4. User confirms → saved to overlay.json, hotkey listener restarted
5. Cancel → no change

This allows binding to exotic keys (media keys, extra macro keys, etc.)
without needing to know their names.

---

## Window Behavior

### Positioning

The window is a **frameless, always-on-top** webview pinned to an edge:

| Position | X | Y | W | H |
|----------|---|---|---|---|
| Right    | screen.right - width | screen.top | width | screen.height |
| Left     | screen.left | screen.top | width | screen.height |
| Center   | screen.center_x - width/2 | screen.top | width | screen.height |

Screen geometry comes from `screeninfo.get_monitors()`.

### Visibility Toggle

- When shown: window appears at target position, opacity fades in via
  CSS transition on `body` (triggered by `evaluate_js`)
- When hidden: opacity fades out → window hidden (not destroyed)
- Window is **never destroyed** during the session — just shown/hidden to
  avoid LiveKit reconnect cost

### Default State

On launch: window is created but hidden. First show action reveals it.

---

## Keyboard Shortcuts

Captured globally via pynput `GlobalHotKeys`.

| Action | Default | Behavior |
|--------|---------|----------|
| Toggle window | `ctrl+shift+v` | Show or hide the overlay |
| Toggle mic | `ctrl+shift+m` | Dispatch `vmux:command { type: 'toggle-mic' }` via evaluate_js |

Shortcuts are independently configurable — users can bind both to the
same key if they want mic toggle to also show the window, or keep them
separate.

### Push-to-Talk (Phase 2)

Push-to-talk requires listening on key *down* and key *up* separately,
which pynput supports via `Listener`. Phase 1 ships toggle only.

---

## Web App — Command Event System

A single extensible event for overlay-to-web communication.

**`web/src/main.tsx`** — add after `ReactDOM.createRoot(...)`:

```ts
// Extensible command hook for the vmux-overlay native wrapper.
// pywebview's evaluate_js() calls this; the web app dispatches internally.
(window as any).vmuxCommand = (type: string, data?: any) => {
  document.dispatchEvent(
    new CustomEvent('vmux:command', { detail: { type, data } })
  );
};
```

**`web/src/components/VoiceControls/components/MicControls/MicControls.tsx`** —
listen for the command event:

```ts
useEffect(() => {
  const handler = (e: CustomEvent) => {
    if (e.detail?.type === 'toggle-mic') toggleMic();
  };
  document.addEventListener('vmux:command', handler as EventListener);
  return () => document.removeEventListener('vmux:command', handler as EventListener);
}, [toggleMic]);
```

From the Python side, sending a command is:
```python
window.evaluate_js("window.vmuxCommand('toggle-mic')")
```

Adding new commands later (e.g., `toggle-speaker`, `set-session`) just
means adding a new `if` branch in the listener — no protocol changes.

---

## overlay.py — High-Level Structure

```python
class VmuxOverlay:
    config: OverlayConfig         # loaded from overlay.json
    window: webview.Window        # pywebview window (main thread)
    tray: pystray.Icon            # system tray icon (own thread)
    hotkeys: GlobalHotKeys        # pynput listener (daemon thread)

    def start():                  # create window, tray, hotkeys; run event loop
    def toggle_window():          # show/hide + animate opacity
    def toggle_mic():             # evaluate_js("window.vmuxCommand('toggle-mic')")
    def set_position(pos):        # reposition window, save config
    def set_screen(idx):          # move to screen, save config
    def set_opacity(val):         # set window opacity, save config
    def rebind_shortcut(name):    # open capture dialog, save to config, restart hotkeys
    def restart():                # teardown + re-exec self
    def quit():                   # cleanup + sys.exit
```

Threading model:
- **Main thread**: pywebview event loop (required by most GUI backends)
- **Thread 2**: pystray icon + menu
- **Thread 3**: pynput hotkey listener (daemon thread, auto-dies on exit)

---

## Dependencies

```toml
# overlay/pyproject.toml
[project]
name = "vmux-overlay"
requires-python = ">=3.10"
dependencies = [
  "pystray>=0.19",
  "pynput>=1.7",
  "pywebview>=5.0",
  "screeninfo>=0.8",
]
```

---

## Known Constraints

| Platform | Issue | Mitigation |
|----------|-------|------------|
| Linux/Wayland | pynput global hotkeys blocked outside app window | Document; suggest XWayland fallback or `DISPLAY=:0` |
| Linux/GNOME | System tray requires `gnome-shell-extension-appindicator` | Auto-detect on startup and warn if missing |
| macOS Sequoia | Accessibility permission required for global hotkeys | Prompt user on first run |
| All (Linux) | pywebview requires webkit2gtk | Document in install-overlay; brew/system package |

---

## Phase 1 (build now)

- [ ] `vmux install-overlay` / `vmux uninstall-overlay` CLI commands
- [ ] Overlay process: tray icon, webview window, show/hide
- [ ] All-click context menu (position, screen, opacity, shortcuts, quit)
- [ ] Global keyboard shortcuts (toggle window, toggle mic)
- [ ] Shortcut rebinding via capture dialog
- [ ] Config persistence in `~/.claude/voice-multiplexer/overlay.json`
- [ ] Monochrome white tray icon from existing SVG
- [ ] Web app: extensible `vmux:command` event system
- [ ] Startup registration (launchd / systemd user service)

## Phase 2 (later)

- [ ] Slide-in / slide-out animation
- [ ] Push-to-talk (key down → record, key up → send)
- [ ] Additional commands (toggle-speaker, switch-session, etc.)
