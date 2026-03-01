import { useCallback, useEffect, useRef, useState } from "react";
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

export interface ConnectedClient {
  client_id: string;
  device_name: string;
}

export type SessionHealth =
  | "alive"
  | "standby"
  | "zombie"
  | "dead"
  | "spawn_failed";

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
  health?: SessionHealth; // daemon-reported health (nil = not daemon-managed)
  daemon_managed?: boolean; // true if managed by vmuxd
}

export interface TranscriptEntry {
  speaker:
    | "user"
    | "claude"
    | "system"
    | "activity"
    | "code"
    | "file"
    | "image";
  text: string;
  session_id: string;
  timestamp: number;
  filename?: string;
  language?: string;
  mimeType?: string;
}

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

interface RelayState {
  liveSessions: Session[];
  persistedSessions: PersistedSession[];
  connectedSessionId: string | null;
  connectedSessionName: string | null;
  transcripts: Record<string, TranscriptEntry[]>; // keyed by session_id
  status: "disconnected" | "connecting" | "connected";
  agentStatus: AgentStatus;
  disableAutoListenSeq: number; // increments when server signals noise-only input
  terminalSnapshot: TerminalSnapshot | null;
  terminalSnapshotLoading: boolean;
}

const MAX_RECONNECT_DELAY = 10_000;
const BASE_RECONNECT_DELAY = 1_000;

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
): DisplaySession[] {
  const result = new Map<string, DisplaySession>();

  // Build lookups for persisted overrides (keyed by session_id)
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

  // Track which session_ids are live
  const liveIds = new Set(live.map((s) => s.session_id));

  // Add persisted (offline) sessions — only those not currently live
  for (const p of persisted) {
    if (!liveIds.has(p.session_id)) {
      result.set(p.session_id, {
        session_id: p.session_id,
        session_name: p.session_name,
        display_name: p.display_name || p.session_name,
        dir_name: p.dir_name,
        cwd: p.cwd || "",
        room_name: makeRoomName(p.session_id),
        online: false,
        last_seen: p.last_seen,
        last_interaction: getLastInteraction(transcripts, p.session_id),
        connected_clients: [],
        hue_override: p.hue_override,
        daemon_managed: p.daemon_managed,
      });
    }
  }

  // Add live sessions (keyed by session_id — unique per directory)
  for (const s of live) {
    result.set(s.session_id, {
      session_id: s.session_id,
      session_name: s.name,
      display_name: displayNames.get(s.session_id) || s.name,
      dir_name: s.dir_name,
      cwd: s.cwd,
      room_name: s.room_name,
      online: true,
      last_seen: s.last_heartbeat,
      last_interaction: getLastInteraction(transcripts, s.session_id),
      connected_clients: s.connected_clients || [],
      hue_override: hueOverrides.get(s.session_id),
      health: s.health,
      daemon_managed: s.daemon_managed,
    });
  }

  // Sort: online first, then by last interaction descending (no interaction goes last)
  return Array.from(result.values()).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const aTime = a.last_interaction ?? 0;
    const bTime = b.last_interaction ?? 0;
    return bTime - aTime;
  });
}

// If we haven't received any message from the server in this many ms, assume the
// connection is a zombie (iOS PWA backgrounded) and force-reconnect on focus.
// A healthy connection always has traffic within the server's 30s ping interval,
// so matching that threshold catches any real suspension without false positives.
const STALE_CONNECTION_MS = 30_000;

