import { useEffect, useRef, useState, useMemo } from "react";
import classNames from "classnames";
import hljs from "highlight.js/lib/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sessionHue } from "../../utils/sessionHue";
import type { TranscriptProps } from "./Transcript.types";
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

export function Transcript({ entries, cwd, sessionId, hueOverride, onSendText, onAnswerQuestion, onAnswerPermission, onCaptureTerminal }: TranscriptProps & { onCaptureTerminal?: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");
  const hue = hueOverride != null ? hueOverride : (sessionId ? sessionHue(sessionId) : null);
  const sendButtonStyle = hue !== null ? { backgroundColor: `hsla(${hue}, 55%, 40%, 0.9)` } : undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "instant" });
  }, [entries.length]);

  const handleSend = () => {
    const text = textInput.trim();
    if (!text || !onSendText) return;
    onSendText(text);
    setTextInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (entries.length === 0) {
    return (
      <div data-component="Transcript" className={styles.Root}>
        <div className={styles.EmptyState}>
          Conversation will appear here
        </div>
        {onSendText && (
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
        )}
      </div>
    );
  }

  return (
    <div data-component="Transcript" className={styles.Root}>
      <div className={styles.GradientFade} />
      <div className={styles.ScrollContainer}>
        {entries.map((entry, i) => {
          if (entry.speaker === "system") {
            return (
              <div key={i} className={styles.MessageRow}>
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
              <div key={i} className={styles.MessageRow}>
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
              <div key={i} className={styles.MessageRow}>
                <span className={styles.SpeakerLabel}>
                  {q.header || "Question"}
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
                              onAnswerQuestion(sessionId, idx, opt.label);
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
            const isLatest = i === entries.length - 1;
            return (
              <div key={i} className={styles.ActivityMessage}>
                <button
                  className={classNames(styles.ActivityBadge, { [styles.ActivityBadgeClickable]: !!onCaptureTerminal })}
                  onClick={() => onCaptureTerminal?.()}
                  title={onCaptureTerminal ? "Click to view terminal" : undefined}
                >
                  <svg className={classNames(styles.ActivityIcon, { [styles.ActivityIconSpin]: isLatest })} viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {entry.text}
                </button>
              </div>
            );
          }
          if (entry.speaker === "code" || entry.speaker === "file") {
            return <CodeBlock key={i} code={entry.text} filename={entry.filename} language={entry.language} cwd={cwd} />;
          }
          if (entry.speaker === "image") {
            const dataUrl = `data:${entry.mimeType || 'image/jpeg'};base64,${entry.text}`;
            return (
              <div key={i} className={styles.ImageRow}>
                {entry.filename && <span className={styles.ImageFilename}>{entry.filename}</span>}
                <img src={dataUrl} alt={entry.filename || 'image'} className={styles.InlineImage} />
              </div>
            );
          }
          return (
            <div
              key={i}
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
                      // Only allow safe URL schemes.  Assistant text is
                      // attacker-influenceable via tool output / prompt
                      // injection; without this a javascript:... link
                      // would pass straight through ReactMarkdown.
                      urlTransform={(url) => {
                        const trimmed = (url || "").trim().toLowerCase();
                        if (/^(https?:|mailto:|tel:|vscode:|#|\/|\.\/|\.\.\/)/.test(trimmed)) {
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
                          // Block code (```...```) — render as CodeBlock
                          if (match || text.includes("\n")) {
                            return <CodeBlock code={text} language={match?.[1]} cwd={cwd} />;
                          }
                          // Inline code
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
        })}
        <div ref={endRef} />
      </div>
      {onSendText && (
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
      )}
    </div>
  );
}
