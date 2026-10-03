import { describe, expect, it } from "vitest";
import { deriveVoiceState, VoiceTurn } from "./voiceTurn";

describe("deriveVoiceState", () => {
  it.each([
    ["error", "active", false, false, "error", false],
    ["thinking", "active", true, false, "user_talkover", true],
    ["speaking", "active", false, false, "agent_speaking", false],
    ["thinking", "wake", false, false, "agent_thinking", false],
    ["idle", "muted", false, false, "idle_muted", false],
    ["idle", "wake", false, false, "wake_armed", false],
    ["idle", "wake", false, true, "user_listening", true],
    ["idle", "active", false, false, "user_listening", true],
    // a stale override on the user's own turn doesn't matter
    ["idle", "muted", true, false, "idle_muted", false],
  ] as const)("%s/%s override=%s wake=%s → %s", (agent, posture, override, wake, phase, live) => {
    const d = deriveVoiceState(agent, posture, override, wake);
    expect(d.phase).toBe(phase);
    expect(d.micShouldBeLive).toBe(live);
  });

  it("only lets the wake word listen while armed", () => {
    expect(deriveVoiceState("idle", "wake", false, false).suspendWake).toBe(false);
    expect(deriveVoiceState("speaking", "wake", false, false).suspendWake).toBe(true);
  });
});

describe("VoiceTurn", () => {
  it("talk-over lasts until Claude's turn ends", () => {
    const t = new VoiceTurn("active");
    t.update("speaking", 0);
    t.beginTalkOver();
    expect(t.state.phase).toBe("user_talkover");
    t.update("thinking", 0);
    expect(t.state.phase).toBe("user_talkover");
    t.update("idle", 0);
    expect(t.state.manualOverride).toBe(false);
    expect(t.state.phase).toBe("user_listening");
  });

  it("talk-over ends when the user's utterance commits", () => {
    const t = new VoiceTurn("muted");
    t.update("thinking", 3);
    t.beginTalkOver();
    t.update("thinking", 4);
    expect(t.state.phase).toBe("agent_thinking");
  });

  it("a wake listen is one utterance, then back to armed", () => {
    const t = new VoiceTurn("wake");
    t.update("idle", 0);
    expect(t.state.phase).toBe("wake_armed");
    t.triggerWake();
    expect(t.state.phase).toBe("user_listening");
    t.update("thinking", 1); // utterance committed, Claude's turn
    t.update("idle", 1);
    expect(t.state.phase).toBe("wake_armed");
  });

  it("the first update only records the commit counter", () => {
    const t = new VoiceTurn("wake");
    t.triggerWake();
    t.update("idle", 7);
    expect(t.state.wakeActive).toBe(true);
  });

  it("emits change only when something changed", () => {
    const t = new VoiceTurn("muted");
    const seen: string[] = [];
    t.on("change", (s) => seen.push(s.phase));
    t.update("idle", 0);
    t.update("idle", 0);
    t.setPosture("active");
    t.stopUserAudio();
    expect(seen).toEqual(["user_listening"]);
  });
});
