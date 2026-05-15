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

export interface TwoStagePayload {
  positives: { buf: Float32Array; sampleRate: number }[]
  negatives: { buf: Float32Array; sampleRate: number }[]
  verify: { buf: Float32Array; sampleRate: number }[]
}

/**
 * Two-stage threshold calibration:
 *   1. Build templates from positives (with outlier rejection).
 *   2. Slide a 1.5 s window over the silence sample, score each window
 *      vs the templates — these are NEGATIVE DTW scores.
 *   3. Score each verify clip vs templates — these are POSITIVE scores.
 *   4. Pick threshold = midpoint(max positive, min negative). If that
 *      window is inverted (positives score worse than negatives), fall
 *      back to the original intra-template heuristic.
 */
export function buildEnrollmentTwoStage(p: TwoStagePayload): EnrolledTemplates {
  const extractor = new MFCCExtractor()
  const base = buildEnrollment(p.positives) // templates + fallback threshold

  if (base.templates.length === 0) return base

  // Score a recorded clip against the best-matching template.
  const scoreClip = (buf: Float32Array, sr: number): number => {
    const re = resampleTo16k(buf, sr)
    const trimmed = trimSilence(re, 16000)
    if (trimmed.length < 16000 * 0.3) return Infinity
    const seq = cmn(extractor.sequence(trimmed))
    if (seq.length === 0) return Infinity
    let best = Infinity
    for (const t of base.templates) {
      const d = dtw(seq, t)
      if (Number.isFinite(d) && d < best) best = d
    }
    return best
  }

  // Slide 1.5 s windows (~750 ms hop) over each silence clip.
  const negScores: number[] = []
  for (const clip of p.negatives) {
    const re = resampleTo16k(clip.buf, clip.sampleRate)
    const winSamples = Math.floor(16000 * 1.5)
    const hop = Math.floor(16000 * 0.75)
    for (let off = 0; off + winSamples <= re.length; off += hop) {
      const slice = re.slice(off, off + winSamples)
      const s = scoreClip(slice, 16000)
      if (Number.isFinite(s)) negScores.push(s)
    }
  }

  const posScores: number[] = p.verify
    .map(c => scoreClip(c.buf, c.sampleRate))
    .filter(s => Number.isFinite(s))

  console.log('[enroll/calibrate] positive scores:', posScores.map(s => s.toFixed(2)))
  console.log('[enroll/calibrate] negative scores:', negScores.map(s => s.toFixed(2)))

  if (posScores.length === 0 || negScores.length === 0) {
    console.log('[enroll/calibrate] not enough data, using intra-template threshold:', base.threshold.toFixed(2))
    return base
  }

  const maxPos = Math.max(...posScores)
  const minNeg = Math.min(...negScores)
  if (maxPos < minNeg) {
    // Healthy separation — threshold sits between them, biased toward
    // recall (closer to negatives so future utterances with variation
    // still match).
    const threshold = maxPos + (minNeg - maxPos) * 0.6
    console.log('[enroll/calibrate] separated — maxPos:', maxPos.toFixed(2),
      'minNeg:', minNeg.toFixed(2), '→ threshold:', threshold.toFixed(2))
    return { ...base, threshold: Math.max(threshold, 12) }
  }

  // Inverted: positives are no better than the room. Best we can do is
  // pick a threshold just above the median positive and warn.
  const sortedPos = [...posScores].sort((a, b) => a - b)
  const medianPos = sortedPos[Math.floor(sortedPos.length / 2)]
  const threshold = Math.max(medianPos * 1.05, 14)
  console.warn('[enroll/calibrate] positives NOT cleanly separable from room noise',
    '— maxPos:', maxPos.toFixed(2), 'minNeg:', minNeg.toFixed(2),
    'falling back to median-pos threshold:', threshold.toFixed(2))
  return { ...base, threshold }
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
  // Step 1: drop length-outliers (>1.4× or <0.6× median). These are
  // almost always trimmer misses; they poison DTW.
  const lens = raw.map(s => s.length).sort((a, b) => a - b)
  const medLen = lens.length ? lens[Math.floor(lens.length / 2)] : 0
  let templates = raw.filter(s =>
    s.length <= medLen * 1.4 && s.length >= medLen * 0.6,
  )
  console.log('[enroll] length filter — kept', templates.length, 'of', raw.length,
    'frame counts:', templates.map(t => t.length), 'median:', medLen)

  // Step 2: distance-outlier rejection. Compute each template's mean
  // distance to the others; drop ones that are >1.5× the median mean.
  if (templates.length >= 3) {
    const meanDistTo = templates.map((tpl, i) => {
      let sum = 0, n = 0
      for (let j = 0; j < templates.length; j++) {
        if (i === j) continue
        const d = dtw(tpl, templates[j])
        if (Number.isFinite(d)) { sum += d; n += 1 }
      }
      return n ? sum / n : Infinity
    })
    const sortedMeans = [...meanDistTo].sort((a, b) => a - b)
    const medMean = sortedMeans[Math.floor(sortedMeans.length / 2)]
    const before = templates.length
    templates = templates.filter((_, i) => meanDistTo[i] <= medMean * 1.5)
    console.log('[enroll] distance filter — dropped', before - templates.length,
      '(mean dists:', meanDistTo.map(d => d.toFixed(2)), 'medMean:', medMean.toFixed(2), ')')
  }

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
  const min = Math.min(...distances)
  // Empirically a real runtime utterance scores BELOW the intra-template
  // mean (it gets to pick the best-matching template, while intra-pairs
  // don't). Set threshold below the mean so noise above mean is rejected.
  const threshold = Math.max(Math.min(mean * 0.85, min * 1.0), 14)
  console.log('[enroll] intra-template distances:', distances.map(d => d.toFixed(2)),
    'worst:', worst.toFixed(2), 'mean:', mean.toFixed(2), 'threshold:', threshold.toFixed(2))
  return { templates, threshold, numCoeffs: extractor.cfg.numCoeffs }
}
