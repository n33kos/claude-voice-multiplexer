import { useCallback, useEffect, useRef, useState } from 'react'

export interface Session {
  session_id: string
  name: string
  cwd: string
  dir_name: string
  connected_client: string | null
  last_heartbeat: number
}

export interface TranscriptEntry {
  speaker: 'user' | 'claude'
  text: string
  session_id: string
  timestamp: number
}

interface RelayState {
  sessions: Session[]
  connectedSessionId: string | null
  transcript: TranscriptEntry[]
  status: 'disconnected' | 'connecting' | 'connected'
}

export function useRelay() {
  const wsRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<RelayState>({
    sessions: [],
    connectedSessionId: null,
    transcript: [],
    status: 'disconnected',
  })

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    setState(s => ({ ...s, status: 'connecting' }))

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/client`)
    wsRef.current = ws

    ws.onopen = () => {
      setState(s => ({ ...s, status: 'connected' }))
    }

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const data = JSON.parse(event.data)

      switch (data.type) {
        case 'sessions':
          setState(s => ({ ...s, sessions: data.sessions }))
          break
        case 'session_connected':
          setState(s => ({ ...s, connectedSessionId: data.session_id }))
          break
        case 'session_not_found':
          setState(s => ({ ...s, connectedSessionId: null }))
          break
        case 'transcript':
          setState(s => ({
            ...s,
            transcript: [...s.transcript, {
              speaker: data.speaker,
              text: data.text,
              session_id: data.session_id,
              timestamp: Date.now(),
            }],
          }))
          break
        case 'error':
          console.error('[relay]', data.message)
          break
      }
    }

    ws.onclose = () => {
      setState(s => ({ ...s, status: 'disconnected', connectedSessionId: null }))
      // Auto-reconnect after 2s
      setTimeout(connect, 2000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
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
    setState(s => ({ ...s, connectedSessionId: null }))
  }, [])

  const clearTranscript = useCallback(() => {
    setState(s => ({ ...s, transcript: [] }))
  }, [])

  return {
    ...state,
    connectSession,
    disconnectSession,
    clearTranscript,
  }
}
