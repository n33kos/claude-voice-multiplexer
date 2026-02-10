import classNames from "classnames";
import { initAudio } from "../../hooks/useChime";
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

  return (
    <div data-component="SessionList" className={classNames(styles.Root, { [styles.RootFull]: !connectedSessionId })}>
      <button onClick={onToggleExpanded} className={styles.HeaderBar}>
        <div className={styles.HeaderLeft}>
          {connectedSession ? (
            <>
              <div className={styles.GreenDot} />
              <span className={styles.SessionName}>
                {connectedSession.display_name}
              </span>
            </>
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
          {sessions.map((session) => {
            const isConnected =
              session.session_id === connectedSessionId && !!connectedSessionId;
            const canConnect = session.online && !!session.session_id;
            return (
              <div
                key={session.session_name}
                onClick={() => {
                  if (!canConnect) return;
                  initAudio();
                  if (isConnected) {
                    onDisconnect();
                  } else {
                    onConnect(session.session_id!);
                    onToggleExpanded();
                  }
                }}
                className={classNames(
                  styles.SessionCard,
                  canConnect ? styles.SessionCardClickable : styles.SessionCardDisabled,
                )}
              >
                <div className={styles.SessionContent}>
                  <div className={styles.SessionInfo}>
                    <div className={styles.SessionNameRow}>
                      {isConnected && <div className={styles.ConnectedDot} />}
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
                    <span className={styles.TimeAgo}>
                      {timeAgo(session.last_seen)}
                    </span>
                    <SessionMenu
                      session={session}
                      onClearTranscript={onClearTranscript}
                      onRemoveSession={onRemoveSession}
                      onRenameSession={onRenameSession}
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
