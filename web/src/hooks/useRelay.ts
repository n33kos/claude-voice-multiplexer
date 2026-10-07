import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RelayClient } from "@vmux/client";
import type {
  ConnectedClient,
  PermissionChoice,
  PREntry,
  ServerMessage,
  ServerSessionMetadata,
  Session,
  SessionHealth,
  TaskEntry,
  TerminalDataCallback,
  TranscriptEntry,
} from "@vmux/client";
import {
  loadTranscripts,
  saveTranscripts,
  deleteTranscripts,
  loadPersistedSessions,
  savePersistedSession,
  deletePersistedSession,
  pruneStaleData,
  type PersistedSession,
} from "./useTranscriptDB";
import { authFetch } from "./useAuth";
import { embed } from "../embed";

// Protocol types live in the client SDK; re-exported for existing imports.
export type {
  AgentState,
  AgentStatus,
  AskOption,
  AskQuestion,
  ConnectedClient,
  PermissionChoice,
  PermissionRequest,
  PREntry,
  Session,
  SessionHealth,
  TaskEntry,
  TaskStatus,
  TerminalDataCallback,
  TerminalSnapshot,
  TranscriptEntry,
} from "@vmux/client";

export interface DisplaySession {
  session_id: string; // primary key — always present (hash of path)
  session_name: string; // default name from MCP server
  display_name: string; // user-set override, falls back to session_name
  dir_name: string;
  cwd: string;
  room_name: string;
  online: boolean;
  last_seen: number;
  last_interaction: number | null; // ms timestamp of last user/claude transcript entry
  connected_clients: ConnectedClient[];
  hue_override?: number; // user-set color hue (0-360)
  voice_override?: string; // per-session Kokoro voice (server-side only)
  health?: SessionHealth; // daemon-reported health (nil = not daemon-managed)
  daemon_managed?: boolean; // true if managed by vmuxd
}

function makeRoomName(sessionId: string): string {
  return `vmux_${sessionId}`;
}

/** Find the timestamp (ms) of the last user or claude transcript entry. */
function getLastInteraction(
  transcripts: Record<string, TranscriptEntry[]>,
  sessionId: string,
): number | null {
  const entries = transcripts[sessionId];
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (
      entries[i].speaker === "user" ||
      entries[i].speaker === "claude" ||
      entries[i].speaker === "code"
    ) {
      return entries[i].timestamp;
    }
  }
  return null;
}

function mergeDisplaySessions(
  live: Session[],
  persisted: PersistedSession[],
  transcripts: Record<string, TranscriptEntry[]>,
  serverMeta: ServerSessionMetadata[] = [],
): DisplaySession[] {
  const result = new Map<string, DisplaySession>();

  const serverDisplayNames = new Map(
    serverMeta
      .filter((m) => m.display_name)
      .map((m) => [m.session_id, m.display_name!]),
  );
  const serverHueOverrides = new Map(
    serverMeta
      .filter((m) => m.hue_override != null)
      .map((m) => [m.session_id, m.hue_override!]),
  );

  const displayNames = new Map(
    persisted
      .filter((p) => p.display_name)
      .map((p) => [p.session_id, p.display_name!]),
  );
  const hueOverrides = new Map(
    persisted
      .filter((p) => p.hue_override != null)
      .map((p) => [p.session_id, p.hue_override!]),
  );

  const serverVoiceOverrides = new Map(
    serverMeta
      .filter((m) => m.voice_override)
      .map((m) => [m.session_id, m.voice_override!]),
  );

  const liveIds = new Set(live.map((s) => s.session_id));

  for (const p of persisted) {
    if (!liveIds.has(p.session_id)) {
      result.set(p.session_id, {
        session_id: p.session_id,
        session_name: p.session_name,
        display_name:
          serverDisplayNames.get(p.session_id) ||
          p.display_name ||
          p.session_name,
        dir_name: p.dir_name,
        cwd: p.cwd || "",
        room_name: makeRoomName(p.session_id),
        online: false,
        last_seen: p.last_seen,
        last_interaction: getLastInteraction(transcripts, p.session_id),
        connected_clients: [],
        hue_override:
          serverHueOverrides.get(p.session_id) ?? p.hue_override,
        voice_override: serverVoiceOverrides.get(p.session_id),
        daemon_managed: p.daemon_managed,
      });
    }
  }

  for (const s of live) {
    result.set(s.session_id, {
      session_id: s.session_id,
      session_name: s.name,
      display_name:
        serverDisplayNames.get(s.session_id) ||
        displayNames.get(s.session_id) ||
        s.name,
      dir_name: s.dir_name,
      cwd: s.cwd,
      room_name: s.room_name,
      online: true,
      last_seen: s.last_heartbeat,
      last_interaction: getLastInteraction(transcripts, s.session_id),
      connected_clients: s.connected_clients || [],
      hue_override:
        serverHueOverrides.get(s.session_id) ??
        hueOverrides.get(s.session_id),
      voice_override: serverVoiceOverrides.get(s.session_id),
      health: s.health,
      daemon_managed: s.daemon_managed,
    });
  }

  return Array.from(result.values()).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const aTime = a.last_interaction ?? 0;
    const bTime = b.last_interaction ?? 0;
    return bTime - aTime;
  });
}

