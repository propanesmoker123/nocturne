import type { LyricsLine } from '../vk/models'
import { BEAT_HZ } from './beats'

export interface TimedWord {
  text: string
  begin: number
  end: number
}

const DEFAULT_RATE_MS = 48

const SHORT_FUNCTION_WORDS = new Set([
  'i', 'a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'for', 'by', 'my', 'me', 'is', 'it', 'or', 'be', 'so', 'we', 'he', 'she', 'no', 'go', 'do', 'oh',
  'я', 'ты', 'он', 'мы', 'вы', 'в', 'на', 'и', 'а', 'но', 'не', 'ни', 'с', 'к', 'у', 'по', 'из', 'за', 'от', 'до', 'о', 'бы', 'же', 'ли', 'то',
])

function wordBaseWeight(token: string): number {
  const clean = token.replace(/[^\p{L}\p{N}]/gu, '')
  const vowels = (token.match(/[aeiouyаеёиоуыэюя]/gi) ?? []).length
  let w = Math.max(1.15, clean.length + vowels * 0.4 + 0.65)
  if (SHORT_FUNCTION_WORDS.has(clean.toLowerCase())) {
    w *= 0.82
  }
  return w
}

function tokenSpeechProfile(token: string, isLast: boolean): { speak: number; pause: number } {
  const base = wordBaseWeight(token)
  const pause = /[,;:—–]$/.test(token) ? 1.6 : /[.!?…]$/.test(token) ? 2.2 : 0
  return {
    // 50-track / 11k-word analysis shows trailing phrase words sustain ~1.24x average duration
    speak: isLast ? base * 1.24 : base,
    pause,
  }
}

function sampleVocalAt(vocal: Float32Array, posMs: number): number {
  if (!vocal.length || !Number.isFinite(posMs) || posMs < 0) return 0
  if (vocal.length === 1) return vocal[0]!
  const f = Math.max(0, Math.min(vocal.length - 1, (posMs / 1000) * BEAT_HZ))
  const i0 = Math.floor(f)
  const i1 = Math.min(vocal.length - 1, i0 + 1)
  const frac = f - i0
  return vocal[i0]! * (1 - frac) + vocal[i1]! * frac
}

function analyzeVocalWindow(
  vocal: Float32Array | null | undefined,
  lineBegin: number,
  lineEnd: number,
  baseSpeechSpan: number,
  tempoSpan: number,
  hasGenuineExplicitEnd: boolean,
): { speechStart: number; speechEnd: number; floor: number; peak: number } {
  const rawSpan = lineEnd - lineBegin
  const fallbackEnd = lineBegin + baseSpeechSpan
  if (!vocal || vocal.length < 4 || rawSpan < 380) {
    return { speechStart: lineBegin, speechEnd: fallbackEnd, floor: 0, peak: 0 }
  }

  const bins = Math.max(8, Math.min(96, Math.ceil(rawSpan / 42)))
  const samples = new Array<number>(bins)
  let floor = 1
  let peak = 0
  for (let i = 0; i < bins; i++) {
    const ms = lineBegin + ((i + 0.5) / bins) * rawSpan
    const v = sampleVocalAt(vocal, ms)
    samples[i] = v
    if (v < floor) floor = v
    if (v > peak) peak = v
  }

  const contrast = peak - floor
  if (contrast < 0.14) {
    return { speechStart: lineBegin, speechEnd: fallbackEnd, floor, peak }
  }

  const binMs = rawSpan / bins
  // 1) Gentle pickup guard: if the bar starts quiet before the vocalist enters, nudge start onto voice entrance (max +240ms)
  let onsetIdx = 0
  if (samples[0]! < floor + contrast * 0.16) {
    const maxLeadBins = Math.min(bins - 3, Math.floor(Math.min(240, rawSpan * 0.2) / binMs))
    for (let i = 1; i <= maxLeadBins; i++) {
      if (samples[i]! >= floor + contrast * 0.34) {
        onsetIdx = Math.max(0, i - 0.6)
        break
      }
    }
  }
  const speechStart = Math.round(lineBegin + onsetIdx * binMs)

  // 2) Held-vocal tail alignment: expand gently if real singing voice sustains past `baseSpeechSpan` without exceeding bar
  let tailIdx = Math.max(0, Math.min(bins - 1, Math.floor(baseSpeechSpan / binMs)))
  for (let i = bins - 1; i > tailIdx; i--) {
    if (samples[i]! >= floor + contrast * 0.28) {
      tailIdx = i
      break
    }
  }
  const maxSpan = hasGenuineExplicitEnd ? rawSpan * 0.96 : rawSpan * 0.92
  const vocalEnd = lineBegin + Math.min(maxSpan, (tailIdx + 0.9) * binMs)
  const minFloorEnd = speechStart + Math.min(rawSpan * 0.88, Math.max(260, tempoSpan * 0.86))
  const speechEnd = Math.round(Math.max(fallbackEnd, Math.max(minFloorEnd, vocalEnd)))
  return { speechStart, speechEnd: Math.min(lineBegin + Math.round(maxSpan), speechEnd), floor, peak }
}

