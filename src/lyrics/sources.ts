import { invoke, isTauri } from '../lib/tauri'
import type { Lyrics, LyricsSource, Track } from '../vk/models'
import { lyricsMatch, searchQueriesFor, searchQueryFor } from './match'
import { decodeHtmlEntities, geniusLyricsFromHtml, isMetadataCreditLine, parseLrc, parseLrclibFile, parseNeteaseYrc } from './parse'

export type LyricsFetcher = (url: string) => Promise<string>

interface LrclibRecord {
  artistName?: string
  trackName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
  hasWordSync?: boolean
  lyricsfile?: string | null
}

interface GeniusSearchResponse {
  response?: {
    sections?: Array<{
      type?: string
      hits?: Array<{
        type?: string
        result?: {
          title?: string
          url?: string
          primary_artist?: { name?: string }
        }
      }>
    }>
  }
}

interface NeteaseSearchResponse {
  result?: {
    songs?: Array<{
      id?: number
      name?: string
      dt?: number
      ar?: Array<{ name?: string }>
      artists?: Array<{ name?: string }>
    }>
  }
}

interface NeteaseLyricResponse {
  lrc?: { lyric?: string }
  yrc?: { lyric?: string }
  nolyric?: boolean
  uncollected?: boolean
}

interface QqSearchResponse {
  data?: {
    song?: {
      list?: Array<{
        songmid?: string
        songname?: string
        interval?: number
        singer?: Array<{ name?: string }>
      }>
    }
  }
}

interface QqLyricResponse {
  retcode?: number
  lyric?: string
}

interface LyricsOvhResponse {
  lyrics?: string
}

function defaultFetcher(): LyricsFetcher | null {
  return isTauri() ? (url) => invoke<string>('lyrics_fetch', { url }) : null
}

function toPlainLyrics(raw: string, source: LyricsSource, credits: string): Lyrics | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isMetadataCreditLine(l))
    .map((text) => ({ text }))
  if (!lines.length) return null
  return { synced: false, source, lines, credits }
}

function toLrcOrPlain(raw: string, source: LyricsSource, credits: string): Lyrics | null {
  const cleaned = decodeHtmlEntities(raw).trim()
  if (!cleaned) return null
  const syncedLines = parseLrc(cleaned).filter((l) => !isMetadataCreditLine(l.text))
  if (syncedLines.length) {
    return { synced: true, source, lines: syncedLines, credits }
  }
  return toPlainLyrics(cleaned, source, credits)
}

function hasWordTimings(l: Lyrics | null | undefined): boolean {
  return Boolean(l?.lines.some((line) => line.words && line.words.length > 0))
}

function recordToLyrics(rec: LrclibRecord): Lyrics | null {
  if (typeof rec.lyricsfile === 'string' && rec.lyricsfile.trim()) {
    const lines = parseLrclibFile(rec.lyricsfile)
    if (lines.length) {
      return { synced: true, source: 'lrclib', lines, credits: 'Текст: LRCLIB' }
    }
  }
  if (typeof rec.syncedLyrics === 'string' && rec.syncedLyrics.trim()) {
    const lines = parseLrc(rec.syncedLyrics)
    if (lines.length) {
      return { synced: true, source: 'lrclib', lines, credits: 'Текст: LRCLIB' }
    }
  }
  if (typeof rec.plainLyrics === 'string' && rec.plainLyrics.trim()) {
    const plain = toPlainLyrics(rec.plainLyrics, 'lrclib', 'Текст: LRCLIB')
    if (plain) return plain
  }
  if (rec.instrumental) {
    return {
      synced: false,
      instrumental: true,
      source: 'lrclib',
      lines: [],
      credits: 'Текст: LRCLIB (инструментал)',
    }
  }
  return null
}

