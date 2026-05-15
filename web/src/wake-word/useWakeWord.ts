// React hook that owns the wake-word capture pipeline.
//
// Responsibilities:
//   - When `active` is true AND templates exist: open getUserMedia, build
//     an AudioContext + ScriptProcessor capture, downsample to 16 kHz,
//     post PCM frames to a Web Worker that runs MFCC+DTW.
//   - When `active` becomes false: tear everything down so the OS mic
//     indicator reflects reality.
//   - Surfaces worker heartbeats so the UI can show a live indicator.

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTemplates, saveTemplates, clearTemplates } from './db'
import type { WakeWordRecord } from './db'
import { buildEnrollment, resampleTo16k } from './enroll'

type Status = 'idle' | 'starting' | 'listening' | 'error'

export interface UseWakeWordOptions {
  enabled: boolean
  /** True only when mic state === 'wake'. */
  active: boolean
  /** Don't run matching while TTS is playing or while user is mid-turn. */
  suspend?: boolean
  onMatch?: () => void
}

export interface UseWakeWordReturn {
  status: Status
  /** Last MFCC+DTW distance reported by the worker (debug). */
  lastDistance: number | null
  /** True if templates are loaded from IndexedDB. */
  hasTemplates: boolean
  /** Timestamp of last heartbeat from the worker. */
  lastHeartbeat: number | null
  /** Run a 3–5 clip enrollment from existing recorded buffers. */
  enroll: (clips: { buf: Float32Array; sampleRate: number }[]) => Promise<void>
  /** Drop the saved templates. */
  reset: () => Promise<void>
  /** Reload templates from IndexedDB (after enrollment elsewhere). */
  reload: () => Promise<void>
}

export function useWakeWord(opts: UseWakeWordOptions): UseWakeWordReturn {
  const { enabled, active, suspend, onMatch } = opts
  const [status, setStatus] = useState<Status>('idle')
  const lastDistance: number | null = null
  const lastHeartbeat: number | null = null
  const [record, setRecord] = useState<WakeWordRecord | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const onMatchRef = useRef(onMatch)
  useEffect(() => { onMatchRef.current = onMatch }, [onMatch])

  const reload = useCallback(async () => {
    const rec = await loadTemplates()
    setRecord(rec)
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload() }, [reload])

  const teardown = useCallback(() => {
    try { procRef.current?.disconnect() } catch { /* ignore */ }
    try { sourceRef.current?.disconnect() } catch { /* ignore */ }
    try { ctxRef.current?.close() } catch { /* ignore */ }
    try {
      streamRef.current?.getTracks().forEach(t => t.stop())
    } catch { /* ignore */ }
    workerRef.current?.terminate()
    workerRef.current = null
    streamRef.current = null
    ctxRef.current = null
    procRef.current = null
    sourceRef.current = null
    setStatus('idle')
  }, [])

  // Suspend / resume in-place
  useEffect(() => {
    if (!workerRef.current) return
    workerRef.current.postMessage({ type: suspend ? 'suspend' : 'resume' })
  }, [suspend])

  // Lifecycle
  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!enabled || !active || !record || record.templates.length === 0) {
        console.log('[wake-word] start skipped — enabled:', enabled, 'active:', active, 'hasRecord:', !!record)
        return
      }
      console.log('[wake-word] starting — templates:', record.templates.length, 'threshold:', record.threshold.toFixed(2))
      setStatus('starting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
        const ctx = new AC()
        ctxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        sourceRef.current = source

        // ScriptProcessor is deprecated but ubiquitous. AudioWorklet would
        // be cleaner; v1 keeps it simple.
        const proc = ctx.createScriptProcessor(2048, 1, 1)
        procRef.current = proc

        const worker = new Worker(new URL('./wakeWorker.ts', import.meta.url), { type: 'module' })
        workerRef.current = worker
        worker.onmessage = (e: MessageEvent) => {
          const m = e.data as { type: string; distance?: number }
          if (m.type === 'worker-started') { console.log('[wake-word] worker started'); setStatus('listening') }
          // heartbeat / score events would re-render MicControls every tick;
          // we deliberately don't propagate them to React state here. The
          // worker logs to console.
          if (m.type === 'match') {
            console.log('[wake-word] MATCH on main thread', m)
            onMatchRef.current?.()
          }
        }
        const effectiveThreshold =
          typeof record.userThreshold === 'number' ? record.userThreshold : record.threshold
        worker.postMessage({
          type: 'init',
          templates: record.templates,
          threshold: effectiveThreshold,
        })

        proc.onaudioprocess = (ev) => {
          if (suspend) return
          const ch = ev.inputBuffer.getChannelData(0)
          const pcm = resampleTo16k(ch, ctx.sampleRate)
          // copy because the underlying buffer is reused
          const copy = new Float32Array(pcm)
          worker.postMessage({ type: 'audio', pcm: copy }, [copy.buffer])
        }
        source.connect(proc)
        // ScriptProcessor only fires onaudioprocess when connected to destination
        proc.connect(ctx.destination)
      } catch (err) {
        console.error('[wake-word] start failed', err)
        setStatus('error')
        teardown()
      }
    }
    if (enabled && active && record) start()
    return () => {
      cancelled = true
      teardown()
    }
  }, [enabled, active, record, suspend, teardown])

  const enroll = useCallback(async (clips: { buf: Float32Array; sampleRate: number }[]) => {
    const { templates, threshold, numCoeffs } = buildEnrollment(clips)
    if (templates.length === 0) throw new Error('No usable audio clips for enrollment')
    await saveTemplates({
      phrase: 'hey claude',
      templates,
      threshold,
      enrolledAt: Date.now(),
      numCoeffs,
    })
    await reload()
  }, [reload])

  const reset = useCallback(async () => {
    await clearTemplates()
    setRecord(null)
  }, [])

  return {
    status,
    lastDistance,
    lastHeartbeat,
    hasTemplates: !!record && record.templates.length > 0,
    enroll,
    reset,
    reload,
  }
}
