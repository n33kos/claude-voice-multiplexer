import { useCallback, useEffect, useState } from 'react'

export interface AuthDevice {
  device_id: string
  device_name: string
  paired_at: number
  last_seen: number
}

interface AuthState {
  checked: boolean
  authenticated: boolean
  authEnabled: boolean
  devices: AuthDevice[]
}

const TOKEN_STORAGE_KEY = 'vmux_auth_token'

/** Retrieve the stored JWT, or null if absent. */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

/** Store a JWT from the pairing response. */
function storeToken(token: string) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // ignore storage errors (private browsing)
  }
}

/** Remove the stored token (e.g. on 401 / session expiry). */
export function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * Create fetch options with Authorization: Bearer header when a token is stored.
 * Falls back to unauthenticated if no token (auth disabled case).
 */
export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getStoredToken()
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return fetch(url, { ...options, headers })
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    checked: false,
    authenticated: false,
    authEnabled: true,
    devices: [],
  })

  const fetchDevices = useCallback(async () => {
    try {
      const resp = await authFetch('/api/auth/devices')
      if (resp.ok) {
        const data = await resp.json()
        setState(s => ({ ...s, devices: data.devices || [] }))
      } else if (resp.status === 401) {
        // Don't immediately clear auth — verify with the canonical status
        // endpoint first. A 401 here can be transient (relay restarting).
        try {
          const check = await authFetch('/api/auth/status')
          const data = await check.json()
          if (!data.authenticated) {
            clearStoredToken()
            setState(s => ({ ...s, authenticated: false }))
          }
        } catch {
          // Server unreachable — keep existing auth state
        }
      }
    } catch {
      // ignore
    }
  }, [])

  // Check auth status on mount
  useEffect(() => {
    authFetch('/api/auth/status')
      .then(r => r.json())
      .then(data => {
        setState(s => ({
          ...s,
          checked: true,
          authenticated: data.authenticated,
          authEnabled: data.auth_enabled,
        }))
        if (data.authenticated) {
          fetchDevices()
        }
      })
      .catch(() => {
        // If server is unreachable, skip auth gate
        setState(s => ({ ...s, checked: true, authenticated: true, authEnabled: false }))
      })
  }, [fetchDevices])

  const pairDevice = useCallback(async (code: string, deviceName: string): Promise<string | null> => {
    try {
      const resp = await fetch('/api/auth/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, device_name: deviceName }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        return data.error || 'Pairing failed'
      }
      // Store JWT for Authorization: Bearer header on all future requests
      if (data.token) {
        storeToken(data.token)
      }
      setState(s => ({ ...s, authenticated: true }))
      fetchDevices()
      return null
    } catch {
      return 'Network error — is the server running?'
    }
  }, [fetchDevices])

  const generateCode = useCallback(async (): Promise<{ code: string; expires_in: number } | null> => {
    try {
      const resp = await authFetch('/api/auth/code', { method: 'POST' })
      if (!resp.ok) return null
      return await resp.json()
    } catch {
      return null
    }
  }, [])

  const revokeDevice = useCallback(async (deviceId: string): Promise<boolean> => {
    try {
      const resp = await authFetch(`/api/auth/devices/${deviceId}`, { method: 'DELETE' })
      if (resp.ok) {
        setState(s => ({ ...s, devices: s.devices.filter(d => d.device_id !== deviceId) }))
        return true
      }
      return false
    } catch {
      return false
    }
  }, [])

  return {
    checked: state.checked,
    authenticated: state.authenticated,
    authEnabled: state.authEnabled,
    devices: state.devices,
    pairDevice,
    generateCode,
    revokeDevice,
    fetchDevices,
  }
}
