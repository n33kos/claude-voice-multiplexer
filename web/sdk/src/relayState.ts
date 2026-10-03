/**
 * Relay client state and the pure functions that update it.
 *
 * `reduceServerMessage` folds one /ws/client message into the state; the
 * other exported functions are local actions (optimistic updates).  All are
 * pure so they can be tested without a socket and reused by any UI layer.
 */
import type {
  AgentState,
  AgentStatus,
  AskQuestion,
  PermissionChoice,
  PermissionRequest,
  PREntry,
  ServerSessionMetadata,
  Session,
  SpokenWord,
  TaskEntry,
  TerminalSnapshot,
  TranscriptEntry,
} from "./protocol";
import { appendTranscriptEntry, mergeTranscriptLists } from "./transcript";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/** What Claude is saying (or last said) in a session. */
export interface SpeechState {
  utteranceId: string;
  messageId: string | null;
  text: string;
  /** All words received so far, timed from the utterance start (seconds). */
  words: SpokenWord[];
  /** Seconds of audio synthesized so far. */
  durationS: number;
  ended: boolean;
  cancelled: boolean;
}

export interface RelayState {
  status: ConnectionStatus;
  liveSessions: Session[];
  serverMetadata: ServerSessionMetadata[];
  connectedSessionId: string | null;
  connectedSessionName: string | null;
  transcripts: Record<string, TranscriptEntry[]>;
  taskLists: Record<string, TaskEntry[]>;
  prLists: Record<string, PREntry[]>;
  agentStatus: AgentStatus;
  /** Increments when the relay heard only noise and asks the client to stop listening. */
  disableAutoListenSeq: number;
  terminalSnapshot: TerminalSnapshot | null;
  terminalSnapshotLoading: boolean;
  speech: Record<string, SpeechState>;
}

const IDLE: AgentStatus = { state: "idle", activity: null };

