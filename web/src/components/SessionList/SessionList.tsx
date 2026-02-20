import classNames from "classnames";
import { initAudio } from "../../hooks/useChime";
import { sessionHue } from "../../utils/sessionHue";
import type { SessionListProps } from "./SessionList.types";
import { timeAgo } from "./SessionList.utils";
import { SessionMenu } from "./components/SessionMenu/SessionMenu";
import { ChevronIcon } from "./components/ChevronIcon/ChevronIcon";
import styles from "./SessionList.module.scss";

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
}: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div data-component="SessionList" className={styles.EmptyState}>
        <p className={styles.EmptyTitle}>No Claude sessions</p>
        <p className={styles.EmptyHint}>
          Use{" "}
          <code className={styles.Code}>/voice-multiplexer:relay-standby</code>{" "}
          in a Claude session
        </p>
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
    <div data-component="SessionList" className={classNames(styles.Root, { [styles.RootFull]: !connectedSessionId })}>
      <button
        onClick={onToggleExpanded}
        className={styles.HeaderBar}
        style={connectedSession ? {
          borderLeftColor: `hsla(${connectedSession.hue_override ?? sessionHue(connectedSession.session_id)}, 70%, 55%, 0.7)`,
        } : undefined}
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

      {expanded && (
        <div className={classNames(styles.ExpandedList, { [styles.ExpandedListFull]: !connectedSessionId })}>
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
                  canConnect ? styles.SessionCardClickable : styles.SessionCardDisabled,
                  isConnected && styles.SessionCardConnected,
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
