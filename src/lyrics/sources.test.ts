import { describe, expect, test, vi } from 'vitest'
import { geniusLyrics, kugouLyrics, lrclibLyrics, lyricsOvhLyrics, neteaseLyrics, qqLyrics } from './sources'
import { searchQueriesFor, searchQueryFor } from './match'

describe('lrclibLyrics', () => {
  test('uses exact /api/get synced LRC when present', async () => {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toContain('https://lrclib.net/api/get?')
      expect(url).toContain('artist_name=XXXTENTACION')
      expect(url).toContain('track_name=Fuck%20Love')
      expect(url).toContain('duration=148')
      return JSON.stringify({
        id: 1,
        artistName: 'XXXTENTACION',
        trackName: 'Fuck Love',
        duration: 148,
        instrumental: false,
        syncedLyrics: '[00:05.00]Ooh baby\n[00:10.00]Please don’t throw your love away',
        plainLyrics: 'Ooh baby\nPlease don’t throw your love away',
      })
    })

    const res = await lrclibLyrics({ artist: 'XXXTENTACION', title: 'Fuck Love (feat. Trippie Redd)', duration: 148 }, fetcher)
    expect(res).toEqual({
      synced: true,
      source: 'lrclib',
      lines: [
        { text: 'Ooh baby', begin: 5000, end: 10000 },
        { text: 'Please don’t throw your love away', begin: 10000 },
      ],
      credits: 'Текст: LRCLIB',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('falls back to /api/search when /api/get returns 404 (empty string) and filters by ±3s + artist/title including Artist - Title', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://lrclib.net/api/get')) return ''
      return JSON.stringify([
        {
          id: 10,
          artistName: 'XXXTENTACION',
          trackName: 'Fuck Love',
          duration: 160,
          syncedLyrics: '[00:01.00]Wrong duration',
        },
        {
          id: 11,
          artistName: 'Impostor',
          trackName: 'Fuck Love',
          duration: 148,
          syncedLyrics: '[00:01.00]Wrong artist',
        },
        {
          id: 12,
          artistName: 'XXXTENTACION',
          trackName: 'Fuck Love',
          duration: 147.4,
          syncedLyrics: '[00:02.00]Right match',
        },
      ])
    })

    const res = await lrclibLyrics(
      { artist: 'some uploader', title: 'XXXTENTACION - Fuck Love (feat. Trippie Redd)', duration: 148 },
      fetcher,
    )
    expect(res).toEqual({
      synced: true,
      source: 'lrclib',
      lines: [{ text: 'Right match', begin: 2000 }],
      credits: 'Текст: LRCLIB',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('returns instrumental marker when LRCLIB marks instrumental', async () => {
    const fetcher = vi.fn(async () =>
      JSON.stringify({
        artistName: 'Boards of Canada',
        trackName: 'Roygbiv',
        duration: 151,
        instrumental: true,
        plainLyrics: null,
        syncedLyrics: null,
      }),
    )

    const res = await lrclibLyrics({ artist: 'Boards of Canada', title: 'Roygbiv', duration: 151 }, fetcher)
    expect(res).toEqual({
      synced: false,
      instrumental: true,
      source: 'lrclib',
      lines: [],
      credits: 'Текст: LRCLIB (инструментал)',
    })
  })

  test('returns null on network or JSON errors without throwing', async () => {
    const failFetcher = vi.fn(async () => {
      throw new Error('HTTP 503')
    })
    await expect(lrclibLyrics({ artist: 'A', title: 'B', duration: 100 }, failFetcher)).resolves.toBeNull()

    const badJsonFetcher = vi.fn(async () => '<html>gateway error</html>')
    await expect(lrclibLyrics({ artist: 'A', title: 'B', duration: 100 }, badJsonFetcher)).resolves.toBeNull()
  })
})

describe('geniusLyrics', () => {
  test('queries /api/search/multi then fetches matching song HTML and parses lyrics', async () => {
    const fetcher = vi.fn(async (url: string) => {
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
                      title: 'Сияние (Remix)',
                      primary_artist: { name: 'Другой Артист' },
                      url: 'https://genius.com/Other-song-lyrics',
                    },
                  },
                  {
                    type: 'song',
                    result: {
                      title: 'Блики (feat. Guest)',
                      primary_artist: { name: 'Фараон' },
                      url: 'https://genius.com/Pharaoh-bliki-lyrics',
                    },
                  },
                ],
              },
            ],
          },
        })
      }
      expect(url).toBe('https://genius.com/Pharaoh-bliki-lyrics')
      return '<div data-lyrics-container="true">[Припев]<br>Эти блики ослепляют</div>'
    })

    const res = await geniusLyrics({ artist: 'Фараон', title: 'Блики' }, fetcher)
    expect(res).toEqual({
      synced: false,
      source: 'genius',
      lines: [{ text: '[Припев]' }, { text: 'Эти блики ослепляют' }],
      credits: 'Текст: Genius',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('returns null if Genius finds no matching song or fetch fails', async () => {
    const fetcher = vi.fn(async () => JSON.stringify({ response: { sections: [{ type: 'song', hits: [] }] } }))
    await expect(geniusLyrics({ artist: 'A', title: 'B' }, fetcher)).resolves.toBeNull()
  })
})

