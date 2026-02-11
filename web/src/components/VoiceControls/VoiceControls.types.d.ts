import type { AgentStatus } from "../../hooks/useRelay";

export interface VoiceControlsProps {
  token: string;
  serverUrl: string;
  sessionId?: string | null;
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
  sessionId?: string | null;
  agentStatus: AgentStatus;
  autoListen: boolean;
  speakerMuted: boolean;
  showStatusPill: boolean;
  onAutoListenChange: (value: boolean) => void;
  onSpeakerMutedChange: (value: boolean) => void;
  onInterrupt: () => void;
}
