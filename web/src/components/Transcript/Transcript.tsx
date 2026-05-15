import { memo, useEffect, useRef, useState, useMemo } from "react";
import type { CSSProperties } from "react";
import classNames from "classnames";
import hljs from "highlight.js/lib/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sessionHue } from "../../utils/sessionHue";
import type { TranscriptProps } from "./Transcript.types";
import { TaskListPanel } from "../TaskListPanel/TaskListPanel";
import { SessionPRList } from "../SessionPRList/SessionPRList";
import styles from "./Transcript.module.scss";
import "highlight.js/styles/github-dark.min.css";

// Register common languages for syntax highlighting
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import ruby from "highlight.js/lib/languages/ruby";
import markdown from "highlight.js/lib/languages/markdown";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("patch", diff);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rb", ruby);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);

/**
 * Split a long text into paragraphs of ~2-3 sentences for readability.
 * Uses a lookbehind to only split after sentence-ending punctuation followed
 * by whitespace and a capital letter, so periods in file paths (e.g. .claude/,
 * SKILL.md) don't cause incorrect splits or dropped text.
 */
function splitIntoParagraphs(text: string): string[] {
  // Split at sentence boundaries: punctuation followed by space(s) and a capital letter
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
  if (sentences.length <= 1) return [text];

  const paragraphs: string[] = [];
  const SENTENCES_PER_PARAGRAPH = 3;

  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARAGRAPH) {
    const chunk = sentences.slice(i, i + SENTENCES_PER_PARAGRAPH).join(" ").trim();
    if (chunk) paragraphs.push(chunk);
  }

  return paragraphs.length > 0 ? paragraphs : [text];
}