export function useRelay(authenticated: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSessionRef = useRef<string | null>(null);
  const lastMessageTime = useRef(Date.now());
  const [state, setState] = useState<RelayState>({
    liveSessions: [],
    persistedSessions: [],
    connectedSessionId: null,
    connectedSessionName: null,
    transcripts: {},
    status: "disconnected",
    agentStatus: { state: "idle", activity: null },
    disableAutoListenSeq: 0,
    terminalSnapshot: null,
    terminalSnapshotLoading: false,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  // Load persisted sessions on mount and prune stale data
  useEffect(() => {
    pruneStaleData().then(() =>
      loadPersistedSessions().then((sessions) => {
        setState((s) => ({ ...s, persistedSessions: sessions }));
      }),
    );
  }, []);

  // Persist live sessions to IndexedDB as they arrive
  const persistLiveSessions = useCallback((sessions: Session[]) => {
    const currentPersisted = stateRef.current.persistedSessions;
    // Preserve existing user overrides (display_name, hue_override) when updating
    const existingOverrides = new Map(
      currentPersisted.map((p) => [
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
    setState((prev) => {
      const persistedMap = new Map(
        prev.persistedSessions.map((p) => [p.session_id, p]),
      );
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
      return { ...prev, persistedSessions: Array.from(persistedMap.values()) };
    });
  }, []);

  // Debounced save to IndexedDB whenever transcripts change
  const scheduleSave = useCallback((sessionId: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const entries = stateRef.current.transcripts[sessionId];
      if (entries) {
        // Exclude image entries — base64 data is large and doesn't need persistence
        saveTranscripts(
          sessionId,
          entries.filter((e) => e.speaker !== "image"),
        );
      }
    }, 500);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setState((s) => ({ ...s, status: "connecting" }));

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/client`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempt.current = 0;
      setState((s) => ({ ...s, status: "connected" }));
      // Auto-rejoin previous session after reconnect
      if (lastSessionRef.current) {
        ws.send(
          JSON.stringify({
            type: "connect_session",
            session_id: lastSessionRef.current,
          }),
        );
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      lastMessageTime.current = Date.now();
      const data = JSON.parse(event.data);

      // Debug: log transcript messages to help diagnose truncation issues
      if (data.type === "transcript") {
        console.debug("[relay:transcript]", {
          speaker: data.speaker,
          textLength: data.text?.length,
          textPreview: data.text?.slice(0, 100),
          fullText: data.text,
          rawDataLength: event.data.length,
        });
      }

      switch (data.type) {
        case "sessions":
          setState((s) => ({ ...s, liveSessions: data.sessions }));
          persistLiveSessions(data.sessions);
          break;
        case "session_connected": {
          const sessionId = data.session_id;
          const sessionName = data.session_name || sessionId;
          const currentStatus = data.current_status
            ? {
                state: data.current_status.state as AgentState,
                activity: data.current_status.activity ?? null,
              }
            : { state: "idle" as AgentState, activity: null };
          setState((s) => ({
            ...s,
            connectedSessionId: sessionId,
            connectedSessionName: sessionName,
            agentStatus: currentStatus,
          }));
          // Load persisted transcripts from IndexedDB by session_id
          loadTranscripts(sessionId).then((dbEntries) => {
            if (dbEntries.length === 0) return;
            setState((s) => {
              const existing = s.transcripts[sessionId] || [];
              if (existing.length === 0) {
                return {
                  ...s,
                  transcripts: { ...s.transcripts, [sessionId]: dbEntries },
                };
              }
              // Merge: keep all DB entries, add any existing entries not in DB
              const merged = [...dbEntries];
              for (const entry of existing) {
                const isDupe = dbEntries.some(
                  (e) =>
                    e.speaker === entry.speaker &&
                    e.text === entry.text &&
                    Math.abs(e.timestamp - entry.timestamp) < 2000,
                );
                if (!isDupe) merged.push(entry);
              }
              merged.sort((a, b) => a.timestamp - b.timestamp);
              return {
                ...s,
                transcripts: { ...s.transcripts, [sessionId]: merged },
              };
            });
          });
          break;
        }
        case "session_not_found":
          setState((s) => ({
            ...s,
            connectedSessionId: null,
            connectedSessionName: null,
          }));
          break;
        case "transcript": {
          // Key transcripts by session_id
          const sessionId = data.session_id;
          setState((s) => {
            const entry: TranscriptEntry = {
              speaker: data.speaker,
              text: data.text,
              session_id: sessionId,
              timestamp: data.ts ? data.ts * 1000 : Date.now(),
              ...(data.filename ? { filename: data.filename } : {}),
              ...(data.language ? { language: data.language } : {}),
              ...(data.mime_type ? { mimeType: data.mime_type } : {}),
            };
            return {
              ...s,
              transcripts: {
                ...s.transcripts,
                [sessionId]: [...(s.transcripts[sessionId] || []), entry],
              },
            };
          });
          scheduleSave(sessionId);
          break;
        }
        case "transcript_sync": {
          // Merge buffered transcripts from server on reconnect
          const syncSessionId = data.session_id;
          const serverEntries: TranscriptEntry[] = (data.entries || [])
            .filter(
              (e: { speaker: string }) =>
                e.speaker === "user" ||
                e.speaker === "claude" ||
                e.speaker === "code",
            )
            .map(
              (e: {
                speaker: string;
                text: string;
                session_id: string;
                ts: number;
                filename?: string;
                language?: string;
              }) => ({
                speaker: e.speaker as TranscriptEntry["speaker"],
                text: e.text,
                session_id: e.session_id,
                timestamp: e.ts ? e.ts * 1000 : Date.now(),
                ...(e.filename ? { filename: e.filename } : {}),
                ...(e.language ? { language: e.language } : {}),
              }),
            );
          if (serverEntries.length === 0) break;
          setState((s) => {
            const existing = s.transcripts[syncSessionId] || [];
            // Merge: deduplicate by matching text + speaker within a 2s window
            const merged = [...existing];
            for (const entry of serverEntries) {
              const isDuplicate = existing.some(
                (e) =>
                  e.speaker === entry.speaker &&
                  e.text === entry.text &&
                  Math.abs(e.timestamp - entry.timestamp) < 2000,
              );
              if (!isDuplicate) merged.push(entry);
            }
            // Sort by timestamp to maintain order
            merged.sort((a, b) => a.timestamp - b.timestamp);
            return {
              ...s,
              transcripts: { ...s.transcripts, [syncSessionId]: merged },
            };
          });
          scheduleSave(syncSessionId);
          break;
        }
        case "agent_status": {
          const newActivity = data.activity ?? null;
          setState((s) => {
            const prevActivity = s.agentStatus.activity;
            const updated: RelayState = {
              ...s,
              agentStatus: {
                state: data.state as AgentState,
                activity: newActivity,
              },
            };
            // Increment seq to signal auto-listen should be disabled
            if (data.disable_auto_listen) {
              updated.disableAutoListenSeq = s.disableAutoListenSeq + 1;
            }
            // Add activity to transcript if it changed and is non-empty
            if (
              newActivity &&
              newActivity !== prevActivity &&
              s.connectedSessionId
            ) {
              const sessionId = s.connectedSessionId;
              const entry: TranscriptEntry = {
                speaker: "activity",
                text: newActivity,
                session_id: sessionId,
                timestamp: Date.now(),
              };
              updated.transcripts = {
                ...s.transcripts,
                [sessionId]: [...(s.transcripts[sessionId] || []), entry],
              };
            }
            return updated;
          });
          // Schedule save if we added a transcript entry
          const sid = stateRef.current.connectedSessionId;
          if (sid && data.activity) scheduleSave(sid);
          break;
        }
        case "terminal_snapshot":
          setState((s) => ({
            ...s,
            terminalSnapshotLoading: false,
            terminalSnapshot: {
              sessionId: data.session_id,
              content: data.content ?? null,
              error: data.error,
              timestamp: data.timestamp ? data.timestamp * 1000 : Date.now(),
            },
          }));
          break;
        case "agent_state":
          // Backward compat: flat state without activity
          setState((s) => ({
            ...s,
            agentStatus: { state: data.state, activity: null },
          }));
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "session_disconnected":
          setState((s) => ({
            ...s,
            connectedSessionId: null,
            connectedSessionName: null,
            agentStatus: { state: "idle", activity: null },
          }));
          break;
        case "error":
          console.error("[relay]", data.message);
          break;
      }
    };

    ws.onclose = (event) => {
      // Save connected session for auto-rejoin on reconnect
      const prev = stateRef.current.connectedSessionId;
      if (prev) lastSessionRef.current = prev;
      setState((s) => ({
        ...s,
        status: "disconnected",
        liveSessions: [],
        connectedSessionId: null,
        connectedSessionName: null,
        agentStatus: { state: "idle", activity: null },
      }));
      // Don't reconnect on auth failure (4001)
      if (event.code === 4001) return;
      // Exponential backoff reconnect
      const delay = Math.min(
        BASE_RECONNECT_DELAY * 2 ** reconnectAttempt.current,
        MAX_RECONNECT_DELAY,
      );
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [scheduleSave, persistLiveSessions]);

  useEffect(() => {
    if (!authenticated) return;
    connect();

    // When the PWA resumes from background on iOS, the WebSocket can appear OPEN
    // to JS but be dead (server dropped it during suspend). Force-reconnect if
    // we haven't received anything since before the stale threshold.
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      const stale = Date.now() - lastMessageTime.current > STALE_CONNECTION_MS;
      if (stale && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close(); // triggers onclose → exponential-backoff reconnect
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimeout(reconnectTimer.current);
      clearTimeout(saveTimer.current);
      wsRef.current?.close();
    };
  }, [connect, authenticated]);

  const connectSession = useCallback((sessionId: string) => {
    wsRef.current?.send(
      JSON.stringify({
        type: "connect_session",
        session_id: sessionId,
      }),
    );
  }, []);

  const disconnectSession = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "disconnect_session" }));
    setState((s) => ({
      ...s,
      connectedSessionId: null,
      connectedSessionName: null,
      agentStatus: { state: "idle", activity: null },
    }));
  }, []);

  const interruptAgent = useCallback(() => {
    // Force agent status to idle so the user can speak
    setState((s) => ({ ...s, agentStatus: { state: "idle", activity: null } }));
    // Tell the relay server to go idle
    wsRef.current?.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const sendTextMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    wsRef.current?.send(
      JSON.stringify({ type: "text_message", text: text.trim() }),
    );
  }, []);

  const clearTranscript = useCallback((sessionId: string) => {
    setState((s) => {
      const { [sessionId]: _, ...rest } = s.transcripts;
      return { ...s, transcripts: rest };
    });
    deleteTranscripts(sessionId);
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    // Remove from persisted sessions + IndexedDB
    deletePersistedSession(sessionId);
    deleteTranscripts(sessionId);
    setState((s) => ({
      ...s,
      persistedSessions: s.persistedSessions.filter(
        (p) => p.session_id !== sessionId,
      ),
      transcripts: (() => {
        const { [sessionId]: _, ...rest } = s.transcripts;
        return rest;
      })(),
    }));
  }, []);

  const renameSession = useCallback(
    (sessionId: string, displayName: string) => {
      setState((s) => ({
        ...s,
        persistedSessions: s.persistedSessions.map((p) =>
          p.session_id === sessionId
            ? { ...p, display_name: displayName || undefined }
            : p,
        ),
      }));
      // Persist to IndexedDB
      const existing = stateRef.current.persistedSessions.find(
        (p) => p.session_id === sessionId,
      );
      if (existing) {
        savePersistedSession({
          ...existing,
          display_name: displayName || undefined,
        });
      }
    },
    [],
  );

  const spawnSession = useCallback(
    async (
      cwd: string,
    ): Promise<{ ok: boolean; error?: string; session_id?: string }> => {
      try {
        const resp = await authFetch("/api/sessions/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          return { ok: false, error: data.error || "Spawn failed" };
        }
        return { ok: true, session_id: data.session_id };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [],
  );

  const reconnectSession = useCallback(
    async (
      sessionId: string,
      cwd?: string,
    ): Promise<{ ok: boolean; error?: string; session_id?: string }> => {
      try {
        const resp = await authFetch("/api/sessions/reconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, cwd }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          return { ok: false, error: data.error || "Reconnect failed" };
        }
        return { ok: true, session_id: data.session_id };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [],
  );

  const killSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const resp = await authFetch(`/api/sessions/${sessionId}`, {
          method: "DELETE",
        });
        return resp.ok;
      } catch {
        return false;
      }
    },
    [],
  );

  const restartSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const resp = await authFetch(`/api/sessions/${sessionId}/restart`, {
          method: "POST",
        });
        return resp.ok;
      } catch {
        return false;
      }
    },
    [],
  );

  const hardInterruptSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const resp = await authFetch(`/api/sessions/${sessionId}/interrupt`, {
          method: "POST",
        });
        return resp.ok;
      } catch {
        return false;
      }
    },
    [],
  );

  const requestTerminalCapture = useCallback((lines = 50) => {
    setState((s) => ({ ...s, terminalSnapshotLoading: true }));
    wsRef.current?.send(JSON.stringify({ type: "capture_terminal", lines }));
  }, []);

  const sendTerminalKeys = useCallback((keys: string) => {
    wsRef.current?.send(JSON.stringify({ type: "terminal_input", keys }));
  }, []);

  const sendTerminalSpecialKey = useCallback((key: string) => {
    wsRef.current?.send(JSON.stringify({ type: "terminal_input", special_key: key }));
  }, []);

  const dismissTerminalSnapshot = useCallback(() => {
    setState((s) => ({
      ...s,
      terminalSnapshot: null,
      terminalSnapshotLoading: false,
    }));
  }, []);

  const recolorSession = useCallback(
    (sessionId: string, hue: number | null) => {
      setState((s) => ({
        ...s,
        persistedSessions: s.persistedSessions.map((p) =>
          p.session_id === sessionId
            ? { ...p, hue_override: hue ?? undefined }
            : p,
        ),
      }));
      // Persist to IndexedDB
      const existing = stateRef.current.persistedSessions.find(
        (p) => p.session_id === sessionId,
      );
      if (existing) {
        savePersistedSession({ ...existing, hue_override: hue ?? undefined });
      }
    },
    [],
  );

  // Merge live + persisted for display
  const displaySessions = mergeDisplaySessions(
    state.liveSessions,
    state.persistedSessions,
    state.transcripts,
  );

  // Select transcript for connected session by session_id
  const transcript = state.connectedSessionId
    ? state.transcripts[state.connectedSessionId] || []
    : [];

  return {
    sessions: displaySessions,
    connectedSessionId: state.connectedSessionId,
    connectedSessionName: state.connectedSessionName,
    transcript,
    transcripts: state.transcripts,
    status: state.status,
    agentStatus: state.agentStatus,
    disableAutoListenSeq: state.disableAutoListenSeq,
    terminalSnapshot: state.terminalSnapshot,
    terminalSnapshotLoading: state.terminalSnapshotLoading,
    connectSession,
    disconnectSession,
    interruptAgent,
    sendTextMessage,
    clearTranscript,
    reconnectSession,
    removeSession,
    renameSession,
    recolorSession,
    spawnSession,
    killSession,
    restartSession,
    hardInterruptSession,
    requestTerminalCapture,
    dismissTerminalSnapshot,
    sendTerminalKeys,
    sendTerminalSpecialKey,
  };
}
