import { useEffect, useRef, useCallback, useState } from "react";
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
  onResizePane?: (cols: number, rows: number) => void;
}

export function TerminalOverlay({
  open,
  onClose,
  onSendKeys,
  onSendSpecialKey,
  onStartStream,
  onStopStream,
  onSetTerminalDataCallback,
  onResizePane,
}: TerminalOverlayProps) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Track when the container div is actually in the DOM via callback ref
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

  // Initialize xterm.js when the container element is available
  useEffect(() => {
    if (!open || !containerEl) return;

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

    term.open(containerEl);

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
        onSendKeys?.(data);
      }
    });

    // Register the callback to receive terminal_data from the relay
    const writeCallback = (data: string) => {
      term.write("\x1b[2J\x1b[H" + data);
    };
    onSetTerminalDataCallback?.(writeCallback);

    // Write initial status message
    term.writeln("\x1b[32m● Terminal connected\x1b[0m");
    term.writeln("\x1b[90mStarting live stream...\x1b[0m");

    // Start the stream
    const startTimer = setTimeout(() => {
      onStartStream?.();
    }, 100);

    return () => {
      clearTimeout(startTimer);
      onStopStream?.();
      onSetTerminalDataCallback?.(null);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, containerEl]);

  // No automatic resize — refit is manual only via the button

  const handleRefit = useCallback(() => {
    try {
      fitAddonRef.current?.fit();
    } catch {
      // Ignore fit errors
    }
    // After fit(), xterm updates term.cols/rows synchronously but the
    // layout may still settle — wait one frame before reading so we get
    // the final dimensions, then push them to the tmux pane so the
    // underlying shell stops wrapping at the old width.
    if (onResizePane) {
      requestAnimationFrame(() => {
        const term = terminalRef.current;
        if (!term) return;
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 0 && rows > 0) {
          onResizePane(cols, rows);
        }
      });
    }
  }, [onResizePane]);

  const handleQuickKey = useCallback(
    (key: string) => {
      onSendSpecialKey?.(key);
      terminalRef.current?.focus();
    },
    [onSendSpecialKey],
  );

  // Callback ref: React calls this when the div mounts/unmounts in the DOM
  const containerRefCallback = useCallback((node: HTMLDivElement | null) => {
    setContainerEl(node);
  }, []);

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
              <button className={styles.CloseButton} title="Refit terminal" onClick={handleRefit}>
                <svg className={styles.CloseIcon} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 01-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 110-2h4a1 1 0 011 1v4a1 1 0 11-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-8 7a1 1 0 112 0v1.586l2.293-2.293a1 1 0 011.414 1.414L6.414 15H8a1 1 0 110 2H4a1 1 0 01-1-1v-4zm13 0a1 1 0 10-2 0v1.586l-2.293-2.293a1 1 0 00-1.414 1.414L13.586 15H12a1 1 0 100 2h4a1 1 0 001-1v-4z" clipRule="evenodd" />
                </svg>
              </button>
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

          <div className={styles.TerminalContainer} ref={containerRefCallback} />

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
