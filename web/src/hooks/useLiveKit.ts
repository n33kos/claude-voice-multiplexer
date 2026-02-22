import { useCallback, useState } from 'react'
import { authFetch } from './useAuth'

interface LiveKitState {
  token: string | null
  url: string | null
  room: string | null
  isConnected: boolean
}

export function useLiveKit() {
  const [state, setState] = useState<LiveKitState>({
    token: null,
    url: null,
    room: null,
    isConnected: false,
  })

  const fetchToken = useCallback(async (room: string) => {
    try {
      const resp = await authFetch(`/api/token?room=${encodeURIComponent(room)}`)
      if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`)
      const data = await resp.json()
      setState({
        token: data.token,
        url: data.url,
        room: data.room,
        isConnected: false,
      })
      return data
    } catch (err) {
      console.error('[livekit] Token fetch error:', err)
      return null
    }
  }, [])

  const resetToken = useCallback(() => {
    setState({ token: null, url: null, room: null, isConnected: false })
  }, [])

  const setConnected = useCallback((connected: boolean) => {
    setState(s => ({ ...s, isConnected: connected }))
  }, [])

  return {
    ...state,
    fetchToken,
    resetToken,
    setConnected,
  }
}