describe('searchQueryFor and searchQueriesFor', () => {
  test('strips leading punctuation marks like !5658444 and builds collaborator fallback query', () => {
    expect(searchQueryFor({ artist: 'snowflakee', title: '!5658444' })).toEqual({
      artist: 'snowflakee',
      title: '5658444',
      query: 'snowflakee 5658444',
    })
    expect(searchQueriesFor({ artist: 'FORTUNA 812, madk1d', title: 'Простужен (slowed + reverb)' })).toContain(
      'FORTUNA 812 Простужен',
    )
  })
})

describe('neteaseLyrics', () => {
  test('prefers word-synced YRC over LRC when available and enforces lyricsMatch', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://music.163.com/api/cloudsearch/pc')) {
        return JSON.stringify({
          result: {
            songs: [
              { id: 99, name: 'Blinding Lights', ar: [{ name: 'The Weeknd' }], dt: 200000 },
            ],
          },
        })
      }
      if (url.startsWith('https://music.163.com/api/song/lyric?id=99')) {
        return JSON.stringify({
          yrc: { lyric: '[0,1000](0,1000,0)作词 : Max Martin\n[1200,900](1200,400,0)I (1600,500,0)said' },
          lrc: { lyric: '[00:01.20]I said' },
        })
      }
      return ''
    })

    const res = await neteaseLyrics({ artist: 'The Weeknd', title: 'Blinding Lights', duration: 200 }, fetcher)
    expect(res).toEqual({
      synced: true,
      source: 'netease',
      credits: 'Текст: NetEase',
      lines: [
        {
          text: 'I said',
          begin: 1200,
          end: 2100,
          words: [
            { text: 'I', begin: 1200, end: 1600 },
            { text: 'said', begin: 1600, end: 2100 },
          ],
        },
      ],
    })
  })

  test('falls back to synced LRC on NetEase when YRC is absent', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://music.163.com/api/cloudsearch/pc')) {
        return JSON.stringify({
          result: { songs: [{ id: 5, name: 'Санта Клаус', ar: [{ name: 'Платина' }], dt: 122000 }] },
        })
      }
      return JSON.stringify({
        lrc: { lyric: '[00:00.00]作词 : Платина\n[00:04.50]Это правда\n[00:07.00]Снег идёт' },
      })
    })

    const res = await neteaseLyrics({ artist: 'Платина', title: 'Санта Клаус', duration: 122 }, fetcher)
    expect(res?.synced).toBe(true)
    expect(res?.source).toBe('netease')
    expect(res?.lines).toEqual([
      { text: 'Это правда', begin: 4500, end: 7000 },
      { text: 'Снег идёт', begin: 7000 },
    ])
  })
})

