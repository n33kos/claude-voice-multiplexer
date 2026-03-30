#!/usr/bin/env python3
"""Minimal test: can pywebview show a window at all?"""
import sys
import os

# Set GI typelib path
os.environ.setdefault('GI_TYPELIB_PATH', '/usr/lib64/girepository-1.0:/usr/lib/girepository-1.0')

import webview

print("Creating window...", file=sys.stderr, flush=True)
w = webview.create_window(
    title="vmux-test",
    url="http://localhost:3100?overlay=true",
    width=420,
    height=800,
)
print("Starting webview...", file=sys.stderr, flush=True)
webview.start(debug=True)
print("Done.", file=sys.stderr, flush=True)
