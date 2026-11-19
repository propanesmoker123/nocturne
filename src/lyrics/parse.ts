import type { LyricsLine, LyricsWord } from '../vk/models'

export interface SpotifyRawLine {
  startTimeMs?: string | number
  endTimeMs?: string | number
  words?: string
  syllables?: Array<{ startTimeMs?: string | number; numChars?: number }>
}

export interface SpotifyRawLyrics {
  syncType?: string
  lines?: SpotifyRawLine[]
}

const LEAD_TAG_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/
const OFFSET_TAG_RE = /^\[offset:\s*([+-]?\d+)\s*\]$/i
const WORD_TAG_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>([^<]*)/g

function parseMs(minStr: string, secStr: string, fracStr?: string): number {
  const min = Number(minStr)
  const sec = Number(secStr)
  const frac = fracStr ? Number(fracStr.slice(0, 3).padEnd(3, '0')) : 0
  return min * 60_000 + sec * 1000 + frac
}

function pushEnhancedTokens(
  words: LyricsWord[],
  textParts: string[],
  tokens: string[],
  begin: number,
  nextBegin: number | undefined,
): void {
  if (tokens.length === 1) {
    words.push(nextBegin !== undefined && nextBegin > begin ? { text: tokens[0], begin, end: nextBegin } : { text: tokens[0], begin })
    textParts.push(tokens[0])
    return
  }

  const span = nextBegin !== undefined && nextBegin > begin ? nextBegin - begin : 0
  for (let j = 0; j < tokens.length; j++) {
    const tBegin = span ? Math.round(begin + (span * j) / tokens.length) : begin
    const tEnd = span ? Math.round(begin + (span * (j + 1)) / tokens.length) : undefined
    words.push(tEnd !== undefined && tEnd > tBegin ? { text: tokens[j], begin: tBegin, end: tEnd } : { text: tokens[j], begin: tBegin })
    textParts.push(tokens[j])
  }
}

function parseEnhancedWords(body: string, lineBegin: number): { text: string; words: LyricsWord[] } | null {
  const matches = [...body.matchAll(WORD_TAG_RE)]
  if (!matches.length) return null

  const words: LyricsWord[] = []
  const textParts: string[] = []

  const firstIdx = matches[0].index ?? 0
  if (firstIdx > 0) {
    const leading = body.slice(0, firstIdx).trim()
    if (leading) {
      const tokens = leading.split(/\s+/).filter(Boolean)
      const firstMatchBegin = parseMs(matches[0][1], matches[0][2], matches[0][3])
      pushEnhancedTokens(words, textParts, tokens, lineBegin, firstMatchBegin)
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const begin = parseMs(m[1], m[2], m[3])
    const chunk = m[4].trim()
    if (!chunk) continue

    const tokens = chunk.split(/\s+/).filter(Boolean)
    const nextMatch = matches.slice(i + 1).find((n) => n[4].trim().length > 0)
    const nextBegin = nextMatch ? parseMs(nextMatch[1], nextMatch[2], nextMatch[3]) : undefined
    pushEnhancedTokens(words, textParts, tokens, begin, nextBegin)
  }

  if (!words.length) return null
  return { text: textParts.join(' '), words }
}

function fillLineEnds(lines: LyricsLine[]): void {
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    if (cur.begin === undefined) continue
    if (cur.end === undefined && i + 1 < lines.length) {
      const nextBegin = lines[i + 1].begin
      if (nextBegin !== undefined && nextBegin > cur.begin) {
        cur.end = nextBegin
      }
    }
    if (cur.words?.length) {
      for (let w = 0; w < cur.words.length; w++) {
        const word = cur.words[w]
        if (word.end !== undefined) continue
        const nextWordBegin = w + 1 < cur.words.length ? cur.words[w + 1].begin : cur.end
        if (nextWordBegin !== undefined && nextWordBegin > word.begin) {
          word.end = nextWordBegin
        }
      }
    }
  }
}