/** Turn URLs in text into clickable <a> elements, leaving the rest as plain text. */
function linkify(text: string): (string | React.ReactElement)[] {
  const urlRegex = /(https?:\/\/[^\s<>)"']+)/g;
  const parts: (string | React.ReactElement)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[1];
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer" className={styles.InlineLink}>
        {url}
      </a>
    );
    lastIndex = urlRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

/** Check if a filename looks like a real file path (has extension or path separator). */
function isFilePath(name: string): boolean {
  return /\.[a-zA-Z0-9]+$/.test(name) || name.includes("/");
}

function resolveFilePath(filename: string, cwd?: string): string | null {
  if (!filename || !isFilePath(filename)) return null;
  if (filename.startsWith("/")) return filename;
  if (filename.startsWith("~/")) return filename;
  if (cwd) return `${cwd.replace(/\/$/, "")}/${filename}`;
  return null;
}

function CodeBlock({ code, filename, language, cwd }: { code: string; filename?: string; language?: string; cwd?: string }) {
  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    // Auto-detect if no language specified
    const result = hljs.highlightAuto(code);
    return result.value;
  }, [code, language]);

  const absolutePath = filename ? resolveFilePath(filename, cwd) : null;
  const vscodeUrl = absolutePath ? `vscode://file${absolutePath.startsWith("/") ? "" : "/"}${absolutePath}` : null;

  return (
    <div className={styles.CodeBlockRow}>
      {filename && (
        vscodeUrl
          ? <a href={vscodeUrl} className={styles.CodeFilename}>{filename}</a>
          : <span className={styles.CodeFilename}>{filename}</span>
      )}
      <pre className={styles.CodeBlock}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

/**
 * Leaf component that owns its own `textInput` state.  Prior implementation
 * lived directly inside Transcript, which meant every keystroke re-rendered
 * the entire entries list (ReactMarkdown, hljs, regex passes, ...) and made
 * typing feel laggy on long sessions.  Lifting the state into a leaf scopes
 * keystroke re-renders to just this small component.
 */
function MessageInputBar({
  onSendText,
  sendButtonStyle,
}: {
  onSendText: (text: string) => void;
  sendButtonStyle?: CSSProperties;
}) {
  const [textInput, setTextInput] = useState("");

  const handleSend = () => {
    const text = textInput.trim();
    if (!text) return;
    onSendText(text);
    setTextInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.TextInputBar}>
      <textarea
        className={styles.TextInput}
        placeholder="Type a message..."
        rows={1}
        value={textInput}
        onChange={(e) => setTextInput(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        className={styles.SendButton}
        onClick={handleSend}
        disabled={!textInput.trim()}
        style={sendButtonStyle}
      >
        <svg className={styles.SendIcon} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
        </svg>
      </button>
    </div>
  );
}

type EntryRowProps = {
  entry: import("../../hooks/useRelay").TranscriptEntry;
  isLatest: boolean;
  cwd?: string;
  sessionId: string | null | undefined;
  hue: number | null;
  onAnswerQuestion?: (sessionId: string, optionIndex: number, label: string, entryTimestamp: number, isFinal: boolean) => void;
  onAnswerPermission?: (sessionId: string, choice: "allow" | "allow_always" | "deny") => void;
  onCaptureTerminal?: () => void;
};

/**
 * Memoized renderer for a single transcript entry.  Memo'd so unrelated
 * re-renders (e.g. a new entry arriving) don't repaint every prior entry's
 * markdown / code blocks / regex passes.  Default shallow comparison is
 * sufficient because the parent passes stable refs (entries are immutable
 * in the relay state, callbacks are useCallback'd in App.tsx and useRelay).
 */
const EntryRow = memo(function EntryRow({
  entry,
  isLatest,
  cwd,
  sessionId,
  hue,
  onAnswerQuestion,
  onAnswerPermission,
  onCaptureTerminal,
}: EntryRowProps) {
  return renderEntry(entry, isLatest, cwd, sessionId, hue, onAnswerQuestion, onAnswerPermission, onCaptureTerminal);
});

/**
 * Group consecutive transcript entries into clusters for collapsed display:
 *   - "subagent": consecutive entries sharing an agent_id
 *   - "toolcall": consecutive top-level (no agent_id) activity entries
 *   - "single":   anything else, rendered inline as before
 *
 * A toolcall group only forms when there are 2+ consecutive activity entries;
 * a lone activity stays inline so a single tool call doesn't get hidden
 * behind an expander.
 */
type EntryGroup =
  | {
      kind: "subagent";
      agentId: string;
      agentType: string | null;
      entries: import("../../hooks/useRelay").TranscriptEntry[];
      indices: number[];
    }
  | {
      kind: "toolcall";
      entries: import("../../hooks/useRelay").TranscriptEntry[];
      indices: number[];
    }
  | {
      kind: "single";
      entries: import("../../hooks/useRelay").TranscriptEntry[];
      indices: number[];
    };

function groupEntries(
  entries: import("../../hooks/useRelay").TranscriptEntry[],
  hidden: Set<number>,
): EntryGroup[] {
  // First pass: bucket by subagent vs other, preserving order.
  type Raw =
    | { kind: "subagent"; agentId: string; agentType: string | null; entries: import("../../hooks/useRelay").TranscriptEntry[]; indices: number[] }
    | { kind: "other"; entry: import("../../hooks/useRelay").TranscriptEntry; index: number };
  const raw: Raw[] = [];
  let currentSub: Extract<Raw, { kind: "subagent" }> | null = null;
  for (let i = 0; i < entries.length; i++) {
    if (hidden.has(i)) continue;
    const e = entries[i];
    const id = e.agent_id || null;
    if (id) {
      if (currentSub && currentSub.agentId === id) {
        currentSub.entries.push(e);
        currentSub.indices.push(i);
      } else {
        currentSub = {
          kind: "subagent",
          agentId: id,
          agentType: e.agent_type || null,
          entries: [e],
          indices: [i],
        };
        raw.push(currentSub);
      }
    } else {
      currentSub = null;
      raw.push({ kind: "other", entry: e, index: i });
    }
  }

  // Second pass: collapse consecutive non-subagent activity entries into a
  // toolcall group when there are 2+ in a row.
  const groups: EntryGroup[] = [];
  let i = 0;
  while (i < raw.length) {
    const item = raw[i];
    if (item.kind === "subagent") {
      groups.push(item);
      i++;
      continue;
    }
    // Walk a run of consecutive plain activity entries.
    if (item.entry.speaker === "activity") {
      let j = i;
      const runEntries: import("../../hooks/useRelay").TranscriptEntry[] = [];
      const runIndices: number[] = [];
      while (j < raw.length) {
        const next = raw[j];
        if (next.kind !== "other" || next.entry.speaker !== "activity") break;
        runEntries.push(next.entry);
        runIndices.push(next.index);
        j++;
      }
      if (runEntries.length >= 2) {
        groups.push({ kind: "toolcall", entries: runEntries, indices: runIndices });
      } else {
        groups.push({ kind: "single", entries: runEntries, indices: runIndices });
      }
      i = j;
      continue;
    }
    groups.push({ kind: "single", entries: [item.entry], indices: [item.index] });
    i++;
  }
  return groups;
}

type CollapsibleGroupShellProps = {
  label: string;
  headerText: string;
  summaryText: string;
  count: number;
  defaultExpanded: boolean;
  // When this becomes true (and the user hasn't toggled since), force the
  // group closed.  Used to auto-collapse a tool-call burst once a non-tool
  // entry follows it.
  forceCollapseSignal?: unknown;
  body: React.ReactNode;
  footer?: React.ReactNode;
};

/**
 * Generic expandable bubble used by both SubagentGroup (one subagent's run)
 * and ToolCallGroup (a burst of N tool calls at top level).  Owns its own
 * expanded state with a manual toggle that overrides external signals.
 */
const CollapsibleGroupShell = memo(function CollapsibleGroupShell({
  label,
  headerText,
  summaryText,
  count,
  defaultExpanded,
  forceCollapseSignal,
  body,
  footer,
}: CollapsibleGroupShellProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (forceCollapseSignal && !userToggledRef.current) {
      setExpanded(false);
    }
  }, [forceCollapseSignal]);
  return (
    <div className={styles.CollapsibleGroup}>
      <button
        type="button"
        className={styles.CollapsibleHeader}
        onClick={() => {
          userToggledRef.current = true;
          setExpanded((v) => !v);
        }}
      >
        <svg
          className={classNames(styles.CollapsibleChevron, {
            [styles.CollapsibleChevronOpen]: expanded,
          })}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M4 2 L8 6 L4 10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={styles.CollapsibleLabel}>{label}</span>
        <span className={styles.CollapsibleSummary}>{expanded ? headerText : summaryText}</span>
        <span className={styles.CollapsibleCount}>{count}</span>
      </button>
      {expanded && <div className={styles.CollapsibleBody}>{body}</div>}
      {expanded && footer}
    </div>
  );
});

