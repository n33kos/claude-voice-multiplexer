import type { MutableRefObject } from "react";
import type { AgentStatus } from "../../hooks/useRelay";

export interface VoiceBarProps {
  agentStatus: AgentStatus;
  isMicEnabled: boolean;
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
