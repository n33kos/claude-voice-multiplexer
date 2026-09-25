// React hook that runs openWakeWord in the browser via onnxruntime-web.
//
// Pipeline (16 kHz mono):
//   mic -> AudioWorklet (1280-sample / 80 ms frames)
//        -> melspectrogram.onnx  (5 mel frames per step, normalized x/10 + 2)
//        -> embedding_model.onnx (76-frame window, stride 8 -> 96-dim vector)
//        -> <phrase>.onnx head   (last 16 embeddings -> score 0..1)
//   silero_vad.onnx gates detections so non-speech noise can't fire the word.
//
// The phrase models are speaker-independent and pre-trained, so there is no
// enrollment: the .onnx files are static assets served from baseAssetUrl.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import * as ort from 'onnxruntime-web/wasm'

/** Live wake-word telemetry for the debug meter. */
export interface WakeDebugState {
  score: number
  speech: boolean
  ts: number
}

// Vite bundles the ORT WASM binary and rewrites its URL, so we don't set
// wasmPaths.  Run single-threaded so we don't need SharedArrayBuffer /
// COOP+COEP headers.
ort.env.wasm.numThreads = 1

export type WakePhrase = 'hey_claude' | 'computer'

const PHRASE_MODEL: Record<WakePhrase, string> = {
  hey_claude: 'hey_claude.onnx',
  computer: 'computer.onnx',
}

const SAMPLE_RATE = 16000
const FRAME_SIZE = 1280 // 80 ms at 16 kHz
const MEL_BINS = 32
const MEL_WINDOW = 76
const MEL_STRIDE = 8
const EMBED_DIM = 96
const EMBED_HISTORY = 16
const VAD_HANGOVER_FRAMES = 12
const DETECTION_COOLDOWN_MS = 2000

type Status = 'idle' | 'loading' | 'listening' | 'error'

export interface UseWakeWordOptions {
  enabled: boolean
  /** True only when the mic posture is "wake". */
  active: boolean
  /** Don't run matching while Claude holds the turn (speaking/thinking) or in cooldown. */
  suspend?: boolean
  /** Which pre-trained phrase model to load. */
  phrase: WakePhrase
  /** Score (0..1) above which a match fires.  Tunable per phrase. */
  threshold: number
  onMatch?: () => void
  /** Where the .onnx assets are served from. */
  baseAssetUrl?: string
  /** Written each inference with the latest score/speech for a debug meter. */
  scoreRef?: MutableRefObject<WakeDebugState>
}

export interface UseWakeWordReturn {
  status: Status
}

