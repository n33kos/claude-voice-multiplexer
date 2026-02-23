import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
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
  onSpawnSession: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  onReconnectSession: (sessionId: string, cwd?: string) => Promise<{ ok: boolean; error?: string }>;
  onMenuOpenChange?: (open: boolean) => void;
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
  onSpawnSession,
  onReconnectSession,
  onMenuOpenChange,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [recoloring, setRecoloring] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [hueValue, setHueValue] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    onMenuOpenChange?.(nextOpen);
    if (!nextOpen) {
      setRenaming(false);
      setRecoloring(false);
    }
  }

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
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button data-session-menu className={styles.MenuButton} disabled={busy}>
          <svg
            className={styles.MenuIcon}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles.Dropdown}
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
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
            <div
              className={styles.ColorRow}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className={styles.ColorPreview}
                style={{ backgroundColor: `hsl(${hueValue}, 70%, 55%)` }}
              />
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
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={(e) => {
                  e.preventDefault();
                  setRenameValue(session.display_name);
                  setRenaming(true);
                  setTimeout(() => inputRef.current?.select(), 0);
                }}
              >
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={(e) => {
                  e.preventDefault();
                  setHueValue(
                    session.hue_override ?? sessionHue(session.session_id),
                  );
                  setRecoloring(true);
                }}
              >
                Change color
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={() => {
                  onClearTranscript(session.session_id);
                  setOpen(false);
                }}
              >
                Clear transcripts
              </DropdownMenu.Item>
              <DropdownMenu.Separator className={styles.Divider} />
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={() =>
                  runAction(() =>
                    onReconnectSession(session.session_id, session.cwd).then((r) => r.ok),
                  )
                }
              >
                Reconnect
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={() =>
                  runAction(() => onSpawnSession(session.cwd).then((r) => r.ok))
                }
              >
                Respawn
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={() =>
                  runAction(() => onHardInterrupt(session.session_id))
                }
              >
                Hard interrupt
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.MenuItem}
                onSelect={() =>
                  runAction(() => onRestartSession(session.session_id))
                }
              >
                Restart session
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.DeleteItem}
                onSelect={() =>
                  runAction(() => onKillSession(session.session_id))
                }
              >
                Kill session
              </DropdownMenu.Item>

              {!session.online && (
                <DropdownMenu.Item
                  className={styles.DeleteItem}
                  onSelect={() => {
                    onRemoveSession(session.session_id);
                    setOpen(false);
                  }}
                >
                  Delete session
                </DropdownMenu.Item>
              )}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
