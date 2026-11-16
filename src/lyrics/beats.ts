export const BEAT_HZ = 24
const MAX_BINS = 72000

export interface BeatAcc {
  sumSq: Float64Array
  vocalSumSq: Float64Array
  count: Uint32Array
  hz: number
  bins: number
  lp: number
  lpVocHi: number
  lpVocLo: number
  lpVocLo2: number
}

export function createBeatAcc(durationSec: number, hz = BEAT_HZ): BeatAcc {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || hz <= 0) {
    return {
      sumSq: new Float64Array(0),
      vocalSumSq: new Float64Array(0),
      count: new Uint32Array(0),
      hz,
      bins: 0,
      lp: 0,
      lpVocHi: 0,
      lpVocLo: 0,
      lpVocLo2: 0,
    }
  }
  const bins = Math.max(1, Math.min(MAX_BINS, Math.ceil(durationSec * hz)))
  return {
    sumSq: new Float64Array(bins),
    vocalSumSq: new Float64Array(bins),
    count: new Uint32Array(bins),
    hz,
    bins,
    lp: 0,
    lpVocHi: 0,
    lpVocLo: 0,
    lpVocLo2: 0,
  }
}

export function accumulateBeatPcm(
  acc: BeatAcc,
  channels: readonly Float32Array[],
  sampleRate: number,
  startSec: number,
): void {
  if (acc.bins <= 0 || !channels.length || sampleRate <= 0) return
  const c0 = channels[0]
  if (!c0?.length) return
  const chCount = channels.length
  const len = c0.length
  const invSr = 1 / sampleRate
  // 1-pole ~190 Hz low-pass emphasises kick/bass transients so sustained vocals do not mask beat hits.
  const lpAlpha = Math.min(0.45, (2 * Math.PI * 190) / sampleRate)
  // 2-pole ~400..3200 Hz band-pass rejects 808 sub-bass kicks strongly while keeping vocal formants & consonants crisp.
  const vocHiAlpha = Math.min(0.85, (2 * Math.PI * 3200) / sampleRate)
  const vocLoAlpha = Math.min(0.48, (2 * Math.PI * 400) / sampleRate)
  let lp = acc.lp
  let lpVocHi = acc.lpVocHi
  let lpVocLo = acc.lpVocLo
  let lpVocLo2 = acc.lpVocLo2
  for (let i = 0; i < len; i++) {
    const bin = Math.floor((startSec + i * invSr) * acc.hz)
    if (bin < 0) continue
    if (bin >= acc.bins) break
    let mono = 0
    for (let c = 0; c < chCount; c++) mono += channels[c]![i]!
    if (chCount > 1) mono /= chCount
    lp += lpAlpha * (mono - lp)
    lpVocHi += vocHiAlpha * (mono - lpVocHi)
    lpVocLo += vocLoAlpha * (lpVocHi - lpVocLo)
    const bp1 = lpVocHi - lpVocLo
    lpVocLo2 += vocLoAlpha * (bp1 - lpVocLo2)
    const vocBp = bp1 - lpVocLo2
    acc.sumSq[bin]! += 0.68 * (lp * lp) + 0.32 * (mono * mono)
    acc.vocalSumSq[bin]! += vocBp * vocBp
    acc.count[bin]! += 1
  }
  acc.lp = lp
  acc.lpVocHi = lpVocHi
  acc.lpVocLo = lpVocLo
  acc.lpVocLo2 = lpVocLo2
}

function normalizeEnvelope(raw: Float32Array): Float32Array {
  const n = raw.length
  const out = new Float32Array(n)
  if (!n) return out
  const nonZero: number[] = []
  let max = 0
  for (let i = 0; i < n; i++) {
    const v = raw[i]!
    if (v > 0) nonZero.push(v)
    if (v > max) max = v
  }
  if (max <= 0 || !nonZero.length) return out
  nonZero.sort((a, b) => a - b)
  const p96 = nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * 0.96))]!
  const ceil = Math.max(max * 0.45, p96, 1e-5)
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(0, raw[i]! / ceil))
    out[i] = Math.pow(v, 0.9)
  }
  return out
}

function finalizeRmsBins(sumSq: Float64Array, count: Uint32Array, bins: number): Float32Array {
  if (bins <= 0) return new Float32Array(0)
  const rms = new Float32Array(bins)
  for (let i = 0; i < bins; i++) {
    const c = count[i]!
    rms[i] = c > 0 ? Math.sqrt(sumSq[i]! / c) : 0
  }
  // Fill single-bin decode gaps without bleeding into unloaded trailing bins
  for (let i = 1; i < bins - 1; i++) {
    if (count[i] === 0 && count[i - 1]! > 0 && count[i + 1]! > 0) {
      rms[i] = (rms[i - 1]! + rms[i + 1]!) * 0.5
    }
  }
  return normalizeEnvelope(rms)
}

export function finalizeBeatEnvelope(acc: BeatAcc): Float32Array {
  return finalizeRmsBins(acc.sumSq, acc.count, acc.bins)
}

