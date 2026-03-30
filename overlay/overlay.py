#!/usr/bin/env python3
"""vmux-overlay — system tray overlay for Claude Voice Multiplexer.

Provides a frameless always-on-top webview window pinned to a screen edge,
a system tray icon with configuration menu, and global keyboard shortcuts
for toggling the window and microphone.

Threading model:
  Main thread  — pywebview event loop (required by most GUI backends)
  Thread 2     — pystray icon + menu
  Thread 3     — pynput hotkey listener (daemon thread)
"""

from __future__ import annotations

import json
import os
import platform
import sys
import threading
import time
from dataclasses import dataclass, field, asdict
from functools import partial
from pathlib import Path
from typing import Optional

import subprocess
import webview
import pystray
from PIL import Image
from pynput import keyboard
from screeninfo import get_monitors

try:
    from gi.repository import GLib as _glib
except ImportError:
    _glib = None

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_DIR = Path.home() / ".claude" / "voice-multiplexer"
CONFIG_PATH = CONFIG_DIR / "overlay.json"
ICON_PATH = Path(__file__).parent / "icon.svg"

DEFAULT_POSITIONS = {
    "right": {
        "label": "Right edge",
        "anchor_x": "right",    # left, center, right
        "anchor_y": "top",      # top, center, bottom
        "width_pct": None,      # None = use fixed width
        "height_pct": 1.0,      # fraction of screen height
        "width_px": 420,        # fixed width in pixels (used when width_pct is None)
    },
    "left": {
        "label": "Left edge",
        "anchor_x": "left",
        "anchor_y": "top",
        "width_pct": None,
        "height_pct": 1.0,
        "width_px": 420,
    },
    "center": {
        "label": "Center",
        "anchor_x": "center",
        "anchor_y": "center",
        "width_pct": 0.40,
        "height_pct": 0.60,
        "width_px": None,
    },
}

DEFAULT_CONFIG = {
    "relay_url": "http://localhost:3100",
    "position": "right",
    "screen": 0,
    "opacity": 0.96,
    "always_on_top": True,
    "shortcut_toggle_window": "<ctrl>+<shift>+v",
    "shortcut_toggle_mic": "<ctrl>+<shift>+m",
    "positions": {},  # user overrides merged on top of DEFAULT_POSITIONS
}

# Map from human-readable labels to pynput format
OPACITY_OPTIONS = [
    ("96%", 0.96),
    ("80%", 0.80),
    ("60%", 0.60),
    ("40%", 0.40),
]


def load_config() -> dict:
    """Load overlay config, creating defaults if missing."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH) as f:
                cfg = json.load(f)
            # Merge with defaults for any missing keys
            for k, v in DEFAULT_CONFIG.items():
                cfg.setdefault(k, v)
            return cfg
        except (json.JSONDecodeError, OSError):
            pass
    save_config(dict(DEFAULT_CONFIG))
    return dict(DEFAULT_CONFIG)


def save_config(cfg: dict):
    """Persist config to disk."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


# ---------------------------------------------------------------------------
# Icon loading
# ---------------------------------------------------------------------------

def load_tray_icon() -> Image.Image:
    """Load the monochrome SVG icon as a PIL Image for pystray."""
    try:
        import cairosvg
        import io
        png_data = cairosvg.svg2png(url=str(ICON_PATH), output_width=64, output_height=64)
        return Image.open(io.BytesIO(png_data))
    except Exception:
        # Fallback: generate a simple white square icon
        img = Image.new("RGBA", (64, 64), (255, 255, 255, 200))
        return img


# ---------------------------------------------------------------------------
# Shortcut helpers
# ---------------------------------------------------------------------------

def format_shortcut_display(pynput_str: str) -> str:
    """Convert pynput-format shortcut to human-readable string.

    e.g. '<ctrl>+<shift>+v' -> 'Ctrl+Shift+V'
    """
    parts = pynput_str.split("+")
    result = []
    for p in parts:
        p = p.strip()
        if p.startswith("<") and p.endswith(">"):
            name = p[1:-1]
            result.append(name.capitalize())
        else:
            result.append(p.upper())
    return "+".join(result)


