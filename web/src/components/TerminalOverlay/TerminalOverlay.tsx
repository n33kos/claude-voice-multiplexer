import * as Dialog from "@radix-ui/react-dialog";
import type { TerminalSnapshot } from "../../hooks/useRelay";
import styles from "./TerminalOverlay.module.scss";

interface TerminalOverlayProps {
  snapshot: TerminalSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

function formatTimestamp(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function TerminalOverlay({ snapshot, loading, onRefresh, onClose }: TerminalOverlayProps) {
  const isOpen = loading || snapshot !== null;

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.Overlay} />
        <Dialog.Content className={styles.Content} aria-describedby={undefined}>
          <Dialog.Title className={styles.VisuallyHidden}>Terminal Snapshot</Dialog.Title>
          <div className={styles.Handle} />
          <div className={styles.Header}>
            <div className={styles.TitleGroup}>
              <svg className={styles.TerminalIcon} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 1.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 10 5.293 7.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
              </svg>
              <span className={styles.Title}>Terminal</span>
              {snapshot && (
                <span className={styles.Timestamp}>{formatTimestamp(snapshot.timestamp)}</span>
              )}
            </div>
            <div className={styles.Actions}>
              <button
                className={styles.RefreshButton}
                onClick={onRefresh}
                disabled={loading}
                title="Refresh snapshot"
              >
                <svg className={loading ? styles.RefreshIconSpin : styles.RefreshIcon} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                </svg>
              </button>
              <Dialog.Close asChild>
                <button className={styles.CloseButton} title="Close">
                  <svg className={styles.CloseIcon} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className={styles.Body}>
            {loading && !snapshot && (
              <div className={styles.LoadingState}>
                <span className={styles.LoadingDot} />
                <span className={styles.LoadingDot} />
                <span className={styles.LoadingDot} />
              </div>
            )}
            {snapshot?.error && (
              <div className={styles.ErrorState}>{snapshot.error}</div>
            )}
            {snapshot?.content && (
              <pre className={styles.TerminalContent}>{snapshot.content}</pre>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
