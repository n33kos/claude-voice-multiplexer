import type { TranscriptEntry } from "../../hooks/useRelay";

export interface TranscriptProps {
  entries: TranscriptEntry[];
  cwd?: string;
  onSendText?: (text: string) => void;
}
