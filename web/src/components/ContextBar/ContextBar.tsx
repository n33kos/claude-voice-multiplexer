import { useState, useRef, useEffect } from "react";
import type { ContextBarFields } from "../../hooks/useSettings";
import styles from "./ContextBar.module.scss";

export interface ContextUsage {
  model: string;
  model_name?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  context_window: number;
  used_tokens: number;
  percentage: number;
  cost_usd?: number | null;
}

interface ContextBarProps {
  usage: ContextUsage | null;
  alwaysShow?: boolean;
  onChangeModel?: (model: string) => void;
  fields: ContextBarFields;
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

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
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

/** Model switcher widget with dropdown. */
function ModelSwitcher({
  usage,
  onChangeModel,
}: {
  usage: ContextUsage | null;
  onChangeModel?: (model: string) => void;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const currentModel = usage?.model || "";

  const handleModelSelect = async (model: string) => {
    setDropdownOpen(false);
    if (!onChangeModel || model === currentModel) return;
    setSwitching(true);
    await onChangeModel(model);
    setSwitching(false);
  };

  return (
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
  );
}

/** Token usage text widget. */
function TokenUsage({ usage }: { usage: ContextUsage | null }) {
  const pct = usage ? Math.min(usage.percentage, 100) : 0;
  return (
    <span className={styles.Tokens}>
      {usage
        ? `${formatTokenCount(usage.used_tokens)} / ${formatTokenCount(usage.context_window)} (${pct.toFixed(1)}%)`
        : "-- / --"}
    </span>
  );
}

/** Cost display widget. */
function CostDisplay({ usage }: { usage: ContextUsage | null }) {
  if (!usage?.cost_usd) return <span className={styles.Tokens}>--</span>;
  return <span className={styles.Tokens}>{formatCost(usage.cost_usd)}</span>;
}

/** Map field IDs to their rendered widgets. */
function renderField(
  fieldId: string,
  usage: ContextUsage | null,
  onChangeModel?: (model: string) => void,
) {
  switch (fieldId) {
    case "model":
      return <ModelSwitcher key="model" usage={usage} onChangeModel={onChangeModel} />;
    case "contextUsage":
      return <TokenUsage key="contextUsage" usage={usage} />;
    case "cost":
      return <CostDisplay key="cost" usage={usage} />;
    default:
      return null;
  }
}

export function ContextBar({ usage, alwaysShow, onChangeModel, fields }: ContextBarProps) {
  if (!usage && !alwaysShow) return null;

  // Group fields by position
  const left: string[] = [];
  const center: string[] = [];
  const right: string[] = [];

  for (const [fieldId, position] of Object.entries(fields)) {
    if (fieldId === "contextBar" || position === "hidden") continue;
    if (position === "left") left.push(fieldId);
    else if (position === "center") center.push(fieldId);
    else if (position === "right") right.push(fieldId);
  }

  const pct = usage ? Math.min(usage.percentage, 100) : 0;
  const showBar = fields.contextBar !== "hidden";

  return (
    <div data-component="ContextBar" className={styles.Root}>
      <div className={styles.Labels}>
        <div className={styles.FieldGroup}>
          {left.map((id) => renderField(id, usage, onChangeModel))}
        </div>
        <div className={`${styles.FieldGroup} ${styles.FieldGroupCenter}`}>
          {center.map((id) => renderField(id, usage, onChangeModel))}
        </div>
        <div className={styles.FieldGroup}>
          {right.map((id) => renderField(id, usage, onChangeModel))}
        </div>
      </div>
      {showBar && (
        <div className={styles.Track}>
          <div
            className={styles.Fill}
            style={{
              width: `${pct}%`,
              backgroundColor: usage ? barColor(pct) : "var(--color-surface-tertiary)",
            }}
          />
        </div>
      )}
    </div>
  );
}