type SubagentGroupProps = {
  agentId: string;
  agentType: string | null;
  entries: import("../../hooks/useRelay").TranscriptEntry[];
};

const SubagentGroup = memo(function SubagentGroup({
  agentType,
  entries,
}: SubagentGroupProps) {
  const startEntry = entries.find((e) => e.kind === "subagent_start");
  const stopEntry = entries.find((e) => e.kind === "subagent_stop");
  const activities = entries.filter((e) => e.speaker === "activity");
  const isRunning = !stopEntry;

  const label = agentType ? `Subagent · ${agentType}` : "Subagent";
  const headerText = startEntry?.text || `${agentType || "Subagent"} running`;
  const summaryText = stopEntry?.text || `${activities.length} step${activities.length === 1 ? "" : "s"}`;

  return (
    <CollapsibleGroupShell
      label={label}
      headerText={headerText}
      summaryText={summaryText}
      count={activities.length}
      defaultExpanded={isRunning}
      forceCollapseSignal={stopEntry ? stopEntry.timestamp : undefined}
      body={activities.map((a, i) => (
        <div key={i} className={styles.CollapsibleActivity}>
          {a.text}
        </div>
      ))}
      footer={stopEntry ? <div className={styles.CollapsibleFooter}>{stopEntry.text}</div> : undefined}
    />
  );
});

type ToolCallGroupProps = {
  entries: import("../../hooks/useRelay").TranscriptEntry[];
  // True while this group is the trailing (most recent) cluster — keeps it
  // expanded so the user sees the live burst.  Once another entry follows,
  // this flips to false and the group auto-collapses.
  isTrailing: boolean;
};

const ToolCallGroup = memo(function ToolCallGroup({
  entries,
  isTrailing,
}: ToolCallGroupProps) {
  const count = entries.length;
  const last = entries[entries.length - 1];
  const summaryText = last?.text || "";
  return (
    <CollapsibleGroupShell
      label={`${count} tool call${count === 1 ? "" : "s"}`}
      headerText={summaryText}
      summaryText={summaryText}
      count={count}
      defaultExpanded={isTrailing}
      forceCollapseSignal={!isTrailing ? "done" : undefined}
      body={entries.map((a, i) => (
        <div key={i} className={styles.CollapsibleActivity}>
          <ActivityRow entry={a} isLatest={false} />
        </div>
      ))}
    />
  );
});

/** Pick a hljs language hint for a tool's captured output. */
function languageForTool(toolName: string | undefined): string | undefined {
  switch (toolName) {
    case "Bash":
      return "bash";
    case "Edit":
    case "Write":
      return "diff";
    default:
      return undefined;
  }
}