const AUDIO_PROCESSOR_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  bufferSize = ${FRAME_SIZE};
  _buffer = new Float32Array(this.bufferSize);
  _pos = 0;
  process(inputs) {
    const input = inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this._buffer[this._pos++] = input[i];
        if (this._pos === this.bufferSize) {
          this.port.postMessage(this._buffer.slice(0));
          this._pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('oww-audio-processor', AudioProcessor);
`

export function useWakeWord(opts: UseWakeWordOptions): UseWakeWordReturn {
  const { enabled, active, suspend, phrase, threshold, onMatch, baseAssetUrl = '/openwakeword', scoreRef } = opts
  const [status, setStatus] = useState<Status>('idle')
  const [modelsReady, setModelsReady] = useState(false)

  // Live-updated refs so threshold / suspend / callback changes don't restart audio.
  const onMatchRef = useRef(onMatch)
  useEffect(() => { onMatchRef.current = onMatch }, [onMatch])
  const suspendRef = useRef(suspend)
  useEffect(() => { suspendRef.current = suspend }, [suspend])
  const thresholdRef = useRef(threshold)
  useEffect(() => { thresholdRef.current = threshold }, [threshold])

  // Model sessions.
  const melRef = useRef<ort.InferenceSession | null>(null)
  const embedRef = useRef<ort.InferenceSession | null>(null)
  const headRef = useRef<ort.InferenceSession | null>(null)
  const vadRef = useRef<ort.InferenceSession | null>(null)

  // Audio graph.
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)

  // Rolling pipeline state.
  const melBufRef = useRef<Float32Array[]>([])
  const embedBufRef = useRef<Float32Array[]>([])
  const vadStateRef = useRef<{ h: ort.Tensor; c: ort.Tensor } | null>(null)
  const speechActiveRef = useRef(false)
  const hangoverRef = useRef(0)
  const cooldownRef = useRef(false)

  const resetPipeline = useCallback(() => {
    melBufRef.current = []
    embedBufRef.current = []
    for (let i = 0; i < EMBED_HISTORY; i++) embedBufRef.current.push(new Float32Array(EMBED_DIM))
    const shape = [2, 1, 64]
    vadStateRef.current = {
      h: new ort.Tensor('float32', new Float32Array(128), shape),
      c: new ort.Tensor('float32', new Float32Array(128), shape),
    }
    speechActiveRef.current = false
    hangoverRef.current = 0
    cooldownRef.current = false
  }, [])

  const runVad = useCallback(async (chunk: Float32Array): Promise<boolean> => {
    const vad = vadRef.current
    const state = vadStateRef.current
    if (!vad || !state) return false
    try {
      const input = new ort.Tensor('float32', chunk, [1, chunk.length])
      const sr = new ort.Tensor('int64', [BigInt(SAMPLE_RATE)], [])
      const res = await vad.run({ input, sr, h: state.h, c: state.c })
      vadStateRef.current = { h: res.hn as ort.Tensor, c: res.cn as ort.Tensor }
      return (res.output.data as Float32Array)[0] > 0.5
    } catch {
      return false
    }
  }, [])

  const runInference = useCallback(async (chunk: Float32Array, speechActive: boolean) => {
    const mel = melRef.current, embed = embedRef.current, head = headRef.current
    if (!mel || !embed || !head) return

    const melOut = await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', chunk, [1, FRAME_SIZE]) })
    const melData = melOut[mel.outputNames[0]].data as Float32Array
    for (let j = 0; j < melData.length; j++) melData[j] = melData[j] / 10.0 + 2.0
    for (let j = 0; j < 5; j++) {
      melBufRef.current.push(new Float32Array(melData.subarray(j * MEL_BINS, (j + 1) * MEL_BINS)))
    }

    while (melBufRef.current.length >= MEL_WINDOW) {
      const flatMel = new Float32Array(MEL_WINDOW * MEL_BINS)
      for (let j = 0; j < MEL_WINDOW; j++) flatMel.set(melBufRef.current[j], j * MEL_BINS)
      const embedOut = await embed.run({
        [embed.inputNames[0]]: new ort.Tensor('float32', flatMel, [1, MEL_WINDOW, MEL_BINS, 1]),
      })
      const newEmbed = embedOut[embed.outputNames[0]].data as Float32Array

      embedBufRef.current.shift()
      embedBufRef.current.push(new Float32Array(newEmbed))

      const flatEmbed = new Float32Array(EMBED_HISTORY * EMBED_DIM)
      for (let j = 0; j < EMBED_HISTORY; j++) flatEmbed.set(embedBufRef.current[j], j * EMBED_DIM)
      const headOut = await head.run({
        [head.inputNames[0]]: new ort.Tensor('float32', flatEmbed, [1, EMBED_HISTORY, EMBED_DIM]),
      })
      const score = (headOut[head.outputNames[0]].data as Float32Array)[0]
      if (scoreRef) scoreRef.current = { score, speech: speechActive, ts: Date.now() }

      if (score > thresholdRef.current && speechActive && !cooldownRef.current && !suspendRef.current) {
        cooldownRef.current = true
        onMatchRef.current?.()
        setTimeout(() => { cooldownRef.current = false }, DETECTION_COOLDOWN_MS)
      }

      melBufRef.current.splice(0, MEL_STRIDE)
    }
  }, [scoreRef])

  // Load models when enabled + phrase changes.
  useEffect(() => {
    let cancelled = false
    if (!enabled) return
    setStatus('loading')
    setModelsReady(false)
    const opt: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] }
    ;(async () => {
      try {
        const [mel, embed, vad] = await Promise.all([
          melRef.current ?? ort.InferenceSession.create(`${baseAssetUrl}/melspectrogram.onnx`, opt),
          embedRef.current ?? ort.InferenceSession.create(`${baseAssetUrl}/embedding_model.onnx`, opt),
          vadRef.current ?? ort.InferenceSession.create(`${baseAssetUrl}/silero_vad.onnx`, opt),
        ])
        const head = await ort.InferenceSession.create(`${baseAssetUrl}/${PHRASE_MODEL[phrase]}`, opt)
        if (cancelled) return
        melRef.current = mel; embedRef.current = embed; vadRef.current = vad; headRef.current = head
        setModelsReady(true)
        setStatus('idle')
      } catch (e) {
        console.error('[wake-word] model load failed', e)
        if (!cancelled) setStatus('error')
      }
    })()
    return () => { cancelled = true }
  }, [enabled, phrase, baseAssetUrl])

  // Start / stop the audio graph.
  useEffect(() => {
    let cancelled = false
    const shouldRun = enabled && active && modelsReady

    async function start() {
      resetPipeline()
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
        ctxRef.current = ctx
        // A freshly created AudioContext is often "suspended" until a user
        // gesture, which would silently stop the wake pipeline.  Resume now,
        // and if the browser still blocks it, resume on the next gesture.
        if (ctx.state === 'suspended') {
          try { await ctx.resume() } catch { /* ignore */ }
        }
        if (ctx.state === 'suspended') {
          const resume = () => {
            ctx.resume().catch(() => {})
            window.removeEventListener('pointerdown', resume)
            window.removeEventListener('keydown', resume)
          }
          window.addEventListener('pointerdown', resume, { once: true })
          window.addEventListener('keydown', resume, { once: true })
        }
        const source = ctx.createMediaStreamSource(stream)
        const blob = new Blob([AUDIO_PROCESSOR_CODE], { type: 'application/javascript' })
        await ctx.audioWorklet.addModule(URL.createObjectURL(blob))
        const node = new AudioWorkletNode(ctx, 'oww-audio-processor')
        nodeRef.current = node

        node.port.onmessage = async (ev: MessageEvent) => {
          const chunk = ev.data as Float32Array
          if (!chunk || suspendRef.current) return
          const vadFired = await runVad(chunk)
          if (vadFired) {
            speechActiveRef.current = true
            hangoverRef.current = VAD_HANGOVER_FRAMES
          } else if (speechActiveRef.current) {
            hangoverRef.current--
            if (hangoverRef.current <= 0) speechActiveRef.current = false
          }
          await runInference(chunk, speechActiveRef.current)
        }

        source.connect(node)
        node.connect(ctx.destination)
        if (!cancelled) setStatus('listening')
      } catch (e) {
        console.error('[wake-word] start failed', e)
        if (!cancelled) setStatus('error')
      }
    }

    function stop() {
      try { nodeRef.current?.port && (nodeRef.current.port.onmessage = null) } catch { /* ignore */ }
      try { nodeRef.current?.disconnect() } catch { /* ignore */ }
      try { streamRef.current?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
      try { if (ctxRef.current && ctxRef.current.state !== 'closed') void ctxRef.current.close() } catch { /* ignore */ }
      nodeRef.current = null; streamRef.current = null; ctxRef.current = null
    }

    if (shouldRun) start()
    return () => { cancelled = true; stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, phrase, modelsReady, resetPipeline, runVad, runInference])

  return { status }
}
