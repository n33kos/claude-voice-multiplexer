import { useEffect, useRef, useState } from "react";
import type { PREntry } from "../../hooks/useRelay";
import styles from "./SessionPRList.module.scss";

interface Props {
  prs: PREntry[];
}

function repoFromUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return m ? m[1] : "";
}

export function SessionPRList({ prs }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Re-show whenever a new PR shows up.
  const dismissedIdsRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!dismissed) return;
    const seen = dismissedIdsRef.current;
    if (!seen) return;
    const hasNew = prs.some((p) => !seen.has(p.pr_number));
    if (hasNew) {
      setDismissed(false);
      dismissedIdsRef.current = null;
    }
  }, [prs, dismissed]);

  if (prs.length === 0) return null;
  if (dismissed) return null;

  const sorted = [...prs].sort((a, b) => a.created_at - b.created_at);

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
            · {prs.length} {prs.length === 1 ? "opened" : "opened"}
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
                dismissedIdsRef.current = new Set(prs.map((p) => p.pr_number));
                setDismissed(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissedIdsRef.current = new Set(prs.map((p) => p.pr_number));
                  setDismissed(true);
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
              <a
                key={pr.pr_number}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