function safeJsonParse<T>(raw: string): T | null {
  if (!raw || !raw.trim()) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function lrclibLyrics(
  track: Pick<Track, 'artist' | 'title' | 'duration'>,
  fetcher: LyricsFetcher | null = defaultFetcher(),
): Promise<Lyrics | null> {
  if (!fetcher) return null
  const { artist, title } = searchQueryFor(track)
  if (!artist || !title) return null

  const getParams = [`artist_name=${encodeURIComponent(artist)}`, `track_name=${encodeURIComponent(title)}`]
  if (track.duration > 0) getParams.push(`duration=${Math.round(track.duration)}`)

  let exactFallback: Lyrics | null = null
  let shouldSearchUpgrade = true
  try {
    const rawGet = await fetcher(`https://lrclib.net/api/get?${getParams.join('&')}`)
    const rec = safeJsonParse<LrclibRecord>(rawGet)
    const maxDiff = rec?.duration && track.duration > 0
      ? Math.max(8, Math.round(Math.min(Math.round(rec.duration), track.duration) * 0.05))
      : 8
    if (rec && (!rec.duration || track.duration <= 0 || Math.abs(Math.round(rec.duration) - track.duration) <= maxDiff)) {
      const parsed = recordToLyrics(rec)
      if (parsed?.instrumental || hasWordTimings(parsed)) return parsed
      if (parsed?.synced && rec.hasWordSync !== false) return parsed
      exactFallback = parsed
      if (parsed?.synced && rec.hasWordSync === false) shouldSearchUpgrade = true
    }
  } catch {
    /* fall through to search */
  }

  if (!shouldSearchUpgrade) return exactFallback

  const refTrack = { artist, title, duration: track.duration }
  const searchUrls = [
    ...searchQueriesFor(track).slice(0, 2).map((q) => `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`),
    `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
  ]

  let bestCandidate: Lyrics | null = null
  for (const searchUrl of searchUrls) {
    try {
      const rawSearch = await fetcher(searchUrl)
      const items = safeJsonParse<LrclibRecord[]>(rawSearch)
      if (!Array.isArray(items) || !items.length) continue

      const candidates: Array<{ lyrics: Lyrics; diff: number; wordCount: number }> = []
      for (const item of items) {
        const candDuration = typeof item.duration === 'number' && item.duration > 0 ? Math.round(item.duration) : track.duration
        if (
          !lyricsMatch(refTrack, {
            artist: item.artistName ?? '',
            title: item.trackName ?? '',
            duration: candDuration,
          })
        ) {
          continue
        }
        const parsed = recordToLyrics(item)
        if (!parsed) continue
        const diff = track.duration > 0 && item.duration ? Math.abs(item.duration - track.duration) : 0
        candidates.push({ lyrics: parsed, diff, wordCount: hasWordTimings(parsed) ? 1 : 0 })
      }

      candidates.sort((a, b) => {
        if (a.wordCount !== b.wordCount) return b.wordCount - a.wordCount
        if (a.lyrics.synced !== b.lyrics.synced) return a.lyrics.synced ? -1 : 1
        if (Boolean(a.lyrics.lines.length) !== Boolean(b.lyrics.lines.length)) return a.lyrics.lines.length ? -1 : 1
        return a.diff - b.diff
      })

      const top = candidates[0]?.lyrics ?? null
      if (!top) continue
      if (hasWordTimings(top)) return top
      if (!bestCandidate || (top.synced && !bestCandidate.synced)) bestCandidate = top
      if (top.synced && (!exactFallback || !exactFallback.synced)) return top
    } catch {
      /* ignore search failure */
    }
  }

  return bestCandidate && (bestCandidate.synced || !exactFallback) ? bestCandidate : exactFallback
}

export async function neteaseLyrics(
  track: Pick<Track, 'artist' | 'title' | 'duration'>,
  fetcher: LyricsFetcher | null = defaultFetcher(),
): Promise<Lyrics | null> {
  if (!fetcher) return null
  const { artist, title } = searchQueryFor(track)
  if (!artist || !title) return null
  const refTrack = { artist, title, duration: track.duration }
  let fallback: Lyrics | null = null

  for (const q of searchQueriesFor(track).slice(0, 2)) {
    try {
      const searchUrl = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(q)}&offset=0&limit=6&type=1`
      const searchData = safeJsonParse<NeteaseSearchResponse>(await fetcher(searchUrl))
      const songs = searchData?.result?.songs ?? []
      const matches = songs
        .filter((s) => {
          if (!s?.id || !s?.name) return false
          const ar = (s.ar ?? s.artists ?? []).map((a) => a.name ?? '').filter(Boolean).join(', ')
          const durSec = typeof s.dt === 'number' && s.dt > 0 ? Math.round(s.dt / 1000) : 0
          return lyricsMatch(refTrack, { artist: ar, title: s.name, duration: durSec })
        })
        .slice(0, 3)

      for (const match of matches) {
        if (!match?.id) continue
        const lyricUrl = `https://music.163.com/api/song/lyric?id=${match.id}&lv=1&kv=1&tv=-1&yv=1`
        const lyricData = safeJsonParse<NeteaseLyricResponse>(await fetcher(lyricUrl))
        if (!lyricData || lyricData.nolyric) continue

        const yrcRaw = lyricData.yrc?.lyric?.trim()
        if (yrcRaw) {
          const yrcLines = parseNeteaseYrc(yrcRaw)
          if (yrcLines.length) {
            return { synced: true, source: 'netease', lines: yrcLines, credits: 'Текст: NetEase' }
          }
        }

        const lrcRaw = lyricData.lrc?.lyric?.trim()
        if (!lrcRaw) continue
        if (lrcRaw.includes('纯音乐，请欣赏')) {
          fallback ??= { synced: false, instrumental: true, source: 'netease', lines: [], credits: 'Текст: NetEase (инструментал)' }
          continue
        }
        const parsed = toLrcOrPlain(lrcRaw, 'netease', 'Текст: NetEase')
        if (parsed?.synced && parsed.lines.length) return parsed
        if (parsed && !fallback) fallback = parsed
      }
    } catch {
      /* ignore provider failure */
    }
  }
  return fallback
}

