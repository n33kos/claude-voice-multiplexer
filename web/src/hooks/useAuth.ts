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

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    checked: false,
    authenticated: false,
    authEnabled: true,
    devices: [],
  })

  // Check auth status on mount
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(data => {
        setState(s => ({
          ...s,
          checked: true,
          authenticated: data.authenticated,
          authEnabled: data.auth_enabled,
        }))
        // If authenticated, fetch devices
        if (data.authenticated) {
          fetchDevices()
        }
      })
      .catch(() => {
        // If server is unreachable, skip auth gate
        setState(s => ({ ...s, checked: true, authenticated: true, authEnabled: false }))
      })
  }, [])

  const fetchDevices = useCallback(async () => {
    try {
      const resp = await fetch('/api/auth/devices')
      if (resp.ok) {
        const data = await resp.json()
        setState(s => ({ ...s, devices: data.devices || [] }))
      }
    } catch {
      // ignore
    }
  }, [])

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
      setState(s => ({ ...s, authenticated: true }))
      fetchDevices()
      return null
    } catch {
      return 'Network error — is the server running?'
    }
  }, [fetchDevices])

  const generateCode = useCallback(async (): Promise<{ code: string; expires_in: number } | null> => {
    try {
      const resp = await fetch('/api/auth/code', { method: 'POST' })
      if (!resp.ok) return null
      return await resp.json()
    } catch {
      return null
    }
  }, [])

  const revokeDevice = useCallback(async (deviceId: string): Promise<boolean> => {
    try {
      const resp = await fetch(`/api/auth/devices/${deviceId}`, { method: 'DELETE' })
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
