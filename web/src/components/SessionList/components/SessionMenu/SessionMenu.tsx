import { useEffect, useRef, useState } from "react";
import { sessionHue } from "../../../../utils/sessionHue";
import type { DisplaySession } from "../../../../hooks/useRelay";
import styles from "./SessionMenu.module.scss";

interface SessionMenuProps {
  session: DisplaySession;
  onClearTranscript: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, displayName: string) => void;
  onRecolorSession: (sessionId: string, hue: number | null) => void;
  onKillSession: (sessionId: string) => Promise<boolean>;
  onRestartSession: (sessionId: string) => Promise<boolean>;
  onHardInterrupt: (sessionId: string) => Promise<boolean>;
}

export function SessionMenu({
  session,
  onClearTranscript,
  onRemoveSession,
  onRenameSession,
  onRecolorSession,
  onKillSession,
  onRestartSession,
  onHardInterrupt,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [recoloring, setRecoloring] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [hueValue, setHueValue] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function runAction(action: () => Promise<boolean>) {
    setBusy(true);
    setOpen(false);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={menuRef} className={styles.Root}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className={styles.MenuButton}
        disabled={busy}
      >
        <svg className={styles.MenuIcon} fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>

      {open && (
        <div className={styles.Dropdown}>
          {renaming ? (
            <div className={styles.RenameRow}>
              <input
                ref={inputRef}
                className={styles.RenameInput}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    onRenameSession(session.session_id, renameValue.trim());
                    setRenaming(false);
                    setOpen(false);
                  } else if (e.key === "Escape") {
                    setRenaming(false);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder={session.session_name}
                autoFocus
              />
            </div>
          ) : recoloring ? (
            <div className={styles.ColorRow} onClick={(e) => e.stopPropagation()}>
              <div className={styles.ColorPreview} style={{ backgroundColor: `hsl(${hueValue}, 70%, 55%)` }} />
              <input
                type="range"
                min={0}
                max={359}
                value={hueValue}
                onChange={(e) => setHueValue(Number(e.target.value))}
                className={styles.HueSlider}
              />
              <div className={styles.ColorActions}>
                <button
                  className={styles.ColorApply}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRecolorSession(session.session_id, hueValue);
                    setRecoloring(false);
                    setOpen(false);
                  }}
                >
                  Apply
                </button>
                {session.hue_override != null && (
                  <button
                    className={styles.ColorReset}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRecolorSession(session.session_id, null);
                      setRecoloring(false);
                      setOpen(false);
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameValue(session.display_name);
                  setRenaming(true);
                  setTimeout(() => inputRef.current?.select(), 0);
                }}
                className={styles.MenuItem}
              >
                Rename
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setHueValue(session.hue_override ?? sessionHue(session.session_id));
                  setRecoloring(true);
                }}
                className={styles.MenuItem}
              >
                Change color
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClearTranscript(session.session_id);
                  setOpen(false);
                }}
                className={styles.MenuItem}
              >
                Clear transcripts
              </button>

              {/* Daemon session controls — always visible */}
              {session.daemon_managed && session.online && (
                <>
                  <div className={styles.Divider} />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      runAction(() => onHardInterrupt(session.session_id));
                    }}
                    className={styles.MenuItem}
                  >
                    Hard interrupt
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      runAction(() => onRestartSession(session.session_id));
                    }}
                    className={styles.MenuItem}
                  >
                    Restart session
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      runAction(() => onKillSession(session.session_id));
                    }}
                    className={styles.DeleteItem}
                  >
                    Kill session
                  </button>
                </>
              )}

              {!session.online && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSession(session.session_id);
                    setOpen(false);
                  }}
                  className={styles.DeleteItem}
                >
                  Delete session
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
