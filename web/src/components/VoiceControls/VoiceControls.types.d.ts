import type React from "react";
import type { AgentStatus } from "../../hooks/useRelay";
import type { MicMode } from "../../types/micMode";
import type { WakePhrase } from "../../wake-word/useWakeWord";

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
  wakeWordPhrase: WakePhrase;
  wakeWordThreshold: number;
  wakeWordDebug: boolean;
  micMode: MicMode;
  setMicMode: (m: MicMode) => void;
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
  wakeWordPhrase: WakePhrase;
  wakeWordThreshold: number;
  wakeWordDebug: boolean;
  micMode: MicMode;
  setMicMode: (m: MicMode) => void;
  disableAutoListenSeq: number;
  onAutoListenChange: (value: boolean) => void;
  onSpeakerMutedChange: (value: boolean) => void;
  onInterrupt: () => void;
  onTerminalOpen: () => void;
  particleAnalyserRef?: React.MutableRefObject<AnalyserNode | null>;
}
