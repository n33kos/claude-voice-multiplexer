import { useEffect, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalOverlay.module.scss";

interface TerminalOverlayProps {
  open: boolean;
  onClose: () => void;
  onSendKeys?: (keys: string) => void;
  onSendSpecialKey?: (key: string) => void;
  onStartStream?: () => void;
  onStopStream?: () => void;
  onSetTerminalDataCallback?: (cb: ((data: string) => void) | null) => void;
}

export function TerminalOverlay({
  open,
  onClose,
  onSendKeys,
  onSendSpecialKey,
  onStartStream,
  onStopStream,
  onSetTerminalDataCallback,
}: TerminalOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initialize xterm.js when the overlay opens
  useEffect(() => {
    if (!open || !containerRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "underline",
      fontSize: 12,
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace",
      theme: {
        background: "#0d1117",
        foreground: "#dcdcdc",
        cursor: "#22c55e",
        selectionBackground: "rgba(34, 197, 94, 0.3)",
        black: "#0d1117",
        red: "#f87171",
        green: "#22c55e",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#dcdcdc",
        brightBlack: "#6b7280",
        brightRed: "#fca5a5",
        brightGreen: "#4ade80",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f9fafb",
      },
      scrollback: 1000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);

    // Small delay to let the DOM settle before fitting
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors during mount race
      }
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Wire up user input to send keystrokes
    term.onData((data) => {
      // Map special sequences to special key names
      if (data === "\r") {
        onSendSpecialKey?.("Enter");
      } else if (data === "\x03") {
        onSendSpecialKey?.("C-c");
      } else if (data === "\x1b") {
        onSendSpecialKey?.("Escape");
      } else if (data === "\t") {
        onSendSpecialKey?.("Tab");
      } else if (data === "\x7f") {
        onSendSpecialKey?.("BSpace");
      } else if (data === "\x1b[A") {
        onSendSpecialKey?.("Up");
      } else if (data === "\x1b[B") {
        onSendSpecialKey?.("Down");
      } else if (data === "\x1b[C") {
        onSendSpecialKey?.("Right");
      } else if (data === "\x1b[D") {
        onSendSpecialKey?.("Left");
      } else if (data === "\x04") {
        onSendSpecialKey?.("C-d");
      } else if (data === "\x1a") {
        onSendSpecialKey?.("C-z");
      } else if (data === "\x01") {
        onSendSpecialKey?.("C-a");
      } else if (data === "\x05") {
        onSendSpecialKey?.("C-e");
      } else if (data === "\x0c") {
        onSendSpecialKey?.("C-l");
      } else {
        // Regular text input
        onSendKeys?.(data);
      }
    });

    // Register the callback to receive terminal_data from the relay
    const writeCallback = (data: string) => {
      // Each terminal_data message is a full pane capture — clear and rewrite
      term.reset();
      term.write(data);
    };
    onSetTerminalDataCallback?.(writeCallback);

    // Start the stream
    onStartStream?.();

    return () => {
      // Stop the stream and unregister callback
      onStopStream?.();
      onSetTerminalDataCallback?.(null);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Only re-run when open changes — the callbacks are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Handle resize events
  useEffect(() => {
    if (!open) return;

    const handleResize = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Ignore errors if terminal was disposed
      }
    };

    window.addEventListener("resize", handleResize);

    // Also re-fit when dialog animation completes
    const timer = setTimeout(handleResize, 300);

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timer);
    };
  }, [open]);

  const handleQuickKey = useCallback(
    (key: string) => {
      onSendSpecialKey?.(key);
      // Refocus the terminal so keyboard input continues
      terminalRef.current?.focus();
    },
    [onSendSpecialKey],
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.Overlay} />
        <Dialog.Content
          className={styles.Content}
          aria-describedby={undefined}
        >
          <Dialog.Title className={styles.VisuallyHidden}>
            Terminal
          </Dialog.Title>
          <div className={styles.Handle} />
          <div className={styles.Header}>
            <div className={styles.TitleGroup}>
              <svg
                className={styles.TerminalIcon}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 1.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 10 5.293 7.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z"
                  clipRule="evenodd"
                />
              </svg>
              <span className={styles.Title}>Terminal</span>
              <span className={styles.LiveBadge}>LIVE</span>
            </div>
            <div className={styles.Actions}>
              <Dialog.Close asChild>
                <button className={styles.CloseButton} title="Close">
                  <svg
                    className={styles.CloseIcon}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className={styles.TerminalContainer} ref={containerRef} />

          {onSendSpecialKey && (
            <div className={styles.InputBar}>
              <div className={styles.QuickKeys}>
                <button
                  className={styles.QuickKey}
                  onClick={() => handleQuickKey("C-c")}
                  title="Ctrl+C"
                >
                  ^C
                </button>
                <button
                  className={styles.QuickKey}
                  onClick={() => handleQuickKey("Escape")}
                  title="Escape"
                >
                  Esc
                </button>
                <button
                  className={styles.QuickKey}
                  onClick={() => handleQuickKey("Tab")}
                  title="Tab"
                >
                  Tab
                </button>
                <button
                  className={styles.QuickKey}
                  onClick={() => handleQuickKey("Up")}
                  title="Up arrow"
                >
                  ↑
                </button>
                <button
                  className={styles.QuickKey}
                  onClick={() => handleQuickKey("Down")}
                  title="Down arrow"
                >
                  ↓
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
