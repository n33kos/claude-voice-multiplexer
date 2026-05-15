import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskEntry, TaskStatus } from "../../hooks/useRelay";
import styles from "./TaskListPanel.module.scss";

interface Props {
  tasks: TaskEntry[];
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: "In progress",
  pending: "Pending",
  completed: "Completed",
};

const STATUS_CLASS: Record<TaskStatus, string> = {
  in_progress: styles.InProgress,
  pending: styles.Pending,
  completed: styles.Completed,
};

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "◐";
    case "completed":
      return "✓";
    case "pending":
    default:
      return "○";
  }
}

export function TaskListPanel({ tasks }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Un-dismiss whenever a brand-new task_id shows up.  Tracks the set of
  // task_ids seen at dismiss time; any new id resets the flag so the panel
  // re-appears for fresh work.
  const dismissedIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!dismissed) return;
    const seen = dismissedIdsRef.current;
    if (!seen) return;
    const hasNew = tasks.some((t) => !seen.has(t.task_id));
    if (hasNew) {
      setDismissed(false);
      dismissedIdsRef.current = null;
    }
  }, [tasks, dismissed]);

  // Auto-collapse when every task is completed so a finished list stays out
  // of the way.  Tracks the all-complete state across renders so a manual
  // re-expand by the user (after auto-collapse fired) is preserved until a
  // new task arrives and flips the state back to "not all complete".
  const allCompleteRef = useRef(false);
  useEffect(() => {
    if (tasks.length === 0) {
      allCompleteRef.current = false;
      return;
    }
    const allComplete = tasks.every((t) => t.status === "completed");
    if (allComplete && !allCompleteRef.current) {
      setCollapsed(true);
    } else if (!allComplete && allCompleteRef.current) {
      setCollapsed(false);
    }
    allCompleteRef.current = allComplete;
  }, [tasks]);

  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const ord = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (ord !== 0) return ord;
        return a.created_at - b.created_at;
      }),
    [tasks],
  );

  const activeCount = useMemo(
    () => tasks.filter((t) => t.status !== "completed").length,
    [tasks],
  );

  if (tasks.length === 0) return null;
  if (dismissed) return null;

  const inProgressTask = tasks.find((t) => t.status === "in_progress");
  const headerLabel = inProgressTask
    ? inProgressTask.subject || STATUS_LABELS.in_progress
    : `${activeCount} ${activeCount === 1 ? "task" : "tasks"}`;

  return (
    <div className={styles.Root}>
      <button
        type="button"
        className={styles.Header}
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand task list" : "Collapse task list"}
      >
        <span className={styles.HeaderTitle}>
          <span
            className={`${styles.Chevron} ${collapsed ? "" : styles.ChevronOpen}`}
          >
            ▶
          </span>
          <span>Tasks</span>
          <span className={styles.Count}>· {headerLabel}</span>
        </span>
        <span className={styles.HeaderRight}>
          <span className={styles.Count}>
            {tasks.filter((t) => t.status === "completed").length}/{tasks.length}
          </span>
          {!collapsed && (
            <span
              role="button"
              tabIndex={0}
              className={styles.DismissButton}
              aria-label="Dismiss task list"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                dismissedIdsRef.current = new Set(tasks.map((t) => t.task_id));
                setDismissed(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissedIdsRef.current = new Set(tasks.map((t) => t.task_id));
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
          {sorted.map((task) => (
            <div
              key={task.task_id}
              className={`${styles.Item} ${STATUS_CLASS[task.status]}`}
              title={task.description || task.subject}
            >
              <span className={styles.Icon} aria-hidden>
                {statusIcon(task.status)}
              </span>
              <span className={styles.Subject}>
                {task.subject || task.task_id}
                {task.teammate ? (
                  <span className={styles.Teammate}>{task.teammate}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
