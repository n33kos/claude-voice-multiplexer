import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadTranscripts,
  saveTranscripts,
  deleteTranscripts,
  loadPersistedSessions,
  savePersistedSession,
  deletePersistedSession,
  type PersistedSession,
} from './useTranscriptDB'

export interface ConnectedClient {
  client_id: string
  device_name: string
}

export interface Session {
  session_id: string
  name: string
  cwd: string
  dir_name: string
  room_name: string
  connected_clients: ConnectedClient[]
  created_at: number
  last_heartbeat: number
}

export interface DisplaySession {
  session_name: string
  display_name: string          // user-set name, falls back to session_name
  dir_name: string
  room_name: string
  online: boolean
  session_id: string | null   // null for offline-only sessions
  last_seen: number
  connected_clients: ConnectedClient[]
}

export interface TranscriptEntry {
  speaker: 'user' | 'claude' | 'system' | 'activity'
  text: string
  session_id: string
  timestamp: number
}

export type AgentState = 'idle' | 'thinking' | 'speaking' | 'error'

export interface AgentStatus {
  state: AgentState
  activity: string | null
}

interface RelayState {
  liveSessions: Session[]
  persistedSessions: PersistedSession[]
  connectedSessionId: string | null
  connectedSessionName: string | null
  transcripts: Record<string, TranscriptEntry[]>  // keyed by session name
  status: 'disconnected' | 'connecting' | 'connected'
  agentStatus: AgentStatus
}

const MAX_RECONNECT_DELAY = 10_000
const BASE_RECONNECT_DELAY = 1_000

function makeRoomName(sessionName: string): string {
  return `vmux_${sessionName.replace(/[^a-zA-Z0-9_\-]/g, '_')}`
}

function mergeDisplaySessions(
  live: Session[],
  persisted: PersistedSession[],
): DisplaySession[] {
  const byName = new Map<string, DisplaySession>()

  // Build a lookup for persisted display names
  const displayNames = new Map(
    persisted.filter(p => p.display_name).map(p => [p.session_name, p.display_name!])
  )

  // Add persisted (offline) sessions first
  for (const p of persisted) {
    byName.set(p.session_name, {
      session_name: p.session_name,
      display_name: p.display_name || p.session_name,
      dir_name: p.dir_name,
      room_name: makeRoomName(p.session_name),
      online: false,
      session_id: null,
      last_seen: p.last_seen,
      connected_clients: [],
    })
  }

  // Override with live sessions (use server-provided room_name)
  for (const s of live) {
    byName.set(s.name, {
      session_name: s.name,
      display_name: displayNames.get(s.name) || s.name,
      dir_name: s.dir_name,
      room_name: s.room_name,
      online: true,
      session_id: s.session_id,
      last_seen: s.last_heartbeat,
      connected_clients: s.connected_clients || [],
    })
  }

  // Sort: online first, then by last_seen descending
  return Array.from(byName.values()).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return b.last_seen - a.last_seen
  })
}

