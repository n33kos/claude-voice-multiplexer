import type { TranscriptEntry, PermissionChoice } from "../../hooks/useRelay";

export interface TranscriptProps {
  entries: TranscriptEntry[];
  cwd?: string;
  sessionId?: string | null;
  hueOverride?: number;
  onSendText?: (text: string) => void;
  onAnswerQuestion?: (sessionId: string, optionIndex: number, label: string) => void;
  onAnswerPermission?: (sessionId: string, choice: PermissionChoice) => void;
}
