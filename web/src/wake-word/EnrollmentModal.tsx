// Two-stage enrollment:
//   Stage 1 — POSITIVES: 4 recordings of "hey claude" (templates).
//   Stage 2 — NEGATIVE:  3 seconds of ambient silence/background noise.
//   Stage 3 — VERIFY:    3 more "hey claude" recordings, scored against
//                        templates to validate the auto-tuned threshold.
//
// The captured buckets are handed to Settings, which calls
// buildEnrollmentTwoStage to compute templates + a threshold that sits
// between the positives and the negatives.

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './EnrollmentModal.module.scss'

const POSITIVE_CLIPS = 4
const VERIFY_CLIPS = 3
const POSITIVE_DURATION_MS = 1500
const VERIFY_DURATION_MS = 1500
const NEGATIVE_DURATION_MS = 3000
const COUNTDOWN_START = 3

export interface EnrollmentPayload {
  positives: { buf: Float32Array; sampleRate: number }[]
  negatives: { buf: Float32Array; sampleRate: number }[]
  verify: { buf: Float32Array; sampleRate: number }[]
}

interface Props {
  open: boolean
  onClose: () => void
  onComplete: (payload: EnrollmentPayload) => Promise<void>
}

type Stage = 'positives' | 'negative' | 'verify'
type Phase =
  | 'intro'
  | 'stage-intro'
  | 'countdown'
  | 'recording'
  | 'review'
  | 'saving'
  | 'done'
  | 'error'

const STAGES: Stage[] = ['positives', 'negative', 'verify']

function durationForStage(s: Stage): number {
  if (s === 'positives') return POSITIVE_DURATION_MS
  if (s === 'verify') return VERIFY_DURATION_MS
  return NEGATIVE_DURATION_MS
}

function targetCountForStage(s: Stage): number {
  if (s === 'positives') return POSITIVE_CLIPS
  if (s === 'verify') return VERIFY_CLIPS
  return 1
}

function stageHeading(s: Stage): string {
  if (s === 'positives') return 'Step 1 of 3 — Train your voice'
  if (s === 'negative') return 'Step 2 of 3 — Listen to your room'
  return 'Step 3 of 3 — Verify'
}

function stageDirections(s: Stage): string {
  if (s === 'positives') {
    return `Say "hey claude" ${POSITIVE_CLIPS} times. Speak the way you normally would when calling me.`
  }
  if (s === 'negative') {
    return `Stay quiet for ${NEGATIVE_DURATION_MS / 1000} seconds so we can sample your background noise. Don't say "hey claude".`
  }
  return `Say "hey claude" ${VERIFY_CLIPS} more times so we can dial the threshold between your voice and the room.`
}

