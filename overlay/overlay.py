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

import faulthandler
faulthandler.enable()

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

IS_MACOS = platform.system() == "Darwin"

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
    ("100%", 1.00),
    ("96%", 0.96),
    ("90%", 0.90),
    ("85%", 0.85),
    ("80%", 0.80),
    ("75%", 0.75),
    ("70%", 0.70),
    ("60%", 0.60),
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
    import io

    # macOS: use AppKit's native SVG rendering
    if IS_MACOS:
        try:
            import AppKit
            import Foundation
            svg_data = Foundation.NSData.dataWithContentsOfFile_(str(ICON_PATH))
            if svg_data:
                ns_image = AppKit.NSImage.alloc().initWithData_(svg_data)
                if ns_image:
                    # Render to 64x64 PNG via NSBitmapImageRep
                    ns_image.setSize_(Foundation.NSMakeSize(64, 64))
                    tiff_data = ns_image.TIFFRepresentation()
                    bitmap = AppKit.NSBitmapImageRep.imageRepWithData_(tiff_data)
                    png_data = bitmap.representationUsingType_properties_(
                        AppKit.NSBitmapImageFileTypePNG, None
                    )
                    return Image.open(io.BytesIO(png_data.bytes()))
        except Exception as e:
            print(f"[overlay] AppKit SVG load failed: {e}", file=sys.stderr, flush=True)

    # Linux/fallback: use cairosvg
    try:
        import cairosvg
        png_data = cairosvg.svg2png(url=str(ICON_PATH), output_width=64, output_height=64)
        return Image.open(io.BytesIO(png_data))
    except Exception:
        pass

    # Last resort: white square
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

        if IS_MACOS:
            self._start_macos()
        else:
            self._start_linux()

    def _create_webview_window(self):
        """Create the webview window (call before starting the event loop)."""
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
        self.window.events.loaded += self._on_window_loaded

    def _start_macos(self):
        """macOS startup: tray + webview share the main thread's Cocoa event loop."""
        import AppKit
        import Foundation

        # Hide from Dock — LSUIElement in the .app bundle's Info.plist handles
        # this natively, but set it programmatically too as a fallback for
        # running outside the app bundle (e.g., during development).
        try:
            app = AppKit.NSApplication.sharedApplication()
            app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
            print("[overlay] set activation policy to Accessory (no dock icon)", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[overlay] could not hide dock icon: {e}", file=sys.stderr, flush=True)

        # Inject NSMicrophoneUsageDescription into runtime Info.plist
        try:
            bundle = AppKit.NSBundle.mainBundle()
            info = bundle.localizedInfoDictionary() or bundle.infoDictionary()
            if info is not None:
                info['NSMicrophoneUsageDescription'] = (
                    'Voice multiplexer requires microphone access for WebRTC audio.'
                )
                print("[overlay] injected NSMicrophoneUsageDescription", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[overlay] mic usage description injection failed: {e}", file=sys.stderr, flush=True)

        # Patch pywebview's BrowserDelegate to auto-grant media capture permissions
        self._patch_wkwebview_media_permissions()

        # pywebview's cocoa.py sets ActivationPolicyRegular (dock icon) at import
        # time (line 59). Override it AFTER import to hide from dock.
        try:
            app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
            print("[overlay] re-set activation policy after pywebview import", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[overlay] re-set activation policy failed: {e}", file=sys.stderr, flush=True)

        # Start hotkey listener (daemon thread)
        self._start_hotkeys()

        # Create tray icon on the main thread (required by Cocoa),
        # then run_detached so it doesn't start its own event loop.
        self._setup_tray()
        self.tray.run_detached()

        # Create webview window and start the Cocoa event loop
        # (pywebview drives NSApp.run(), which also processes tray events)
        self._create_webview_window()

        # Re-apply Accessory policy right before starting the event loop,
        # in case pywebview's window creation resets it again.
        try:
            app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)
        except Exception:
            pass

        storage_dir = str(CONFIG_DIR / "webdata")
        webview.start(debug=False, private_mode=False, storage_path=storage_dir)

    def _start_linux(self):
        """Linux startup: tray in daemon thread, webview on main thread."""
        # Start tray in a daemon thread
        tray_thread = threading.Thread(target=self._run_tray, daemon=True)
        tray_thread.start()

        # Start hotkey listener
        self._start_hotkeys()

        # Create webview window on main thread (required by GTK backends)
        self._create_webview_window()
        storage_dir = str(CONFIG_DIR / "webdata")
        webview.start(debug=False, private_mode=False, storage_path=storage_dir)

    def _on_window_loaded(self):
        """Called when the webview finishes loading."""
        print("[overlay] window loaded event fired", file=sys.stderr, flush=True)
        self._apply_window_setup()
        self._grant_media_permissions()
        # Apply initial opacity
        opacity = self.config.get("opacity", 0.96)
        if opacity < 1.0:
            self._apply_opacity(opacity)

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

    # -- Media permissions -----------------------------------------------------

    def _grant_media_permissions(self):
        """Auto-grant microphone/camera permissions."""
        if IS_MACOS:
            self._grant_media_permissions_macos()
        else:
            self._grant_media_permissions_linux()

    @staticmethod
    def _patch_wkwebview_media_permissions():
        """Monkey-patch pywebview's BrowserDelegate to auto-grant media capture.

        Must be called BEFORE webview.start() / window creation.
        """
        try:
            import objc
            from webview.platforms.cocoa import BrowserView

            # Add requestMediaCapturePermissionFor delegate method
            def _media_capture_handler(self, webview, origin, frame, capture_type, handler):
                # WKPermissionDecision.grant = 1
                handler(1)
                print("[overlay] auto-granted media capture permission", file=sys.stderr, flush=True)

            objc.classAddMethod(
                BrowserView.BrowserDelegate,
                b'webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:',
                objc.selector(
                    _media_capture_handler,
                    selector=b'webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:',
                    signature=b'v@:@@@q@?',
                ),
            )
            print("[overlay] patched BrowserDelegate for media capture", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[overlay] media delegate patch failed: {e}", file=sys.stderr, flush=True)

    def _grant_media_permissions_macos(self):
        """Enable media devices on the WKWebView instance (post-creation)."""
        try:
            from webview.platforms.cocoa import BrowserView

            bv = BrowserView.instances.get(self.window.uid)
            if not bv or not hasattr(bv, 'webview'):
                print("[overlay] could not access WKWebView for permissions", file=sys.stderr, flush=True)
                return

            # Set private WKPreferences to enable media devices on HTTP
            prefs = bv.webview.configuration().preferences()
            prefs._setMediaDevicesEnabled_(True)
            prefs._setMediaCaptureRequiresSecureConnection_(False)
            print("[overlay] enabled WKWebView media devices (HTTP allowed)", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[overlay] WKWebView media preferences failed: {e}", file=sys.stderr, flush=True)

    def _grant_media_permissions_linux(self):
        """Auto-grant microphone/camera permissions for webkit2gtk on Linux."""
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
            self._apply_opacity(val)

    def _apply_opacity(self, val: float):
        """Apply opacity to the window using platform-appropriate API."""
        if IS_MACOS:
            try:
                # pywebview cocoa backend sets window.native = NSWindow
                ns_window = getattr(self.window, 'native', None)
                if ns_window and hasattr(ns_window, 'setAlphaValue_'):
                    ns_window.setAlphaValue_(val)
                    print(f"[overlay] set NSWindow alpha to {val}", file=sys.stderr, flush=True)
                    return
                # Fallback: CSS opacity
                self.window.evaluate_js(f"document.body.style.opacity = '{val}'")
            except Exception as e:
                print(f"[overlay] macOS opacity failed: {e}", file=sys.stderr, flush=True)
        else:
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

    def _apply_shortcut_change(self):
        """Apply a shortcut config change. Restarts hotkeys and updates tray."""
        if IS_MACOS:
            from PyObjCTools import AppHelper

            def _do_apply():
                try:
                    self._start_hotkeys_macos()
                except Exception as e:
                    print(f"[overlay] hotkey restart failed: {e}", file=sys.stderr, flush=True)
                try:
                    if self.tray:
                        self.tray.menu = self._build_menu()
                except Exception as e:
                    print(f"[overlay] tray menu update failed: {e}", file=sys.stderr, flush=True)

            AppHelper.callAfter(_do_apply)
        else:
            self._start_hotkeys()
            self._update_tray_menu()

    # -- Hotkeys -------------------------------------------------------------

    def _start_hotkeys(self):
        """Start the global hotkey listener."""
        if IS_MACOS:
            self._start_hotkeys_macos()
        else:
            self._start_hotkeys_linux()

    def _start_hotkeys_macos(self):
        """macOS: use Carbon RegisterEventHotKey via QuickMacHotKey.

        This does NOT require Accessibility permissions (unlike NSEvent monitors
        or CGEventTap). It uses the Carbon Event Manager which integrates with
        the NSApp run loop that pywebview drives.
        """
        # Unregister existing hotkeys
        for handler in getattr(self, '_hotkey_handlers', []):
            try:
                handler.unregister()
            except Exception:
                pass
        self._hotkey_handlers = []

        from quickmachotkey import quickHotKey, mask

        toggle_win = self.config.get("shortcut_toggle_window", "<ctrl>+<shift>+v")
        toggle_mic = self.config.get("shortcut_toggle_mic", "<ctrl>+<shift>+m")

        if toggle_win:
            parsed = self._parse_shortcut_carbon(toggle_win)
            if parsed:
                keycode, mod_mask = parsed
                overlay = self  # closure ref

                @quickHotKey(virtualKey=keycode, modifierMask=mod_mask)
                def _toggle_win():
                    threading.Thread(target=overlay.toggle_window, daemon=True).start()

                self._hotkey_handlers.append(_toggle_win)
                print(f"[overlay] registered toggle-window: {toggle_win}", file=sys.stderr, flush=True)

        if toggle_mic:
            parsed = self._parse_shortcut_carbon(toggle_mic)
            if parsed:
                keycode, mod_mask = parsed
                overlay = self

                @quickHotKey(virtualKey=keycode, modifierMask=mod_mask)
                def _toggle_mic():
                    threading.Thread(target=overlay.toggle_mic, daemon=True).start()

                self._hotkey_handlers.append(_toggle_mic)
                print(f"[overlay] registered toggle-mic: {toggle_mic}", file=sys.stderr, flush=True)

    @staticmethod
    def _parse_shortcut_carbon(pynput_str: str):
        """Convert pynput-format shortcut to (keyCode, carbonModifierMask) tuple.

        Returns (keyCode, mask) for use with QuickMacHotKey/Carbon RegisterEventHotKey.
        """
        from quickmachotkey.constants import controlKey, shiftKey, optionKey, cmdKey

        # Virtual key codes (same as kVK_* constants)
        KEY_CODES = {
            'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5,
            'h': 4, 'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45,
            'o': 31, 'p': 35, 'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32,
            'v': 9, 'w': 13, 'x': 7, 'y': 16, 'z': 6,
            '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
            '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
            'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96,
            'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109,
            'f11': 103, 'f12': 111,
            'space': 49, 'tab': 48, 'return': 36, 'escape': 53,
            'delete': 51, 'backspace': 51,
            '[': 33, ']': 30, '\\': 42, ';': 41, "'": 39,
            ',': 43, '.': 47, '/': 44, '`': 50, '-': 27, '=': 24,
        }

        MODIFIER_MAP = {
            '<ctrl>': controlKey,
            '<shift>': shiftKey,
            '<alt>': optionKey,
            '<cmd>': cmdKey,
        }

        parts = pynput_str.split("+")
        mod_mask = 0
        keycode = None

        for p in parts:
            p = p.strip().lower()
            if p in MODIFIER_MAP:
                mod_mask |= MODIFIER_MAP[p]
            elif p in KEY_CODES:
                keycode = KEY_CODES[p]
            else:
                print(f"[overlay] unknown key in shortcut: {p}", file=sys.stderr, flush=True)
                return None

        if keycode is None:
            return None
        return (keycode, mod_mask)

    def _start_hotkeys_linux(self):
        """Linux: use pynput GlobalHotKeys."""
        if self.hotkey_listener:
            try:
                self.hotkey_listener.stop()
            except Exception:
                pass

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
        """Open a key capture overlay inside the main webview window.

        Args:
            name: 'shortcut_toggle_window' or 'shortcut_toggle_mic'
        """
        if not self.window:
            return

        # Show window if hidden so user can see the capture dialog
        if not self.visible:
            with self._lock:
                self._show_window()

        # Temporarily unregister existing hotkeys so they don't fire during capture
        if IS_MACOS:
            for handler in getattr(self, '_hotkey_handlers', []):
                try:
                    handler.unregister()
                except Exception:
                    pass
            print("[overlay] hotkeys suspended for capture", file=sys.stderr, flush=True)

        # Inject a key capture overlay into the existing webview
        # The overlay reports results via document.title changes that we poll
        capture_js = r"""
        (function() {
            if (document.getElementById('vmux-capture-overlay')) return;
            var overlay = document.createElement('div');
            overlay.id = 'vmux-capture-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;color:#e0e0e0;';
            overlay.innerHTML = '<h3 style="margin:0 0 16px;font-size:16px;color:#fff">Press your key combination</h3>' +
                '<div id="vmux-combo" style="font-size:22px;font-weight:bold;color:#7ecfff;min-height:32px;margin:12px 0">Waiting...</div>' +
                '<p style="font-size:12px;color:#888;margin-top:12px">Hold modifier keys and press a regular key</p>' +
                '<div style="margin-top:20px;display:flex;gap:12px">' +
                '<button id="vmux-confirm" style="padding:8px 20px;border:1px solid #4a8a4a;border-radius:6px;background:#2d5a2d;color:#ddd;cursor:pointer;font-size:14px">Confirm</button>' +
                '<button id="vmux-cancel" style="padding:8px 20px;border:1px solid #444;border-radius:6px;background:#2a2a3e;color:#ddd;cursor:pointer;font-size:14px">Cancel</button>' +
                '</div>';
            document.body.appendChild(overlay);

            var currentKeys = new Set();
            var lastCombo = '';
            var bestDisplay = '';

            function keyName(e) {
                var modifiers = ['Control', 'Shift', 'Alt', 'Meta'];
                if (modifiers.indexOf(e.key) >= 0) return e.key;
                // Map e.code first (reliable, not affected by modifiers)
                var codeMap = {
                    'Space': 'space', 'Tab': 'tab', 'Enter': 'return',
                    'Escape': 'escape', 'Backspace': 'backspace', 'Delete': 'delete',
                    'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
                };
                if (e.code && codeMap[e.code]) return codeMap[e.code];
                // Function keys (F1-F12)
                if (e.code && e.code.match(/^F\d+$/)) return e.code.toLowerCase();
                // Letter keys
                if (e.code && e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
                // Digit keys
                if (e.code && e.code.startsWith('Digit')) return e.code.slice(5);
                // Punctuation and others — use e.key as fallback
                return e.key;
            }

            function toPynput(keys) {
                var map = {'Control':'<ctrl>','Shift':'<shift>','Alt':'<alt>','Meta':'<cmd>'};
                var mods = [], regular = [];
                keys.forEach(function(k) { if (map[k]) mods.push(map[k]); else regular.push(k.toLowerCase()); });
                return mods.concat(regular).join('+');
            }

            function onKeyDown(e) {
                e.preventDefault(); e.stopPropagation();
                var name = keyName(e);
                console.log('[capture] keydown:', e.key, e.code, '->', name);
                currentKeys.add(name);
                var display = Array.from(currentKeys).join(' + ');
                var combo = toPynput(currentKeys);
                // Keep the best combo (most keys held simultaneously)
                if (currentKeys.size > bestDisplay.split(' + ').filter(Boolean).length || !bestDisplay) {
                    bestDisplay = display;
                    lastCombo = combo;
                }
                document.getElementById('vmux-combo').textContent = bestDisplay + ' [' + lastCombo + ']';
            }
            function onKeyUp(e) {
                // Remove released key from current set but keep bestDisplay/lastCombo
                currentKeys.delete(keyName(e));
                // When all keys released, reset for next attempt
                if (currentKeys.size === 0) {
                    // Don't clear bestDisplay/lastCombo — user needs to click confirm
                }
            }

            // Use capture phase to intercept before WKWebView defaults
            document.addEventListener('keydown', onKeyDown, true);
            document.addEventListener('keyup', onKeyUp, true);
            // Also prevent default on the overlay itself to stop scrolling
            overlay.addEventListener('keydown', function(e) { e.preventDefault(); }, true);

            function cleanup() {
                document.removeEventListener('keydown', onKeyDown, true);
                document.removeEventListener('keyup', onKeyUp, true);
                overlay.remove();
            }

            document.getElementById('vmux-confirm').onclick = function() {
                if (lastCombo) document.title = 'VMUX_SHORTCUT:' + lastCombo;
                else document.title = 'VMUX_SHORTCUT_CANCEL';
                cleanup();
            };
            document.getElementById('vmux-cancel').onclick = function() {
                document.title = 'VMUX_SHORTCUT_CANCEL';
                cleanup();
            };
        })();
        """
        self.window.evaluate_js(capture_js)

        # Poll for result via document.title
        def _poll():
            try:
                for _ in range(120):  # 60 seconds
                    time.sleep(0.5)
                    try:
                        if not self.window:
                            return
                        title = self.window.evaluate_js("document.title")
                        if not title:
                            continue
                        if title.startswith("VMUX_SHORTCUT:"):
                            combo = title.replace("VMUX_SHORTCUT:", "")
                            print(f"[overlay] captured shortcut: {combo}", file=sys.stderr, flush=True)
                            # Validate: must have at least one non-modifier key
                            parts = combo.split("+")
                            modifiers = {"<ctrl>", "<shift>", "<alt>", "<cmd>"}
                            has_regular = any(p.strip() not in modifiers for p in parts if p.strip())
                            if not has_regular:
                                print(f"[overlay] invalid shortcut (modifiers only): {combo}", file=sys.stderr, flush=True)
                                try:
                                    self.window.evaluate_js("document.title = 'vmux-overlay'")
                                except Exception:
                                    pass
                                # Re-register existing hotkeys
                                self._apply_shortcut_change()
                                return
                            self.config[name] = combo
                            save_config(self.config)
                            # Apply changes on the main thread to avoid Cocoa crashes
                            self._apply_shortcut_change()
                            try:
                                self.window.evaluate_js("document.title = 'vmux-overlay'")
                            except Exception:
                                pass
                            return
                        elif title == "VMUX_SHORTCUT_CANCEL":
                            try:
                                self.window.evaluate_js("document.title = 'vmux-overlay'")
                            except Exception:
                                pass
                            # Re-register existing hotkeys
                            self._apply_shortcut_change()
                            return
                    except Exception as e:
                        print(f"[overlay] poll error: {e}", file=sys.stderr, flush=True)
                        continue
            except Exception as e:
                print(f"[overlay] _poll crashed: {e}", file=sys.stderr, flush=True)
            # Timeout — clean up and re-register hotkeys
            try:
                if self.window:
                    self.window.evaluate_js("var el = document.getElementById('vmux-capture-overlay'); if(el) el.remove(); document.title = 'vmux-overlay';")
            except Exception:
                pass
            self._apply_shortcut_change()

        threading.Thread(target=_poll, daemon=True).start()

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

    def _setup_tray(self):
        """Create the tray icon (does not start an event loop)."""
        icon_image = load_tray_icon()
        self.tray = pystray.Icon(
            name="vmux-overlay",
            icon=icon_image,
            title="vmux-overlay",
            menu=self._build_menu(),
        )

    def _run_tray(self):
        """Run the system tray icon (called in a daemon thread on Linux)."""
        self._setup_tray()
        self.tray.run()

    def _update_tray_menu(self):
        """Rebuild the tray menu (e.g. after shortcut rebinding).

        On macOS, NSStatusBar operations must happen on the main thread.
        """
        if not self.tray:
            return
        if IS_MACOS:
            try:
                from PyObjCTools import AppHelper
                def _do_update():
                    try:
                        self.tray.menu = self._build_menu()
                        self.tray.update_menu()
                    except Exception as e:
                        print(f"[overlay] tray menu update error: {e}", file=sys.stderr, flush=True)
                AppHelper.callAfter(_do_update)
            except Exception as e:
                print(f"[overlay] could not schedule tray update: {e}", file=sys.stderr, flush=True)
        else:
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
