import { useEffect, useRef, useState, useMemo } from "react";
import classNames from "classnames";
import hljs from "highlight.js/lib/core";
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
 */
function splitIntoParagraphs(text: string): string[] {
  // Split on sentence-ending punctuation followed by a space
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  const paragraphs: string[] = [];
  const SENTENCES_PER_PARAGRAPH = 3;

  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARAGRAPH) {
    const chunk = sentences.slice(i, i + SENTENCES_PER_PARAGRAPH).join("").trim();
    if (chunk) paragraphs.push(chunk);
  }

  return paragraphs.length > 0 ? paragraphs : [text];
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

export function Transcript({ entries, cwd, onSendText }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState("");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
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
            <input
              type="text"
              className={styles.TextInput}
              placeholder="Type a message..."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className={styles.SendButton}
              onClick={handleSend}
              disabled={!textInput.trim()}
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
              <div key={i} className={styles.SystemMessage}>
                <span className={styles.SystemBadge}>{entry.text}</span>
              </div>
            );
          }
          if (entry.speaker === "activity") {
            return (
              <div key={i} className={styles.ActivityMessage}>
                <span className={styles.ActivityBadge}>{entry.text}</span>
              </div>
            );
          }
          if (entry.speaker === "code") {
            return <CodeBlock key={i} code={entry.text} filename={entry.filename} language={entry.language} cwd={cwd} />;
          }
          // Split long responses into paragraphs (~2-3 sentences each)
          const paragraphs = entry.speaker === "claude"
            ? splitIntoParagraphs(entry.text)
            : [entry.text];
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
              >
                {paragraphs.map((p, j) => (
                  <p key={j} className={styles.Paragraph}>{p}</p>
                ))}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {onSendText && (
        <div className={styles.TextInputBar}>
          <input
            type="text"
            className={styles.TextInput}
            placeholder="Type a message..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className={styles.SendButton}
            onClick={handleSend}
            disabled={!textInput.trim()}
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