type ToolCallDetailProps = {
  toolName?: string;
  result: NonNullable<import("../../hooks/useRelay").TranscriptEntry["tool_result"]>;
};

const ToolCallDetail = memo(function ToolCallDetail({ toolName, result }: ToolCallDetailProps) {
  const lang = languageForTool(toolName);
  let html: string | null = null;
  if (lang) {
    try {
      html = hljs.highlight(result.result_text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      html = null;
    }
  }
  return (
    <div className={styles.ToolCallDetail}>
      <pre className={styles.ToolCallPre}>
        {html ? (
          <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{result.result_text}</code>
        )}
      </pre>
      {result.truncated && (
        <div className={styles.ToolCallTruncated}>
          Output truncated{result.lines_total ? ` (${result.lines_total} lines total)` : ""}
        </div>
      )}
    </div>
  );
});

type ActivityRowProps = {
  entry: import("../../hooks/useRelay").TranscriptEntry;
  isLatest: boolean;
  onCaptureTerminal?: () => void;
};

const ActivityRow = memo(function ActivityRow({ entry, isLatest, onCaptureTerminal }: ActivityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = !!entry.tool_result;
  const handleClick = () => {
    if (hasResult) {
      setExpanded((v) => !v);
    } else if (onCaptureTerminal) {
      onCaptureTerminal();
    }
  };
  return (
    <div className={styles.ActivityMessage}>
      <button
        className={classNames(styles.ActivityBadge, { [styles.ActivityBadgeClickable]: hasResult || !!onCaptureTerminal })}
        onClick={handleClick}
        title={hasResult ? (expanded ? "Hide output" : "Show output") : onCaptureTerminal ? "Click to view terminal" : undefined}
      >
        <svg className={classNames(styles.ActivityIcon, { [styles.ActivityIconSpin]: isLatest && !hasResult })} viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {entry.text}
        {hasResult && (
          <svg
            className={classNames(styles.ActivityChevron, { [styles.ActivityChevronOpen]: expanded })}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M4 2 L8 6 L4 10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {hasResult && expanded && entry.tool_result && (
        <ToolCallDetail toolName={entry.tool_name} result={entry.tool_result} />
      )}
    </div>
  );
});

export function Transcript({ entries, tasks, prs, cwd, sessionId, hueOverride, onSendText, onAnswerQuestion, onAnswerPermission, onCaptureTerminal }: TranscriptProps & { onCaptureTerminal?: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  const hue = hueOverride != null ? hueOverride : (sessionId ? sessionHue(sessionId) : null);
  const sendButtonStyle = hue !== null ? { backgroundColor: `hsla(${hue}, 55%, 40%, 0.9)` } : undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "instant" });
  }, [entries.length]);

  // Multi-question AskUserQuestion arrives as N broadcasts up-front, but the
  // terminal-side picker is strictly sequential.  Hide questions whose prior
  // sibling (question_index - 1, same question_count) is still unanswered so
  // the user can only click the currently-active prompt.
  // NOTE: must run BEFORE the early-return below — hooks can't be conditional.
  const hiddenEntries = useMemo(() => {
    const hidden = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.speaker !== "question" || !e.question) continue;
      const qc = e.question.question_count ?? 1;
      const qi = e.question.question_index ?? 0;
      if (qc <= 1 || qi === 0) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = entries[j];
        if (prev.speaker !== "question" || !prev.question) continue;
        const pqc = prev.question.question_count ?? 1;
        const pqi = prev.question.question_index ?? 0;
        if (pqc === qc && pqi === qi - 1) {
          if (!prev.answered) hidden.add(i);
          break;
        }
      }
    }
    return hidden;
  }, [entries]);

  const taskPanel =
    tasks && tasks.length > 0 ? <TaskListPanel tasks={tasks} /> : null;
  const prPanel =
    prs && prs.length > 0 ? <SessionPRList prs={prs} /> : null;

  if (entries.length === 0) {
    return (
      <div data-component="Transcript" className={styles.Root}>
        <div className={styles.EmptyState}>
          Conversation will appear here
        </div>
        {taskPanel}
        {prPanel}
        {onSendText && <MessageInputBar onSendText={onSendText} sendButtonStyle={sendButtonStyle} />}
      </div>
    );
  }

  return (
    <div data-component="Transcript" className={styles.Root}>
      <div className={styles.GradientFade} />
      <div className={styles.ScrollContainer}>
        {(() => {
          const groups = groupEntries(entries, hiddenEntries);
          return groups.map((g, gi) => {
            if (g.kind === "subagent") {
              return (
                <SubagentGroup
                  key={`sub-${gi}-${g.agentId}`}
                  agentId={g.agentId}
                  agentType={g.agentType}
                  entries={g.entries}
                />
              );
            }
            if (g.kind === "toolcall") {
              const isTrailing = gi === groups.length - 1;
              const firstIdx = g.indices[0];
              return (
                <ToolCallGroup
                  key={`tools-${firstIdx}-${g.entries.length}`}
                  entries={g.entries}
                  isTrailing={isTrailing}
                />
              );
            }
            return g.entries.map((entry, k) => {
              const i = g.indices[k];
              return (
                <EntryRow
                  key={i}
                  entry={entry}
                  isLatest={i === entries.length - 1}
                  cwd={cwd}
                  sessionId={sessionId}
                  hue={hue}
                  onAnswerQuestion={onAnswerQuestion}
                  onAnswerPermission={onAnswerPermission}
                  onCaptureTerminal={onCaptureTerminal}
                />
              );
            });
          });
        })()}
        {taskPanel}
        {prPanel}
        <div ref={endRef} />
      </div>
      {onSendText && <MessageInputBar onSendText={onSendText} sendButtonStyle={sendButtonStyle} />}
    </div>
  );
}