export function parseLrc(raw: string): LyricsLine[] {
  const entries: LyricsLine[] = []
  let offsetMs = 0

  for (const rawLine of raw.split(/\r?\n/)) {
    let rest = rawLine.trim()
    if (!rest) continue

    const om = OFFSET_TAG_RE.exec(rest)
    if (om) {
      offsetMs = Number(om[1]) || 0
      continue
    }

    const begins: number[] = []
    while (true) {
      const m = LEAD_TAG_RE.exec(rest)
      if (!m) break
      begins.push(parseMs(m[1], m[2], m[3]))
      rest = rest.slice(m[0].length)
    }

    if (!begins.length) continue
    const body = rest.trim()
    const enhanced = begins.length === 1 ? parseEnhancedWords(body, begins[0]) : null

    for (const begin of begins) {
      if (enhanced) {
        entries.push({ text: enhanced.text, begin, words: enhanced.words.map((w) => ({ ...w })) })
      } else {
        const plain = body.replace(WORD_TAG_RE, '$4').trim()
        entries.push({ text: plain || '♪', begin })
      }
    }
  }

  if (offsetMs !== 0) {
    for (const entry of entries) {
      if (entry.begin !== undefined) entry.begin = Math.max(0, entry.begin - offsetMs)
      if (entry.words) {
        for (const w of entry.words) {
          w.begin = Math.max(0, w.begin - offsetMs)
          if (w.end !== undefined) w.end = Math.max(w.begin, w.end - offsetMs)
        }
      }
    }
  }

  entries.sort((a, b) => (a.begin ?? 0) - (b.begin ?? 0))
  fillLineEnds(entries)
  return entries
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed
    } catch {
      return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1')
    }
  }
  return trimmed
}

interface RawYamlWord {
  rawText?: string
  startMs?: number
  endMs?: number
}

interface RawYamlLine {
  text?: string
  startMs?: number
  endMs?: number
  words: RawYamlWord[]
}

function parseYamlKeyVal(fragment: string): { key: string; val: string } | null {
  const idx = fragment.indexOf(':')
  if (idx <= 0) return null
  return {
    key: fragment.slice(0, idx).trim(),
    val: fragment.slice(idx + 1),
  }
}

function assignYamlField(target: { text?: string; rawText?: string; startMs?: number; endMs?: number }, key: string, val: string, isWord: boolean): void {
  if (key === 'text') {
    const str = unquoteYamlScalar(val)
    if (isWord) target.rawText = str
    else target.text = str
  } else if (key === 'start_ms' || key === 'end_ms') {
    const num = Number(val.trim())
    if (Number.isFinite(num) && num >= 0) {
      if (key === 'start_ms') target.startMs = Math.round(num)
      else target.endMs = Math.round(num)
    }
  }
}

function buildWordsFromLrclibYaml(rawWords: RawYamlWord[], lineEndMs?: number): LyricsWord[] | undefined {
  const valid = rawWords.filter((w) => w.rawText !== undefined && w.startMs !== undefined)
  if (!valid.length) return undefined

  const hasSpacing = valid.some((w) => /^\s|\s$/.test(w.rawText!))
  const out: LyricsWord[] = []
  let prevEndedWithSpace = true
  let prevEndedWithHyphen = false

  for (const w of valid) {
    const rawText = w.rawText!
    const clean = rawText.trim()
    const begin = w.startMs!
    const end = w.endMs !== undefined && w.endMs >= begin ? w.endMs : undefined

    if (!clean) {
      if (/\s/.test(rawText)) prevEndedWithSpace = true
      continue
    }

    const isStandalonePunct = /^[,.;:!?…—–]+$/.test(clean)
    const joinDirect =
      out.length > 0 &&
      (isStandalonePunct ||
        (hasSpacing ? !prevEndedWithSpace && !/^\s/.test(rawText) : prevEndedWithHyphen))

    if (joinDirect) {
      const prev = out[out.length - 1]
      prev.text += clean
      prev.end = end !== undefined ? (prev.end !== undefined ? Math.max(prev.end, end) : end) : undefined
    } else {
      out.push(end !== undefined ? { text: clean, begin, end } : { text: clean, begin })
    }

    prevEndedWithSpace = /\s$/.test(rawText)
    prevEndedWithHyphen = clean.endsWith('-') && clean.length > 1
  }

  if (!out.length) return undefined

  for (let i = 0; i < out.length; i++) {
    const w = out[i]
    if (w.end !== undefined) continue
    if (i < out.length - 1) {
      w.end = Math.max(w.begin, out[i + 1].begin)
    } else if (lineEndMs !== undefined && lineEndMs >= w.begin) {
      w.end = lineEndMs
    }
  }
  return out
}

