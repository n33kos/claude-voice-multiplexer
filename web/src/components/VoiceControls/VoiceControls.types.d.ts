import type React from "react";
import type { AgentStatus } from "../../hooks/useRelay";
import type { MicMode } from "../../types/micMode";

export interface VoiceControlsProps {
  token: string;
  serverUrl: string;
  sessionId?: string | null;
  hueOverride?: number;
  agentStatus: AgentStatus;
  autoListen: boolean;
  speakerMuted: boolean;
  showStatusPill: boolean;
  wakeWordEnabled: boolean;
  wakeWordChime: boolean;
  wakeWordReloadKey: number;
  micMode: MicMode;
  setMicMode: (m: MicMode) => void;
  returnToWakeAfterTurn: boolean;
  setReturnToWakeAfterTurn: (v: boolean) => void;
  disableAutoListenSeq: number;
  onAutoListenChange: (value: boolean) => void;
  onSpeakerMutedChange: (value: boolean) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onInterrupt: () => void;
  onTerminalOpen: () => void;
  particleAnalyserRef?: React.MutableRefObject<AnalyserNode | null>;
}

export interface MicControlsProps {
  sessionId?: string | null;
  hueOverride?: number;
  agentStatus: AgentStatus;
  autoListen: boolean;
  speakerMuted: boolean;
  showStatusPill: boolean;
  wakeWordEnabled: boolean;
  wakeWordChime: boolean;
  wakeWordReloadKey: number;
  micMode: MicMode;
  setMicMode: (m: MicMode) => void;
  returnToWakeAfterTurn: boolean;
  setReturnToWakeAfterTurn: (v: boolean) => void;
  disableAutoListenSeq: number;
  onAutoListenChange: (value: boolean) => void;
  onSpeakerMutedChange: (value: boolean) => void;
  onInterrupt: () => void;
  onTerminalOpen: () => void;
  particleAnalyserRef?: React.MutableRefObject<AnalyserNode | null>;
}