export function EnrollmentModal({ open, onClose, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('intro')
  const [stageIdx, setStageIdx] = useState(0)
  const [clipIndex, setClipIndex] = useState(0)
  const [countdown, setCountdown] = useState(COUNTDOWN_START)
  const [error, setError] = useState<string | null>(null)
  const positivesRef = useRef<{ buf: Float32Array; sampleRate: number }[]>([])
  const negativesRef = useRef<{ buf: Float32Array; sampleRate: number }[]>([])
  const verifyRef = useRef<{ buf: Float32Array; sampleRate: number }[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)

  const stage = STAGES[stageIdx]

  const bucketForStage = useCallback(
    (s: Stage) => {
      if (s === 'positives') return positivesRef.current
      if (s === 'negative') return negativesRef.current
      return verifyRef.current
    },
    [],
  )

  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void ctxRef.current?.close()
    ctxRef.current = null
  }, [])

  useEffect(() => {
    if (!open) {
      teardown()
      setPhase('intro')
      setStageIdx(0)
      setClipIndex(0)
      setCountdown(COUNTDOWN_START)
      setError(null)
      positivesRef.current = []
      negativesRef.current = []
      verifyRef.current = []
    }
  }, [open, teardown])

  const captureClip = useCallback(
    async (currentStage: Stage): Promise<void> => {
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
      await new Promise((r) => setTimeout(r, durationForStage(currentStage)))
      proc.disconnect()
      source.disconnect()
      let total = 0
      for (const c of chunks) total += c.length
      const merged = new Float32Array(total)
      let off = 0
      for (const c of chunks) {
        merged.set(c, off)
        off += c.length
      }
      bucketForStage(currentStage).push({ buf: merged, sampleRate: ctx.sampleRate })
    },
    [bucketForStage],
  )

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
      setStageIdx(0)
      setClipIndex(0)
      setPhase('stage-intro')
    } catch (err) {
      console.error('[enroll] mic permission denied', err)
      setError('Microphone permission denied.')
      setPhase('error')
    }
  }, [])

  // Drive countdown → recording → next clip / next stage
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
        await captureClip(stage)
        const have = bucketForStage(stage).length
        const need = targetCountForStage(stage)
        if (have >= need) {
          // Stage done — advance.
          if (stageIdx < STAGES.length - 1) {
            setStageIdx(stageIdx + 1)
            setClipIndex(0)
            setPhase('stage-intro')
          } else {
            setPhase('review')
          }
        } else {
          setClipIndex(have)
          setPhase('countdown')
        }
      }
    }, 700)
    return () => clearInterval(tick)
  }, [phase, stage, stageIdx, captureClip, bucketForStage])

  const finalize = useCallback(async () => {
    setPhase('saving')
    try {
      await onComplete({
        positives: positivesRef.current,
        negatives: negativesRef.current,
        verify: verifyRef.current,
      })
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

  const need = targetCountForStage(stage)

  return (
    <div className={styles.Overlay}>
      <div className={styles.Backdrop} onClick={onClose} />
      <div className={styles.Panel}>
        <div className={styles.Header}>
          <h3 className={styles.Title}>Train "hey claude"</h3>
          <button className={styles.Close} onClick={onClose}>
            ×
          </button>
        </div>

        {phase === 'intro' && (
          <>
            <p className={styles.Body}>
              We'll train your wake word in three short steps:
              <br />
              1. Say "hey claude" {POSITIVE_CLIPS} times
              <br />
              2. Stay quiet for {NEGATIVE_DURATION_MS / 1000}s while we sample the room
              <br />
              3. Say "hey claude" {VERIFY_CLIPS} more times to calibrate
              <br />
              <br />
              Audio stays on this device — only acoustic features are saved.
            </p>
            <button className={styles.Primary} onClick={startEnrollment}>
              Start
            </button>
          </>
        )}

        {phase === 'stage-intro' && (
          <>
            <p className={styles.Body}>
              <strong>{stageHeading(stage)}</strong>
              <br />
              <br />
              {stageDirections(stage)}
            </p>
            <button className={styles.Primary} onClick={() => setPhase('countdown')}>
              Ready
            </button>
          </>
        )}

        {phase === 'countdown' && (
          <>
            <p className={styles.Body}>
              {stage === 'negative'
                ? 'Get ready to stay quiet…'
                : `Clip ${clipIndex + 1} of ${need} — get ready…`}
            </p>
            <div className={styles.Countdown}>{countdown}</div>
          </>
        )}

        {phase === 'recording' && (
          <>
            <p className={styles.Body}>
              {stage === 'negative'
                ? 'Listening to the room — stay quiet'
                : stage === 'verify'
                ? `Verifying ${clipIndex + 1} of ${need} — say "hey claude"`
                : `Recording ${clipIndex + 1} of ${need} — say "hey claude"`}
            </p>
            <div className={styles.RecordingDot} />
          </>
        )}

        {phase === 'review' && (
          <>
            <p className={styles.Body}>
              Captured {positivesRef.current.length} positive clips,{' '}
              {negativesRef.current.length} room sample,{' '}
              {verifyRef.current.length} verification clips. Save and start listening?
            </p>
            <div className={styles.ButtonRow}>
              <button className={styles.Secondary} onClick={onClose}>
                Cancel
              </button>
              <button className={styles.Primary} onClick={finalize}>
                Save
              </button>
            </div>
          </>
        )}

        {phase === 'saving' && <p className={styles.Body}>Saving…</p>}

        {phase === 'done' && (
          <>
            <p className={styles.Body}>Saved. Wake-word listening is ready.</p>
            <button className={styles.Primary} onClick={onClose}>
              Done
            </button>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className={styles.Body}>{error}</p>
            <button className={styles.Primary} onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  )
}
