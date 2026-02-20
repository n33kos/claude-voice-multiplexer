import type { DisplaySession } from "../../hooks/useRelay";

export interface SessionListProps {
  sessions: DisplaySession[];
  connectedSessionId: string | null;
  connectedSessionName: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onConnect: (sessionId: string) => void;
  onDisconnect: () => void;
  onClearTranscript: (sessionId: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, displayName: string) => void;
  onRecolorSession: (sessionId: string, hue: number | null) => void;
}
