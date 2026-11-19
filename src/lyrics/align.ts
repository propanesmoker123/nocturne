import type { Lyrics, LyricsLine, LyricsWord } from '../vk/models'

export interface WhisperWordChunk {
  text: string
  beginMs: number
  endMs: number
}

interface RefToken {
  lineIdx: number
  text: string
  norm: string
  begin?: number
  end?: number
}

function normWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

let simPrev = new Int32Array(64)
let simCur = new Int32Array(64)

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const m = a.length
  const n = b.length
  const maxLen = m > n ? m : n
  const minLen = m < n ? m : n
  // Exact upper bound: edit distance >= maxLen - minLen, so similarity <= minLen / maxLen.
  if (minLen / maxLen < 0.45) return 0

  if (n + 1 > simPrev.length) {
    const cap = Math.max(n + 1, simPrev.length * 2)
    simPrev = new Int32Array(cap)
    simCur = new Int32Array(cap)
  }
  const prev = simPrev
  const cur = simCur
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      const del = prev[j] + 1
      const ins = cur[j - 1] + 1
      const sub = prev[j - 1] + cost
      cur[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]
  }
  return 1 - prev[n] / maxLen
}

function isSectionHeader(text: string): boolean {
  return /^\[[^\]]+\]$/.test(text.trim())
}

