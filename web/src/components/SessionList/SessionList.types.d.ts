import type { DisplaySession } from "../../hooks/useRelay";

export interface SessionListProps {
  sessions: DisplaySession[];
  connectedSessionId: string | null;
  connectedSessionName: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onConnect: (sessionId: string) => void;
  onDisconnect: () => void;
  onClearTranscript: (sessionName: string) => void;
  onRemoveSession: (sessionName: string) => void;
  onRenameSession: (sessionName: string, displayName: string) => void;
}
