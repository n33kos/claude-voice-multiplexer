import { useEffect, useRef, useState } from "react";
import type { DisplaySession } from "../../../../hooks/useRelay";
import styles from "./SessionMenu.module.scss";

interface SessionMenuProps {
  session: DisplaySession;
  onClearTranscript: (sessionName: string) => void;
  onRemoveSession: (sessionName: string) => void;
  onRenameSession: (sessionName: string, displayName: string) => void;
}

export function SessionMenu({
  session,
  onClearTranscript,
  onRemoveSession,
  onRenameSession,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
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

  return (
    <div ref={menuRef} className={styles.Root}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className={styles.MenuButton}
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
                    onRenameSession(session.session_name, renameValue.trim());
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
                  onClearTranscript(session.session_name);
                  setOpen(false);
                }}
                className={styles.MenuItem}
              >
                Clear transcripts
              </button>
              {!session.online && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSession(session.session_name);
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
