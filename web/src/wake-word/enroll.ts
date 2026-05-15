// Enrollment helpers: turn captured audio buffers into MFCC templates and
// auto-tune a DTW acceptance threshold from intra-template self-distances.

import { MFCCExtractor, cmn } from './mfcc'
import { dtw } from './dtw'

const TARGET_SR = 16000

/** Downsample a Float32 buffer at fromSR to TARGET_SR by linear interpolation. */
export function resampleTo16k(buf: Float32Array, fromSR: number): Float32Array {
  if (fromSR === TARGET_SR) return buf
  const ratio = fromSR / TARGET_SR
  const outLen = Math.floor(buf.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(buf.length - 1, i0 + 1)
    const frac = src - i0
    out[i] = buf[i0] * (1 - frac) + buf[i1] * frac
  }
  return out
}

/** Trim leading/trailing silence based on RMS energy of 30ms frames. */
export function trimSilence(buf: Float32Array, sampleRate: number): Float32Array {
  const frameLen = Math.floor(sampleRate * 0.03)
  if (buf.length < frameLen * 2) return buf
  const energies: number[] = []
  for (let i = 0; i + frameLen <= buf.length; i += frameLen) {
    let s = 0
    for (let j = 0; j < frameLen; j++) s += buf[i + j] * buf[i + j]
    energies.push(Math.sqrt(s / frameLen))
  }
  const maxE = Math.max(...energies, 1e-9)
  const threshold = maxE * 0.15
  const startFrame = energies.findIndex(e => e > threshold)
  let endFrame = energies.length - 1
  for (; endFrame > startFrame; endFrame--) {
    if (energies[endFrame] > threshold) break
  }
  if (startFrame < 0) return buf
  const padFrames = 3 // ~90 ms of padding on each side
  const sStart = Math.max(0, (startFrame - padFrames) * frameLen)
  const sEnd = Math.min(buf.length, (endFrame + padFrames) * frameLen)
  return buf.slice(sStart, sEnd)
}

export interface EnrolledTemplates {
  templates: Float32Array[][]
  threshold: number
  numCoeffs: number
}

/**
 * Build MFCC templates from recorded enrollment audio and pick a threshold.
 *
 * Threshold heuristic: take the max DTW distance observed when comparing
 * each template to every other template (intra-set similarity), then
 * multiply by 1.3 to give the runtime matcher some slack.
 */
export function buildEnrollment(
  audioClips: { buf: Float32Array; sampleRate: number }[]
): EnrolledTemplates {
  const extractor = new MFCCExtractor()
  const raw: Float32Array[][] = []
  for (const clip of audioClips) {
    const resampled = resampleTo16k(clip.buf, clip.sampleRate)
    const trimmed = trimSilence(resampled, TARGET_SR)
    const seq = cmn(extractor.sequence(trimmed))
    if (seq.length > 0) raw.push(seq)
  }
  // Reject length-outliers (anything > 1.7× median or < 0.5× median).
  // These are usually clips where the trimmer didn't catch leading or
  // trailing silence and they poison the DTW grid.
  const lens = raw.map(s => s.length).sort((a, b) => a - b)
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0
  const templates = raw.filter(s =>
    s.length <= median * 1.7 && s.length >= median * 0.5,
  )
  console.log('[enroll] kept', templates.length, 'of', raw.length,
    'templates — frame counts:', templates.map(t => t.length),
    '(median:', median, 'dropped:', raw.length - templates.length, ')')
  if (templates.length < 2) {
    return { templates, threshold: 22, numCoeffs: extractor.cfg.numCoeffs }
  }
  const distances: number[] = []
  for (let i = 0; i < templates.length; i++) {
    for (let j = i + 1; j < templates.length; j++) {
      const d = dtw(templates[i], templates[j])
      if (Number.isFinite(d)) distances.push(d)
    }
  }
  if (distances.length === 0) {
    return { templates, threshold: 22, numCoeffs: extractor.cfg.numCoeffs }
  }
  const worst = Math.max(...distances)
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length
  const threshold = Math.max(worst * 1.15, mean * 1.4, 18)
  console.log('[enroll] intra-template distances:', distances.map(d => d.toFixed(2)),
    'threshold:', threshold.toFixed(2))
  return { templates, threshold, numCoeffs: extractor.cfg.numCoeffs }
}
