import { useEffect, useRef } from 'react'

interface WakeLockSentinel {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: string, listener: () => void) => void
}

interface NavigatorWithWakeLock extends Navigator {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>
  }
}

function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/**
 * Keep the device awake while voice mode is engaged.
 *
 * Holds a Screen Wake Lock whenever `active` is true. On mobile only,
 * also starts a silent looping audio track when the page goes hidden
 * so iOS/Android don't suspend the tab and cut Claude's TTS mid-turn.
 * Desktop never gets the silent audio path (would block system sleep).
 */
export function useKeepAwake(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // --- Wake Lock ---
  useEffect(() => {
    if (!active) return
    const nav = navigator as NavigatorWithWakeLock
    if (!nav.wakeLock) return

    let cancelled = false

    const acquire = async () => {
      try {
        const sentinel = await nav.wakeLock!.request('screen')
        if (cancelled) {
          void sentinel.release()
          return
        }
        sentinelRef.current = sentinel
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null
        })
      } catch {
        // Permission denied or unsupported state — silent fail.
      }
    }

    void acquire()

    // Re-acquire after visibility returns; the browser releases the
    // lock automatically when the document is hidden.
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinelRef.current) {
        void acquire()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      const s = sentinelRef.current
      sentinelRef.current = null
      if (s && !s.released) void s.release()
    }
  }, [active])

  // --- Silent audio (mobile only, hidden only) ---
  useEffect(() => {
    if (!active) return
    if (!isMobileUA()) return

    const audio = new Audio()
    // 1s of near-silent stereo wav, base64 inlined; loops forever.
    audio.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
    audio.loop = true
    audio.preload = 'auto'
    audio.volume = 0.001
    audioRef.current = audio

    let playing = false
    const tryPlay = () => {
      if (playing) return
      audio.play().then(() => { playing = true }).catch(() => {
        // Likely no user gesture yet — will retry on next visibility flip.
      })
    }
    const pause = () => {
      audio.pause()
      playing = false
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') tryPlay()
      else pause()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      audio.pause()
      audio.src = ''
      audioRef.current = null
    }
  }, [active])
}