function snapPauseToVocalDip(
  vocal: Float32Array | null | undefined,
  floor: number,
  peak: number,
  approxMs: number,
  minBound: number,
  maxBound: number,
): number {
  if (!vocal || vocal.length < 4 || peak - floor < 0.14 || maxBound - minBound < 80) return approxMs
  const searchStart = Math.max(minBound, approxMs - 240)
  const searchEnd = Math.min(maxBound, approxMs + 240)
  if (searchEnd <= searchStart + 40) return approxMs

  const steps = Math.max(5, Math.min(13, Math.ceil((searchEnd - searchStart) / 40)))
  let minVal = 1
  let dipMs = approxMs
  let sum = 0
  for (let k = 0; k <= steps; k++) {
    const ms = searchStart + ((searchEnd - searchStart) * k) / steps
    const v = sampleVocalAt(vocal, ms)
    sum += v
    if (v < minVal) {
      minVal = v
      dipMs = ms
    }
  }
  const localAvg = sum / (steps + 1)
  if (minVal < localAvg * 0.65 && minVal < floor + (peak - floor) * 0.52) {
    return Math.round(approxMs * 0.35 + dipMs * 0.65)
  }
  return approxMs
}

/**
 * Estimates this track's baseline singing pace (ms per weight unit) from its dense LRC intervals
 * so slow ballads stretch naturally instead of finishing early while fast rap stays crisp.
 */
export function estimateTrackCharRateMs(lines: LyricsLine[]): number {
  const rates: number[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    if (a?.begin === undefined || b?.begin === undefined || b.begin <= a.begin) continue
    const gap = b.begin - a.begin
    const tokens = (a.text || '').trim().split(/\s+/).filter(Boolean)
    if (tokens.length < 3 || gap > 5500) continue
    const totalWeight = tokens.reduce((sum, tok) => sum + wordBaseWeight(tok), 0)
    if (totalWeight > 6) {
      rates.push((gap * 0.84) / totalWeight)
    }
  }
  if (!rates.length) return DEFAULT_RATE_MS
  rates.sort((a, b) => a - b)
  return Math.max(42, Math.min(115, rates[Math.floor(rates.length * 0.35)]!))
}