export async function qqLyrics(
  track: Pick<Track, 'artist' | 'title' | 'duration'>,
  fetcher: LyricsFetcher | null = defaultFetcher(),
): Promise<Lyrics | null> {
  if (!fetcher) return null
  const { artist, title } = searchQueryFor(track)
  if (!artist || !title) return null
  const refTrack = { artist, title, duration: track.duration }
  let fallback: Lyrics | null = null

  for (const q of searchQueriesFor(track).slice(0, 2)) {
    try {
      const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(q)}&format=json&n=6`
      const searchData = safeJsonParse<QqSearchResponse>(await fetcher(searchUrl))
      const items = searchData?.data?.song?.list ?? []
      const matches = items
        .filter((s) => {
          if (!s?.songmid || !s?.songname) return false
          const singer = (s.singer ?? []).map((x) => x.name ?? '').filter(Boolean).join(', ')
          const durSec = typeof s.interval === 'number' && s.interval > 0 ? Math.round(s.interval) : 0
          return lyricsMatch(refTrack, { artist: singer, title: s.songname, duration: durSec })
        })
        .slice(0, 3)

      for (const match of matches) {
        if (!match?.songmid) continue
        const lyricUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(match.songmid)}&format=json&nobase64=1`
        const lyricData = safeJsonParse<QqLyricResponse>(await fetcher(lyricUrl))
        const raw = lyricData?.lyric?.trim()
        if (!raw || raw.includes('此歌曲为没有填词的纯音乐')) continue
        const parsed = toLrcOrPlain(raw, 'qq', 'Текст: QQ Music')
        if (parsed?.synced && parsed.lines.length) return parsed
        if (parsed && !fallback) fallback = parsed
      }
    } catch {
      /* ignore provider failure */
    }
  }
  return fallback
}

interface KugouSearchResponse {
  data?: {
    info?: Array<{
      hash?: string
      songname?: string
      singername?: string
      duration?: number
    }>
  }
}

interface KugouCandidateSearchResponse {
  candidates?: Array<{
    id?: string | number
    accesskey?: string
    duration?: number
  }>
}

interface KugouDownloadResponse {
  content?: string
  fmt?: string
}

