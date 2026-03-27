import styles from "./ContextBar.module.scss";

export interface ContextUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  context_window: number;
  used_tokens: number;
  percentage: number;
}

interface ContextBarProps {
  usage: ContextUsage | null;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function barColor(pct: number): string {
  if (pct < 50) return "var(--color-status-green)";
  if (pct < 80) return "var(--color-status-yellow)";
  return "var(--color-status-red)";
}

/** Short model display name — strip common prefixes. */
function modelLabel(model: string): string {
  return model.replace("claude-", "").replace(/-/g, " ");
}

export function ContextBar({ usage }: ContextBarProps) {
  if (!usage) return null;

  const pct = Math.min(usage.percentage, 100);

  return (
    <div data-component="ContextBar" className={styles.Root}>
      <div className={styles.Labels}>
        <span className={styles.Model}>{modelLabel(usage.model)}</span>
        <span className={styles.Tokens}>
          {formatTokenCount(usage.used_tokens)} / {formatTokenCount(usage.context_window)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className={styles.Track}>
        <div
          className={styles.Fill}
          style={{
            width: `${pct}%`,
            backgroundColor: barColor(pct),
          }}
        />
      </div>
    </div>
  );
}