/**
 * Parses LRCLIB's YAML `lyricsfile` payload (precise line `start_ms`/`end_ms` and per-word `words`).
 */
function areWordTimingsConsistent(words: LyricsWord[]): boolean {
  if (words.length < 4) return true
  let squished = 0
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1]!.begin - words[i]!.begin <= 25) squished++
  }
  return squished / (words.length - 1) <= 0.35
}

export function parseLrclibFile(raw: string): LyricsLine[] {
  if (!raw || !raw.trim()) return []
  const rawLines: RawYamlLine[] = []
  let inLines = false
  let lineItemIndent = -1
  let curLine: RawYamlLine | null = null
  let inWords = false
  let wordsIndent = -1
  let wordItemIndent = -1
  let curWord: RawYamlWord | null = null

  const flushWord = () => {
    if (curWord && curLine) curLine.words.push(curWord)
    curWord = null
  }

  const flushLine = () => {
    flushWord()
    if (curLine) rawLines.push(curLine)
    curLine = null
    inWords = false
    wordItemIndent = -1
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length

    if (!inLines) {
      if (/^lines\s*:/.test(trimmed)) inLines = true
      continue
    }

    if (indent === 0 && !trimmed.startsWith('-')) break

    if (lineItemIndent === -1 && trimmed.startsWith('-')) {
      lineItemIndent = indent
    }

    if (indent === lineItemIndent && trimmed.startsWith('-')) {
      flushLine()
      curLine = { words: [] }
      const rest = trimmed.slice(1).trim()
      const kv = rest ? parseYamlKeyVal(rest) : null
      if (kv) {
        if (kv.key === 'words') {
          inWords = true
          wordsIndent = indent
        } else {
          assignYamlField(curLine, kv.key, kv.val, false)
        }
      }
      continue
    }

    if (inWords) {
      const isSiblingLineProp = indent <= wordsIndent && !trimmed.startsWith('-')
      const isNextLineItem = indent <= lineItemIndent && trimmed.startsWith('-')
      if (isSiblingLineProp || isNextLineItem) {
        flushWord()
        inWords = false
      } else if (trimmed.startsWith('-')) {
        if (wordItemIndent === -1) wordItemIndent = indent
        if (indent === wordItemIndent) {
          flushWord()
          curWord = {}
          const rest = trimmed.slice(1).trim()
          const kv = rest ? parseYamlKeyVal(rest) : null
          if (kv) assignYamlField(curWord, kv.key, kv.val, true)
          continue
        }
      } else if (curWord) {
        const kv = parseYamlKeyVal(trimmed)
        if (kv) assignYamlField(curWord, kv.key, kv.val, true)
        continue
      }
    }

    if (curLine) {
      const kv = parseYamlKeyVal(trimmed)
      if (!kv) continue
      if (kv.key === 'words') {
        inWords = true
        wordsIndent = indent
        wordItemIndent = -1
      } else {
        assignYamlField(curLine, kv.key, kv.val, false)
      }
    }
  }
  flushLine()

  const entries: LyricsLine[] = []
  for (const item of rawLines) {
    if (item.startMs === undefined) continue
    const end = item.endMs !== undefined && item.endMs > item.startMs ? item.endMs : undefined
    const rawWords = buildWordsFromLrclibYaml(item.words, end)
    const words = rawWords && areWordTimingsConsistent(rawWords) ? rawWords : undefined
    const fallbackText = rawWords ? rawWords.map((w) => w.text).join(' ') : ''
    const text = (item.text ?? fallbackText).trim() || '♪'
    entries.push({
      text,
      begin: item.startMs,
      ...(end !== undefined ? { end } : {}),
      ...(words ? { words } : {}),
    })
  }

  entries.sort((a, b) => (a.begin ?? 0) - (b.begin ?? 0))
  fillLineEnds(entries)
  for (const line of entries) {
    if (line.words?.length && line.end !== undefined) {
      const last = line.words[line.words.length - 1]
      if (last.end === undefined) last.end = Math.max(last.begin, line.end)
    }
  }
  return entries
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return fallback
  }
  return String.fromCodePoint(code)
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16)
      return safeFromCodePoint(code, full)
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10)
      return safeFromCodePoint(code, full)
    }
    return NAMED_ENTITIES[lower] ?? full
  })
}