export function useRelay(authenticated: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttempt = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [state, setState] = useState<RelayState>({
    liveSessions: [],
    persistedSessions: [],
    connectedSessionId: null,
    connectedSessionName: null,
    transcripts: {},
    status: 'disconnected',
    agentStatus: { state: 'idle', activity: null },
  })

  const stateRef = useRef(state)
  stateRef.current = state

  // Load persisted sessions on mount
  useEffect(() => {
    loadPersistedSessions().then(sessions => {
      setState(s => ({ ...s, persistedSessions: sessions }))
    })
  }, [])

  // Persist live sessions to IndexedDB as they arrive
  const persistLiveSessions = useCallback((sessions: Session[]) => {
    // Preserve existing display_name when updating persisted sessions
    const currentPersisted = stateRef.current.persistedSessions
    const existingNames = new Map(
      currentPersisted.filter(p => p.display_name).map(p => [p.session_name, p.display_name!])
    )

    for (const s of sessions) {
      savePersistedSession({
        session_name: s.name,
        dir_name: s.dir_name,
        last_seen: s.last_heartbeat,
        display_name: existingNames.get(s.name),
      })
    }
    // Also update local persisted state so merge is correct
    setState(prev => {
      const persistedMap = new Map(
        prev.persistedSessions.map(p => [p.session_name, p])
      )
      for (const s of sessions) {
        const existing = persistedMap.get(s.name)
        persistedMap.set(s.name, {
          session_name: s.name,
          dir_name: s.dir_name,
          last_seen: s.last_heartbeat,
          display_name: existing?.display_name,
        })
      }
      return { ...prev, persistedSessions: Array.from(persistedMap.values()) }
    })
  }, [])

  // Debounced save to IndexedDB whenever transcripts change
  const scheduleSave = useCallback((sessionName: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const entries = stateRef.current.transcripts[sessionName]
      if (entries) {
        saveTranscripts(sessionName, entries)
      }
    }, 500)
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    setState(s => ({ ...s, status: 'connecting' }))

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/client`)
    wsRef.current = ws

    ws.onopen = () => {
      reconnectAttempt.current = 0
      setState(s => ({ ...s, status: 'connected' }))
    }

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const data = JSON.parse(event.data)

      switch (data.type) {
        case 'sessions':
          setState(s => ({ ...s, liveSessions: data.sessions }))
          persistLiveSessions(data.sessions)
          break
        case 'session_connected': {
          const sessionName = data.session_name || data.session_id
          setState(s => ({ ...s, connectedSessionId: data.session_id, connectedSessionName: sessionName, agentStatus: { state: 'idle', activity: null } }))
          // Load persisted transcripts from IndexedDB, merging with any
          // entries already in state (e.g. from a transcript_sync message)
          loadTranscripts(sessionName).then(dbEntries => {
            if (dbEntries.length === 0) return
            setState(s => {
              const existing = s.transcripts[sessionName] || []
              if (existing.length === 0) {
                return { ...s, transcripts: { ...s.transcripts, [sessionName]: dbEntries } }
              }
              // Merge: keep all DB entries, add any existing entries not in DB
              const merged = [...dbEntries]
              for (const entry of existing) {
                const isDupe = dbEntries.some(
                  e => e.speaker === entry.speaker &&
                    e.text === entry.text &&
                    Math.abs(e.timestamp - entry.timestamp) < 2000
                )
                if (!isDupe) merged.push(entry)
              }
              merged.sort((a, b) => a.timestamp - b.timestamp)
              return { ...s, transcripts: { ...s.transcripts, [sessionName]: merged } }
            })
          })
          break
        }
        case 'session_not_found':
          setState(s => ({ ...s, connectedSessionId: null, connectedSessionName: null }))
          break
        case 'transcript': {
          // Use session_name from server (works even when viewing a different session)
          const transcriptSessionName = data.session_name || data.session_id
          setState(s => {
            const entry: TranscriptEntry = {
              speaker: data.speaker,
              text: data.text,
              session_id: data.session_id,
              timestamp: data.ts ? data.ts * 1000 : Date.now(),
            }
            return {
              ...s,
              transcripts: {
                ...s.transcripts,
                [transcriptSessionName]: [...(s.transcripts[transcriptSessionName] || []), entry],
              },
            }
          })
          scheduleSave(transcriptSessionName)
          break
        }
        case 'transcript_sync': {
          // Merge buffered transcripts from server on reconnect
          const syncSessionName = data.session_name || data.session_id
          const serverEntries: TranscriptEntry[] = (data.entries || [])
            .filter((e: { speaker: string }) => e.speaker === 'user' || e.speaker === 'claude')
            .map((e: { speaker: string; text: string; session_id: string; ts: number }) => ({
              speaker: e.speaker as TranscriptEntry['speaker'],
              text: e.text,
              session_id: e.session_id,
              timestamp: e.ts ? e.ts * 1000 : Date.now(),
            }))
          if (serverEntries.length === 0) break
          setState(s => {
            const existing = s.transcripts[syncSessionName] || []
            // Merge: deduplicate by matching text + speaker within a 2s window
            const merged = [...existing]
            for (const entry of serverEntries) {
              const isDuplicate = existing.some(
                e => e.speaker === entry.speaker &&
                  e.text === entry.text &&
                  Math.abs(e.timestamp - entry.timestamp) < 2000
              )
              if (!isDuplicate) merged.push(entry)
            }
            // Sort by timestamp to maintain order
            merged.sort((a, b) => a.timestamp - b.timestamp)
            return {
              ...s,
              transcripts: { ...s.transcripts, [syncSessionName]: merged },
            }
          })
          scheduleSave(syncSessionName)
          break
        }
        case 'agent_status': {
          const newActivity = data.activity ?? null
          setState(s => {
            const prevActivity = s.agentStatus.activity
            const updated = { ...s, agentStatus: { state: data.state as AgentState, activity: newActivity } }
            // Add activity to transcript if it changed and is non-empty
            if (newActivity && newActivity !== prevActivity && s.connectedSessionName) {
              const sessionName = s.connectedSessionName
              const entry: TranscriptEntry = {
                speaker: 'activity',
                text: newActivity,
                session_id: s.connectedSessionId || '',
                timestamp: Date.now(),
              }
              updated.transcripts = {
                ...s.transcripts,
                [sessionName]: [...(s.transcripts[sessionName] || []), entry],
              }
            }
            return updated
          })
          // Schedule save if we added a transcript entry
          const name = stateRef.current.connectedSessionName
          if (name && data.activity) scheduleSave(name)
          break
        }
        case 'agent_state':
          // Backward compat: flat state without activity
          setState(s => ({ ...s, agentStatus: { state: data.state, activity: null } }))
          break
        case 'error':
          console.error('[relay]', data.message)
          break
      }
    }

    ws.onclose = (event) => {
      setState(s => ({ ...s, status: 'disconnected', liveSessions: [], connectedSessionId: null, connectedSessionName: null, agentStatus: { state: 'idle', activity: null } }))
      // Don't reconnect on auth failure (4001)
      if (event.code === 4001) return
      // Exponential backoff reconnect
      const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** reconnectAttempt.current, MAX_RECONNECT_DELAY)
      reconnectAttempt.current++
      reconnectTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [scheduleSave, persistLiveSessions])

  useEffect(() => {
    if (!authenticated) return
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      clearTimeout(saveTimer.current)
      wsRef.current?.close()
    }
  }, [connect, authenticated])

  const connectSession = useCallback((sessionId: string) => {
    wsRef.current?.send(JSON.stringify({
      type: 'connect_session',
      session_id: sessionId,
    }))
  }, [])

  const disconnectSession = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'disconnect_session' }))
    setState(s => ({ ...s, connectedSessionId: null, connectedSessionName: null, agentStatus: { state: 'idle', activity: null } }))
  }, [])

  const interruptAgent = useCallback(() => {
    // Force agent status to idle so the user can speak
    setState(s => ({ ...s, agentStatus: { state: 'idle', activity: null } }))
    // Tell the relay server to go idle
    wsRef.current?.send(JSON.stringify({ type: 'interrupt' }))
  }, [])

  const clearTranscript = useCallback((sessionName?: string) => {
    setState(s => {
      if (sessionName) {
        const { [sessionName]: _, ...rest } = s.transcripts
        return { ...s, transcripts: rest }
      }
      return { ...s, transcripts: {} }
    })
    if (sessionName) {
      deleteTranscripts(sessionName)
    }
  }, [])

  const removeSession = useCallback((sessionName: string) => {
    // Remove from persisted sessions + IndexedDB
    deletePersistedSession(sessionName)
    deleteTranscripts(sessionName)
    setState(s => ({
      ...s,
      persistedSessions: s.persistedSessions.filter(p => p.session_name !== sessionName),
      transcripts: (() => {
        const { [sessionName]: _, ...rest } = s.transcripts
        return rest
      })(),
    }))
  }, [])

  const renameSession = useCallback((sessionName: string, displayName: string) => {
    setState(s => ({
      ...s,
      persistedSessions: s.persistedSessions.map(p =>
        p.session_name === sessionName ? { ...p, display_name: displayName || undefined } : p
      ),
    }))
    // Persist to IndexedDB
    const existing = stateRef.current.persistedSessions.find(p => p.session_name === sessionName)
    if (existing) {
      savePersistedSession({ ...existing, display_name: displayName || undefined })
    }
  }, [])

  // Merge live + persisted for display
  const displaySessions = mergeDisplaySessions(state.liveSessions, state.persistedSessions)

  // Select transcript for connected session, or allow viewing offline transcripts by name
  const viewingSessionName = state.connectedSessionName
  const transcript = viewingSessionName
    ? state.transcripts[viewingSessionName] || []
    : []

  // Load transcript for a session name (for viewing offline sessions)
  const viewSessionTranscript = useCallback((sessionName: string) => {
    const existing = stateRef.current.transcripts[sessionName]
    if (existing) return // already loaded
    loadTranscripts(sessionName).then(entries => {
      if (entries.length > 0) {
        setState(s => ({
          ...s,
          transcripts: { ...s.transcripts, [sessionName]: entries },
        }))
      }
    })
  }, [])

  return {
    sessions: displaySessions,
    connectedSessionId: state.connectedSessionId,
    connectedSessionName: state.connectedSessionName,
    transcript,
    transcripts: state.transcripts,
    status: state.status,
    agentStatus: state.agentStatus,
    connectSession,
    disconnectSession,
    interruptAgent,
    clearTranscript,
    removeSession,
    renameSession,
    viewSessionTranscript,
  }
}
