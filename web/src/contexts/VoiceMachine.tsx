import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentState } from "../hooks/useRelay";
import type { MicMode } from "../types/micMode";

/**
 * Single source of truth for the voice turn / microphone state.
 *
 * The UI has three independent inputs that used to be recombined by hand in
 * each component (and drifted): the relay's agent state, the user's chosen mic
 * posture, and whether the user has forced the mic on to talk over Claude.
 * deriveVoiceState folds those into one phase so color, motion, mic hardware,
 * and wake-word gating can never disagree.
 *
 * Turn model:
 *   - The user's turn is agentState "idle".
 *   - Claude's turn covers "thinking" (tool calls) and "speaking" (TTS).
 * Posture (persistent, user-chosen): auto ("active"), wake, or muted.
 *   - auto:  records on the user's turn; goes off the instant the utterance
 *            commits and stays off through Claude's whole turn; auto-returns
 *            to recording when the turn ends.
 *   - wake:  the published mic stays off; a separate stream matches "hey
 *            claude"; a match flips posture to active.  Wake matching runs
 *            only on the user's turn, so Claude's own speech can't trigger it.
 *   - muted: always off, never auto-returns.
 * Manual talk-over: the user can force the mic on during Claude's turn.  That
 * stops the TTS immediately but leaves Claude's turn running in the background.
 */
export type VoicePhase =
  | "idle_muted"
  | "wake_armed"
  | "user_listening"
  | "user_talkover"
  | "agent_thinking"
  | "agent_speaking"
  | "error";

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

export function deriveVoiceState(
  agentState: AgentState,
  posture: MicMode,
  manualOverride: boolean,
  wakeActive: boolean,
): { phase: VoicePhase; micShouldBeLive: boolean; suspendWake: boolean } {
  const claudeTurn = agentState === "thinking" || agentState === "speaking";

  if (agentState === "error") {
    return { phase: "error", micShouldBeLive: false, suspendWake: true };
  }
  if (manualOverride && claudeTurn) {
    return { phase: "user_talkover", micShouldBeLive: true, suspendWake: true };
  }
  if (agentState === "speaking") {
    return { phase: "agent_speaking", micShouldBeLive: false, suspendWake: true };
  }
  if (agentState === "thinking") {
    return { phase: "agent_thinking", micShouldBeLive: false, suspendWake: true };
  }
  // Idle == the user's turn.
  if (posture === "muted") {
    return { phase: "idle_muted", micShouldBeLive: false, suspendWake: true };
  }
  if (posture === "wake") {
    // The posture stays "wake"; a wake-word match only transiently opens the
    // mic for one utterance (wakeActive), then it returns to armed.
    if (wakeActive) {
      return { phase: "user_listening", micShouldBeLive: true, suspendWake: true };
    }
    return { phase: "wake_armed", micShouldBeLive: false, suspendWake: false };
  }
  return { phase: "user_listening", micShouldBeLive: true, suspendWake: true };
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
  const [manualOverride, setManualOverride] = useState(false);
  // Transient: a wake-word match opened the mic for one utterance while the
  // posture stays "wake".  Cleared when the utterance commits or Claude takes
  // the turn, so wake mode returns to armed instead of sticking on hot-mic.
  const [wakeActive, setWakeActive] = useState(false);

  // The override lasts only for the talk-over: it clears when Claude's turn
  // ends (back to the user) ...
  useEffect(() => {
    if (agentState === "idle" || agentState === "error") {
      setManualOverride(false);
    }
    // A wake listen ends once Claude takes the turn; the utterance has been
    // captured and the mic should return to armed after the turn.
    if (agentState !== "idle") {
      setWakeActive(false);
    }
  }, [agentState]);

  // ... and when the user commits an utterance, so the transient live states
  // drop and the mic returns to its resting posture.
  const prevCommit = useRef(userCommitSeq);
  useEffect(() => {
    if (userCommitSeq !== prevCommit.current) {
      prevCommit.current = userCommitSeq;
      setManualOverride(false);
      setWakeActive(false);
    }
  }, [userCommitSeq]);

  const derived = deriveVoiceState(agentState, posture, manualOverride, wakeActive);

  const beginTalkOver = useCallback(() => setManualOverride(true), []);
  const triggerWake = useCallback(() => setWakeActive(true), []);
  const stopUserAudio = useCallback(() => {
    setManualOverride(false);
    setWakeActive(false);
  }, []);

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
