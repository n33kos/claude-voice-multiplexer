import type { AgentStatus } from "../../hooks/useRelay";

export interface VoiceControlsProps {
  token: string;
  serverUrl: string;
  agentStatus: AgentStatus;
  autoListen: boolean;
  speakerMuted: boolean;
  showStatusPill: boolean;
  onAutoListenChange: (value: boolean) => void;
  onSpeakerMutedChange: (value: boolean) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onInterrupt: () => void;
}

export interface MicControlsProps {
  agentStatus: AgentStatus;
  autoListen: boolean;
  speakerMuted: boolean;
  showStatusPill: boolean;
  onAutoListenChange: (value: boolean) => void;
  onSpeakerMutedChange: (value: boolean) => void;
  onInterrupt: () => void;
}