export function finalizeVocalEnvelope(acc: BeatAcc): Float32Array {
  return finalizeRmsBins(acc.vocalSumSq, acc.count, acc.bins)
}

export function beatsFromSegments(
  segments: [number, number, number][],
  duration: number,
): Float32Array | null {
  if (!segments.length || !Number.isFinite(duration) || duration <= 0) return null
  const bins = Math.max(1, Math.min(MAX_BINS, Math.ceil(duration * BEAT_HZ)))
  const raw = new Float32Array(bins)
  for (const [start, dur, loudnessDb] of segments) {
    const amp = Math.pow(10, Math.min(0, Math.max(-45, loudnessDb)) / 20)
    const fromBin = Math.max(0, Math.min(bins - 1, Math.floor(start * BEAT_HZ)))
    const toBin = Math.min(
      bins - 1,
      Math.max(fromBin, Math.floor((start + Math.max(0.08, dur)) * BEAT_HZ)),
    )
    for (let b = fromBin; b <= toBin; b++) {
      const elapsed = b / BEAT_HZ - start
      const shaped = elapsed <= 0 ? amp : amp * (0.35 + 0.65 * Math.exp(-elapsed / 0.14))
      if (shaped > raw[b]!) raw[b] = shaped
    }
  }
  return normalizeEnvelope(raw)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function shapedFlux(jump: number, gate: number, span: number): number {
  const above = Math.max(0, jump - gate)
  if (above <= 0) return 0
  return clamp01(Math.pow(above / span, 1.08))
}

function binFlux(env: Float32Array, idx: number): number {
  const curr = env[idx]!
  const prev1 = idx > 0 ? env[idx - 1]! : 0
  let prevMin = prev1
  const lookback = Math.max(0, idx - 4)
  for (let j = lookback; j < idx; j++) {
    if (env[j]! < prevMin) prevMin = env[j]!
  }
  const baseline = prevMin * 0.65 + prev1 * 0.35
  return shapedFlux(curr - baseline, 0.045, 0.165)
}

export interface BeatEnvelopeState {
  kick: number
  energy: number
}

/** Smoothly integrates target kick (fast attack, punchy decay) and ambient vocal/beat energy across frames. */
export function stepBeatEnvelope(
  state: BeatEnvelopeState,
  targetKick: number,
  targetEnergy: number,
  dtMs: number,
): BeatEnvelopeState {
  const safeDt = Math.max(1, Math.min(64, dtMs))
  const attackRate = 1 - Math.exp(-safeDt / 18)
  const nextKick =
    targetKick > state.kick
      ? state.kick + (targetKick - state.kick) * attackRate
      : state.kick * Math.exp(-safeDt / 135)
  const energyRate = 1 - Math.exp(-safeDt / 95)
  const nextEnergy = state.energy + (targetEnergy - state.energy) * energyRate
  state.kick = nextKick < 0.005 ? 0 : nextKick
  state.energy = nextEnergy < 0.005 ? 0 : nextEnergy
  return state
}

export function sampleBeatAt(
  beats: Float32Array | null,
  peaks: Float32Array | null,
  durationSec: number,
  posMs: number,
): { energy: number; kick: number } {
  if (!Number.isFinite(posMs) || posMs < 0) {
    return { energy: 0, kick: 0 }
  }
  const tSec = posMs / 1000
  if (beats && beats.length > 1) {
    // Beats array is indexed directly in wall-audio seconds * BEAT_HZ, avoiding drift when metadata duration differs.
    const fIdx = Math.max(0, Math.min(beats.length - 1, tSec * BEAT_HZ))
    const i0 = Math.floor(fIdx)
    const i1 = Math.min(beats.length - 1, i0 + 1)
    const frac = fIdx - i0
    const energy = clamp01(beats[i0]! * (1 - frac) + beats[i1]! * frac)
    const f0 = binFlux(beats, i0)
    const f1 = binFlux(beats, i1)
    const fPrev = i0 > 0 ? binFlux(beats, i0 - 1) * 0.62 * (1 - frac) : 0
    const flux = Math.max(f0 * (1 - frac) + f1 * frac, fPrev)
    const sustainedPush = Math.max(0, energy - 0.78) * 0.55
    return { energy, kick: clamp01(Math.max(flux, sustainedPush)) }
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { energy: 0, kick: 0 }
  }
  if (peaks && peaks.length > 1) {
    const fIdx = Math.max(0, Math.min(peaks.length - 1, (tSec / durationSec) * (peaks.length - 1)))
    const i0 = Math.floor(fIdx)
    const i1 = Math.min(peaks.length - 1, i0 + 1)
    const frac = fIdx - i0
    const energy = clamp01(peaks[i0]! * (1 - frac) + peaks[i1]! * frac)
    const prev = i0 > 0 ? peaks[i0 - 1]! : energy
    const kick = clamp01(Math.max(shapedFlux(energy - prev, 0.045, 0.19), Math.max(0, energy - 0.8) * 0.6))
    return { energy, kick }
  }
  return { energy: 0, kick: 0 }
}