function findMatchingDivEnd(html: string, openEnd: number): number {
  let depth = 1
  const tagRe = /<\/?div\b[^>]*>/gi
  tagRe.lastIndex = openEnd
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--
      if (depth === 0) return m.index
    } else if (!m[0].endsWith('/>')) {
      depth++
    }
  }
  return -1
}

function stripExcludedBlocks(fragment: string): string {
  let out = fragment
  const excludeRe = /<div\b[^>]*\bdata-exclude-from-selection=(?:"true"|'true'|true)[^>]*>/i
  while (true) {
    const m = excludeRe.exec(out)
    if (!m) break
    const innerStart = m.index + m[0].length
    const closeIdx = findMatchingDivEnd(out, innerStart)
    if (closeIdx < 0) {
      out = out.slice(0, m.index)
      break
    }
    const closeEnd = out.indexOf('>', closeIdx) + 1
    out = out.slice(0, m.index) + out.slice(closeEnd)
  }
  return out
}

export function geniusLyricsFromHtml(html: string): string | null {
  const containerRe = /<div\b[^>]*\bdata-lyrics-container=(?:"true"|'true'|true)[^>]*>/gi
  const sections: string[] = []
  let m: RegExpExecArray | null

  while ((m = containerRe.exec(html)) !== null) {
    const innerStart = m.index + m[0].length
    const closeIdx = findMatchingDivEnd(html, innerStart)
    const rawInner = closeIdx >= 0 ? html.slice(innerStart, closeIdx) : html.slice(innerStart)
    if (closeIdx >= 0) containerRe.lastIndex = closeIdx + 6

    const cleaned = stripExcludedBlocks(rawInner)
      .replace(/\r?\n/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li)>\s*(?!<br\b|<\/div>)/gi, '\n')
      .replace(/<[^>]+>/g, '')

    const decoded = decodeHtmlEntities(cleaned)
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    if (decoded) sections.push(decoded)
  }

  return sections.length ? sections.join('\n') : null
}

function buildWordsFromSyllables(rawWords: string, lineBegin: number, syllables: NonNullable<SpotifyRawLine['syllables']>): LyricsWord[] | undefined {
  const sylSpans: Array<{ start: number; end: number; begin: number }> = []
  let cursor = 0
  for (const syl of syllables) {
    const numChars = Number(syl?.numChars)
    const startMs = Number(syl?.startTimeMs)
    if (!Number.isFinite(numChars) || numChars <= 0 || !Number.isFinite(startMs) || startMs < 0) continue
    sylSpans.push({ start: cursor, end: cursor + numChars, begin: Math.max(lineBegin, startMs) })
    cursor += numChars
  }
  if (!sylSpans.length) return undefined

  const words: LyricsWord[] = []
  for (const match of rawWords.matchAll(/\S+/g)) {
    const text = match[0]
    const charIdx = match.index ?? 0
    const span = sylSpans.find((s) => charIdx >= s.start && charIdx < s.end) ?? sylSpans.findLast((s) => s.start <= charIdx) ?? sylSpans[0]
    words.push({ text, begin: span.begin })
  }
  return words.length ? words : undefined
}