export function alignWhisperToLines(plainLines: LyricsLine[], asrWords: WhisperWordChunk[]): LyricsLine[] {
  const cleanAsr = asrWords
    .map((w) => ({ norm: normWord(w.text), beginMs: Math.round(w.beginMs), endMs: Math.round(Math.max(w.beginMs + 50, w.endMs)) }))
    .filter((w) => w.norm.length > 0 && Number.isFinite(w.beginMs))

  const refs: RefToken[] = []
  for (let li = 0; li < plainLines.length; li++) {
    const trimmed = plainLines[li].text.trim()
    if (!trimmed || trimmed === '♪' || isSectionHeader(trimmed)) continue
    for (const raw of trimmed.split(/\s+/)) {
      if (!raw) continue
      refs.push({ lineIdx: li, text: raw, norm: normWord(raw) })
    }
  }

  if (!refs.length || !cleanAsr.length) return plainLines

  const R = refs.length
  const A = cleanAsr.length
  const GAP = -0.32
  const stride = A + 1
  const useBand = R * A > 250_000
  const halfBand = useBand ? Math.max(160, Math.abs(R - A) + Math.ceil(Math.max(R, A) * 0.25)) : A + 1
  const dp = new Float32Array((R + 1) * stride)
  const dir = new Uint8Array((R + 1) * stride) // 1: diag, 2: up (skip ref), 3: left (skip asr)
  if (useBand) dp.fill(-1e9)
  dp[0] = 0

  for (let i = 1; i <= R; i++) {
    dp[i * stride] = dp[(i - 1) * stride] + GAP
    dir[i * stride] = 2
  }
  for (let j = 1; j <= A; j++) {
    dp[j] = dp[j - 1] + GAP
    dir[j] = 3
  }

  for (let i = 1; i <= R; i++) {
    const rn = refs[i - 1].norm
    const center = useBand ? Math.round((i * A) / R) : 0
    const jStart = useBand ? Math.max(1, center - halfBand) : 1
    const jEnd = useBand ? Math.min(A, center + halfBand) : A
    const rowOff = i * stride
    const prevRowOff = (i - 1) * stride
    for (let j = jStart; j <= jEnd; j++) {
      const sim = similarity(rn, cleanAsr[j - 1].norm)
      const matchScore = sim >= 0.45 ? sim * 2.2 : -0.8
      const dScore = dp[prevRowOff + (j - 1)] + matchScore
      const uScore = dp[prevRowOff + j] + GAP
      const lScore = dp[rowOff + (j - 1)] + GAP
      const idx = rowOff + j
      if (dScore >= uScore && dScore >= lScore) {
        dp[idx] = dScore
        dir[idx] = 1
      } else if (uScore >= lScore) {
        dp[idx] = uScore
        dir[idx] = 2
      } else {
        dp[idx] = lScore
        dir[idx] = 3
      }
    }
  }

  let ri = R
  let ai = A
  while (ri > 0 || ai > 0) {
    const d = dir[ri * stride + ai]
    if (d === 1 && ri > 0 && ai > 0) {
      const sim = similarity(refs[ri - 1].norm, cleanAsr[ai - 1].norm)
      if (sim >= 0.45) {
        refs[ri - 1].begin = cleanAsr[ai - 1].beginMs
        refs[ri - 1].end = cleanAsr[ai - 1].endMs
      }
      ri--
      ai--
    } else if (d === 2 && ri > 0) {
      ri--
    } else if (ai > 0) {
      ai--
    } else {
      break
    }
  }

  // Interpolate unmatched spans monotonically without overshooting nextBegin
  let i = 0
  while (i < refs.length) {
    if (refs[i].begin !== undefined) {
      i++
      continue
    }
    const start = i
    while (i < refs.length && refs[i].begin === undefined) i++
    const count = i - start
    const prevEnd = start > 0 ? refs[start - 1].end! : Math.max(0, cleanAsr[0].beginMs - count * 350)
    const nextBegin = i < refs.length ? Math.max(prevEnd + 80, refs[i].begin!) : prevEnd + count * 420
    const span = Math.max(80, nextBegin - prevEnd)
    const minStep = span >= count * 40 ? 40 : 0
    const weights = refs.slice(start, i).map((t) => Math.max(1, t.norm.length + 1))
    const totalW = weights.reduce((s, w) => s + w, 0)
    let acc = 0
    let cursor = prevEnd
    for (let k = start; k < i; k++) {
      acc += weights[k - start]
      const remaining = i - 1 - k
      const idealEnd = k === i - 1 ? nextBegin : Math.round(prevEnd + (span * acc) / totalW)
      const maxAllowedEnd = nextBegin - remaining * minStep
      const end =
        k === i - 1
          ? Math.max(cursor, nextBegin)
          : Math.min(maxAllowedEnd, Math.max(cursor + minStep, idealEnd))
      const clampedEnd = Math.max(cursor, end)
      refs[k].begin = cursor
      refs[k].end = clampedEnd
      cursor = clampedEnd
    }
  }

  const byLine = new Map<number, LyricsWord[]>()
  for (const r of refs) {
    const list = byLine.get(r.lineIdx) ?? []
    list.push({ text: r.text, begin: r.begin!, end: r.end! })
    byLine.set(r.lineIdx, list)
  }

  const out: LyricsLine[] = []
  let lastBegin = 0
  for (let li = 0; li < plainLines.length; li++) {
    const line = plainLines[li]
    const words = byLine.get(li)
    if (words?.length) {
      lastBegin = words[0].begin
      out.push({ text: line.text, begin: words[0].begin, end: words.at(-1)!.end, words })
    } else {
      // Section header or empty line stays near next sung timestamp cleanly
      out.push({ text: line.text, begin: lastBegin })
    }
  }

  for (let li = 0; li < out.length - 1; li++) {
    const nb = out[li + 1].begin
    if (nb !== undefined && out[li].begin !== undefined && nb > out[li].begin!) {
      out[li].end = nb
    }
  }

  return out
}

export function whisperWordsToLyrics(asrWords: WhisperWordChunk[]): Lyrics | null {
  const clean = asrWords
    .map((w) => ({ text: w.text.trim(), begin: Math.round(w.beginMs), end: Math.round(Math.max(w.beginMs + 50, w.endMs)) }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.begin))
  if (!clean.length) return null

  const lines: LyricsLine[] = []
  let cur: LyricsWord[] = []

  const flush = (nextBegin?: number) => {
    if (!cur.length) return
    const begin = cur[0].begin
    const rawEnd = cur.at(-1)!.end ?? begin + 500
    const end = nextBegin !== undefined && nextBegin > begin ? nextBegin : rawEnd
    lines.push({
      text: cur.map((w) => w.text).join(' '),
      begin,
      end,
      words: cur,
    })
    cur = []
  }

  for (const w of clean) {
    const prev = cur.at(-1)
    if (
      prev &&
      (cur.length >= 8 ||
        w.begin - (prev.end ?? prev.begin) > 650 ||
        /[.!?…]$/.test(prev.text))
    ) {
      flush(w.begin)
    }
    cur.push(w)
  }
  flush()

  return {
    synced: true,
    source: 'ai',
    lines,
    credits: 'Текст: Whisper AI (локально)',
  }
}