describe('qqLyrics', () => {
  test('searches c.y.qq.com and parses synced LRC with HTML entities decoded', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://c.y.qq.com/soso/fcgi-bin/client_search_cp')) {
        return JSON.stringify({
          data: {
            song: {
              list: [{ songmid: 'mid_1', songname: 'Minor (Explicit)', singer: [{ name: 'Miyagi' }], interval: 185 }],
            },
          },
        })
      }
      return JSON.stringify({
        retcode: 0,
        lyric: '[ti:Minor]\n[ar:Miyagi]\n[00:10.00]Don&apos;t stop\n[00:13.00]Keep rolling',
      })
    })

    const res = await qqLyrics({ artist: 'Miyagi', title: 'Minor', duration: 185 }, fetcher)
    expect(res).toEqual({
      synced: true,
      source: 'qq',
      credits: 'Текст: QQ Music',
      lines: [
        { text: "Don't stop", begin: 10000, end: 13000 },
        { text: 'Keep rolling', begin: 13000 },
      ],
    })
  })
})

describe('lyricsOvhLyrics', () => {
  test('falls back to /api/search when /api/get lacks word sync and parses LRCLIB lyricsfile', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://lrclib.net/api/get')) {
        return JSON.stringify({
          artistName: 'MACAN',
          trackName: 'ASPHALT 8',
          duration: 135,
          hasWordSync: false,
          syncedLyrics: '[00:14.92]Подо мной M5',
        })
      }
      return JSON.stringify([
        {
          artistName: 'ASPHALT 8',
          trackName: 'MACAN',
          duration: 139,
          hasWordSync: true,
          lyricsfile: "lines:\n- text: Подо мной M5\n  start_ms: 14920\n  end_ms: 16200\n  words:\n  - text: 'Подо '\n    start_ms: 14920\n  - text: 'мной '\n    start_ms: 15200\n  - text: 'M5'\n    start_ms: 15500\n",
        },
      ])
    })

    const res = await lrclibLyrics({ artist: 'MACAN', title: 'ASPHALT 8', duration: 135 }, fetcher)
    expect(res?.synced).toBe(true)
    expect(res?.lines[0]).toEqual({
      text: 'Подо мной M5',
      begin: 14920,
      end: 16200,
      words: [
        { text: 'Подо', begin: 14920, end: 15200 },
        { text: 'мной', begin: 15200, end: 15500 },
        { text: 'M5', begin: 15500, end: 16200 },
      ],
    })
  })

  test('returns plain lines when api.lyrics.ovh responds with lyrics', async () => {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.lyrics.ovh/v1/Pharaoh/Bliki')
      return JSON.stringify({ lyrics: 'Строка один\r\n\r\nСтрока два' })
    })
    const res = await lyricsOvhLyrics({ artist: 'Pharaoh', title: 'Bliki' }, fetcher)
    expect(res).toEqual({
      synced: false,
      source: 'ovh',
      lines: [{ text: 'Строка один' }, { text: 'Строка два' }],
      credits: 'Текст: Lyrics.ovh',
    })
  })
})

describe('kugouLyrics', () => {
  test('searches hash, resolves candidate accesskey, and decodes UTF-8 base64 LRC', async () => {
    const lrc = '[00:05.00]Строка из Kugou\n[00:08.50]Вторая строка'
    const bytes = new TextEncoder().encode(lrc)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const b64 = btoa(bin)

    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://mobileservice.kugou.com/api/v3/search/song')) {
        return JSON.stringify({
          data: { info: [{ hash: 'H123', songname: 'Отпускай', singername: 'Три дня дождя', duration: 196 }] },
        })
      }
      if (url.startsWith('https://krcs.kugou.com/search')) {
        return JSON.stringify({ candidates: [{ id: 99, accesskey: 'KEY99', duration: 196000 }] })
      }
      expect(url).toContain('https://lyrics.kugou.com/download?')
      expect(url).toContain('fmt=lrc')
      return JSON.stringify({ content: b64, fmt: 'lrc' })
    })

    const res = await kugouLyrics({ artist: 'Три дня дождя', title: 'Отпускай', duration: 194 }, fetcher)
    expect(res).toEqual({
      synced: true,
      source: 'kugou',
      credits: 'Текст: Kugou',
      lines: [
        { text: 'Строка из Kugou', begin: 5000, end: 8500 },
        { text: 'Вторая строка', begin: 8500 },
      ],
    })
  })
})
