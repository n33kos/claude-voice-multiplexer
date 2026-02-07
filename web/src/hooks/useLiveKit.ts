import { useCallback, useState } from 'react'

interface LiveKitState {
  token: string | null
  url: string | null
  isConnected: boolean
}

export function useLiveKit() {
  const [state, setState] = useState<LiveKitState>({
    token: null,
    url: null,
    isConnected: false,
  })

  const fetchToken = useCallback(async (room: string = 'voice_relay') => {
    try {
      const resp = await fetch(`/api/token?room=${room}`)
      if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`)
      const data = await resp.json()
      setState({
        token: data.token,
        url: data.url,
        isConnected: false,
      })
      return data
    } catch (err) {
      console.error('[livekit] Token fetch error:', err)
      return null
    }
  }, [])

  const setConnected = useCallback((connected: boolean) => {
    setState(s => ({ ...s, isConnected: connected }))
  }, [])

  return {
    ...state,
    fetchToken,
    setConnected,
  }
}
