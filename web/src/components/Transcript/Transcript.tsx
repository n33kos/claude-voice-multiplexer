import { useEffect, useRef, useState } from "react";
import classNames from "classnames";
import type { TranscriptProps } from "./Transcript.types";
import styles from "./Transcript.module.scss";

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

export function Transcript({ entries, onSendText }: TranscriptProps) {
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
