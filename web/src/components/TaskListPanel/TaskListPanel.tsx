import { useMemo, useState } from "react";
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
        <span className={styles.Count}>
          {tasks.filter((t) => t.status === "completed").length}/{tasks.length}
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
