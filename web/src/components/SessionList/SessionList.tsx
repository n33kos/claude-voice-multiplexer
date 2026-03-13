import classNames from "classnames";
import { useEffect, useRef, useState } from "react";
import { initAudio } from "../../hooks/useChime";
import type { SessionHealth } from "../../hooks/useRelay";
import { sessionHue } from "../../utils/sessionHue";
import type { SessionListProps } from "./SessionList.types";
import { timeAgo } from "./SessionList.utils";
import { SessionMenu } from "./components/SessionMenu/SessionMenu";
import { ChevronIcon } from "./components/ChevronIcon/ChevronIcon";
import styles from "./SessionList.module.scss";

function HealthBadge({ health }: { health: SessionHealth }) {
  const label =
    health === "zombie" ? "zombie" : health === "dead" ? "dead" : null;
  if (!label) return null;
  return (
    <span
      className={classNames(
        styles.HealthBadge,
        styles[`HealthBadge_${health}`],
      )}
    >
      {label}
    </span>
  );
}

function NewSessionDialog({
  onSpawn,
  onClose,
}: {
  onSpawn: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [spawning, setSpawning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cwd.trim()) return;
    setSpawning(true);
    setError("");
    const result = await onSpawn(cwd.trim());
    setSpawning(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.error || "Failed to spawn session");
    }
  }

  return (
    <div
      className={styles.NewSessionOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.NewSessionDialog}>
        <div className={styles.NewSessionTitle}>New Session</div>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={styles.NewSessionInput}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="Working directory (e.g. ~/projects/myapp)"
            autoFocus
            disabled={spawning}
          />
          {error && <div className={styles.NewSessionError}>{error}</div>}
          <div className={styles.NewSessionActions}>
            <button
              type="button"
              className={styles.NewSessionCancel}
              onClick={onClose}
              disabled={spawning}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.NewSessionSubmit}
              disabled={!cwd.trim() || spawning}
            >
              {spawning ? "Spawning…" : "Spawn"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SessionList({
  sessions,
  connectedSessionId,
  expanded,
  unreadSessions,
  onToggleExpanded,
  onConnect,
  onDisconnect,
  onClearTranscript,
  onReconnectSession,
  onRemoveSession,
  onRenameSession,
  onRecolorSession,
  onSpawnSession,
  onKillSession,
  onRestartSession,
  onHardInterrupt,
  onClearContext,
}: SessionListProps) {
  const [showNewSession, setShowNewSession] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);

  // Click outside to close overlay
  useEffect(() => {
    if (!expanded) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      // Don't close if clicking inside Radix dropdown portal
      const radixPortal = (target as Element).closest?.(
        "[data-radix-popper-content-wrapper]",
      );
      if (radixPortal) return;
      if (
        overlayRef.current &&
        !overlayRef.current.contains(target) &&
        headerRowRef.current &&
        !headerRowRef.current.contains(target)
      ) {
        onToggleExpanded();
      }
    }
    // Delay adding listener to avoid the toggle click itself closing it
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [expanded, onToggleExpanded]);

  if (sessions.length === 0) {
    return (
      <div data-component="SessionList" className={styles.EmptyState}>
        <p className={styles.EmptyTitle}>No Claude sessions</p>
        <p className={styles.EmptyHint}>
          Use <code className={styles.Code}>/voice-multiplexer:standby</code> in
          a Claude session, or{" "}
          <button
            className={styles.SpawnLink}
            onClick={() => setShowNewSession(true)}
          >
            spawn one
          </button>
        </p>
        {showNewSession && (
          <NewSessionDialog
            onSpawn={onSpawnSession}
            onClose={() => setShowNewSession(false)}
          />
        )}
      </div>
    );
  }

  const connectedSession = sessions.find(
    (s) => s.session_id === connectedSessionId && !!connectedSessionId,
  );

  // Sort: connected first, then unread, then preserve existing order
  const sortedSessions = [...sessions].sort((a, b) => {
    if (connectedSessionId) {
      if (a.session_id === connectedSessionId) return -1;
      if (b.session_id === connectedSessionId) return 1;
    }
    const aUnread = unreadSessions.has(a.session_id) ? 1 : 0;
    const bUnread = unreadSessions.has(b.session_id) ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
    return 0;
  });

  const connectedSessionDisplayName = connectedSession
    ? connectedSession.display_name ||
      connectedSession.dir_name.split("/").slice(-1)[0] ||
      connectedSession.session_name
    : null;

  return (
    <div
      data-component="SessionList"
      className={classNames(styles.Root, {
        [styles.RootFull]: !connectedSessionId,
      })}
    >
      <div className={styles.HeaderRow} ref={headerRowRef}>
        <button
          onClick={onToggleExpanded}
          className={styles.HeaderBar}
          style={
            connectedSession
              ? {
                  borderLeftColor: `hsla(${connectedSession.hue_override ?? sessionHue(connectedSession.session_id)}, 70%, 55%, 0.7)`,
                }
              : undefined
          }
        >
          <div className={styles.HeaderLeft}>
            {connectedSession ? (
              <span className={styles.SessionName}>
                {connectedSessionDisplayName}
              </span>
            ) : (
              <span className={styles.PlaceholderText}>Select a session</span>
            )}
          </div>
          <div className={styles.HeaderRight}>
            {unreadSessions.size > 0 && (
              <span className={styles.UnreadDotsContainer}>
                {/* Most recent unread sessions sorted by last_interaction desc.
                    Render oldest first (leftmost/bottom z), newest last (rightmost/top z). */}
                {[...sessions]
                  .filter((s) => unreadSessions.has(s.session_id))
                  .sort(
                    (a, b) =>
                      (a.last_interaction ?? 0) - (b.last_interaction ?? 0),
                  )
                  .map((s, i, arr) => {
                    const h = s.hue_override ?? sessionHue(s.session_id);
                    const isTop = i === arr.length - 1;
                    return (
                      <span
                        key={s.session_id}
                        className={styles.UnreadDotStacked}
                        style={{
                          backgroundColor: `hsla(${h}, 70%, 55%, 1)`,
                        }}
                      >
                        {isTop && (
                          <span className={styles.UnreadCount}>
                            {unreadSessions.size}
                          </span>
                        )}
                      </span>
                    );
                  })}
              </span>
            )}
            <ChevronIcon expanded={expanded} />
          </div>
        </button>
        <button
          className={styles.NewSessionButton}
          onClick={(e) => {
            e.stopPropagation();
            setShowNewSession(true);
          }}
          title="Spawn new Claude session"
        >
          +
        </button>
      </div>

      {showNewSession && (
        <NewSessionDialog
          onSpawn={onSpawnSession}
          onClose={() => setShowNewSession(false)}
        />
      )}

      {expanded && (
        <div ref={overlayRef} className={styles.OverlayPanel}>
          <div
            className={classNames(styles.ExpandedList, {
              [styles.ExpandedListFull]: !connectedSessionId,
            })}
          >
            {sortedSessions.map((session) => {
              const isConnected =
                session.session_id === connectedSessionId &&
                !!connectedSessionId;
              const canConnect = session.online;
              const hue =
                session.hue_override ?? sessionHue(session.session_id);
              const sessionDisplayTitle =
                session.display_name ||
                session.dir_name.split("/").slice(-1)[0] ||
                session.session_name;

              const hasUnread = unreadSessions.has(session.session_id);

              return (
                <div
                  key={session.session_id}
                  onClick={() => {
                    if (!canConnect) return;
                    initAudio();
                    if (isConnected) {
                      onDisconnect();
                    } else {
                      onConnect(session.session_id);
                      onToggleExpanded();
                    }
                  }}
                  className={classNames(
                    styles.SessionCard,
                    canConnect
                      ? styles.SessionCardClickable
                      : styles.SessionCardDisabled,
                    isConnected && styles.SessionCardConnected,
                    session.health === "zombie" && styles.SessionCardZombie,
                    session.health === "dead" && styles.SessionCardDead,
                  )}
                  style={{
                    borderLeftColor: `hsla(${hue}, 70%, 55%, ${session.online ? 0.7 : 0.3})`,
                  }}
                >
                  <div className={styles.SessionContent}>
                    <div className={styles.SessionInfo}>
                      <div className={styles.SessionNameRow}>
                        {hasUnread && (
                          <span
                            className={styles.UnreadDot}
                            style={{
                              backgroundColor: `hsla(${hue}, 70%, 55%, 0.85)`,
                            }}
                          />
                        )}
                        <span
                          className={classNames(styles.NameText, {
                            [styles.NameTextOffline]: !session.online,
                          })}
                        >
                          {sessionDisplayTitle}
                        </span>
                        {!session.online && (
                          <span className={styles.OfflineBadge}>offline</span>
                        )}
                        {session.health &&
                          (session.health === "zombie" ||
                            session.health === "dead") && (
                            <HealthBadge health={session.health} />
                          )}
                      </div>
                      <div className={styles.DirName}>{session.cwd}</div>
                    </div>
                    <div className={styles.SessionMeta}>
                      {session.last_interaction != null && (
                        <span className={styles.TimeAgo}>
                          {timeAgo(session.last_interaction / 1000)}
                        </span>
                      )}
                      <SessionMenu
                        session={session}
                        onClearTranscript={onClearTranscript}
                        onReconnectSession={onReconnectSession}
                        onRemoveSession={onRemoveSession}
                        onRenameSession={onRenameSession}
                        onRecolorSession={onRecolorSession}
                        onKillSession={onKillSession}
                        onRestartSession={onRestartSession}
                        onHardInterrupt={onHardInterrupt}
                        onSpawnSession={onSpawnSession}
                        onClearContext={onClearContext}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
