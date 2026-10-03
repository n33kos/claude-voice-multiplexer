// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentState, MicMode } from "@vmux/client";
import { VoiceMachineProvider, useVoiceMachine, type VoiceMachineState } from "./VoiceMachine";

/** Records what each render saw, to catch one-render lags. */
function harness() {
  const renders: Array<Pick<VoiceMachineState, "phase" | "micShouldBeLive">> = [];
  let machine: VoiceMachineState | null = null;
  function Probe() {
    const m = useVoiceMachine();
    machine = m;
    renders.push({ phase: m.phase, micShouldBeLive: m.micShouldBeLive });
    return null;
  }
  function App({ agentState, posture, seq }: { agentState: AgentState; posture: MicMode; seq: number }) {
    return (
      <VoiceMachineProvider agentState={agentState} posture={posture} userCommitSeq={seq}>
        <Probe />
      </VoiceMachineProvider>
    );
  }
  return { renders, App, machine: () => machine! };
}

describe("VoiceMachineProvider", () => {
  it("reflects a posture change in the same render (no stale mic state)", () => {
    const { renders, App } = harness();
    const r = render(<App agentState="idle" posture="muted" seq={0} />);
    renders.length = 0;
    r.rerender(<App agentState="idle" posture="active" seq={0} />);
    expect(renders[0]).toEqual({ phase: "user_listening", micShouldBeLive: true });
  });

  it("turns the mic off in the same render Claude starts speaking", () => {
    const { renders, App } = harness();
    const r = render(<App agentState="idle" posture="active" seq={0} />);
    renders.length = 0;
    r.rerender(<App agentState="speaking" posture="active" seq={1} />);
    expect(renders[0]).toEqual({ phase: "agent_speaking", micShouldBeLive: false });
  });

  it("talk-over holds the mic open through Claude's turn and clears after", () => {
    const { App, machine } = harness();
    const r = render(<App agentState="speaking" posture="muted" seq={0} />);
    act(() => machine().beginTalkOver());
    expect(machine().phase).toBe("user_talkover");
    r.rerender(<App agentState="thinking" posture="muted" seq={0} />);
    expect(machine().micShouldBeLive).toBe(true);
    r.rerender(<App agentState="idle" posture="muted" seq={0} />);
    expect(machine().phase).toBe("idle_muted");
    expect(machine().manualOverride).toBe(false);
  });

  it("wake listen returns to armed after the utterance commits", () => {
    const { App, machine } = harness();
    const r = render(<App agentState="idle" posture="wake" seq={0} />);
    expect(machine().phase).toBe("wake_armed");
    act(() => machine().triggerWake());
    expect(machine().phase).toBe("user_listening");
    r.rerender(<App agentState="idle" posture="wake" seq={1} />);
    expect(machine().phase).toBe("wake_armed");
  });
});
