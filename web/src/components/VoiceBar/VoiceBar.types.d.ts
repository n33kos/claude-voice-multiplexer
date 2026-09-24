import type { MutableRefObject } from "react";
import type { VoicePhase } from "../../contexts/VoiceMachine";

export interface VoiceBarProps {
  phase: VoicePhase;
  analyserRef: MutableRefObject<AnalyserNode | null>;
  sessionColor?: RGB;
  /** Override the recording color (e.g. yellow when in wake mode). */
  micColorOverride?: RGB;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}
