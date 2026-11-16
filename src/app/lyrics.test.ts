import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({
  searched: [] as string[],
  spSearched: [] as string[],
  found: [] as Track[],
  spFound: [] as Track[],
  lyricsOf: [] as string[],
  spLyrics: null as { synced: boolean; source?: 'spotify'; lines: { text: string; begin?: number; words?: { text: string; begin: number; end?: number }[] }[]; credits?: string } | null,
  vkLyrics: { synced: false, lines: [{ text: 'la' }] } as { synced: boolean; lines: { text: string; begin?: number }[]; credits?: string } | null,
  tauri: false,
  fetchedUrls: [] as string[],
  fetchReply: (_url: string): string => '',
}))

vi.mock('../lib/tauri', () => ({
  isTauri: () => h.tauri,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'lyrics_fetch') {
      const url = String(args?.url ?? '')
      h.fetchedUrls.push(url)
      return h.fetchReply(url)
    }
    throw new Error(`unexpected invoke: ${cmd}`)
  },
}))

vi.mock('../vk/api', () => ({
  searchTracks: async (q: string) => {
    h.searched.push(q)
    return { count: h.found.length, items: h.found }
  },
  getLyrics: async (t: Track) => {
    h.lyricsOf.push(t.key)
    return h.vkLyrics
  },
}))

vi.mock('../spotify/api', () => ({
  search: async (q: string) => {
    h.spSearched.push(q)
    return { tracks: h.spFound, artists: [], playlists: [], albums: [] }
  },
  getSpotifyLyrics: async () => h.spLyrics,
}))

const { findLyrics, lyricsMatch } = await import('./lyrics')

const track = (over: Partial<Track>): Track => ({ id: 1, ownerId: 1, key: '1_1', artist: 'A', title: 'T', duration: 148, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false, ...over })
const sc = (over: Partial<Track> = {}) => track({ service: 'sc', key: 'sc_9', artist: 'XXXTENTACION', title: 'Fuck Love (feat. Trippie Redd)', duration: 148, ...over })

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null
    },
    key(i: number) {
      return [...map.keys()][i] ?? null
    },
    removeItem(k: string) {
      map.delete(k)
    },
    setItem(k: string, v: string) {
      map.set(k, String(v))
    },
  }
}

beforeEach(() => {
  h.searched.length = 0
  h.spSearched.length = 0
  h.found = []
  h.spFound = []
  h.lyricsOf.length = 0
  h.spLyrics = null
  h.vkLyrics = { synced: false, lines: [{ text: 'la' }] }
  h.tauri = false
  h.fetchedUrls.length = 0
  h.fetchReply = () => ''
  ;(globalThis as Record<string, unknown>).localStorage = undefined
})

