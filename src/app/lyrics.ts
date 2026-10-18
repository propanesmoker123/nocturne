import { normalizeSearch } from '../lib/format'
import * as vk from '../vk/api'
import { serviceOf, type Lyrics, type Track } from '../vk/models'

/** «Song (feat. X) [Prod. Y]» → «song»: what is left to compare once the extras are gone. */
const bareTitle = (s: string) =>
  normalizeSearch(
    s
      .replace(/[([][^)\]]*[)\]]/g, ' ')
      .replace(/\s(feat|ft|prod)\.?\s.*$/i, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' '),
  )

/** SoundCloud uploads are often titled «Artist - Title» under someone else's name. */
function splitUpload(t: Track): { artist: string; title: string } {
  const at = t.title.indexOf(' - ')
  if (at > 0) return { artist: t.title.slice(0, at), title: t.title.slice(at + 3) }
  return { artist: t.artist, title: t.title }
}

const sameArtist = (a: string, b: string) => {
  const x = bareTitle(a)
  const y = bareTitle(b)
  return !!x && !!y && (x.includes(y) || y.includes(x))
}

/** The VK track `candidate` is the same song as the SoundCloud track `t` (title, artist, length). */
export function lyricsMatch(t: Track, candidate: Track): boolean {
  if (Math.abs(t.duration - candidate.duration) > 3) return false
  const { artist, title } = splitUpload(t)
  const wanted = bareTitle(title)
  if (!wanted || bareTitle(candidate.title) !== wanted) return false
  return sameArtist(artist, candidate.artist) || sameArtist(t.artist, candidate.artist)
}

/** Lyrics of a track: its own in VK, or — SoundCloud has none — those of the same song in VK. */
export async function findLyrics(t: Track): Promise<Lyrics | null> {
  if (serviceOf(t) !== 'sc') return t.hasLyrics ? vk.getLyrics(t) : null
  const { artist, title } = splitUpload(t)
  // the title without its «(feat. …)» tail finds the song best
  const page = await vk.searchTracks(`${artist} ${title.replace(/\s*[([].*$/, '')}`.trim(), 0, 20)
  const match = page.items.find((c) => c.hasLyrics && lyricsMatch(t, c))
  return match ? vk.getLyrics(match) : null
}
