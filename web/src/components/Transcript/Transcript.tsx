import { useEffect, useRef } from "react";
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

export function Transcript({ entries }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div data-component="Transcript" className={styles.EmptyState}>
        Conversation will appear here
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
    </div>
  );
}
