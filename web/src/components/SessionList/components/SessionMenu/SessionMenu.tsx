import { useEffect, useRef, useState } from "react";
import type { DisplaySession } from "../../../../hooks/useRelay";
import styles from "./SessionMenu.module.scss";

interface SessionMenuProps {
  session: DisplaySession;
  onClearTranscript: (sessionName: string) => void;
  onRemoveSession: (sessionName: string) => void;
}

export function SessionMenu({
  session,
  onClearTranscript,
  onRemoveSession,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
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
        </div>
      )}
    </div>
  );
}
