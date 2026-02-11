import type { MutableRefObject } from "react";
import type { AgentStatus } from "../../hooks/useRelay";

export interface VoiceBarProps {
  agentStatus: AgentStatus;
  isMicEnabled: boolean;
  analyserRef: MutableRefObject<AnalyserNode | null>;
  sessionColor?: RGB;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}
