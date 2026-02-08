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

export interface Session {
  session_id: string
  name: string
  cwd: string
  dir_name: string
  connected_client: string | null
  created_at: number
  last_heartbeat: number
}

export interface DisplaySession {
  session_name: string
  dir_name: string
  online: boolean
  session_id: string | null   // null for offline-only sessions
  last_seen: number
}

export interface TranscriptEntry {
  speaker: 'user' | 'claude' | 'system'
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

function mergeDisplaySessions(
  live: Session[],
  persisted: PersistedSession[],
): DisplaySession[] {
  const byName = new Map<string, DisplaySession>()

  // Add persisted (offline) sessions first
  for (const p of persisted) {
    byName.set(p.session_name, {
      session_name: p.session_name,
      dir_name: p.dir_name,
      online: false,
      session_id: null,
      last_seen: p.last_seen,
    })
  }

  // Override with live sessions
  for (const s of live) {
    byName.set(s.name, {
      session_name: s.name,
      dir_name: s.dir_name,
      online: true,
      session_id: s.session_id,
      last_seen: s.last_heartbeat,
    })
  }

  // Sort: online first, then by last_seen descending
  return Array.from(byName.values()).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return b.last_seen - a.last_seen
  })
}

export function useRelay() {
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
    for (const s of sessions) {
      savePersistedSession({
        session_name: s.name,
        dir_name: s.dir_name,
        last_seen: s.last_heartbeat,
      })
    }
    // Also update local persisted state so merge is correct
    setState(prev => {
      const persistedMap = new Map(
        prev.persistedSessions.map(p => [p.session_name, p])
      )
      for (const s of sessions) {
        persistedMap.set(s.name, {
          session_name: s.name,
          dir_name: s.dir_name,
          last_seen: s.last_heartbeat,
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
          setState(s => ({ ...s, connectedSessionId: data.session_id, connectedSessionName: sessionName }))
          // Load persisted transcripts from IndexedDB
          loadTranscripts(sessionName).then(entries => {
            if (entries.length > 0) {
              setState(s => ({
                ...s,
                transcripts: { ...s.transcripts, [sessionName]: entries },
              }))
            }
          })
          break
        }
        case 'session_not_found':
          setState(s => ({ ...s, connectedSessionId: null, connectedSessionName: null }))
          break
        case 'transcript':
          setState(s => {
            // Use session name for transcript keying
            const sessionName = s.connectedSessionName || data.session_id
            const entry: TranscriptEntry = {
              speaker: data.speaker,
              text: data.text,
              session_id: data.session_id,
              timestamp: Date.now(),
            }
            const updated = {
              ...s,
              transcripts: {
                ...s.transcripts,
                [sessionName]: [...(s.transcripts[sessionName] || []), entry],
              },
            }
            return updated
          })
          // Schedule persistence
          const currentName = stateRef.current.connectedSessionName
          if (currentName) scheduleSave(currentName)
          break
        case 'agent_status':
          setState(s => ({ ...s, agentStatus: { state: data.state, activity: data.activity ?? null } }))
          break
        case 'agent_state':
          // Backward compat: flat state without activity
          setState(s => ({ ...s, agentStatus: { state: data.state, activity: null } }))
          break
        case 'error':
          console.error('[relay]', data.message)
          break
      }
    }

    ws.onclose = () => {
      setState(s => ({ ...s, status: 'disconnected', liveSessions: [], connectedSessionId: null, connectedSessionName: null, agentStatus: { state: 'idle', activity: null } }))
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
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      clearTimeout(saveTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

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
    viewSessionTranscript,
  }
}
