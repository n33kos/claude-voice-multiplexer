/**
 * Relay protocol types: what /ws/client and the REST API carry.
 *
 * Server → client JSON messages are listed in `ServerMessage`; client →
 * server messages in `ClientMessage`.  Unknown message types must be ignored
 * so the relay can add new ones without breaking older clients.
 */

export interface ConnectedClient {
  client_id: string;
  device_name: string;
}

export type SessionHealth = "alive" | "standby" | "zombie" | "dead" | "spawn_failed";

/** A live session as the relay lists it (`sessions` message, GET /api/sessions). */
export interface Session {
  session_id: string;
  name: string;
  cwd: string;
  dir_name: string;
  room_name: string;
  connected_clients: ConnectedClient[];
  created_at: number;
  last_heartbeat: number;
  health?: SessionHealth;
  daemon_managed?: boolean;
}

/** Server-side session metadata (display names, color and voice overrides). */
export interface ServerSessionMetadata {
  session_id: string;
  display_name: string | null;
  hue_override: number | null;
  /** Kokoro voice ID for this session; null uses the global voice. */
  voice_override?: string | null;
  updated_at: number | null;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
  question_index?: number;
  question_count?: number;
}

export interface PermissionRequest {
  tool_name: string;
  summary?: string;
}

export type PermissionChoice = "allow" | "allow_always" | "deny";

export type Speaker =
  | "user"
  | "claude"
  | "system"
  | "activity"
  | "code"
  | "file"
  | "image"
  | "question"
  | "permission";

export interface TranscriptEntry {
  speaker: Speaker;
  text: string;
  session_id: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  filename?: string;
  language?: string;
  mimeType?: string;
  question?: AskQuestion;
  answered?: { optionIndex: number; label: string };
  permission?: PermissionRequest;
  permissionAnswered?: PermissionChoice;
  agent_id?: string;
  agent_type?: string;
  kind?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_result?: {
    result_text: string;
    lines_total: number;
    truncated: boolean;
  };
  /** Streamed assistant messages: every delta of one message shares this id
   *  and is appended to the same entry (see transcript.ts). */
  message_id?: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskEntry {
  task_id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  teammate?: string | null;
  created_at: number;
  updated_at: number;
}

export interface PREntry {
  pr_number: number;
  url: string;
  title: string;
  created_at: number;
}

/** "idle" is the user's turn; "thinking" and "speaking" are Claude's. */
export type AgentState = "idle" | "thinking" | "speaking" | "error";

export interface AgentStatus {
  state: AgentState;
  activity: string | null;
}

export interface TerminalSnapshot {
  sessionId: string;
  content: string | null;
  error?: string;
  timestamp: number;
}

/** Callback for raw terminal data (ANSI) from streaming. */
export type TerminalDataCallback = (data: string) => void;

/** A word Claude is speaking, timed from the start of its utterance (seconds). */
export interface SpokenWord {
  word: string;
  start: number;
  end: number;
  /** Kokoro (misaki) phonemes for the word, e.g. "həlˈO", when the relay's
   *  phonemizer is running.  Stress marks: ˈ primary, ˌ secondary.
   *  Diphthongs are single letters: A=eɪ I=aɪ W=aʊ Y=ɔɪ O=oʊ; T is a flap. */
  phonemes?: string;
}

// --- server → client ---------------------------------------------------------

export interface SpeechStartMessage {
  type: "speech_start";
  session_id: string;
  utterance_id: string;
  /** The streamed transcript entry this was spoken from, if any. */
  message_id: string | null;
  /** The text as spoken (after markdown/code clean-up). */
  text: string;
  sample_rate: number;
}

export interface SpeechChunkMessage {
  type: "speech_chunk";
  session_id: string;
  utterance_id: string;
  seq: number;
  offset_s: number;
  duration_s: number;
  words: SpokenWord[];
}

export interface SpeechEndMessage {
  type: "speech_end";
  session_id: string;
  utterance_id: string;
  cancelled: boolean;
  duration_s: number;
}

export type SpeechMessage = SpeechStartMessage | SpeechChunkMessage | SpeechEndMessage;

/** Loosely typed: the relay sends many optional fields per message. */
export type ServerMessage =
  | { type: "sessions"; sessions: Session[] }
  | { type: "session_connected"; session_id: string; session_name?: string; current_status?: { state: AgentState; activity?: string | null } }
  | { type: "session_not_found"; session_id: string }
  | { type: "session_disconnected"; session_id?: string; reason?: string }
  | { type: "request_session_switch"; target_session_id: string; target_name?: string }
  | { type: "transcript"; speaker: Speaker; text: string; session_id: string; ts?: number; message_id?: string; [k: string]: unknown }
  | { type: "transcript_sync"; session_id: string; entries: Array<Record<string, unknown>> }
  | { type: "task_list"; session_id: string; tasks: TaskEntry[] }
  | { type: "pr_list"; session_id: string; prs: PREntry[] }
  | { type: "agent_status"; state: AgentState; activity?: string | null; disable_auto_listen?: boolean; agent_id?: string; agent_type?: string; tool_use_id?: string; tool_name?: string }
  | { type: "agent_state"; state: AgentState }
  | { type: "tool_result"; session_id: string; tool_use_id: string; result_text?: string; lines_total?: number; truncated?: boolean }
  | { type: "terminal_snapshot"; session_id: string; content?: string | null; error?: string; timestamp?: number }
  | { type: "terminal_data"; data: string }
  | { type: "session_metadata_updated"; metadata: ServerSessionMetadata }
  | { type: "turn-complete" }
  | { type: "ping" }
  | { type: "error"; message: string }
  | SpeechMessage;

// --- client → server ---------------------------------------------------------

export type ClientMessage =
  | { type: "connect_session"; session_id: string }
  | { type: "disconnect_session" }
  | { type: "text_message"; text: string }
  | { type: "interrupt" }
  | { type: "pong" }
  | { type: "answer_question"; session_id: string; option_index: number; submit_after: boolean }
  | { type: "answer_permission"; session_id: string; choice: PermissionChoice }
  | { type: "capture_terminal"; lines: number }
  | { type: "terminal_input"; keys?: string; special_key?: string }
  | { type: "terminal_resize"; cols: number; rows: number }
  | { type: "terminal_stream_start" }
  | { type: "terminal_stream_stop" }
  | { type: "audio_subscribe"; enabled: boolean };
