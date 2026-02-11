import type { TranscriptEntry } from "../../hooks/useRelay";

export interface TranscriptProps {
  entries: TranscriptEntry[];
  cwd?: string;
  sessionId?: string | null;
  onSendText?: (text: string) => void;
}