/**
 * The web app's relay connection: a RelayClient (web/sdk) plus what only the
 * web app does — persisting sessions and transcripts to IndexedDB and merging
 * offline sessions into the session list.
 */
export function useRelay(authenticated: boolean = true) {
  // One client for the life of the component.  REST goes through authFetch
  // (Bearer token from localStorage); the WebSocket uses the auth cookie.
  const [client] = useState(
    () =>
      new RelayClient({
        fetch: (url, init) => (init ? authFetch(url, init) : authFetch(url)),
        wsAuth: "cookie",
        lockSessionId: embed.lockedSessionId,
      }),
  );
  const state = useSyncExternalStore(client.subscribe, client.getState);

  const [persistedSessions, setPersistedSessions] = useState<PersistedSession[]>([]);
  const persistedRef = useRef(persistedSessions);
  useEffect(() => {
    persistedRef.current = persistedSessions;
  }, [persistedSessions]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const terminalDataCallbackRef = useRef<TerminalDataCallback | null>(null);

  // Load persisted sessions on mount and prune stale data
  useEffect(() => {
    pruneStaleData().then(() =>
      loadPersistedSessions().then((sessions) => setPersistedSessions(sessions)),
    );
  }, []);

  // Persist live sessions to IndexedDB as they arrive
  const persistLiveSessions = useCallback((sessions: Session[]) => {
    // Preserve existing user overrides (display_name, hue_override) when updating
    const existingOverrides = new Map(
      persistedRef.current.map((p) => [
        p.session_id,
        { display_name: p.display_name, hue_override: p.hue_override },
      ]),
    );
    for (const s of sessions) {
      const overrides = existingOverrides.get(s.session_id);
      savePersistedSession({
        session_id: s.session_id,
        session_name: s.name,
        dir_name: s.dir_name,
        cwd: s.cwd,
        last_seen: s.last_heartbeat,
        display_name: overrides?.display_name,
        hue_override: overrides?.hue_override,
        daemon_managed: s.daemon_managed,
      });
    }
    // Also update local persisted state so merge is correct
    setPersistedSessions((prev) => {
      const persistedMap = new Map(prev.map((p) => [p.session_id, p]));
      for (const s of sessions) {
        const existing = persistedMap.get(s.session_id);
        persistedMap.set(s.session_id, {
          session_id: s.session_id,
          session_name: s.name,
          dir_name: s.dir_name,
          cwd: s.cwd,
          last_seen: s.last_heartbeat,
          display_name: existing?.display_name,
          hue_override: existing?.hue_override,
          daemon_managed: s.daemon_managed,
        });
      }
      return Array.from(persistedMap.values());
    });
  }, []);

  // Debounced save to IndexedDB whenever transcripts change
  const scheduleSave = useCallback(
    (sessionId: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const entries = client.getState().transcripts[sessionId];
        if (entries) {
          // Exclude image entries — base64 data is large and doesn't need persistence
          saveTranscripts(
            sessionId,
            entries.filter((e) => e.speaker !== "image"),
          );
        }
      }, 500);
    },
    [client],
  );

  // Web-only side effects of relay messages: persistence and the terminal view.
  useEffect(() => {
    const offMessage = client.on("message", (data: ServerMessage) => {
      switch (data.type) {
        case "sessions":
          persistLiveSessions(data.sessions);
          break;
        case "session_connected": {
          // Load persisted transcripts from IndexedDB by session_id
          const sessionId = data.session_id;
          loadTranscripts(sessionId).then((dbEntries) =>
            client.hydrateTranscript(sessionId, dbEntries),
          );
          break;
        }
        case "transcript":
        case "transcript_sync":
        case "tool_result":
          scheduleSave(data.session_id);
          break;
        case "agent_status": {
          // An activity change adds a transcript entry to the connected session
          const sid = client.getState().connectedSessionId;
          if (sid && data.activity) scheduleSave(sid);
          break;
        }
      }
    });
    const offTerminal = client.on("terminalData", (data) => {
      terminalDataCallbackRef.current?.(data);
    });
    return () => {
      offMessage();
      offTerminal();
    };
  }, [client, persistLiveSessions, scheduleSave]);

  useEffect(() => {
    if (!authenticated) return;
    client.start();
    return () => {
      clearTimeout(saveTimer.current);
      client.stop();
    };
  }, [client, authenticated]);

  const connectSession = useCallback((sessionId: string) => client.connectSession(sessionId), [client]);
  const disconnectSession = useCallback(() => client.disconnectSession(), [client]);
  const interruptAgent = useCallback(() => client.interrupt(), [client]);
  const sendTextMessage = useCallback((text: string) => client.sendText(text), [client]);

  const clearTranscript = useCallback(
    (sessionId: string) => {
      client.clearTranscript(sessionId);
      deleteTranscripts(sessionId);
    },
    [client],
  );

  const removeSession = useCallback(
    (sessionId: string) => {
      // Remove from persisted sessions + IndexedDB
      deletePersistedSession(sessionId);
      deleteTranscripts(sessionId);
      setPersistedSessions((prev) => prev.filter((p) => p.session_id !== sessionId));
      client.clearTranscript(sessionId);
    },
    [client],
  );

  const updatePersisted = useCallback(
    (sessionId: string, patch: Partial<PersistedSession>) => {
      // Optimistic local update
      setPersistedSessions((prev) =>
        prev.map((p) => (p.session_id === sessionId ? { ...p, ...patch } : p)),
      );
      // Persist to IndexedDB as cache/fallback
      const existing = persistedRef.current.find((p) => p.session_id === sessionId);
      if (existing) savePersistedSession({ ...existing, ...patch });
    },
    [],
  );

  const renameSession = useCallback(
    (sessionId: string, displayName: string) => {
      updatePersisted(sessionId, { display_name: displayName || undefined });
      // Persist to server (authoritative); non-fatal if it fails
      void client.setSessionMetadata(sessionId, { display_name: displayName || null });
    },
    [client, updatePersisted],
  );

  const recolorSession = useCallback(
    (sessionId: string, hue: number | null) => {
      updatePersisted(sessionId, { hue_override: hue ?? undefined });
      void client.setSessionMetadata(sessionId, { hue_override: hue });
    },
    [client, updatePersisted],
  );

  const setSessionVoice = useCallback(
    (sessionId: string, voice: string | null) => {
      void client.setSessionMetadata(sessionId, { voice_override: voice });
    },
    [client],
  );

  const spawnSession = useCallback((cwd: string, name?: string) => client.spawnSession(cwd, name), [client]);
  const killSession = useCallback((sessionId: string) => client.killSession(sessionId), [client]);
  const restartSession = useCallback((sessionId: string) => client.restartSession(sessionId), [client]);
  const restartAllSessions = useCallback(() => client.restartAllSessions(), [client]);
  const hardInterruptSession = useCallback((sessionId: string) => client.hardInterrupt(sessionId), [client]);
  const cancelTts = useCallback((sessionId: string) => client.cancelTts(sessionId), [client]);
  const clearContextSession = useCallback((sessionId: string) => client.clearContext(sessionId), [client]);
  const compactSession = useCallback((sessionId: string) => client.compact(sessionId), [client]);
  const changeModel = useCallback((sessionId: string, model: string) => client.changeModel(sessionId, model), [client]);
  const changeEffort = useCallback((sessionId: string, level: string) => client.changeEffort(sessionId, level), [client]);

  const requestTerminalCapture = useCallback((lines = 50) => client.captureTerminal(lines), [client]);
  const dismissTerminalSnapshot = useCallback(() => client.dismissTerminalSnapshot(), [client]);
  const sendTerminalKeys = useCallback((keys: string) => client.sendTerminalKeys(keys), [client]);
  const sendTerminalSpecialKey = useCallback((key: string) => client.sendTerminalSpecialKey(key), [client]);
  const sendTerminalResize = useCallback((cols: number, rows: number) => client.resizeTerminal(cols, rows), [client]);
  const startTerminalStream = useCallback(() => client.startTerminalStream(), [client]);
  const stopTerminalStream = useCallback(() => client.stopTerminalStream(), [client]);
  const setTerminalDataCallback = useCallback((cb: TerminalDataCallback | null) => {
    terminalDataCallbackRef.current = cb;
  }, []);

  const answerQuestion = useCallback(
    (sessionId: string, optionIndex: number, label: string, entryTimestamp: number, isFinal: boolean) =>
      client.answerQuestion(sessionId, optionIndex, label, entryTimestamp, isFinal),
    [client],
  );
  const answerPermission = useCallback(
    (sessionId: string, choice: PermissionChoice) => client.answerPermission(sessionId, choice),
    [client],
  );

  // Merge live + persisted for display (server metadata takes priority)
  const displaySessions = mergeDisplaySessions(
    state.liveSessions,
    persistedSessions,
    state.transcripts,
    state.serverMetadata,
  );

  // Select transcript for connected session by session_id
  const transcript = state.connectedSessionId
    ? state.transcripts[state.connectedSessionId] || []
    : [];

  const tasks: TaskEntry[] = state.connectedSessionId
    ? state.taskLists[state.connectedSessionId] || []
    : [];

  const prs: PREntry[] = state.connectedSessionId
    ? state.prLists[state.connectedSessionId] || []
    : [];

  return {
    sessions: displaySessions,
    connectedSessionId: state.connectedSessionId,
    connectedSessionName: state.connectedSessionName,
    transcript,
    transcripts: state.transcripts,
    tasks,
    taskLists: state.taskLists,
    prs,
    prLists: state.prLists,
    status: state.status,
    agentStatus: state.agentStatus,
    disableAutoListenSeq: state.disableAutoListenSeq,
    terminalSnapshot: state.terminalSnapshot,
    terminalSnapshotLoading: state.terminalSnapshotLoading,
    /** The underlying SDK client, for speech events and other SDK features. */
    client,
    connectSession,
    disconnectSession,
    interruptAgent,
    sendTextMessage,
    clearTranscript,
    removeSession,
    renameSession,
    recolorSession,
    setSessionVoice,
    spawnSession,
    killSession,
    restartSession,
    restartAllSessions,
    hardInterruptSession,
    cancelTts,
    clearContextSession,
    compactSession,
    changeModel,
    changeEffort,
    requestTerminalCapture,
    dismissTerminalSnapshot,
    sendTerminalKeys,
    sendTerminalSpecialKey,
    sendTerminalResize,
    answerQuestion,
    answerPermission,
    startTerminalStream,
    stopTerminalStream,
    setTerminalDataCallback,
  };
}
