import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PREntry } from "../../hooks/useRelay";
import styles from "./SessionPRList.module.scss";

interface Props {
  prs: PREntry[];
  sessionId?: string | null;
}

function repoFromUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return m ? m[1] : "";
}

function storageKey(sessionId: string | null | undefined): string {
  return `voice-multiplexer-dismissed-prs:${sessionId ?? "_global"}`;
}

function loadDismissed(sessionId: string | null | undefined): Set<number> {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((n): n is number => typeof n === "number"));
  } catch {
    return new Set();
  }
}

function saveDismissed(sessionId: string | null | undefined, ids: Set<number>) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

export function SessionPRList({ prs, sessionId }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [paneDismissed, setPaneDismissed] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() =>
    loadDismissed(sessionId),
  );

  // Reload the persisted set when switching sessions.
  useEffect(() => {
    setDismissedIds(loadDismissed(sessionId));
  }, [sessionId]);

  // Re-show the pane whenever a non-dismissed PR shows up.
  const paneDismissedIdsRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!paneDismissed) return;
    const seen = paneDismissedIdsRef.current;
    if (!seen) return;
    const hasNew = prs.some(
      (p) => !seen.has(p.pr_number) && !dismissedIds.has(p.pr_number),
    );
    if (hasNew) {
      setPaneDismissed(false);
      paneDismissedIdsRef.current = null;
    }
  }, [prs, paneDismissed, dismissedIds]);

  const removePr = useCallback(
    (prNumber: number) => {
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.add(prNumber);
        saveDismissed(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );

  const visible = useMemo(
    () => prs.filter((p) => !dismissedIds.has(p.pr_number)),
    [prs, dismissedIds],
  );

  if (visible.length === 0) return null;
  if (paneDismissed) return null;

  const sorted = [...visible].sort((a, b) => a.created_at - b.created_at);

  return (
    <div className={styles.Root}>
      <button
        type="button"
        className={styles.Header}
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand PR list" : "Collapse PR list"}
      >
        <span className={styles.HeaderTitle}>
          <span
            className={`${styles.Chevron} ${collapsed ? "" : styles.ChevronOpen}`}
          >
            ▶
          </span>
          <span>PRs</span>
          <span className={styles.Count}>
            · {visible.length} {visible.length === 1 ? "opened" : "opened"}
          </span>
        </span>
        <span className={styles.HeaderRight}>
          {!collapsed && (
            <span
              role="button"
              tabIndex={0}
              className={styles.DismissButton}
              aria-label="Dismiss PR list"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                paneDismissedIdsRef.current = new Set(
                  visible.map((p) => p.pr_number),
                );
                setPaneDismissed(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  paneDismissedIdsRef.current = new Set(
                    visible.map((p) => p.pr_number),
                  );
                  setPaneDismissed(true);
                }
              }}
            >
              ×
            </span>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className={styles.List}>
          {sorted.map((pr) => {
            const repo = repoFromUrl(pr.url);
            const label = pr.title || repo || pr.url;
            return (
              <div key={pr.pr_number} className={styles.Row}>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.Item}
                  title={pr.url}
                >
                  <span className={styles.Number}>#{pr.pr_number}</span>
                  <span className={styles.Title}>{label}</span>
                  {repo && pr.title ? (
                    <span className={styles.Repo}>{repo}</span>
                  ) : null}
                </a>
                <button
                  type="button"
                  className={styles.RowRemove}
                  aria-label={`Remove PR #${pr.pr_number} from list`}
                  title="Remove from list"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removePr(pr.pr_number);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
