/**
 * The voice turn / microphone state machine, shared by every UI.
 *
 * Three inputs decide what the mic and visuals should do: the relay's agent
 * state, the user's chosen mic posture, and whether the user has forced the
 * mic on to talk over Claude.  deriveVoiceState folds those into one phase so
 * color, motion, mic hardware and wake-word gating can never disagree.
 *
 * Turn model:
 *   - The user's turn is agentState "idle".
 *   - Claude's turn covers "thinking" (tool calls) and "speaking" (TTS).
 * Posture (persistent, user-chosen): auto ("active"), wake, or muted.
 *   - auto:  records on the user's turn; goes off the instant the utterance
 *            commits and stays off through Claude's whole turn; auto-returns
 *            to recording when the turn ends.
 *   - wake:  the published mic stays off; a separate stream matches the wake
 *            phrase; a match opens the mic for one utterance.  Wake matching
 *            runs only on the user's turn, so Claude's own speech can't trigger it.
 *   - muted: always off, never auto-returns.
 * Manual talk-over: the user can force the mic on during Claude's turn.  That
 * stops the TTS immediately but leaves Claude's turn running in the background.
 */
import { Emitter } from "./emitter";
import type { AgentState } from "./protocol";

export type MicMode = "muted" | "wake" | "active";

export type VoicePhase =
  | "idle_muted"
  | "wake_armed"
  | "user_listening"
  | "user_talkover"
  | "agent_thinking"
  | "agent_speaking"
  | "error";

export interface DerivedVoiceState {
  phase: VoicePhase;
  /** Whether the published mic track should be live (recording) now. */
  micShouldBeLive: boolean;
  /** Whether wake-word matching should be suspended. */
  suspendWake: boolean;
}

export function deriveVoiceState(
  agentState: AgentState,
  posture: MicMode,
  manualOverride: boolean,
  wakeActive: boolean,
): DerivedVoiceState {
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

export interface VoiceTurnState extends DerivedVoiceState {
  agentState: AgentState;
  posture: MicMode;
  /** True while the user has forced the mic on over Claude's turn. */
  manualOverride: boolean;
  /** A wake-word match opened the mic for one utterance (posture stays "wake"). */
  wakeActive: boolean;
}

/**
 * Stateful wrapper around deriveVoiceState: tracks the transient talk-over
 * and wake-listen flags and clears them at the right moments.
 *
 *   const turn = new VoiceTurn("muted");
 *   relay.on("state", (s) => turn.update(s.agentStatus.state, userCommitCount(s)));
 *   turn.on("change", (v) => mic.setEnabled(v.micShouldBeLive));
 */
export class VoiceTurn extends Emitter<{ change: VoiceTurnState }> {
  private agentState: AgentState = "idle";
  private posture: MicMode;
  private manualOverride = false;
  private wakeActive = false;
  private commitSeq: number | null = null;
  private current: VoiceTurnState;

  constructor(posture: MicMode = "muted") {
    super();
    this.posture = posture;
    this.current = this.compute();
  }

  get state(): VoiceTurnState {
    return this.current;
  }

  /**
   * Feed the relay's agent state and a counter that increments each time the
   * user commits an utterance (e.g. the number of "user" transcript entries).
   */
  update(agentState: AgentState, userCommitSeq: number): void {
    if (agentState !== this.agentState) {
      this.agentState = agentState;
      // The override lasts only for the talk-over: it clears when Claude's turn ends.
      if (agentState === "idle" || agentState === "error") this.manualOverride = false;
      // A wake listen ends once Claude takes the turn.
      if (agentState !== "idle") this.wakeActive = false;
    }
    if (this.commitSeq !== null && userCommitSeq !== this.commitSeq) {
      // The user's utterance committed: transient live states drop.
      this.manualOverride = false;
      this.wakeActive = false;
    }
    this.commitSeq = userCommitSeq;
    this.publish();
  }

  setPosture(posture: MicMode): void {
    this.posture = posture;
    this.publish();
  }

  /** Force the mic on to talk over Claude (pair with relay.interrupt()). */
  beginTalkOver(): void {
    this.manualOverride = true;
    this.publish();
  }

  /** The wake phrase matched: record this one utterance, then return to armed. */
  triggerWake(): void {
    this.wakeActive = true;
    this.publish();
  }

  /** Stop a transient user-audio state (wake listen or talk-over) now. */
  stopUserAudio(): void {
    this.manualOverride = false;
    this.wakeActive = false;
    this.publish();
  }

  private compute(): VoiceTurnState {
    return {
      ...deriveVoiceState(this.agentState, this.posture, this.manualOverride, this.wakeActive),
      agentState: this.agentState,
      posture: this.posture,
      manualOverride: this.manualOverride,
      wakeActive: this.wakeActive,
    };
  }

  private publish() {
    const next = this.compute();
    const prev = this.current;
    const same = (Object.keys(next) as Array<keyof VoiceTurnState>).every((k) => next[k] === prev[k]);
    if (same) return;
    this.current = next;
    this.emit("change", next);
  }
}
