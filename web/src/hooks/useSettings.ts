import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

/** Position for a context bar field: hidden or left/center/right. */
export type FieldPosition = 'hidden' | 'left' | 'center' | 'right'

/** Visibility for the progress bar (only hidden/visible). */
export type BarVisibility = 'hidden' | 'visible'

/** Claude Code effort levels sent via /effort &lt;level&gt;. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'xhigh'

/** Configurable context bar field placement. */
export interface ContextBarFields {
  model: FieldPosition
  effort: FieldPosition
  contextUsage: FieldPosition
  cost: FieldPosition
  rateLimit5h: FieldPosition
  rateLimit7d: FieldPosition
  workingDir: FieldPosition
  duration: FieldPosition
  contextBar: BarVisibility
}

export interface Settings {
  autoListen: boolean
  speakerMuted: boolean
  showStatusPill: boolean
  showParticles: boolean
  theme: ThemeMode
  audioReactiveParticles: boolean
  showTitle: boolean
  showContextBar: boolean
  contextBarFields: ContextBarFields
  effortLevel: EffortLevel
  /** Wake-word "hey claude" listener feature flag. Default OFF. */
  wakeWordEnabled: boolean
  /** Play a chime when the wake word fires. */
  wakeWordChime: boolean
  /**
   * Keep the device awake while listening / armed. When ON we hold a
   * Screen Wake Lock and (on mobile, while visibility is hidden) play
   * a silent audio track so the OS doesn't suspend the tab and cut
   * Claude's voice off mid-conversation. Defaults to true on mobile UA,
   * false on desktop. User selection overrides permanently.
   */
  keepAwake: boolean
}

const STORAGE_KEY = 'voice-multiplexer-settings'

export const DEFAULT_CONTEXT_BAR_FIELDS: ContextBarFields = {
  model: 'left',
  effort: 'left',
  contextUsage: 'right',
  cost: 'hidden',
  rateLimit5h: 'hidden',
  rateLimit7d: 'hidden',
  workingDir: 'hidden',
  duration: 'hidden',
  contextBar: 'visible',
}

function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

const DEFAULTS: Settings = {
  autoListen: true,
  speakerMuted: false,
  showStatusPill: true,
  showParticles: true,
  theme: 'system',
  audioReactiveParticles: false,
  showTitle: true,
  showContextBar: true,
  contextBarFields: DEFAULT_CONTEXT_BAR_FIELDS,
  effortLevel: 'medium',
  wakeWordEnabled: false,
  wakeWordChime: true,
  keepAwake: isMobileUA(),
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        ...DEFAULTS,
        ...parsed,
        contextBarFields: {
          ...DEFAULT_CONTEXT_BAR_FIELDS,
          ...(parsed.contextBarFields ?? {}),
        },
      }
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
          const parsed = JSON.parse(e.newValue)
          setSettingsState({
            ...DEFAULTS,
            ...parsed,
            contextBarFields: {
              ...DEFAULT_CONTEXT_BAR_FIELDS,
              ...(parsed.contextBarFields ?? {}),
            },
          })
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
