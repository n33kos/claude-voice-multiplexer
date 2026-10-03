import type { TranscriptEntry } from "./useRelay";

/**
 * Transcript merge rules.
 *
 * Streamed assistant messages arrive as several deltas that share a
 * `message_id`; they're shown as one growing entry.  Entries without a
 * `message_id` keep the original behavior: each live event is its own
 * entry, and lists are de-duplicated by speaker + text within 2s.
 */

/** Add a live transcript event: append to its message's entry, or push a new one. */
export function appendTranscriptEntry(
  entries: TranscriptEntry[],
  entry: TranscriptEntry,
): TranscriptEntry[] {
  if (entry.message_id) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].message_id !== entry.message_id) continue;
      const next = entries.slice();
      next[i] = { ...entries[i], text: entries[i].text + entry.text };
      return next;
    }
  }
  return [...entries, entry];
}

function isSameEntry(a: TranscriptEntry, b: TranscriptEntry): boolean {
  if (a.message_id || b.message_id) return a.message_id === b.message_id;
  return (
    a.speaker === b.speaker &&
    a.text === b.text &&
    Math.abs(a.timestamp - b.timestamp) < 2000
  );
}

/**
 * Merge `incoming` into `base` (e.g. server replay into live state, or live
 * state into entries loaded from IndexedDB).  Each incoming entry is checked
 * against `base` only.  A streamed message present in both keeps the longer
 * text, since one side may have been captured mid-stream.  Sorted by time.
 */
export function mergeTranscriptLists(
  base: TranscriptEntry[],
  incoming: TranscriptEntry[],
): TranscriptEntry[] {
  const merged = base.slice();
  for (const entry of incoming) {
    const idx = base.findIndex((e) => isSameEntry(e, entry));
    if (idx === -1) {
      merged.push(entry);
    } else if (entry.message_id && entry.text.length > merged[idx].text.length) {
      merged[idx] = { ...merged[idx], text: entry.text };
    }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}
