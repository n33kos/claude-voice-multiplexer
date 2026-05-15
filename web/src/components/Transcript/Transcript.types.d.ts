import type { TranscriptEntry, PermissionChoice, TaskEntry } from "../../hooks/useRelay";

export interface TranscriptProps {
  entries: TranscriptEntry[];
  tasks?: TaskEntry[];
  cwd?: string;
  sessionId?: string | null;
  hueOverride?: number;
  onSendText?: (text: string) => void;
  onAnswerQuestion?: (sessionId: string, optionIndex: number, label: string, entryTimestamp: number, isFinal: boolean) => void;
  onAnswerPermission?: (sessionId: string, choice: PermissionChoice) => void;
}