function decodeBase64Utf8(b64: string): string {
  try {
    const normalized = b64.replace(/\s+/g, '')
    const bin = atob(normalized)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

export async function kugouLyrics(
  track: Pick<Track, 'artist' | 'title' | 'duration'>,
  fetcher: LyricsFetcher | null = defaultFetcher(),
): Promise<Lyrics | null> {
  if (!fetcher) return null
  const { artist, title } = searchQueryFor(track)
  if (!artist || !title) return null
  const refTrack = { artist, title, duration: track.duration }
  let fallback: Lyrics | null = null

  for (const q of searchQueriesFor(track).slice(0, 2)) {
    try {
      const searchUrl = `https://mobileservice.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(q)}&page=1&pagesize=6&showtype=1`
      const searchData = safeJsonParse<KugouSearchResponse>(await fetcher(searchUrl))
      const items = searchData?.data?.info ?? []
      const matches = items
        .filter((s) => {
          if (!s?.hash || !s?.songname) return false
          const durSec = typeof s.duration === 'number' && s.duration > 0 ? Math.round(s.duration) : 0
          return lyricsMatch(refTrack, { artist: s.singername ?? '', title: s.songname, duration: durSec })
        })
        .slice(0, 3)

      for (const match of matches) {
        if (!match.hash) continue
        const durMs = Math.round((match.duration && match.duration > 0 ? match.duration : track.duration || 0) * 1000)
        const candUrl = `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=${durMs}&hash=${encodeURIComponent(match.hash)}`
        const candData = safeJsonParse<KugouCandidateSearchResponse>(await fetcher(candUrl))
        const cand = candData?.candidates?.find((c) => c?.id !== undefined && Boolean(c?.accesskey))
        if (!cand?.accesskey) continue

        const dlUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(String(cand.id))}&accesskey=${encodeURIComponent(cand.accesskey)}&fmt=lrc&charset=utf8`
        const dlData = safeJsonParse<KugouDownloadResponse>(await fetcher(dlUrl))
        const encoded = dlData?.content?.trim()
        if (!encoded) continue
        const decoded = decodeBase64Utf8(encoded)
        if (!decoded) continue
        const parsed = toLrcOrPlain(decoded, 'kugou', 'Текст: Kugou')
        if (parsed?.synced && parsed.lines.length) return parsed
        if (parsed && !fallback) fallback = parsed
      }
    } catch {
      /* ignore provider failure */
    }
  }
  return fallback
}

export async function lyricsOvhLyrics(
  track: Pick<Track, 'artist' | 'title'>,
  fetcher: LyricsFetcher | null = defaultFetcher(),
): Promise<Lyrics | null> {
  if (!fetcher) return null
  const { artist, title } = searchQueryFor(track)
  if (!artist || !title) return null
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
    const data = safeJsonParse<LyricsOvhResponse>(await fetcher(url))
    if (!data?.lyrics?.trim()) return null
    return toPlainLyrics(data.lyrics, 'ovh', 'Текст: Lyrics.ovh')
  } catch {
    return null
  }
}

export async function geniusLyrics(
  track: Pick<Track, 'artist' | 'title'>,
  fetcher: LyricsFetcher | null = defaultFetcher(),
): Promise<Lyrics | null> {
  if (!fetcher) return null
  const { artist, title, query } = searchQueryFor(track)
  if (!artist || !title) return null

  try {
    const searchUrl = `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(query)}`
    const data = safeJsonParse<GeniusSearchResponse>(await fetcher(searchUrl))
    const hits = data?.response?.sections?.flatMap((s) => (Array.isArray(s?.hits) ? s.hits : [])) ?? []

    const refTrack = { artist, title, duration: 0 }
    const songHit = hits.find((hit) => {
      if (hit?.type !== 'song' || !hit.result?.url) return false
      if (!/^https:\/\/genius\.com\/[^/?#]+-lyrics$/i.test(hit.result.url)) return false
      return lyricsMatch(refTrack, {
        artist: hit.result.primary_artist?.name ?? '',
        title: hit.result.title ?? '',
        duration: 0,
      })
    })
    if (!songHit?.result?.url) return null

    const html = await fetcher(songHit.result.url)
    const extracted = html ? geniusLyricsFromHtml(html) : null
    if (!extracted) return null

    return toPlainLyrics(extracted, 'genius', 'Текст: Genius')
  } catch {
    return null
  }
}