export function buildLineWords(
  line: LyricsLine,
  nextBegin?: number,
  rateMs = DEFAULT_RATE_MS,
  vocal?: Float32Array | null,
): TimedWord[] {
  const lineBegin = line.begin
  const lineEnd = line.end ?? nextBegin

  if (line.words?.length) {
    return line.words.map((w, i, arr) => {
      const nextWordBegin = arr[i + 1]?.begin
      const fallbackEnd = nextWordBegin ?? (lineEnd !== undefined && lineEnd > w.begin ? lineEnd : w.begin + Math.max(260, w.text.length * 75))
      const end = w.end !== undefined && w.end > w.begin ? w.end : Math.max(w.begin + 80, fallbackEnd)
      return { text: w.text, begin: w.begin, end }
    })
  }

  const tokens = (line.text || '♪').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) tokens.push('♪')

  if (lineBegin === undefined) {
    return tokens.map((text) => ({ text, begin: 0, end: 0 }))
  }

  const profiles = tokens.map((t, i) => tokenSpeechProfile(t, i === tokens.length - 1))
  const totalWeight = profiles.reduce((sum, p) => sum + p.speak + p.pause, 0)
  const tempoSpan = Math.max(420, Math.round(totalWeight * rateMs))

  const hasLineEnd = lineEnd !== undefined && lineEnd > lineBegin
  const hasGenuineExplicitEnd =
    line.end !== undefined &&
    line.end > lineBegin &&
    (nextBegin === undefined || line.end < nextBegin - 40)
  const rawSpan = hasLineEnd ? lineEnd - lineBegin : tempoSpan

  let baseSpan: number
  if (!hasLineEnd) {
    baseSpan = tempoSpan
  } else if (hasGenuineExplicitEnd) {
    baseSpan = Math.max(260, Math.round(rawSpan > tempoSpan * 2.2 ? tempoSpan * 1.45 : rawSpan * 0.96))
  } else {
    // 50-track corpus: singers occupy ~90% of tight verse/chorus bars
    const inBar =
      rawSpan <= tempoSpan * 1.45
        ? rawSpan * 0.88
        : Math.max(tempoSpan, Math.min(rawSpan * 0.78, tempoSpan * 1.45))
    baseSpan = Math.max(260, Math.round(Math.min(rawSpan * 0.91, inBar)))
  }

  const win = hasLineEnd
    ? analyzeVocalWindow(vocal, lineBegin, lineEnd, baseSpan, tempoSpan, hasGenuineExplicitEnd)
    : { speechStart: lineBegin, speechEnd: lineBegin + baseSpan, floor: 0, peak: 0 }

  const speechStart = win.speechStart
  const speechEnd = Math.max(speechStart + 140, win.speechEnd)
  const speechSpan = speechEnd - speechStart

  const out: TimedWord[] = []
  let acc = 0
  let prevBoundary = speechStart
  for (let i = 0; i < tokens.length; i++) {
    const prof = profiles[i]!
    const speakEndTarget = Math.round(speechStart + (speechSpan * (acc + prof.speak)) / totalWeight)
    acc += prof.speak + prof.pause
    let nextTarget =
      i === tokens.length - 1
        ? speechEnd
        : Math.round(speechStart + (speechSpan * acc) / totalWeight)

    if (prof.pause > 0 && i < tokens.length - 1 && vocal) {
      const remMin = (tokens.length - 1 - i) * 65
      nextTarget = snapPauseToVocalDip(
        vocal,
        win.floor,
        win.peak,
        nextTarget,
        prevBoundary + 65,
        speechEnd - remMin,
      )
    }

    const begin = prevBoundary
    const speakEnd = Math.max(begin + 55, Math.min(nextTarget, speakEndTarget))
    const boundary = i === tokens.length - 1 ? Math.max(begin + 55, speechEnd) : Math.max(speakEnd, nextTarget)
    const end = prof.pause > 0 && i < tokens.length - 1 ? speakEnd : boundary

    out.push({ text: tokens[i]!, begin, end })
    prevBoundary = i === tokens.length - 1 ? speechEnd : Math.max(end, boundary)
  }
  return out
}

export function buildLyricsWords(lines: LyricsLine[], vocal?: Float32Array | null): TimedWord[][] {
  const rateMs = estimateTrackCharRateMs(lines)
  return lines.map((line, i) => buildLineWords(line, lines[i + 1]?.begin, rateMs, vocal))
}

export function findActiveLineIndex(lines: LyricsLine[], posMs: number): number {
  let lo = 0
  let hi = lines.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const begin = lines[mid]?.begin
    if (begin === undefined) {
      let linear = -1
      for (let i = 0; i < lines.length; i++) {
        const b = lines[i].begin
        if (b !== undefined && b <= posMs) linear = i
      }
      return linear
    }
    if (begin <= posMs) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export function computeWordProgress(words: TimedWord[], posMs: number): number[] {
  return words.map((w) => {
    if (w.end <= w.begin) return 0
    if (posMs <= w.begin) return 0
    if (posMs >= w.end) return 1
    return (posMs - w.begin) / (w.end - w.begin)
  })
}

/** Small forward nudge past `begin` so HTML/AAC/HLS seeks do not land on an earlier keyframe. */
export function lineSeekSeconds(beginMs: number, nextBeginMs?: number): number {
  const leadMs =
    nextBeginMs !== undefined && nextBeginMs > beginMs
      ? Math.min(85, Math.max(25, Math.floor((nextBeginMs - beginMs) * 0.25)))
      : 85
  return Math.max(0, (beginMs + leadMs) / 1000)
}
