// Modal that walks the user through 4 recordings of "hey claude".
// Captures Float32 buffers at the device sample rate and hands them to
// the parent (which calls useWakeWord.enroll).

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './EnrollmentModal.module.scss'

const TARGET_CLIPS = 4
const CLIP_DURATION_MS = 1500
const COUNTDOWN_START = 3

interface Props {
  open: boolean
  onClose: () => void
  onComplete: (clips: { buf: Float32Array; sampleRate: number }[]) => Promise<void>
}

type Phase = 'intro' | 'countdown' | 'recording' | 'review' | 'saving' | 'done' | 'error'

export function EnrollmentModal({ open, onClose, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('intro')
  const [clipIndex, setClipIndex] = useState(0)
  const [countdown, setCountdown] = useState(COUNTDOWN_START)
  const [error, setError] = useState<string | null>(null)
  const clipsRef = useRef<{ buf: Float32Array; sampleRate: number }[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)

  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    void ctxRef.current?.close()
    ctxRef.current = null
  }, [])

  useEffect(() => {
    if (!open) {
      teardown()
      setPhase('intro')
      setClipIndex(0)
      setCountdown(COUNTDOWN_START)
      setError(null)
      clipsRef.current = []
    }
  }, [open, teardown])

  const captureClip = useCallback(async (): Promise<void> => {
    if (!streamRef.current || !ctxRef.current) return
    const ctx = ctxRef.current
    const source = ctx.createMediaStreamSource(streamRef.current)
    const proc = ctx.createScriptProcessor(2048, 1, 1)
    const chunks: Float32Array[] = []
    proc.onaudioprocess = (ev) => {
      chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
    }
    source.connect(proc)
    proc.connect(ctx.destination)
    await new Promise(r => setTimeout(r, CLIP_DURATION_MS))
    proc.disconnect()
    source.disconnect()
    let total = 0
    for (const c of chunks) total += c.length
    const merged = new Float32Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.length }
    clipsRef.current.push({ buf: merged, sampleRate: ctx.sampleRate })
  }, [])

  const startEnrollment = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
      streamRef.current = stream
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
      ctxRef.current = new AC()
      setPhase('countdown')
      setClipIndex(0)
    } catch (err) {
      console.error('[enroll] mic permission denied', err)
      setError('Microphone permission denied.')
      setPhase('error')
    }
  }, [])

  // Drive countdown → recording → next clip
  useEffect(() => {
    if (phase !== 'countdown') return
    let n = COUNTDOWN_START
    setCountdown(n)
    const tick = setInterval(async () => {
      n -= 1
      if (n > 0) {
        setCountdown(n)
      } else {
        clearInterval(tick)
        setPhase('recording')
        await captureClip()
        if (clipsRef.current.length >= TARGET_CLIPS) {
          setPhase('review')
        } else {
          setClipIndex(clipsRef.current.length)
          setPhase('countdown')
        }
      }
    }, 700)
    return () => clearInterval(tick)
  }, [phase, captureClip])

  const finalize = useCallback(async () => {
    setPhase('saving')
    try {
      await onComplete(clipsRef.current)
      setPhase('done')
    } catch (err) {
      console.error('[enroll] save failed', err)
      setError(err instanceof Error ? err.message : 'Failed to save enrollment')
      setPhase('error')
    } finally {
      teardown()
    }
  }, [onComplete, teardown])

  if (!open) return null

  return (
    <div className={styles.Overlay}>
      <div className={styles.Backdrop} onClick={onClose} />
      <div className={styles.Panel}>
        <div className={styles.Header}>
          <h3 className={styles.Title}>Train "hey claude"</h3>
          <button className={styles.Close} onClick={onClose}>×</button>
        </div>

        {phase === 'intro' && (
          <>
            <p className={styles.Body}>
              We'll record your voice saying <strong>"hey claude"</strong> {TARGET_CLIPS} times.
              Audio stays on this device — only acoustic features are saved.
            </p>
            <button className={styles.Primary} onClick={startEnrollment}>
              Start
            </button>
          </>
        )}

        {phase === 'countdown' && (
          <>
            <p className={styles.Body}>
              Clip {clipIndex + 1} of {TARGET_CLIPS} — get ready…
            </p>
            <div className={styles.Countdown}>{countdown}</div>
          </>
        )}

        {phase === 'recording' && (
          <>
            <p className={styles.Body}>
              Recording clip {clipIndex + 1} of {TARGET_CLIPS} — say "hey claude"
            </p>
            <div className={styles.RecordingDot} />
          </>
        )}

        {phase === 'review' && (
          <>
            <p className={styles.Body}>
              Captured {clipsRef.current.length} clips. Save and start listening?
            </p>
            <div className={styles.ButtonRow}>
              <button className={styles.Secondary} onClick={onClose}>Cancel</button>
              <button className={styles.Primary} onClick={finalize}>Save</button>
            </div>
          </>
        )}

        {phase === 'saving' && <p className={styles.Body}>Saving…</p>}

        {phase === 'done' && (
          <>
            <p className={styles.Body}>Saved. Wake-word listening is ready.</p>
            <button className={styles.Primary} onClick={onClose}>Done</button>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className={styles.Body}>{error}</p>
            <button className={styles.Primary} onClick={onClose}>Close</button>
          </>
        )}
      </div>
    </div>
  )
}