describe('lyrics for a SoundCloud track come from the same song in VK', () => {
  test('the same song matches through «feat.», case and a second or two of length', () => {
    expect(lyricsMatch(sc(), track({ artist: 'XXXTENTACION, Trippie Redd', title: 'Fuck Love', duration: 147 }))).toBe(true)
  })

  test('«Artist - Title» uploads match by the title part', () => {
    expect(lyricsMatch(sc({ artist: 'some label', title: 'XXXTENTACION - Fuck Love' }), track({ artist: 'XXXTENTACION', title: 'Fuck Love' }))).toBe(true)
  })

  test('another song, another artist or another length does not match', () => {
    expect(lyricsMatch(sc(), track({ artist: 'XXXTENTACION', title: 'Revenge', duration: 148 }))).toBe(false)
    expect(lyricsMatch(sc(), track({ artist: 'Someone Else', title: 'Fuck Love', duration: 148 }))).toBe(false)
    expect(lyricsMatch(sc(), track({ artist: 'XXXTENTACION', title: 'Fuck Love', duration: 170 }))).toBe(false)
  })

  test('the first matching VK track with lyrics gives them', async () => {
    h.found = [track({ key: '2_1', artist: 'XXXTENTACION', title: 'Fuck Love', hasLyrics: false }), track({ key: '2_2', artist: 'XXXTENTACION', title: 'Fuck Love', hasLyrics: true })]
    const got = await findLyrics(sc())
    expect(got?.lines[0].text).toBe('la')
    expect(h.lyricsOf).toEqual(['2_2'])
    expect(h.searched).toEqual(['XXXTENTACION Fuck Love'])
  })

  test('no match: no lyrics, and nothing else is fetched', async () => {
    h.found = [track({ key: '2_3', artist: 'Other', title: 'Other', hasLyrics: true })]
    expect(await findLyrics(sc())).toBeNull()
    expect(h.lyricsOf).toEqual([])
  })

  test('a VK track with synced lyrics keeps its own lyrics, without a search', async () => {
    h.vkLyrics = { synced: true, lines: [{ text: 'la', begin: 1000 }] }
    await findLyrics(track({ key: '3_1', hasLyrics: true }))
    expect(h.lyricsOf).toEqual(['3_1'])
    expect(h.searched).toEqual([])
  })

  test('an unsynced VK track checks releaseId and official VK duplicates for synced lyrics', async () => {
    const res = await (async () => {
      h.found = [
        track({ key: '99_1', ownerId: 99, artist: 'A', title: 'T', hasLyrics: true }),
        track({ key: '-2000_55', ownerId: -2000, artist: 'A', title: 'T', hasLyrics: true, album: { id: 1, ownerId: -2000, title: 'Alb' } }),
      ]
      const origGetLyrics = h.vkLyrics
      void origGetLyrics
      return findLyrics(track({ key: '3_9', ownerId: 3, hasLyrics: true }))
    })()
    expect(res?.lines[0].text).toBe('la')
    expect(h.searched).toEqual(['A T'])
    // Prioritizes official ownerId < 0 release match ahead of plain user re-upload
    expect(h.lyricsOf[0]).toBe('3_9')
    expect(h.lyricsOf[1]).toBe('-2000_55')
  })

  test('a Spotify track uses native Spotify lyrics first, then falls back to VK', async () => {
    const spTrack = track({
      service: 'spotify',
      spotifyId: '4cOdK2wGLETKBW3PvgPWqT',
      key: 'sp_4cOdK2wGLETKBW3PvgPWqT',
      artist: 'Rick Astley',
      title: 'Never Gonna Give You Up',
      duration: 214,
    })
    h.spLyrics = { synced: true, lines: [{ text: 'Never gonna give you up', begin: 18000 }], credits: 'Текст: Spotify' }
    const native = await findLyrics(spTrack)
    expect(native?.synced).toBe(true)
    expect(native?.lines[0]).toEqual({ text: 'Never gonna give you up', begin: 18000 })
    expect(h.searched).toEqual([])

    h.spLyrics = null
    h.found = [track({ key: 'vk_9', artist: 'Rick Astley', title: 'Never Gonna Give You Up', duration: 214, hasLyrics: true })]
    const fallback = await findLyrics(spTrack)
    expect(fallback?.lines[0].text).toBe('la')
    expect(h.searched).toEqual(['Rick Astley Never Gonna Give You Up'])
    expect(h.lyricsOf).toEqual(['vk_9'])
  })

  test('syllable-synced Spotify lyrics short-circuit without hitting LRCLIB or Genius, while line-synced upgrade word timings via LRCLIB', async () => {
    h.tauri = true
    const spTrack = track({
      service: 'spotify',
      spotifyId: '4cOdK2wGLETKBW3PvgPWqT',
      key: 'sp_fast',
      artist: 'Rick Astley',
      title: 'Never Gonna Give You Up',
      duration: 214,
    })
    h.spLyrics = {
      synced: true,
      source: 'spotify',
      lines: [
        {
          text: 'Fast synced',
          begin: 1000,
          words: [
            { text: 'Fast', begin: 1000, end: 1350 },
            { text: 'synced', begin: 1350, end: 1800 },
          ],
        },
      ],
    }

    const res = await findLyrics(spTrack)
    expect(res?.synced).toBe(true)
    expect(res?.lines[0].words).toHaveLength(2)
    expect(h.fetchedUrls).toEqual([])
    expect(h.searched).toEqual([])

    h.spLyrics = { synced: true, source: 'spotify', lines: [{ text: 'Line synced only', begin: 1000 }] }
    h.fetchReply = (url) =>
      url.startsWith('https://lrclib.net/api/get')
        ? JSON.stringify({
            artistName: 'Rick Astley',
            trackName: 'Never Gonna Give You Up',
            duration: 214,
            hasWordSync: true,
            lyricsfile: "lines:\n- text: Line synced only\n  start_ms: 1000\n  end_ms: 1900\n  words:\n  - text: 'Line '\n    start_ms: 1000\n  - text: 'synced '\n    start_ms: 1280\n  - text: only\n    start_ms: 1620\n",
          })
        : ''

    const upgraded = await findLyrics({ ...spTrack, key: 'sp_upgrade_word' })
    expect(upgraded?.source).toBe('lrclib')
    expect(upgraded?.lines[0].words).toHaveLength(3)
    expect(h.searched).toEqual([])
  })

  test('VK track without hasLyrics fetches synced lyrics from LRCLIB', async () => {
    h.tauri = true
    h.fetchReply = (url) =>
      url.startsWith('https://lrclib.net/api/get')
        ? JSON.stringify({ artistName: 'Pharaoh', trackName: 'Bliki', duration: 180, syncedLyrics: '[00:05.00]Эти блики' })
        : ''

    const res = await findLyrics(track({ key: 'vk_noflag', hasLyrics: false, artist: 'Pharaoh', title: 'Bliki', duration: 180 }))
    expect(res?.synced).toBe(true)
    expect(res?.source).toBe('lrclib')
    expect(res?.lines[0]).toEqual({ text: 'Эти блики', begin: 5000 })
    expect(h.lyricsOf).toEqual([])
  })

  test('VK synced lyrics beat LRCLIB plain text on SC track', async () => {
    h.tauri = true
    h.fetchReply = (url) =>
      url.startsWith('https://lrclib.net/api/get')
        ? JSON.stringify({ artistName: 'XXXTENTACION', trackName: 'Fuck Love', duration: 148, plainLyrics: 'Plain LRCLIB' })
        : ''
    h.found = [track({ key: 'vk_synced_hit', artist: 'XXXTENTACION', title: 'Fuck Love', duration: 148, hasLyrics: true })]
    h.vkLyrics = { synced: true, lines: [{ text: 'VK synced', begin: 1200 }] }

    const res = await findLyrics(sc())
    expect(res?.synced).toBe(true)
    expect(res?.source).toBe('vk')
    expect(res?.lines[0].text).toBe('VK synced')
  })

  test('Genius acts as final fallback when LRCLIB and VK return nothing', async () => {
    h.tauri = true
    h.fetchReply = (url) => {
      if (url.startsWith('https://genius.com/api/search/multi')) {
        return JSON.stringify({
          response: {
            sections: [
              {
                type: 'song',
                hits: [
                  {
                    type: 'song',
                    result: {
                      title: 'Rare Track',
                      primary_artist: { name: 'Indie Guy' },
                      url: 'https://genius.com/Indie-guy-rare-track-lyrics',
                    },
                  },
                ],
              },
            ],
          },
        })
      }
      if (url === 'https://genius.com/Indie-guy-rare-track-lyrics') {
        return '<div data-lyrics-container="true">Rare line one<br>Rare line two</div>'
      }
      return ''
    }

    const res = await findLyrics(track({ key: 'vk_rare', hasLyrics: false, artist: 'Indie Guy', title: 'Rare Track', duration: 190 }))
    expect(res).toEqual({
      synced: false,
      source: 'genius',
      lines: [{ text: 'Rare line one' }, { text: 'Rare line two' }],
      credits: 'Текст: Genius',
    })
  })

  test('caches hits and misses cleanly in localStorage', async () => {
    h.tauri = true
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
    h.fetchReply = (url) =>
      url.startsWith('https://lrclib.net/api/get')
        ? JSON.stringify({ artistName: 'A', trackName: 'Cached', duration: 100, syncedLyrics: '[00:01.00]Cached line' })
        : ''

    const t = track({ key: 'vk_cached_1', hasLyrics: false, artist: 'A', title: 'Cached', duration: 100 })
    const first = await findLyrics(t)
    expect(first?.lines[0].text).toBe('Cached line')
    expect(h.fetchedUrls.length).toBeGreaterThan(0)

    h.fetchedUrls.length = 0
    const second = await findLyrics(t)
    expect(second).toEqual(first)
    expect(h.fetchedUrls).toEqual([])
  })

  test('fills default ВКонтакте credit when native VK lyrics return an empty credits string', async () => {
    h.vkLyrics = { synced: true, lines: [{ text: 'Line', begin: 1000 }], credits: '' }
    const res = await findLyrics(track({ key: 'vk_empty_credits', hasLyrics: true }))
    expect(res?.source).toBe('vk')
    expect(res?.credits).toBe('Текст: ВКонтакте')
  })

  test('upgrades plain VK lyrics to synced Spotify / NetEase lyrics when a match exists', async () => {
    h.vkLyrics = { synced: false, lines: [{ text: 'Обычная строка ВКонтакте' }] }
    h.spFound = [track({ service: 'spotify', spotifyId: 'sp123', key: 'sp_sp123', artist: 'A', title: 'T', duration: 148 })]
    h.spLyrics = { synced: true, source: 'spotify', lines: [{ text: 'Синхронизированная строка', begin: 1200 }], credits: 'Текст: Spotify' }

    const res = await findLyrics(track({ key: 'vk_plain_upgrade', hasLyrics: true }))
    expect(res?.synced).toBe(true)
    expect(res?.source).toBe('spotify')
    expect(h.spSearched).toEqual(['A T'])
  })

  test('upgrades line-synced VK lyrics to word-synced LRCLIB lyricsfile when available', async () => {
    h.tauri = true
    h.vkLyrics = { synced: true, lines: [{ text: 'Подо мной', begin: 14920 }] }
    h.fetchReply = (url) =>
      url.startsWith('https://lrclib.net/api/get')
        ? JSON.stringify({
            artistName: 'MACAN',
            trackName: 'ASPHALT 8',
            duration: 135,
            hasWordSync: true,
            lyricsfile: "lines:\n- text: Подо мной\n  start_ms: 14920\n  end_ms: 15600\n  words:\n  - text: 'Подо '\n    start_ms: 14920\n  - text: 'мной'\n    start_ms: 15210\n",
          })
        : ''

    const res = await findLyrics(track({ key: 'vk_line_only', artist: 'MACAN', title: 'ASPHALT 8', duration: 135, hasLyrics: true }))
    expect(res?.source).toBe('lrclib')
    expect(res?.lines[0].words).toEqual([
      { text: 'Подо', begin: 14920, end: 15210 },
      { text: 'мной', begin: 15210, end: 15600 },
    ])
  })

  test('VK track without hasLyrics checks other VK duplicates when external databases miss', async () => {
    h.found = [track({ key: 'vk_dup_hit', artist: 'A', title: 'T', duration: 148, hasLyrics: true })]
    const res = await findLyrics(track({ key: 'vk_orig_miss', hasLyrics: false }))
    expect(res?.lines[0].text).toBe('la')
    expect(h.lyricsOf).toEqual(['vk_dup_hit'])
  })

  test('deduplicates concurrent in-flight findLyrics calls for the same track key', async () => {
    ;(globalThis as Record<string, unknown>).localStorage = memoryStorage()
    h.tauri = true
    h.fetchedUrls.length = 0
    h.fetchReply = (url) =>
      url.startsWith('https://lrclib.net/api/get')
        ? JSON.stringify({ artistName: 'Daft', trackName: 'One', duration: 200, syncedLyrics: '[00:02.00]Concurrent line' })
        : ''

    const t = track({ key: 'dedup_1', hasLyrics: false, artist: 'Daft', title: 'One', duration: 200 })
    const [a, b] = await Promise.all([findLyrics(t), findLyrics(t)])
    expect(a).toEqual(b)
    expect(a?.lines[0].text).toBe('Concurrent line')
    expect(h.fetchedUrls.filter((u) => u.startsWith('https://lrclib.net/api/get'))).toHaveLength(1)
  })
})
