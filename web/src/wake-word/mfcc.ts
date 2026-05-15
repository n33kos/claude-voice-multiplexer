// Minimal MFCC implementation. Self-contained — no external deps.
//
// Pipeline per frame:
//   pre-emphasis → window (Hamming) → real FFT → power spectrum
//   → mel filter bank → log → DCT-II → keep N coefficients
//
// Defaults are reasonable for 16 kHz speech at ~30 ms frames.

export interface MFCCConfig {
  sampleRate: number
  fftSize: number          // power of two
  frameSize: number        // samples per frame (<= fftSize)
  hopSize: number          // samples between frames
  numMelFilters: number
  numCoeffs: number        // number of MFCCs to keep (incl. C0 or not — see keepC0)
  keepC0: boolean
  preEmphasis: number      // 0 to disable
  fMin: number
  fMax: number
}

export const DEFAULT_MFCC: MFCCConfig = {
  sampleRate: 16000,
  fftSize: 512,
  frameSize: 480,   // 30 ms
  hopSize: 160,     // 10 ms
  numMelFilters: 26,
  numCoeffs: 13,
  keepC0: false,
  preEmphasis: 0.97,
  fMin: 80,
  fMax: 7600,
}

// --- mel scale helpers ---

function hzToMel(hz: number) {
  return 2595 * Math.log10(1 + hz / 700)
}
function melToHz(mel: number) {
  return 700 * (Math.pow(10, mel / 2595) - 1)
}

function buildMelFilterBank(cfg: MFCCConfig): Float32Array[] {
  const { fftSize, numMelFilters, sampleRate, fMin, fMax } = cfg
  const nBins = fftSize / 2 + 1
  const melLow = hzToMel(fMin)
  const melHigh = hzToMel(fMax)
  const melPoints = new Float32Array(numMelFilters + 2)
  for (let i = 0; i < melPoints.length; i++) {
    melPoints[i] = melLow + ((melHigh - melLow) * i) / (numMelFilters + 1)
  }
  const binPoints = new Int32Array(numMelFilters + 2)
  for (let i = 0; i < melPoints.length; i++) {
    const hz = melToHz(melPoints[i])
    binPoints[i] = Math.floor(((fftSize + 1) * hz) / sampleRate)
  }
  const filters: Float32Array[] = []
  for (let m = 1; m <= numMelFilters; m++) {
    const f = new Float32Array(nBins)
    const left = binPoints[m - 1]
    const center = binPoints[m]
    const right = binPoints[m + 1]
    for (let k = left; k < center; k++) {
      if (center === left) continue
      f[k] = (k - left) / (center - left)
    }
    for (let k = center; k < right; k++) {
      if (right === center) continue
      f[k] = (right - k) / (right - center)
    }
    filters.push(f)
  }
  return filters
}

// --- Hamming window ---

function buildHamming(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))
  }
  return w
}

// --- iterative radix-2 FFT (in-place, real input via complex) ---

function bitReverse(n: number, bits: number) {
  let r = 0
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (n & 1)
    n >>= 1
  }
  return r
}

function fftRealPower(input: Float32Array, fftSize: number, out: Float32Array) {
  // real input → power spectrum (length fftSize/2 + 1)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const len = Math.min(input.length, fftSize)
  for (let i = 0; i < len; i++) re[i] = input[i]

  const bits = Math.log2(fftSize) | 0
  for (let i = 0; i < fftSize; i++) {
    const j = bitReverse(i, bits)
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let size = 2; size <= fftSize; size *= 2) {
    const half = size / 2
    const tAngle = (-2 * Math.PI) / size
    for (let i = 0; i < fftSize; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = tAngle * k
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const i1 = i + k
        const i2 = i + k + half
        const tr = re[i2] * cos - im[i2] * sin
        const ti = re[i2] * sin + im[i2] * cos
        re[i2] = re[i1] - tr
        im[i2] = im[i1] - ti
        re[i1] += tr
        im[i1] += ti
      }
    }
  }
  const nBins = fftSize / 2 + 1
  for (let i = 0; i < nBins; i++) {
    out[i] = re[i] * re[i] + im[i] * im[i]
  }
}

// --- DCT-II ---

function dctII(input: Float32Array, n: number, out: Float32Array) {
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let i = 0; i < input.length; i++) {
      s += input[i] * Math.cos((Math.PI * (i + 0.5) * k) / input.length)
    }
    out[k] = s
  }
}

// --- public extractor ---

export class MFCCExtractor {
  cfg: MFCCConfig
  private hamming: Float32Array
  private filters: Float32Array[]
  private powerBuf: Float32Array
  private melBuf: Float32Array
  private dctBuf: Float32Array

  constructor(cfg: Partial<MFCCConfig> = {}) {
    this.cfg = { ...DEFAULT_MFCC, ...cfg }
    this.hamming = buildHamming(this.cfg.frameSize)
    this.filters = buildMelFilterBank(this.cfg)
    this.powerBuf = new Float32Array(this.cfg.fftSize / 2 + 1)
    this.melBuf = new Float32Array(this.cfg.numMelFilters)
    this.dctBuf = new Float32Array(this.cfg.numMelFilters)
  }

  /** Extract one MFCC vector from a frame of length frameSize. */
  frame(samples: Float32Array): Float32Array {
    const cfg = this.cfg
    // pre-emphasis + window into local buffer (length fftSize, zero-padded)
    const windowed = new Float32Array(cfg.fftSize)
    let prev = 0
    for (let i = 0; i < cfg.frameSize; i++) {
      const x = samples[i] ?? 0
      const pe = x - cfg.preEmphasis * prev
      prev = x
      windowed[i] = pe * this.hamming[i]
    }
    fftRealPower(windowed, cfg.fftSize, this.powerBuf)

    // mel filter bank energies (log)
    for (let m = 0; m < cfg.numMelFilters; m++) {
      const filt = this.filters[m]
      let s = 0
      for (let k = 0; k < filt.length; k++) s += filt[k] * this.powerBuf[k]
      this.melBuf[m] = Math.log(s + 1e-12)
    }
    dctII(this.melBuf, cfg.numMelFilters, this.dctBuf)

    const start = cfg.keepC0 ? 0 : 1
    const out = new Float32Array(cfg.numCoeffs)
    for (let i = 0; i < cfg.numCoeffs; i++) {
      out[i] = this.dctBuf[start + i] ?? 0
    }
    return out
  }

  /** Extract a sequence of MFCC vectors from a longer audio buffer. */
  sequence(audio: Float32Array): Float32Array[] {
    const cfg = this.cfg
    const out: Float32Array[] = []
    for (let off = 0; off + cfg.frameSize <= audio.length; off += cfg.hopSize) {
      const slice = audio.subarray(off, off + cfg.frameSize)
      out.push(this.frame(slice))
    }
    return out
  }
}

/** Mean-normalize a sequence so cepstral offset doesn't dominate distance. */
export function cmn(seq: Float32Array[]): Float32Array[] {
  if (seq.length === 0) return seq
  const dim = seq[0].length
  const mean = new Float32Array(dim)
  for (const v of seq) for (let i = 0; i < dim; i++) mean[i] += v[i]
  for (let i = 0; i < dim; i++) mean[i] /= seq.length
  return seq.map(v => {
    const o = new Float32Array(dim)
    for (let i = 0; i < dim; i++) o[i] = v[i] - mean[i]
    return o
  })
}
