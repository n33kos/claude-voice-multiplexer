import { useState, useRef, useEffect } from "react";
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
  alwaysShow?: boolean;
  onChangeModel?: (model: string) => void;
}

const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", label: "Opus 4.6", shortFilter: "opus" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", shortFilter: "sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", shortFilter: "haiku" },
];

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

export function ContextBar({ usage, alwaysShow, onChangeModel }: ContextBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  if (!usage && !alwaysShow) return null;

  const pct = usage ? Math.min(usage.percentage, 100) : 0;
  const currentModel = usage?.model || "";

  const handleModelSelect = async (model: string) => {
    setDropdownOpen(false);
    if (!onChangeModel || model === currentModel) return;
    setSwitching(true);
    await onChangeModel(model);
    setSwitching(false);
  };

  return (
    <div data-component="ContextBar" className={styles.Root}>
      <div className={styles.Labels}>
        <div className={styles.ModelContainer} ref={dropdownRef}>
          <button
            className={styles.ModelButton}
            onClick={() => onChangeModel && setDropdownOpen((o) => !o)}
            disabled={!onChangeModel || switching}
            title={onChangeModel ? "Switch model" : undefined}
          >
            <span className={styles.Model}>
              {switching ? "Switching..." : usage ? modelLabel(usage.model) : "--"}
            </span>
            {onChangeModel && (
              <svg className={styles.ChevronIcon} viewBox="0 0 12 12" fill="currentColor">
                <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
          </button>
          {dropdownOpen && (
            <div className={styles.Dropdown}>
              {AVAILABLE_MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`${styles.DropdownItem} ${m.id === currentModel ? styles.DropdownItemActive : ""}`}
                  onClick={() => handleModelSelect(m.id)}
                >
                  {m.label}
                  {m.id === currentModel && (
                    <svg className={styles.CheckIcon} viewBox="0 0 12 12" fill="currentColor">
                      <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className={styles.Tokens}>
          {usage
            ? `${formatTokenCount(usage.used_tokens)} / ${formatTokenCount(usage.context_window)} (${pct.toFixed(1)}%)`
            : "-- / --"}
        </span>
      </div>
      <div className={styles.Track}>
        <div
          className={styles.Fill}
          style={{
            width: `${pct}%`,
            backgroundColor: usage ? barColor(pct) : "var(--color-surface-tertiary)",
          }}
        />
      </div>
    </div>
  );
}
