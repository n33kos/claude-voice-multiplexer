// Web Worker: receives PCM frames at 16 kHz, maintains a rolling ~1.5 s
// window, computes MFCC over the window, runs DTW vs enrolled templates,
// and posts a 'match' when distance is below threshold.
//
// Main thread is responsible for:
//   - getUserMedia + AudioContext + AudioWorklet plumbing
//   - resampling to 16 kHz (we do it on the main thread before posting)
//   - terminating this worker when leaving wake state

/// <reference lib="webworker" />

import { MFCCExtractor, cmn, DEFAULT_MFCC } from './mfcc'
import { dtw } from './dtw'
import { trimSilence } from './enroll'

const SR = 16000
const WINDOW_SEC = 1.5
const WINDOW_SAMPLES = Math.floor(SR * WINDOW_SEC)
const SLIDE_INTERVAL_MS = 200 // re-evaluate match this often
const VAD_RMS_FLOOR = 0.004   // crude energy gate; only run DTW on voiced windows
const HEARTBEAT_MS = 2000
const LOG = true

type Init = {
  type: 'init'
  templates: Float32Array[][]
  threshold: number
}
type Audio = {
  type: 'audio'
  pcm: Float32Array // mono, 16 kHz
}
type Suspend = { type: 'suspend' | 'resume' }
type In = Init | Audio | Suspend

const extractor = new MFCCExtractor(DEFAULT_MFCC)
let templates: Float32Array[][] = []
let threshold = Infinity
let suspended = false
let buf = new Float32Array(0)
let lastEval = 0
let lastMatch = 0
let heartbeat: ReturnType<typeof setInterval> | null = null

function post(type: string, payload?: Record<string, unknown>) {
  ;(self as unknown as Worker).postMessage({ type, ...payload })
}

function append(pcm: Float32Array) {
  const merged = new Float32Array(buf.length + pcm.length)
  merged.set(buf, 0)
  merged.set(pcm, buf.length)
  if (merged.length > WINDOW_SAMPLES) {
    buf = merged.slice(merged.length - WINDOW_SAMPLES)
  } else {
    buf = merged
  }
}

function rms(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}

let frameCount = 0
function tryMatch() {
  if (suspended) return
  if (templates.length === 0) return
  if (buf.length < WINDOW_SAMPLES * 0.5) return
  const now = performance.now()
  if (now - lastEval < SLIDE_INTERVAL_MS) return
  if (now - lastMatch < 1500) return
  lastEval = now
  const energy = rms(buf)
  if (energy < VAD_RMS_FLOOR) {
    if (LOG && frameCount % 25 === 0) console.log('[wake-worker] silent rms=', energy.toFixed(4))
    frameCount++
    return
  }

  const trimmed = trimSilence(buf, SR)
  if (trimmed.length < SR * 0.3) return // too short to be a phrase
  const seq = cmn(extractor.sequence(trimmed))
  if (seq.length === 0) return
  let best = Infinity
  for (const t of templates) {
    const d = dtw(seq, t)
    if (Number.isFinite(d) && d < best) best = d
  }
  if (!Number.isFinite(best)) return
  if (LOG) console.log('[wake-worker] score=', best.toFixed(3), 'threshold=', threshold.toFixed(3), 'rms=', energy.toFixed(4))
  post('score', { distance: best, threshold })
  if (best < threshold) {
    lastMatch = now
    if (LOG) console.log('[wake-worker] MATCH 🎯', { distance: best, threshold })
    post('match', { distance: best, threshold })
  }
  frameCount++
}

self.onmessage = (e: MessageEvent<In>) => {
  const msg = e.data
  if (msg.type === 'init') {
    templates = msg.templates
    threshold = msg.threshold
    if (LOG) console.log('[wake-worker] init — templates:', templates.length,
      'threshold:', threshold.toFixed(3),
      'tpl frames:', templates.map(t => t.length))
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = setInterval(() => post('heartbeat'), HEARTBEAT_MS)
    post('worker-started')
    return
  }
  if (msg.type === 'suspend') { suspended = true; return }
  if (msg.type === 'resume')  { suspended = false; return }
  if (msg.type === 'audio') {
    append(msg.pcm)
    tryMatch()
  }
}

self.addEventListener('error', (ev) => {
  post('error', { message: String(ev) })
})