export function initialRelayState(): RelayState {
  return {
    status: "disconnected",
    liveSessions: [],
    serverMetadata: [],
    connectedSessionId: null,
    connectedSessionName: null,
    transcripts: {},
    taskLists: {},
    prLists: {},
    agentStatus: IDLE,
    disableAutoListenSeq: 0,
    terminalSnapshot: null,
    terminalSnapshotLoading: false,
    speech: {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;

function transcriptEntryFrom(data: Msg): TranscriptEntry {
  return {
    speaker: data.speaker,
    text: data.text,
    session_id: data.session_id,
    timestamp: data.ts ? data.ts * 1000 : Date.now(),
    ...(data.filename ? { filename: data.filename } : {}),
    ...(data.language ? { language: data.language } : {}),
    ...(data.mime_type ? { mimeType: data.mime_type } : {}),
    ...(data.question ? { question: data.question as AskQuestion } : {}),
    ...(data.permission ? { permission: data.permission as PermissionRequest } : {}),
    ...(data.agent_id ? { agent_id: data.agent_id } : {}),
    ...(data.agent_type ? { agent_type: data.agent_type } : {}),
    ...(data.kind ? { kind: data.kind } : {}),
    ...(data.message_id ? { message_id: data.message_id } : {}),
  };
}

function syncEntryFrom(e: Msg): TranscriptEntry {
  return {
    speaker: e.speaker,
    text: e.text,
    session_id: e.session_id,
    timestamp: e.ts ? e.ts * 1000 : Date.now(),
    ...(e.filename ? { filename: e.filename } : {}),
    ...(e.language ? { language: e.language } : {}),
    ...(e.message_id ? { message_id: e.message_id } : {}),
  };
}

function withTranscript(s: RelayState, sessionId: string, entries: TranscriptEntry[]): RelayState {
  return { ...s, transcripts: { ...s.transcripts, [sessionId]: entries } };
}

/** Fold one server message into the state.  Unknown types return `s` unchanged. */
export function reduceServerMessage(s: RelayState, data: Msg, now: number = Date.now()): RelayState {
  switch (data.type) {
    case "sessions":
      return { ...s, liveSessions: data.sessions };

    case "session_connected": {
      const sessionId = data.session_id;
      const agentStatus: AgentStatus = data.current_status
        ? { state: data.current_status.state as AgentState, activity: data.current_status.activity ?? null }
        : IDLE;
      return {
        ...s,
        connectedSessionId: sessionId,
        connectedSessionName: data.session_name || sessionId,
        agentStatus,
      };
    }

    case "session_not_found":
      return { ...s, connectedSessionId: null, connectedSessionName: null };

    case "session_disconnected":
      return { ...s, connectedSessionId: null, connectedSessionName: null, agentStatus: IDLE };

    case "transcript": {
      const sessionId = data.session_id;
      return withTranscript(s, sessionId, appendTranscriptEntry(s.transcripts[sessionId] || [], transcriptEntryFrom(data)));
    }

    case "transcript_sync": {
      const sessionId = data.session_id;
      const serverEntries = ((data.entries || []) as Msg[])
        .filter((e) => e.speaker === "user" || e.speaker === "claude" || e.speaker === "code")
        .map(syncEntryFrom);
      if (serverEntries.length === 0) return s;
      return withTranscript(s, sessionId, mergeTranscriptLists(s.transcripts[sessionId] || [], serverEntries));
    }

    case "task_list":
      return { ...s, taskLists: { ...s.taskLists, [data.session_id]: (data.tasks || []) as TaskEntry[] } };

    case "pr_list":
      return { ...s, prLists: { ...s.prLists, [data.session_id]: (data.prs || []) as PREntry[] } };

    case "agent_status": {
      const activity: string | null = data.activity ?? null;
      const prevActivity = s.agentStatus.activity;
      let next: RelayState = { ...s, agentStatus: { state: data.state as AgentState, activity } };
      if (data.disable_auto_listen) {
        next = { ...next, disableAutoListenSeq: s.disableAutoListenSeq + 1 };
      }
      // Each new activity becomes a transcript entry for the connected session.
      if (activity && activity !== prevActivity && s.connectedSessionId) {
        const sessionId = s.connectedSessionId;
        const entry: TranscriptEntry = {
          speaker: "activity",
          text: activity,
          session_id: sessionId,
          timestamp: now,
          ...(data.agent_id ? { agent_id: data.agent_id as string } : {}),
          ...(data.agent_type ? { agent_type: data.agent_type as string } : {}),
          ...(data.tool_use_id ? { tool_use_id: data.tool_use_id as string } : {}),
          ...(data.tool_name ? { tool_name: data.tool_name as string } : {}),
        };
        next = withTranscript(next, sessionId, [...(s.transcripts[sessionId] || []), entry]);
      }
      return next;
    }

    case "agent_state":
      // Backward compat: flat state without activity
      return { ...s, agentStatus: { state: data.state, activity: null } };

    case "tool_result": {
      const sessionId = data.session_id as string;
      const toolUseId = data.tool_use_id as string;
      if (!sessionId || !toolUseId) return s;
      const list = s.transcripts[sessionId];
      if (!list) return s;
      const result = {
        result_text: (data.result_text as string) || "",
        lines_total: (data.lines_total as number) || 0,
        truncated: !!data.truncated,
      };
      let changed = false;
      const updated = list.map((e) => {
        if (e.tool_use_id === toolUseId && !e.tool_result) {
          changed = true;
          return { ...e, tool_result: result };
        }
        return e;
      });
      return changed ? withTranscript(s, sessionId, updated) : s;
    }

    case "terminal_snapshot":
      return {
        ...s,
        terminalSnapshotLoading: false,
        terminalSnapshot: {
          sessionId: data.session_id,
          content: data.content ?? null,
          error: data.error,
          timestamp: data.timestamp ? data.timestamp * 1000 : now,
        },
      };

    case "session_metadata_updated": {
      const meta = data.metadata as ServerSessionMetadata;
      if (!meta?.session_id) return s;
      const others = s.serverMetadata.filter((m) => m.session_id !== meta.session_id);
      // All fields null means the metadata was deleted.
      if (meta.display_name == null && meta.hue_override == null && meta.updated_at == null) {
        return { ...s, serverMetadata: others };
      }
      return { ...s, serverMetadata: [...others, meta] };
    }

    case "speech_start":
      return {
        ...s,
        speech: {
          ...s.speech,
          [data.session_id]: {
            utteranceId: data.utterance_id,
            messageId: data.message_id ?? null,
            text: data.text ?? "",
            words: [],
            durationS: 0,
            ended: false,
            cancelled: false,
          },
        },
      };

    case "speech_chunk": {
      const cur = s.speech[data.session_id];
      if (!cur || cur.utteranceId !== data.utterance_id) return s;
      return {
        ...s,
        speech: {
          ...s.speech,
          [data.session_id]: {
            ...cur,
            words: [...cur.words, ...((data.words || []) as SpokenWord[])],
            durationS: (data.offset_s ?? 0) + (data.duration_s ?? 0),
          },
        },
      };
    }

    case "speech_end": {
      const cur = s.speech[data.session_id];
      if (!cur || cur.utteranceId !== data.utterance_id) return s;
      return {
        ...s,
        speech: {
          ...s.speech,
          [data.session_id]: { ...cur, ended: true, cancelled: !!data.cancelled, durationS: data.duration_s ?? cur.durationS },
        },
      };
    }

    default:
      return s;
  }
}

// --- local actions -------------------------------------------------------------

export function connectionClosed(s: RelayState): RelayState {
  return {
    ...s,
    status: "disconnected",
    liveSessions: [],
    connectedSessionId: null,
    connectedSessionName: null,
    agentStatus: IDLE,
  };
}

export function sessionLeft(s: RelayState): RelayState {
  return { ...s, connectedSessionId: null, connectedSessionName: null, agentStatus: IDLE };
}

export function interrupted(s: RelayState): RelayState {
  return { ...s, agentStatus: IDLE };
}

/** Drop a session's transcript, tasks and PRs. */
export function sessionDataCleared(s: RelayState, sessionId: string): RelayState {
  const { [sessionId]: _t, ...transcripts } = s.transcripts;
  const { [sessionId]: _k, ...taskLists } = s.taskLists;
  const { [sessionId]: _p, ...prLists } = s.prLists;
  void _t;
  void _k;
  void _p;
  return { ...s, transcripts, taskLists, prLists };
}

/**
 * Merge entries loaded from local storage under the live ones: stored
 * entries form the base and live entries not already stored are added.
 */
export function transcriptHydrated(s: RelayState, sessionId: string, stored: TranscriptEntry[]): RelayState {
  if (stored.length === 0) return s;
  const existing = s.transcripts[sessionId] || [];
  if (existing.length === 0) return withTranscript(s, sessionId, stored);
  return withTranscript(s, sessionId, mergeTranscriptLists(stored, existing));
}

/** Mark the question card with this timestamp answered (the one the user clicked). */
export function questionAnswered(
  s: RelayState,
  sessionId: string,
  entryTimestamp: number,
  answer: { optionIndex: number; label: string },
): RelayState {
  const entries = s.transcripts[sessionId] || [];
  let updated = false;
  const next = entries.map((e) => {
    if (!updated && e.speaker === "question" && !e.answered && e.timestamp === entryTimestamp) {
      updated = true;
      return { ...e, answered: answer };
    }
    return e;
  });
  return updated ? withTranscript(s, sessionId, next) : s;
}

/** Mark the latest open permission card answered. */
export function permissionAnswered(s: RelayState, sessionId: string, choice: PermissionChoice): RelayState {
  const entries = s.transcripts[sessionId] || [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.speaker === "permission" && !e.permissionAnswered) {
      const next = entries.slice();
      next[i] = { ...e, permissionAnswered: choice };
      return withTranscript(s, sessionId, next);
    }
  }
  return s;
}

/** Live sessions with server display-name / color overrides applied. */
export function sessionsWithMetadata(s: RelayState): Array<Session & { display_name: string; hue_override?: number }> {
  const meta = new Map(s.serverMetadata.map((m) => [m.session_id, m]));
  return s.liveSessions.map((session) => {
    const m = meta.get(session.session_id);
    return {
      ...session,
      display_name: m?.display_name || session.name,
      ...(m?.hue_override != null ? { hue_override: m.hue_override } : {}),
    };
  });
}
