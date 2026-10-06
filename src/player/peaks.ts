/** Loudness of a track in fixed time bins, filled chunk by chunk as audio gets decoded. */
export const BINS = 240

export interface PeakAcc {
  sums: Float64Array
  counts: Uint32Array
}

export const newAcc = (): PeakAcc => ({ sums: new Float64Array(BINS), counts: new Uint32Array(BINS) })

/**
 * Adds decoded samples that start `start` seconds into a track of `duration` seconds.
 * Channels are mixed by averaging their squares (RMS per bin).
 */
export function accumulate(acc: PeakAcc, channels: Float32Array[], sampleRate: number, start: number, duration: number) {
  if (!channels.length || duration <= 0 || sampleRate <= 0) return
  const n = channels[0].length
  const perBin = (duration * sampleRate) / BINS
  const first = start * sampleRate
  for (let i = 0; i < n; i++) {
    const bin = Math.floor((first + i) / perBin)
    if (bin < 0) continue
    if (bin >= BINS) break
    let sq = 0
    for (const ch of channels) sq += ch[i] * ch[i]
    acc.sums[bin] += sq / channels.length
    acc.counts[bin]++
  }
}

/** 0..1 per bin relative to the loudest bin so far; -1 where nothing is decoded yet. */
export function toPeaks(acc: PeakAcc): Float32Array {
  const out = new Float32Array(BINS)
  let max = 0
  for (let b = 0; b < BINS; b++) {
    out[b] = acc.counts[b] ? Math.sqrt(acc.sums[b] / acc.counts[b]) : -1
    if (out[b] > max) max = out[b]
  }
  for (let b = 0; b < BINS; b++) if (out[b] >= 0) out[b] = max > 0 ? Math.pow(out[b] / max, 0.8) : 0
  return out
}

export const isComplete = (acc: PeakAcc) => acc.counts.every((c) => c > 0)

/** Squeezes the bins into `bars` columns (loudest bin wins); -1 when a column is still unknown. */
export function resample(peaks: Float32Array | null, bars: number): number[] {
  const out = new Array<number>(bars).fill(-1)
  if (!peaks) return out
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * peaks.length) / bars)
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars))
    for (let b = from; b < to && b < peaks.length; b++) if (peaks[b] > out[i]) out[i] = peaks[b]
  }
  return out
}
