// Dynamic Time Warping distance between two sequences of feature vectors.
// Standard banded DP with Sakoe–Chiba constraint to keep matching cheap.

function euclid(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return Math.sqrt(s)
}

export interface DTWOptions {
  /** Sakoe–Chiba band width as a fraction of max(n,m). 0.2 = ±20%. */
  band?: number
}

/** Returns DTW distance normalized by warp-path length. Smaller = more similar. */
export function dtw(a: Float32Array[], b: Float32Array[], opts: DTWOptions = {}): number {
  const n = a.length, m = b.length
  if (n === 0 || m === 0) return Infinity
  const band = Math.max(1, Math.floor((opts.band ?? 0.2) * Math.max(n, m)))
  const INF = Number.POSITIVE_INFINITY

  // cost matrix: only need two rows
  let prev = new Float64Array(m + 1)
  let curr = new Float64Array(m + 1)
  prev.fill(INF); curr.fill(INF)
  prev[0] = 0

  // path-length matrix for normalization
  let prevLen = new Float64Array(m + 1)
  let currLen = new Float64Array(m + 1)

  for (let i = 1; i <= n; i++) {
    curr.fill(INF)
    currLen.fill(0)
    const jStart = Math.max(1, i - band)
    const jEnd = Math.min(m, i + band)
    for (let j = jStart; j <= jEnd; j++) {
      const c = euclid(a[i - 1], b[j - 1])
      // three predecessors: (i-1,j-1) diag, (i-1,j) up, (i,j-1) left
      const diag = prev[j - 1]
      const up = prev[j]
      const left = curr[j - 1]
      let best = diag, bestLen = prevLen[j - 1]
      if (up < best) { best = up; bestLen = prevLen[j] }
      if (left < best) { best = left; bestLen = currLen[j - 1] }
      curr[j] = best + c
      currLen[j] = bestLen + 1
    }
    ;[prev, curr] = [curr, prev]
    ;[prevLen, currLen] = [currLen, prevLen]
  }
  const total = prev[m]
  const len = prevLen[m] || 1
  return total / len
}
