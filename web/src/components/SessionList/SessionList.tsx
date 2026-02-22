import classNames from "classnames";
import { useRef, useState } from "react";
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
  onToggleExpanded,
  onConnect,
  onDisconnect,
  onClearTranscript,
  onRemoveSession,
  onRenameSession,
  onRecolorSession,
  onSpawnSession,
  onKillSession,
  onRestartSession,
  onHardInterrupt,
}: SessionListProps) {
  const [showNewSession, setShowNewSession] = useState(false);

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

  // Sort: connected session first, then preserve existing order
  const sortedSessions = connectedSessionId
    ? [...sessions].sort((a, b) => {
        if (a.session_id === connectedSessionId) return -1;
        if (b.session_id === connectedSessionId) return 1;
        return 0;
      })
    : sessions;

  return (
    <div
      data-component="SessionList"
      className={classNames(styles.Root, {
        [styles.RootFull]: !connectedSessionId,
      })}
    >
      <div className={styles.HeaderRow}>
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
                {connectedSession.display_name}
              </span>
            ) : (
              <span className={styles.PlaceholderText}>Select a session</span>
            )}
          </div>
          <div className={styles.HeaderRight}>
            {sessions.length > 1 && (
              <span className={styles.SessionCount}>
                {sessions.length} sessions
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
        <div
          className={classNames(styles.ExpandedList, {
            [styles.ExpandedListFull]: !connectedSessionId,
          })}
        >
          {sortedSessions.map((session) => {
            const isConnected =
              session.session_id === connectedSessionId && !!connectedSessionId;
            const canConnect = session.online;
            const hue = session.hue_override ?? sessionHue(session.session_id);
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
                      <span
                        className={classNames(styles.NameText, {
                          [styles.NameTextOffline]: !session.online,
                        })}
                      >
                        {session.display_name}
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
                    <div className={styles.DirName}>{session.dir_name}</div>
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
                      onRemoveSession={onRemoveSession}
                      onRenameSession={onRenameSession}
                      onRecolorSession={onRecolorSession}
                      onKillSession={onKillSession}
                      onRestartSession={onRestartSession}
                      onHardInterrupt={onHardInterrupt}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