# ---------------------------------------------------------------------------
# Key capture dialog
# ---------------------------------------------------------------------------

CAPTURE_HTML = """<!DOCTYPE html>
<html>
<head>
<style>
  body {
    margin: 0; padding: 24px;
    background: #1a1a2e; color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: calc(100vh - 48px);
    user-select: none;
  }
  h3 { margin: 0 0 16px; font-size: 16px; color: #fff; }
  #combo { font-size: 22px; font-weight: bold; color: #7ecfff;
           min-height: 32px; margin: 12px 0; }
  .hint { font-size: 12px; color: #888; margin-top: 12px; }
  .buttons { margin-top: 20px; display: flex; gap: 12px; }
  button {
    padding: 8px 20px; border: 1px solid #444; border-radius: 6px;
    background: #2a2a3e; color: #ddd; cursor: pointer; font-size: 14px;
  }
  button:hover { background: #3a3a5e; }
  button.confirm { background: #2d5a2d; border-color: #4a8a4a; }
  button.confirm:hover { background: #3d6a3d; }
</style>
</head>
<body>
  <h3>Press your key combination</h3>
  <div id="combo">Waiting...</div>
  <p class="hint">Hold modifier keys and press a regular key</p>
  <div class="buttons">
    <button class="confirm" onclick="confirmBinding()">Confirm</button>
    <button onclick="cancelBinding()">Cancel</button>
  </div>
<script>
  let currentKeys = new Set();
  let lastCombo = '';

  function keyName(e) {
    const modifiers = ['Control', 'Shift', 'Alt', 'Meta'];
    if (modifiers.includes(e.key)) return e.key;
    if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    return e.key;
  }

  function toPynput(keys) {
    const map = {
      'Control': '<ctrl>', 'Shift': '<shift>',
      'Alt': '<alt>', 'Meta': '<cmd>',
    };
    let mods = [];
    let regular = [];
    keys.forEach(k => {
      if (map[k]) mods.push(map[k]);
      else regular.push(k.toLowerCase());
    });
    return [...mods, ...regular].join('+');
  }

  document.addEventListener('keydown', e => {
    e.preventDefault();
    currentKeys.add(keyName(e));
    const display = Array.from(currentKeys).join(' + ');
    document.getElementById('combo').textContent = display;
    lastCombo = toPynput(currentKeys);
  });

  document.addEventListener('keyup', e => {
    // Keep the display but clear the set after a short delay
    setTimeout(() => currentKeys.clear(), 200);
  });

  function confirmBinding() {
    if (lastCombo) {
      pywebview.api.on_shortcut_captured(lastCombo);
    }
  }

  function cancelBinding() {
    pywebview.api.on_shortcut_cancelled();
  }
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Main overlay class
# ---------------------------------------------------------------------------

class CaptureApi:
    """JS-to-Python bridge for the key capture dialog."""

    def __init__(self, overlay: "VmuxOverlay", shortcut_name: str):
        self.overlay = overlay
        self.shortcut_name = shortcut_name
        self.result: Optional[str] = None
        self.done = threading.Event()

    def on_shortcut_captured(self, combo: str):
        self.result = combo
        self.done.set()

    def on_shortcut_cancelled(self):
        self.result = None
        self.done.set()


class VmuxOverlay:
    """Main overlay application."""

    def __init__(self):
        self.config = load_config()
        self.window: Optional[webview.Window] = None
        self.tray: Optional[pystray.Icon] = None
        self.hotkey_listener: Optional[keyboard.GlobalHotKeys] = None
        self.visible = False
        self._lock = threading.Lock()
        self._capture_api: Optional[CaptureApi] = None

    # -- Startup -------------------------------------------------------------

    def start(self):
        """Entry point. Starts tray + hotkeys in threads, runs webview on main."""
        # Log monitor info (sorted left-to-right)
        monitors = self._get_monitors()
        for i, m in enumerate(monitors):
            primary = " (primary)" if getattr(m, 'is_primary', False) else ""
            print(f"[overlay] screen {i}: x={m.x} w={m.width}{primary}", file=sys.stderr, flush=True)
        print(f"[overlay] config: pos={self.config.get('position')}, screen={self.config.get('screen')}, width={self.config.get('width')}", file=sys.stderr, flush=True)

        # Start tray in a daemon thread
        tray_thread = threading.Thread(target=self._run_tray, daemon=True)
        tray_thread.start()

        # Start hotkey listener
        self._start_hotkeys()

        # Create the webview window on main thread (required by most backends)
        relay_url = self.config["relay_url"].rstrip("/")
        sep = "&" if "?" in relay_url else "?"
        overlay_url = f"{relay_url}{sep}overlay=true"
        self.window = webview.create_window(
            title="vmux-overlay",
            url=overlay_url,
            width=self._calc_geometry()[2],
            height=self._calc_geometry()[3],
            x=self._calc_geometry()[0],
            y=self._calc_geometry()[1],
            frameless=True,
            on_top=self.config.get("always_on_top", True),
            transparent=False,
            hidden=False,
        )
        self.visible = True

        # Apply opacity and permissions after window is ready
        self.window.events.loaded += self._on_window_loaded

        # Persistent cookies/storage and non-private mode
        storage_dir = str(CONFIG_DIR / "webdata")
        webview.start(debug=False, private_mode=False, storage_path=storage_dir)

    def _on_window_loaded(self):
        """Called when the webview finishes loading."""
        print("[overlay] window loaded event fired", file=sys.stderr, flush=True)
        self._apply_window_setup()
        self._grant_media_permissions()

    def _apply_window_setup(self):
        """Apply GTK window hints and initial position on Linux."""
        native = getattr(self.window, 'native', None)
        if native and _glib:
            def _setup():
                native.set_skip_taskbar_hint(True)
                native.set_skip_pager_hint(True)
            _glib.idle_add(_setup)
        # Reposition handles DOCK → move → NORMAL cycle
        self._reposition()

    # -- Media permissions (Linux/webkit2gtk) ----------------------------------

    def _grant_media_permissions(self):
        """Auto-grant microphone/camera permissions for webkit2gtk."""
        try:
            from webview.platforms.gtk import BrowserView
            import gi
            gi.require_version('WebKit2', '4.1')
            from gi.repository import WebKit2

            bv = BrowserView.instances.get(self.window.uid)
            if not bv or not hasattr(bv, 'webview'):
                print("[overlay] could not access native webview for permissions", file=sys.stderr, flush=True)
                return

            def on_permission_request(wv, request):
                if isinstance(request, (WebKit2.UserMediaPermissionRequest,
                                        WebKit2.DeviceInfoPermissionRequest)):
                    request.allow()
                    print(f"[overlay] granted permission: {type(request).__name__}", file=sys.stderr, flush=True)
                    return True
                return False

            bv.webview.connect('permission-request', on_permission_request)
            print("[overlay] media permission handler connected", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[overlay] media permissions setup failed: {e}", file=sys.stderr, flush=True)

    # -- Screen geometry -----------------------------------------------------

    def _get_monitors(self):
        try:
            monitors = get_monitors()
            # Sort left-to-right by X coordinate for consistent ordering
            monitors.sort(key=lambda m: (m.x, m.y))
            return monitors
        except Exception:
            return []

    def _current_screen(self):
        monitors = self._get_monitors()
        idx = self.config.get("screen", 0)
        if idx < len(monitors):
            return monitors[idx]
        if monitors:
            return monitors[0]
        # Fallback
        from types import SimpleNamespace
        return SimpleNamespace(x=0, y=0, width=1920, height=1080)

    def _get_position_preset(self) -> dict:
        """Get the active position preset, merging user overrides with defaults."""
        pos_name = self.config.get("position", "right")
        # Start with built-in defaults
        preset = dict(DEFAULT_POSITIONS.get(pos_name, DEFAULT_POSITIONS["right"]))
        # Merge any user overrides from config
        user_positions = self.config.get("positions", {})
        if pos_name in user_positions:
            preset.update(user_positions[pos_name])
        return preset

    def _calc_geometry(self) -> tuple:
        """Calculate (x, y, width, height) based on current screen and position preset."""
        scr = self._current_screen()
        preset = self._get_position_preset()

        # Calculate width
        if preset.get("width_pct"):
            w = int(scr.width * preset["width_pct"])
        else:
            w = preset.get("width_px", 420)

        # Calculate height
        h_pct = preset.get("height_pct", 1.0)
        h = int(scr.height * h_pct)

        # Calculate X based on anchor
        anchor_x = preset.get("anchor_x", "right")
        if anchor_x == "left":
            x = scr.x
        elif anchor_x == "center":
            x = scr.x + (scr.width - w) // 2
        else:  # right
            x = scr.x + scr.width - w

        # Calculate Y based on anchor
        anchor_y = preset.get("anchor_y", "top")
        if anchor_y == "top":
            y = scr.y
        elif anchor_y == "center":
            y = scr.y + (scr.height - h) // 2
        else:  # bottom
            y = scr.y + scr.height - h

        return (x, y, w, h)

    # -- Window toggle -------------------------------------------------------

    def toggle_window(self):
        """Show or hide the overlay window."""
        print(f"[overlay] toggle_window called, visible={self.visible}", file=sys.stderr, flush=True)
        if not self.window:
            return
        with self._lock:
            if self.visible:
                self._hide_window()
            else:
                self._show_window()
        self._update_tray_menu()

    def _show_window(self):
        if not self.window:
            return
        print("[overlay] _show_window", file=sys.stderr, flush=True)
        native = getattr(self.window, 'native', None)
        if native and _glib:
            x, y, w, h = self._calc_geometry()
            def _do_show():
                native.set_accept_focus(True)
                native.resize(w, h)
                native.move(x, y)
                native.set_opacity(self.config.get("opacity", 0.96))
                native.present()
            _glib.idle_add(_do_show)
        else:
            # macOS / other platforms — use pywebview API
            self.window.show()
        self.visible = True

    def _hide_window(self):
        if not self.window:
            return
        print("[overlay] _hide_window", file=sys.stderr, flush=True)
        self.visible = False
        native = getattr(self.window, 'native', None)
        if native and _glib:
            def _do_hide():
                native.set_opacity(0.0)
                native.set_accept_focus(False)
                # Resize to 1x1 to prevent invisible window from capturing input
                native.resize(1, 1)
            _glib.idle_add(_do_hide)
        else:
            # macOS / other platforms — use pywebview API
            self.window.hide()

    # -- Mic toggle ----------------------------------------------------------

    def toggle_mic(self):
        """Send toggle-mic command to the web app via evaluate_js."""
        if not self.window:
            return
        # Show window if hidden so user sees feedback
        if not self.visible:
            with self._lock:
                self._show_window()
        self.window.evaluate_js("window.vmuxCommand && window.vmuxCommand('toggle-mic')")

    # -- Position / Screen / Opacity -----------------------------------------

    def set_position(self, pos: str):
        """Change window position and save config."""
        print(f"[overlay] set_position({pos})", file=sys.stderr, flush=True)
        self.config["position"] = pos
        save_config(self.config)
        self._reposition()

    def set_screen(self, idx: int):
        """Move window to a different screen."""
        self.config["screen"] = idx
        save_config(self.config)
        self._reposition()

    def set_opacity(self, val: float):
        """Set window opacity and save config."""
        print(f"[overlay] set_opacity({val})", file=sys.stderr, flush=True)
        self.config["opacity"] = val
        save_config(self.config)
        if self.window and self.visible:
            native = getattr(self.window, 'native', None)
            if native and _glib:
                _glib.idle_add(native.set_opacity, val)

    def _reposition(self):
        """Move and resize the window to match current config.

        On Linux/XWayland, uses DOCK type hint temporarily to bypass Mutter's
        snap behavior, then switches back to NORMAL for proper interaction.
        """
        if not self.window:
            return
        scr = self._current_screen()
        x, y, w, h = self._calc_geometry()
        print(f"[overlay] reposition: screen={self.config.get('screen')} scr.x={scr.x} pos={self.config.get('position')} → ({x},{y}) {w}x{h}", file=sys.stderr, flush=True)

        native = getattr(self.window, 'native', None)
        if native and _glib:
            try:
                import gi
                gi.require_version('Gdk', '3.0')
                from gi.repository import Gdk

                def _do_reposition():
                    # Set DOCK to bypass Mutter snapping
                    native.set_type_hint(Gdk.WindowTypeHint.DOCK)
                    native.resize(w, h)
                    native.move(x, y)
                    # Restore NORMAL after a short delay for interaction
                    def _restore():
                        native.set_type_hint(Gdk.WindowTypeHint.NORMAL)
                        native.set_skip_taskbar_hint(True)
                        native.set_skip_pager_hint(True)
                        return False
                    _glib.timeout_add(150, _restore)

                _glib.idle_add(_do_reposition)
            except Exception as e:
                print(f"[overlay] GTK reposition failed: {e}", file=sys.stderr, flush=True)
                self.window.move(x, y)
                self.window.resize(w, h)
        else:
            # macOS / other platforms
            self.window.move(x, y)
            self.window.resize(w, h)

    # -- Hotkeys -------------------------------------------------------------

    def _start_hotkeys(self):
        """Start the global hotkey listener."""
        if self.hotkey_listener:
            self.hotkey_listener.stop()

        bindings = {}
        toggle_win = self.config.get("shortcut_toggle_window", "<ctrl>+<shift>+v")
        toggle_mic = self.config.get("shortcut_toggle_mic", "<ctrl>+<shift>+m")

        if toggle_win:
            bindings[toggle_win] = self.toggle_window
        if toggle_mic:
            bindings[toggle_mic] = self.toggle_mic

        if bindings:
            try:
                self.hotkey_listener = keyboard.GlobalHotKeys(bindings)
                self.hotkey_listener.daemon = True
                self.hotkey_listener.start()
            except Exception as e:
                print(f"Warning: could not register global hotkeys: {e}", file=sys.stderr)

    # -- Shortcut rebinding --------------------------------------------------

    def rebind_shortcut(self, name: str):
        """Open a capture dialog to rebind a shortcut.

        Args:
            name: 'shortcut_toggle_window' or 'shortcut_toggle_mic'
        """
        api = CaptureApi(self, name)
        self._capture_api = api

        def _open_capture():
            capture_win = webview.create_window(
                title="Rebind Shortcut",
                html=CAPTURE_HTML,
                width=340,
                height=220,
                resizable=False,
                on_top=True,
                js_api=api,
            )

            # Wait for result in a thread
            def _wait():
                api.done.wait(timeout=60)
                if api.result:
                    self.config[name] = api.result
                    save_config(self.config)
                    self._start_hotkeys()
                try:
                    capture_win.destroy()
                except Exception:
                    pass
                # Rebuild tray menu to show updated shortcut
                self._update_tray_menu()

            t = threading.Thread(target=_wait, daemon=True)
            t.start()

        # Must create window from a thread-safe context
        # Use webview's built-in thread safety
        threading.Thread(target=_open_capture, daemon=True).start()

    # -- Tray icon -----------------------------------------------------------

    @staticmethod
    def _action(fn, *args):
        """Return a pystray-compatible callback (icon, item) that calls fn(*args).

        Runs the function in a daemon thread to avoid blocking the pystray
        callback (which would deadlock pywebview's evaluate_js semaphore).
        """
        def _cb(icon, item):
            threading.Thread(target=fn, args=args, daemon=True).start()
        return _cb

    def _build_menu(self) -> pystray.Menu:
        """Build the context menu for the tray icon."""
        monitors = self._get_monitors()

        # Position submenu — built-in + user-defined presets
        all_positions = dict(DEFAULT_POSITIONS)
        all_positions.update(self.config.get("positions", {}))
        pos_items = []
        for pos_name, preset in all_positions.items():
            label = preset.get("label", pos_name.replace("_", " ").title())
            pos_items.append(pystray.MenuItem(
                label,
                self._action(self.set_position, pos_name),
                checked=lambda item, p=pos_name: self.config.get("position") == p,
                radio=True,
            ))

        # Screen submenu
        screen_items = []
        for i, mon in enumerate(monitors):
            label = f"Screen {i + 1}"
            if hasattr(mon, "is_primary") and mon.is_primary:
                label += " (primary)"
            label += f" ({mon.width}x{mon.height})"
            screen_items.append(pystray.MenuItem(
                label,
                self._action(self.set_screen, i),
                checked=lambda item, idx=i: self.config.get("screen") == idx,
                radio=True,
            ))
        if not screen_items:
            screen_items.append(pystray.MenuItem("No screens detected", None, enabled=False))

        # Opacity submenu
        opacity_items = []
        for label, val in OPACITY_OPTIONS:
            opacity_items.append(pystray.MenuItem(
                label,
                self._action(self.set_opacity, val),
                checked=lambda item, v=val: abs(self.config.get("opacity", 0.96) - v) < 0.01,
                radio=True,
            ))

        # Shortcuts submenu
        tw_display = format_shortcut_display(self.config.get("shortcut_toggle_window", ""))
        tm_display = format_shortcut_display(self.config.get("shortcut_toggle_mic", ""))
        shortcut_items = [
            pystray.MenuItem(
                f"Toggle window: {tw_display}",
                self._action(self.rebind_shortcut, "shortcut_toggle_window"),
            ),
            pystray.MenuItem(
                f"Toggle mic: {tm_display}",
                self._action(self.rebind_shortcut, "shortcut_toggle_mic"),
            ),
        ]

        menu = pystray.Menu(
            pystray.MenuItem(
                lambda item: "Hide" if self.visible else "Show",
                self._action(self.toggle_window),
                default=True,
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Position", pystray.Menu(*pos_items)),
            pystray.MenuItem("Screen", pystray.Menu(*screen_items)),
            pystray.MenuItem("Opacity", pystray.Menu(*opacity_items)),
            pystray.MenuItem("Shortcuts", pystray.Menu(*shortcut_items)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Restart", self._action(self.restart)),
            pystray.MenuItem("Quit", self._action(self.quit)),
        )
        return menu

    def _run_tray(self):
        """Run the system tray icon (called in a daemon thread)."""
        icon_image = load_tray_icon()
        self.tray = pystray.Icon(
            name="vmux-overlay",
            icon=icon_image,
            title="vmux-overlay",
            menu=self._build_menu(),
        )

        # On Linux, pystray may need to be told to use AppIndicator
        self.tray.run()

    def _update_tray_menu(self):
        """Rebuild the tray menu (e.g. after shortcut rebinding)."""
        if self.tray:
            self.tray.menu = self._build_menu()
            self.tray.update_menu()

    # -- Restart / Quit ------------------------------------------------------

    def restart(self):
        """Restart the overlay process by re-executing self."""
        print("[overlay] restart() called", file=sys.stderr, flush=True)
        self._cleanup()
        os.execv(sys.executable, [sys.executable] + sys.argv)

    def quit(self):
        """Clean exit."""
        print("[overlay] quit() called", file=sys.stderr, flush=True)
        self._cleanup()
        os._exit(0)

    def _cleanup(self):
        """Tear down all subsystems."""
        if self.hotkey_listener:
            try:
                self.hotkey_listener.stop()
            except Exception:
                pass
        if self.tray:
            try:
                self.tray.stop()
            except Exception:
                pass
        if self.window:
            try:
                self.window.destroy()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    overlay = VmuxOverlay()
    overlay.start()


if __name__ == "__main__":
    main()
