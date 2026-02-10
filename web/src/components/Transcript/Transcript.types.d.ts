import type { TranscriptEntry } from "../../hooks/useRelay";

export interface TranscriptProps {
  entries: TranscriptEntry[];
  onSendText?: (text: string) => void;
}
