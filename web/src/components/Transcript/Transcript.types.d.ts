import type { TranscriptEntry, PermissionChoice, TaskEntry, PREntry } from "../../hooks/useRelay";

export interface TranscriptProps {
  entries: TranscriptEntry[];
  tasks?: TaskEntry[];
  prs?: PREntry[];
  cwd?: string;
  sessionId?: string | null;
  hueOverride?: number;
  onSendText?: (text: string) => void;
  onAnswerQuestion?: (sessionId: string, optionIndex: number, label: string, entryTimestamp: number, isFinal: boolean) => void;
  onAnswerPermission?: (sessionId: string, choice: PermissionChoice) => void;
}
