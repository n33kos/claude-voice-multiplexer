import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

/** Position for a context bar field: hidden or left/center/right. */
export type FieldPosition = 'hidden' | 'left' | 'center' | 'right'

/** Configurable context bar field placement. */
export interface ContextBarFields {
  model: FieldPosition
  contextUsage: FieldPosition
  cost: FieldPosition
  contextBar: FieldPosition  // the progress bar itself
}

export interface Settings {
  autoListen: boolean
  speakerMuted: boolean
  showStatusPill: boolean
  showParticles: boolean
  theme: ThemeMode
  audioReactiveParticles: boolean
  showContextBar: boolean
  contextBarFields: ContextBarFields
}

const STORAGE_KEY = 'voice-multiplexer-settings'

export const DEFAULT_CONTEXT_BAR_FIELDS: ContextBarFields = {
  model: 'left',
  contextUsage: 'right',
  cost: 'hidden',
  contextBar: 'left',  // spans full width below, position just controls visibility
}

const DEFAULTS: Settings = {
  autoListen: true,
  speakerMuted: false,
  showStatusPill: true,
  showParticles: true,
  theme: 'system',
  audioReactiveParticles: false,
  showContextBar: true,
  contextBarFields: DEFAULT_CONTEXT_BAR_FIELDS,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      return { ...DEFAULTS, ...JSON.parse(raw) }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS }
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // ignore
  }
}

export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(loadSettings)

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState(prev => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  // Sync across tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          setSettingsState({ ...DEFAULTS, ...JSON.parse(e.newValue) })
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  return { settings, updateSettings }
}
