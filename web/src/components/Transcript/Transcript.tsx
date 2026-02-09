import { useEffect, useRef } from "react";
import classNames from "classnames";
import type { TranscriptProps } from "./Transcript.types";
import styles from "./Transcript.module.scss";

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
                {entry.text}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
