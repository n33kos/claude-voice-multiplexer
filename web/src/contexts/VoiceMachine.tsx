import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { deriveVoiceState, VoiceTurn } from "@vmux/client";
import type { AgentState, MicMode, VoicePhase } from "@vmux/client";

/**
 * React binding for the SDK's voice turn state machine (VoiceTurn in
 * web/sdk/src/voiceTurn.ts): single source of truth for the voice turn /
 * microphone state, shared by color, motion, mic hardware and wake gating.
 */
export type { VoicePhase };

export interface VoiceMachineState {
  phase: VoicePhase;
  /** Whether the published LiveKit mic track should be live (recording) now. */
  micShouldBeLive: boolean;
  /** Whether wake-word matching should be suspended. */
  suspendWake: boolean;
  /** True while the user has forced the mic on over Claude's turn. */
  manualOverride: boolean;
  /** Force the mic on to talk over Claude.  Callers pair this with the TTS
   *  cancel so Claude stops speaking; the turn itself keeps running. */
  beginTalkOver: () => void;
  /** Wake-word matched: record this one utterance, then return to armed. */
  triggerWake: () => void;
  /** Stop a transient user-audio state (wake listen or talk-over) now. */
  stopUserAudio: () => void;
}

const VoiceMachineContext = createContext<VoiceMachineState | null>(null);

export function useVoiceMachine(): VoiceMachineState {
  const ctx = useContext(VoiceMachineContext);
  if (!ctx) {
    throw new Error("useVoiceMachine must be used within a VoiceMachineProvider");
  }
  return ctx;
}

export function VoiceMachineProvider({
  agentState,
  posture,
  userCommitSeq,
  children,
}: {
  agentState: AgentState;
  posture: MicMode;
  /** Increments each time the user commits an utterance (a new user transcript). */
  userCommitSeq: number;
  children: ReactNode;
}) {
  // VoiceTurn keeps the transient flags (talk-over, wake listen) and clears
  // them when Claude's turn starts/ends or the user's utterance commits.
  const [turn] = useState(() => new VoiceTurn(posture));
  const subscribe = useCallback((cb: () => void) => turn.on("change", cb), [turn]);
  const { manualOverride, wakeActive } = useSyncExternalStore(subscribe, () => turn.state);

  useEffect(() => {
    turn.update(agentState, userCommitSeq);
  }, [turn, agentState, userCommitSeq]);

  // The phase is derived during render from the current props, so a posture
  // or agent-state change is reflected in the same render (the mic effect in
  // MicControls must never see a stale micShouldBeLive).
  const derived = deriveVoiceState(agentState, posture, manualOverride, wakeActive);

  const beginTalkOver = useCallback(() => turn.beginTalkOver(), [turn]);
  const triggerWake = useCallback(() => turn.triggerWake(), [turn]);
  const stopUserAudio = useCallback(() => turn.stopUserAudio(), [turn]);

  const value: VoiceMachineState = {
    ...derived,
    manualOverride,
    beginTalkOver,
    triggerWake,
    stopUserAudio,
  };

  return (
    <VoiceMachineContext.Provider value={value}>
      {children}
    </VoiceMachineContext.Provider>
  );
}
