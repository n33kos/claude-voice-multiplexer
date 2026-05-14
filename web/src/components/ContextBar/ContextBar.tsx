import { useState, useRef, useEffect } from "react";
import type { ContextBarFields } from "../../hooks/useSettings";
import { authFetch } from "../../hooks/useAuth";
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
  cost_duration_ms?: number | null;
  cwd?: string;
  rate_limit_5h?: number | null;
  rate_limit_7d?: number | null;
}

interface ContextBarProps {
  usage: ContextUsage | null;
  alwaysShow?: boolean;
  onChangeModel?: (model: string) => void;
  fields: ContextBarFields;
}

interface AvailableModel {
  id: string;
  display_name: string;
}

// Curated fallback shown while the live list is in-flight or if /api/models
// fails. Mirrors the server-side fallback in relay-server/server.py.
const FALLBACK_MODELS: AvailableModel[] = [
  { id: "claude-opus-4-7", display_name: "Opus 4.7" },
  { id: "claude-opus-4-6", display_name: "Opus 4.6" },
  { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", display_name: "Haiku 4.5" },
];

// Session-level cache so we only hit /api/models once per page load.
let _modelsCache: AvailableModel[] | null = null;
let _modelsInFlight: Promise<AvailableModel[]> | null = null;

async function fetchAvailableModels(): Promise<AvailableModel[]> {
  if (_modelsCache) return _modelsCache;
  if (_modelsInFlight) return _modelsInFlight;
  _modelsInFlight = (async () => {
    try {
      const resp = await authFetch("/api/models");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const models: AvailableModel[] = Array.isArray(data.models) ? data.models : [];
      if (models.length > 0) {
        _modelsCache = models;
        return models;
      }
      return FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    } finally {
      _modelsInFlight = null;
    }
  })();
  return _modelsInFlight;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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

/** Shorten a path to just the last directory name. */
function shortCwd(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd;
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
  const [models, setModels] = useState<AvailableModel[]>(_modelsCache ?? FALLBACK_MODELS);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAvailableModels().then((list) => {
      if (!cancelled) setModels(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
          {models.map((m) => (
            <button
              key={m.id}
              className={`${styles.DropdownItem} ${m.id === currentModel ? styles.DropdownItemActive : ""}`}
              onClick={() => handleModelSelect(m.id)}
            >
              {m.display_name}
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

/** 5-hour rate limit widget. */
function RateLimit5h({ usage }: { usage: ContextUsage | null }) {
  if (usage?.rate_limit_5h == null) return <span className={styles.Tokens}>5h: --</span>;
  return <span className={styles.Tokens}>5h: {usage.rate_limit_5h.toFixed(1)}%</span>;
}

/** 7-day rate limit widget. */
function RateLimit7d({ usage }: { usage: ContextUsage | null }) {
  if (usage?.rate_limit_7d == null) return <span className={styles.Tokens}>7d: --</span>;
  return <span className={styles.Tokens}>7d: {usage.rate_limit_7d.toFixed(1)}%</span>;
}

/** Working directory widget. */
function WorkingDir({ usage }: { usage: ContextUsage | null }) {
  if (!usage?.cwd) return <span className={styles.Tokens}>--</span>;
  return <span className={styles.Tokens} title={usage.cwd}>{shortCwd(usage.cwd)}</span>;
}

/** Session duration widget. */
function Duration({ usage }: { usage: ContextUsage | null }) {
  if (!usage?.cost_duration_ms) return <span className={styles.Tokens}>--</span>;
  return <span className={styles.Tokens}>{formatDuration(usage.cost_duration_ms)}</span>;
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
    case "rateLimit5h":
      return <RateLimit5h key="rateLimit5h" usage={usage} />;
    case "rateLimit7d":
      return <RateLimit7d key="rateLimit7d" usage={usage} />;
    case "workingDir":
      return <WorkingDir key="workingDir" usage={usage} />;
    case "duration":
      return <Duration key="duration" usage={usage} />;
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
