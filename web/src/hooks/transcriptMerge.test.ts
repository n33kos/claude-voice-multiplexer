import { describe, expect, it } from "vitest";
import { appendTranscriptEntry, mergeTranscriptLists } from "./transcriptMerge";
import type { TranscriptEntry } from "./useRelay";

function entry(
  text: string,
  opts: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    speaker: "claude",
    text,
    session_id: "s1",
    timestamp: 1000,
    ...opts,
  };
}

describe("appendTranscriptEntry", () => {
  it("pushes entries without a message_id, even identical ones", () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptEntry(list, entry("ok"));
    list = appendTranscriptEntry(list, entry("ok"));
    expect(list.map((e) => e.text)).toEqual(["ok", "ok"]);
  });

  it("grows one entry per message_id, keeping the first timestamp", () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptEntry(list, entry("Intro:\n\n", { message_id: "m1", timestamp: 1 }));
    list = appendTranscriptEntry(list, entry("- a\n- b\n\n", { message_id: "m1", timestamp: 2 }));
    list = appendTranscriptEntry(list, entry("Done.", { message_id: "m1", timestamp: 3 }));
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("Intro:\n\n- a\n- b\n\nDone.");
    expect(list[0].timestamp).toBe(1);
  });

  it("appends to the right message when others sit in between", () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptEntry(list, entry("A", { message_id: "m1" }));
    list = appendTranscriptEntry(list, entry("Read file", { speaker: "activity" }));
    list = appendTranscriptEntry(list, entry("B", { message_id: "m1" }));
    expect(list.map((e) => e.text)).toEqual(["AB", "Read file"]);
  });

  it("keeps separate messages separate", () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptEntry(list, entry("A", { message_id: "m1" }));
    list = appendTranscriptEntry(list, entry("B", { message_id: "m2" }));
    expect(list.map((e) => e.text)).toEqual(["A", "B"]);
  });

  it("does not mutate the previous list or entry", () => {
    const first = entry("A", { message_id: "m1" });
    const before = [first];
    const after = appendTranscriptEntry(before, entry("B", { message_id: "m1" }));
    expect(before[0].text).toBe("A");
    expect(first.text).toBe("A");
    expect(after[0]).not.toBe(first);
  });
});

describe("mergeTranscriptLists", () => {
  it("dedupes plain entries by speaker + text within 2s (original rule)", () => {
    const base = [entry("hi", { timestamp: 1000 })];
    const merged = mergeTranscriptLists(base, [
      entry("hi", { timestamp: 2500 }),
      entry("hi", { timestamp: 5000 }),
    ]);
    expect(merged.map((e) => e.timestamp)).toEqual([1000, 5000]);
  });

  it("does not dedupe incoming entries against each other (original rule)", () => {
    const merged = mergeTranscriptLists([], [
      entry("ok", { timestamp: 1000 }),
      entry("ok", { timestamp: 1500 }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("matches streamed messages by id and keeps the longer text", () => {
    const partial = entry("Intro:\n\n", { message_id: "m1", timestamp: 1000 });
    const full = entry("Intro:\n\n- a\n- b", { message_id: "m1", timestamp: 1000 });
    expect(mergeTranscriptLists([partial], [full])).toEqual([full]);
    expect(mergeTranscriptLists([full], [partial])).toEqual([full]);
  });

  it("never matches a streamed message against a plain entry with the same text", () => {
    const merged = mergeTranscriptLists(
      [entry("same", { timestamp: 1000 })],
      [entry("same", { message_id: "m1", timestamp: 1000 })],
    );
    expect(merged).toHaveLength(2);
  });

  it("sorts the result by timestamp", () => {
    const merged = mergeTranscriptLists(
      [entry("b", { timestamp: 2000 })],
      [entry("a", { timestamp: 1000 }), entry("c", { timestamp: 9000 })],
    );
    expect(merged.map((e) => e.text)).toEqual(["a", "b", "c"]);
  });
});