export function spotifyLines(raw: SpotifyRawLyrics): { synced: boolean; lines: LyricsLine[] } {
  const synced = raw.syncType === 'LINE_SYNCED' || raw.syncType === 'SYLLABLE_SYNCED'
  const rawList = Array.isArray(raw.lines) ? raw.lines : []
  const lines: LyricsLine[] = []

  for (const item of rawList) {
    const rawWords = typeof item?.words === 'string' ? item.words : ''
    const trimmed = rawWords.trim()

    if (!synced) {
      if (trimmed) lines.push({ text: trimmed })
      continue
    }

    const begin = Number(item?.startTimeMs)
    if (!Number.isFinite(begin) || begin < 0) continue
    const endRaw = item?.endTimeMs !== undefined ? Number(item.endTimeMs) : NaN
    const words =
      raw.syncType === 'SYLLABLE_SYNCED' && trimmed && Array.isArray(item?.syllables) && item.syllables.length > 0
        ? buildWordsFromSyllables(rawWords, begin, item.syllables)
        : undefined

    const entry: LyricsLine = { text: trimmed || '♪', begin }
    if (Number.isFinite(endRaw) && endRaw > begin) entry.end = endRaw
    if (words) entry.words = words
    lines.push(entry)
  }

  if (synced) fillLineEnds(lines)
  return { synced, lines }
}

const NETEASE_META_RE = /^(?:制作人|作词|作曲|编曲|混音|母带|录音|监制|出品|统筹|和声|吉他|贝斯|鼓|弦乐)\s*[:：]/i
const YRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/
const YRC_WORD_RE = /\((\d+),(\d+),\d+\)([^()]*)/g

export function isMetadataCreditLine(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.startsWith('{') && t.endsWith('}')) return true
  return NETEASE_META_RE.test(t)
}

const YRC_ATTACH_PREV_RE = /^(?:[,.;:!?)}\]…]+|['’](?:s|t|m|re|ve|ll|d))$/i

/**
 * Parses NetEase Cloud Music word-synced YRC format:
 * `[lineBeginMs,lineDurMs](wordBeginMs,wordDurMs,0)word...`
 */
export function parseNeteaseYrc(raw: string): LyricsLine[] {
  const entries: LyricsLine[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('{')) continue
    const lineMatch = YRC_LINE_RE.exec(trimmed)
    if (!lineMatch) continue
    const begin = Number(lineMatch[1])
    const dur = Number(lineMatch[2])
    if (!Number.isFinite(begin) || begin < 0) continue

    const body = lineMatch[3] ?? ''
    const words: LyricsWord[] = []
    const textParts: string[] = []
    for (const m of body.matchAll(YRC_WORD_RE)) {
      const wBegin = Number(m[1])
      const wDur = Number(m[2])
      const wordText = (m[3] ?? '').trim()
      if (!wordText || !Number.isFinite(wBegin)) continue
      const tokens = wordText.split(/\s+/).filter(Boolean)
      const totalSpan = Number.isFinite(wDur) && wDur > 0 ? wDur : 0
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]
        const subBegin = totalSpan > 0 ? Math.round(wBegin + (totalSpan * i) / tokens.length) : wBegin
        const subEnd = totalSpan > 0 ? Math.round(wBegin + (totalSpan * (i + 1)) / tokens.length) : undefined
        if (words.length > 0 && YRC_ATTACH_PREV_RE.test(tok)) {
          const prev = words[words.length - 1]
          prev.text += tok
          if (subEnd !== undefined && (prev.end === undefined || subEnd > prev.end)) {
            prev.end = subEnd
          }
          textParts[textParts.length - 1] += tok
          continue
        }
        const entry: LyricsWord = subEnd !== undefined && subEnd > subBegin ? { text: tok, begin: subBegin, end: subEnd } : { text: tok, begin: subBegin }
        words.push(entry)
        textParts.push(tok)
      }
    }

    const text = textParts.join(' ').trim()
    if (isMetadataCreditLine(text) && text) continue
    const lineEnd = Number.isFinite(dur) && dur > 0 ? begin + dur : undefined
    const entry: LyricsLine = {
      text: text || '♪',
      begin,
    }
    if (lineEnd !== undefined && lineEnd > begin) entry.end = lineEnd
    if (words.length) entry.words = words
    entries.push(entry)
  }

  entries.sort((a, b) => (a.begin ?? 0) - (b.begin ?? 0))
  fillLineEnds(entries)
  return entries
}