/**
 * The big switch over entry types — extracted so EntryRow's React.memo can
 * call it without affecting the JSX shape.  Each branch returns a JSX node.
 */
function renderEntry(
  entry: import("../../hooks/useRelay").TranscriptEntry,
  isLatest: boolean,
  cwd: string | undefined,
  sessionId: string | null | undefined,
  hue: number | null,
  onAnswerQuestion: ((sessionId: string, optionIndex: number, label: string, entryTimestamp: number, isFinal: boolean) => void) | undefined,
  onAnswerPermission: ((sessionId: string, choice: "allow" | "allow_always" | "deny") => void) | undefined,
  onCaptureTerminal: (() => void) | undefined,
): React.ReactElement {
  if (entry.speaker === "system") {
    return (
      <div className={styles.MessageRow}>
        <span className={styles.SpeakerLabel}>
          <svg className={styles.AgentIcon} viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h9a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0015.75 4.5h-9A2.25 2.25 0 004.5 6.75v10.5A2.25 2.25 0 006.75 19.5z" />
          </svg>
          Background Agent
        </span>
        <div className={classNames(styles.Bubble, styles.BubbleSystem)}>
          <p className={styles.Paragraph}>{entry.text}</p>
        </div>
      </div>
    );
  }
  if (entry.speaker === "permission" && entry.permission) {
    const p = entry.permission;
    const answered = entry.permissionAnswered;
    const choices: { id: "allow" | "allow_always" | "deny"; label: string; desc: string; danger?: boolean }[] = [
      { id: "allow", label: "Allow once", desc: "Approve this single call" },
      { id: "allow_always", label: "Allow for session", desc: "Don't ask again this session" },
      { id: "deny", label: "Deny", desc: "Cancel and let Claude try differently", danger: true },
    ];
    return (
      <div className={styles.MessageRow}>
        <span className={styles.SpeakerLabel}>Permission needed</span>
        <div className={classNames(styles.Bubble, styles.BubblePermission)}>
          <p className={styles.QuestionText}>
            Claude wants to use <code className={styles.InlineCode}>{p.tool_name}</code>
          </p>
          {p.summary && <p className={styles.PermissionSummary}>{p.summary}</p>}
          <div className={styles.OptionList}>
            {choices.map((c) => {
              const isSelected = answered === c.id;
              const isDisabled = !!answered;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={isDisabled || !onAnswerPermission || !sessionId}
                  onClick={() => {
                    if (onAnswerPermission && sessionId) {
                      onAnswerPermission(sessionId, c.id);
                    }
                  }}
                  className={classNames(styles.OptionButton, {
                    [styles.OptionButtonSelected]: isSelected,
                    [styles.OptionButtonFaded]: isDisabled && !isSelected,
                    [styles.OptionButtonDanger]: c.danger,
                  })}
                >
                  <span className={styles.OptionContent}>
                    <span className={styles.OptionLabel}>{c.label}</span>
                    <span className={styles.OptionDescription}>{c.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {answered && (
            <p className={styles.QuestionAnsweredNote}>
              {answered === "allow" && "Allowed once."}
              {answered === "allow_always" && "Allowed for the rest of this session."}
              {answered === "deny" && "Denied."}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (entry.speaker === "question" && entry.question) {
    const q = entry.question;
    const answered = entry.answered;
    return (
      <div className={styles.MessageRow}>
        <span className={styles.SpeakerLabel}>
          {q.header || "Question"}
          {q.question_count && q.question_count > 1
            ? ` (${(q.question_index ?? 0) + 1} of ${q.question_count})`
            : ""}
        </span>
        <div className={classNames(styles.Bubble, styles.BubbleQuestion)}>
          <p className={styles.QuestionText}>{q.question}</p>
          <div className={styles.OptionList}>
            {q.options.map((opt, idx) => {
              const isSelected = answered?.optionIndex === idx;
              const isDisabled = !!answered;
              return (
                <button
                  key={idx}
                  type="button"
                  disabled={isDisabled || !onAnswerQuestion || !sessionId}
                  onClick={() => {
                    if (onAnswerQuestion && sessionId) {
                      const qc = q.question_count ?? 1;
                      const qi = q.question_index ?? 0;
                      const isFinal = qi + 1 >= qc;
                      onAnswerQuestion(sessionId, idx, opt.label, entry.timestamp, isFinal);
                    }
                  }}
                  className={classNames(styles.OptionButton, {
                    [styles.OptionButtonSelected]: isSelected,
                    [styles.OptionButtonFaded]: isDisabled && !isSelected,
                  })}
                >
                  <span className={styles.OptionNumber}>{idx + 1}</span>
                  <span className={styles.OptionContent}>
                    <span className={styles.OptionLabel}>{opt.label}</span>
                    {opt.description && (
                      <span className={styles.OptionDescription}>{opt.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {answered && (
            <p className={styles.QuestionAnsweredNote}>Answered: {answered.label}</p>
          )}
        </div>
      </div>
    );
  }
  if (entry.speaker === "activity") {
    return (
      <ActivityRow
        entry={entry}
        isLatest={isLatest}
        onCaptureTerminal={onCaptureTerminal}
      />
    );
  }
  if (entry.speaker === "code" || entry.speaker === "file") {
    return <CodeBlock code={entry.text} filename={entry.filename} language={entry.language} cwd={cwd} />;
  }
  if (entry.speaker === "image") {
    const dataUrl = `data:${entry.mimeType || 'image/jpeg'};base64,${entry.text}`;
    return (
      <div className={styles.ImageRow}>
        {entry.filename && <span className={styles.ImageFilename}>{entry.filename}</span>}
        <img src={dataUrl} alt={entry.filename || 'image'} className={styles.InlineImage} />
      </div>
    );
  }
  return (
    <div
      className={classNames(styles.MessageRow, {
        [styles.MessageRowUser]: entry.speaker === "user",
      })}
    >
      <span className={styles.SpeakerLabel}>
        {entry.speaker === "user" ? "You" : "Claude"}
      </span>
      <div
        className={classNames(
          styles.Bubble,
          entry.speaker === "user" ? styles.BubbleUser : styles.BubbleClaude,
        )}
        style={entry.speaker === "user" && hue !== null ? {
          backgroundColor: `hsla(${hue}, 55%, 35%, 0.85)`,
        } : undefined}
      >
        {entry.speaker === "claude" ? (
          <div className={styles.Markdown}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={(url) => {
                const trimmed = (url || "").trim().toLowerCase();
                if (/^(https?:|data:image\/|mailto:|tel:|vscode:|#|\/|\.\/|\.\.\/)/.test(trimmed)) {
                  return url;
                }
                return "";
              }}
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className={styles.InlineLink}>
                    {children}
                  </a>
                ),
                code: ({ className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || "");
                  const text = String(children).replace(/\n$/, "");
                  if (match || text.includes("\n")) {
                    return <CodeBlock code={text} language={match?.[1]} cwd={cwd} />;
                  }
                  return <code className={styles.InlineCode} {...props}>{children}</code>;
                },
              }}
            >
              {entry.text}
            </ReactMarkdown>
          </div>
        ) : (
          splitIntoParagraphs(entry.text).map((p, j) => (
            <p key={j} className={styles.Paragraph}>{linkify(p)}</p>
          ))
        )}
      </div>
    </div>
  );
}

