import type { Track } from '../vk/models'

const VERSION_SIDE_RE =
  /^(remix|edit|live|acoustic|instrumental|slowed|reverb|sped|nightcore|radio|explicit|clean|demo|mix|vip|version|cover|remaster(?:ed)?)\b/i

export function bareTitle(title: string): string {
  return title
    .replace(/\s*[\[(]\s*(?:feat|ft|featuring|prod|official(?:\s+(?:audio|video|lyrics?|visualizer|music\s+video))?|lyric\s+video|explicit|clean)[^\])]*[\])]/gi, ' ')
    .replace(/\s+(?:feat|ft|featuring)\.?\s+[^(\[\-–—]+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function splitUpload(artist: string, title: string): { artist: string; title: string } {
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (m) {
    const left = m[1].trim()
    const right = m[2].trim()
    if (left && right && !VERSION_SIDE_RE.test(right)) {
      return { artist: left, title: right }
    }
  }
  return { artist: artist.trim(), title: title.trim() }
}

function normStr(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ARTIST_SEP_RE = /[,;&+\/×]|\bx\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\s+и\s+/gi
const SEARCH_NOISE_TAGS_RE =
  /\s*[\[(]\s*(?:slowed(?:\s*[+&]\s*reverb)?|reverb|sped\s*up|nightcore|bass\s*boost(?:ed)?|tiktok(?:\s+version)?|8d(?:\s+audio)?|(?:vk\.com|t\.me)\/\S+|prod\.?\s+by[^)\]]*|remix|edit|explicit|clean|demo|remaster(?:ed)?(?:\s+\d{4})?)[^\])]*[\])]/gi

function stripLeadingQueryPunct(s: string): string {
  return s.replace(/^[!#*~•?._\-–—\s]+/, '').replace(/\s+/g, ' ').trim()
}

function artistTokens(artist: string): string[] {
  return artist.split(ARTIST_SEP_RE).map(normStr).filter(Boolean)
}

function rawArtistParts(artist: string): string[] {
  return artist
    .split(ARTIST_SEP_RE)
    .map((p) => p.trim())
    .filter(Boolean)
}

export function sameArtist(a: string, b: string): boolean {
  const na = normStr(a)
  const nb = normStr(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = artistTokens(a)
  const tb = new Set(artistTokens(b))
  return ta.some((tok) => tb.has(tok))
}

export function lyricsMatch(t: Pick<Track, 'artist' | 'title' | 'duration'>, candidate: Pick<Track, 'artist' | 'title' | 'duration'>): boolean {
  if (t.duration > 0 && candidate.duration > 0) {
    const maxDiff = Math.max(8, Math.round(Math.min(t.duration, candidate.duration) * 0.05))
    if (Math.abs(t.duration - candidate.duration) > maxDiff) return false
  }
  const a = splitUpload(t.artist, t.title)
  const b = splitUpload(candidate.artist, candidate.title)
  const titleA = normStr(bareTitle(a.title))
  if (!titleA) return false
  const titleB = normStr(bareTitle(b.title))
  if (sameArtist(a.artist, b.artist) && titleB && titleA === titleB) return true
  // External catalogs / LRCLIB uploads occasionally swap artist and track title
  const titleBAsArtist = normStr(bareTitle(b.artist))
  return Boolean(titleBAsArtist && sameArtist(a.artist, b.title) && titleA === titleBAsArtist)
}

export function searchQueryFor(t: Pick<Track, 'artist' | 'title'>): { artist: string; title: string; query: string } {
  const { artist, title } = splitUpload(t.artist, t.title)
  const cleanTitle = stripLeadingQueryPunct(bareTitle(title)) || stripLeadingQueryPunct(title) || title.trim()
  const cleanArtist = stripLeadingQueryPunct(artist) || artist.trim()
  return {
    artist: cleanArtist,
    title: cleanTitle,
    query: `${cleanArtist} ${cleanTitle}`.trim(),
  }
}

export function searchQueriesFor(t: Pick<Track, 'artist' | 'title'>): string[] {
  const { artist, title, query } = searchQueryFor(t)
  const out: string[] = []
  const push = (q: string) => {
    const clean = q.replace(/\s+/g, ' ').trim()
    if (clean && !out.includes(clean)) out.push(clean)
  }
  push(query)
  const noModTitle = stripLeadingQueryPunct(title.replace(SEARCH_NOISE_TAGS_RE, ' '))
  const firstArtist = rawArtistParts(artist)[0] ?? artist
  if (noModTitle && firstArtist) push(`${firstArtist} ${noModTitle}`)
  if (noModTitle && noModTitle !== title) push(`${artist} ${noModTitle}`)
  return out
}
