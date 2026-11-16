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

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const m = a.length
  const n = b.length
  const prev = new Array<number>(n + 1)
  const cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]
  }
  return 1 - prev[n] / Math.max(m, n)
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
  const dp = new Float32Array((R + 1) * stride)
  const dir = new Uint8Array((R + 1) * stride) // 1: diag, 2: up (skip ref), 3: left (skip asr)

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
    for (let j = 1; j <= A; j++) {
      const sim = similarity(rn, cleanAsr[j - 1].norm)
      const matchScore = sim >= 0.45 ? sim * 2.2 : -0.8
      const dScore = dp[(i - 1) * stride + (j - 1)] + matchScore
      const uScore = dp[(i - 1) * stride + j] + GAP
      const lScore = dp[i * stride + (j - 1)] + GAP
      const idx = i * stride + j
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

  // Interpolate unmatched spans monotonically
  let i = 0
  while (i < refs.length) {
    if (refs[i].begin !== undefined) {
      i++
      continue
    }
    const start = i
    while (i < refs.length && refs[i].begin === undefined) i++
    const prevEnd = start > 0 ? refs[start - 1].end! : Math.max(0, cleanAsr[0].beginMs - (i - start) * 350)
    const nextBegin = i < refs.length ? Math.max(prevEnd + 80, refs[i].begin!) : prevEnd + (i - start) * 420
    const span = Math.max(80, nextBegin - prevEnd)
    const weights = refs.slice(start, i).map((t) => Math.max(1, t.norm.length + 1))
    const totalW = weights.reduce((s, w) => s + w, 0)
    let acc = 0
    let cursor = prevEnd
    for (let k = start; k < i; k++) {
      acc += weights[k - start]
      const end = k === i - 1 ? nextBegin : Math.max(cursor + 40, Math.round(prevEnd + (span * acc) / totalW))
      refs[k].begin = cursor
      refs[k].end = end
      cursor = end
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
