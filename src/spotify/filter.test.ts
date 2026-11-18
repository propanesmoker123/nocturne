/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'
import { fetchSpotifyWaveform, getMyPlaylists, getSpotifyLyrics, normalizeSpotifyPlaylist, normalizeSpotifyTrack, normalizeSpotifyUser, organizeHomeFeed, organizeHomeSections, peaksFromSegments, structuralPeaks } from './api'

const source = readFileSync(new URL('../../src-tauri/src/spotify/filter.js', import.meta.url), 'utf8')
const endpoint = 'https://spclient.wg.spotify.com/track-playback/v1/devices/device/state'
const machine = () => ({ state_machine: { state_machine_id: 'fixture', tracks: [
  { metadata: { uri: 'spotify:track:first' } }, { metadata: { uri: 'spotify:ad:advert' } }, { metadata: { uri: 'spotify:track:next' } },
], states: [
  { state_id: 'song', track: 0, transitions: { advance: { state_index: 1 } } },
  { state_id: 'ad', track: 1, transitions: { advance: { state_index: 2 } } },
  { state_id: 'next', track: 2, transitions: { advance: null } },
] }, updated_state_ref: { state_index: 1 } })

class Socket extends EventTarget {
  static OPEN = 1
  readonly url: string
  constructor(url: string) { super(); this.url = url }
  send() {}
}
function fixture(reply: unknown = machine(), origin = 'https://open.spotify.com', failure?: Error, extra: Record<string, unknown> = {}) {
  let requests = 0
  const response = new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json', 'X-Fixture': 'kept' } })
  const fetch = async (_input: unknown, _init?: unknown) => { requests++; if (failure) throw failure; return response.clone() }
  const win = { location: { origin }, fetch, WebSocket: Socket, ...extra } as unknown as Window & { WebSocket: typeof WebSocket; __nocturneSpotifyLab: { configure(enabled: boolean): void; playing(): boolean | null; control(action: string): boolean; stats(): { enabled: boolean; removed: number; unsupported: number; intercepted: number } } }
  const context = { window: win, URL, URLSearchParams, Request, Response, Headers, MessageEvent, Event, structuredClone, setTimeout, clearTimeout, ...extra }
  runInNewContext(source, context)
  return { win, requests: () => requests }
}
describe('bounded Spotify ad experiment', () => {
  test('play and pause use real playback state independently of button language', () => {
    const mediaSession = { playbackState: 'playing' }
    let clicks = 0
    const document = { querySelector: () => ({ disabled: false, getAttribute: () => 'Pausieren', click: () => { clicks++; mediaSession.playbackState = mediaSession.playbackState === 'playing' ? 'paused' : 'playing' } }), querySelectorAll: () => [] }
    const { win } = fixture({}, undefined, undefined, { document, navigator: { mediaSession } })
    expect(win.__nocturneSpotifyLab.playing()).toBe(true)
    expect(win.__nocturneSpotifyLab.control('pause')).toBe(true)
    expect(win.__nocturneSpotifyLab.playing()).toBe(false)
    expect(win.__nocturneSpotifyLab.control('pause')).toBe(false)
    expect(clicks).toBe(1)
    expect(win.__nocturneSpotifyLab.control('play')).toBe(true)
    expect(win.__nocturneSpotifyLab.playing()).toBe(true)
  })
  test('substitutes a known next song while preserving references, regular tracks, headers and input', async () => {
    const payload = machine(), { win } = fixture(payload)
    const reply = await win.fetch(endpoint)
    const data = await reply.json()
    expect(data.state_machine.states[1]).toEqual(payload.state_machine.states[2])
    expect(data.updated_state_ref.state_index).toBe(1)
    expect(data.state_machine.states[0]).toEqual(payload.state_machine.states[0])
    expect(reply.headers.get('X-Fixture')).toBe('kept')
    expect(payload.state_machine.states[1].state_id).toBe('ad')
    expect(win.__nocturneSpotifyLab.stats().removed).toBe(1)
  })
  test('works with URL and Request fetch inputs and keeps fetch errors unchanged', async () => {
    for (const input of [new URL(endpoint), new Request(endpoint)]) {
      const { win } = fixture()
      expect((await (await win.fetch(input)).json()).state_machine.states[1].state_id).toBe('next')
    }
    const error = new TypeError('fixture network error'), { win } = fixture({}, undefined, error)
    await expect(win.fetch(endpoint)).rejects.toBe(error)
  })
  test('never changes license, login, unrelated or lookalike-host requests', async () => {
    for (const url of ['https://spclient.wg.spotify.com/widevine-license/v1/audio/license', 'https://accounts.spotify.com/api/token', 'https://evil.test/state', 'https://spclient.wg.spotify.com.evil.test/track-playback/v1/devices/d/state']) {
      const payload = machine(), { win } = fixture(payload)
      expect(await (await win.fetch(url)).json()).toEqual(payload)
      expect(win.__nocturneSpotifyLab.stats().intercepted).toBe(0)
    }
  })
  test('disabled filtering passes all messages untouched', async () => {
    const payload = machine(), { win } = fixture(payload)
    win.__nocturneSpotifyLab.configure(false)
    expect(await (await win.fetch(endpoint)).json()).toEqual(payload)
    expect(win.__nocturneSpotifyLab.stats().enabled).toBe(false)
    expect(win.__nocturneSpotifyLab.stats().removed).toBe(0)
  })
  test('cycles, missing successors and unknown shapes preserve the original response', async () => {
    const cyclic = machine(); cyclic.state_machine.states[1].transitions.advance = { state_index: 1 }
    const missing = machine(); missing.state_machine.states[1].transitions.advance = { state_index: 300 }
    for (const payload of [cyclic, missing, { state_machine: { states: [], tracks: [] } }, { unrelated: 'value' }]) {
      const { win, requests } = fixture(payload)
      expect(await (await win.fetch(endpoint)).json()).toEqual(payload)
      expect(requests()).toBe(1)
    }
  })
  test('websocket property/listeners receive one filtered event and removals work', () => {
    const { win } = fixture(), socket = new win.WebSocket('wss://dealer.spotify.com/')
    let received = 0, last = ''
    const listener = (event: MessageEvent) => { received++; last = event.data }
    socket.addEventListener('message', listener)
    socket.onmessage = listener
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ payloads: [{ type: 'replace_state', ...machine() }] }) }))
    expect(received).toBe(2)
    expect(JSON.parse(last).payloads[0].state_machine.states[1].state_id).toBe('next')
    expect(win.__nocturneSpotifyLab.stats().removed).toBe(1)
    socket.removeEventListener('message', listener); socket.onmessage = null
    socket.dispatchEvent(new MessageEvent('message', { data: '{}' }))
    expect(received).toBe(2)
  })
  test('binary websocket data and non-Spotify sockets are passed through', () => {
    const { win } = fixture()
    for (const [url, data] of [['wss://dealer.spotify.com/', new Blob(['binary'])], ['wss://other.test/', JSON.stringify(machine())]] as const) {
      const socket = new win.WebSocket(url)
      let got: unknown
      socket.addEventListener('message', event => { got = event.data })
      socket.dispatchEvent(new MessageEvent('message', { data }))
      expect(got).toBe(data)
    }
  })
  test('regional dealer sockets and listener objects preserve once and removal behavior', () => {
    const { win } = fixture(), socket = new win.WebSocket('wss://guc3-dealer.spotify.com/')
    let count = 0, state = ''
    const callback = { handleEvent(event: Event) { count++; state = JSON.parse((event as MessageEvent).data).state_machine.states[1].state_id } }
    socket.addEventListener('message', callback, { once: true })
    const emit = () => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(machine()) }))
    emit(); emit()
    expect(count).toBe(1)
    expect(state).toBe('next')
    socket.addEventListener('message', callback)
    socket.removeEventListener('message', callback)
    emit()
    expect(count).toBe(1)
  })
  test('hooks are installed only on the Spotify player origin', () => {
    const { win } = fixture({}, 'https://accounts.spotify.com')
    expect(win.__nocturneSpotifyLab).toBeUndefined()
  })
  test('now playing is read from the media session and the bottom bar; seek sets the slider like a keyboard change', () => {
    class Input extends EventTarget { min = '0'; max = '200000'; step = '5000'; disabled = false; _value = '30000'; get value() { return this._value } set value(v: string) { this._value = v } }
    const slider = new Input()
    const events: string[] = []
    slider.addEventListener('input', () => events.push('input'))
    slider.addEventListener('change', () => events.push('change'))
    const elements: Record<string, unknown> = {
      '[data-testid="playback-progressbar"]': { querySelector: () => slider },
      '[data-testid="control-button-shuffle"]': { getAttribute: () => 'true' },
      '[data-testid="control-button-repeat"]': { getAttribute: () => 'mixed' },
      '[data-testid="user-widget-link"]': {},
    }
    const document = { querySelector: (selector: string) => elements[selector] ?? null, querySelectorAll: () => [] }
    const mediaSession = { playbackState: 'playing', metadata: { title: ' Song ', artist: 'Band', album: 'Record', artwork: [{ src: 'https://i.scdn.co/image/small', sizes: '64x64' }, { src: 'https://i.scdn.co/image/large', sizes: '640x640' }, { src: 'https://evil.test/x.png', sizes: '900x900' }] } }
    const { win } = fixture({}, undefined, undefined, { document, navigator: { mediaSession }, HTMLInputElement: Input })
    const lab = win.__nocturneSpotifyLab as unknown as { nowPlaying(): Record<string, unknown>; account(): string | null; control(action: string, value?: number): boolean }
    expect(lab.nowPlaying()).toMatchObject({ title: 'Song', artist: 'Band', album: 'Record', cover: 'https://i.scdn.co/image/small', coverLarge: 'https://i.scdn.co/image/large', position: 30, duration: 200, shuffle: true, repeat: 'one', liked: null, volume: null })
    expect(lab.account()).toBe('in')
    expect(lab.control('seek', 61.2)).toBe(true)
    expect(slider.value).toBe('61200')
    expect(events).toEqual(['input', 'change'])
    expect(lab.control('seek', Number.NaN)).toBe(false)
    expect(lab.control('arbitrary')).toBe(false)
  })
  test('filters regional spclient state endpoints and blocks ad decision endpoints', async () => {
    const payload = machine()
    const { win, requests } = fixture(payload)
    const regionalState = await (await win.fetch('https://guc3-spclient.spotify.com/track-playback/v1/devices/device/state')).json()
    expect(regionalState.state_machine.states[1].state_id).toBe('next')
    expect(requests()).toBe(1)

    const adReply = await (await win.fetch('https://gae2-spclient.spotify.com/ads/v2/config')).json()
    expect(adReply).toEqual({})
    expect(requests()).toBe(1)
    expect(win.__nocturneSpotifyLab.stats().removed).toBe(2)
  })
  test('normalizes Spotify tracks and playlists and builds chorus/verse waveform peaks', () => {
    const track = normalizeSpotifyTrack({
      id: '4cOdK2wGLETKBW3PvgPWqT',
      name: 'Never Gonna Give You Up',
      duration_ms: 213573,
      explicit: false,
      artists: [{ id: '0gxyHStUsqpMadRV0Di1Qt', name: 'Rick Astley' }],
      album: {
        id: '6N9PS4QXF1D0OWPk0Sxtb4',
        name: 'Whenever You Need Somebody',
        images: [{ url: 'https://i.scdn.co/image/ab67616d0000b273', width: 640 }],
      },
    })
    expect(track).toMatchObject({
      service: 'spotify',
      spotifyId: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      duration: 214,
      url: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
      playable: true,
    })

    const pl = normalizeSpotifyPlaylist({
      id: '37i9dQZF1DXcBWIGoYBM5M',
      name: "Today's Top Hits",
      tracks: { total: 50 },
      images: [{ url: 'https://i.scdn.co/image/ab67706f00000002', width: 300 }],
    })
    expect(pl).toMatchObject({
      service: 'spotify',
      spotifyId: '37i9dQZF1DXcBWIGoYBM5M',
      title: "Today's Top Hits",
      count: 50,
    })

    const struct = structuralPeaks('4cOdK2wGLETKBW3PvgPWqT')
    expect(struct.length).toBe(240)
    expect(Math.max(...struct)).toBeCloseTo(1, 2)
    expect(Math.min(...struct)).toBeGreaterThan(0)

    const segs: [number, number, number][] = Array.from({ length: 120 }, (_, i) => [i * 1.5, 1.5, i >= 30 && i <= 50 ? -5 : -18])
    const segPeaks = peaksFromSegments(segs, 180)
    expect(segPeaks).not.toBeNull()
    expect(segPeaks!.length).toBe(240)
    // Chorus bins (60..100 for i=30..50) are louder than intro/verse bins
    expect(segPeaks![70]).toBeGreaterThan(segPeaks![10])
  })
  test('normalizes Pathfinder GraphQL tracks, playlists, and users', () => {
    const pfTrack = normalizeSpotifyTrack({
      track: {
        _uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
        data: {
          __typename: 'Track',
          uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
          name: 'губы',
          duration: { totalMilliseconds: 132000 },
          contentRating: { label: 'EXPLICIT' },
          playability: { playable: true },
          artists: {
            items: [{ uri: 'spotify:artist:0gxyHStUsqpMadRV0Di1Qt', profile: { name: 'vanchss' } }],
          },
          albumOfTrack: {
            uri: 'spotify:album:6N9PS4QXF1D0OWPk0Sxtb4',
            name: 'губы - Single',
            coverArt: {
              sources: [{ url: 'https://i.scdn.co/image/ab67616d0000b273', width: 640 }],
            },
          },
        },
      },
    }, true)
    expect(pfTrack).toMatchObject({
      service: 'spotify',
      spotifyId: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'губы',
      artist: 'vanchss',
      duration: 132,
      explicit: true,
      liked: true,
      playable: true,
    })

    const pfPlaylist = normalizeSpotifyPlaylist({
      item: {
        data: {
          __typename: 'Playlist',
          uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
          name: 'Мои треки',
          ownerV2: { data: { name: 'User' } },
          content: { totalCount: 42 },
          images: {
            items: [{ sources: [{ url: 'https://i.scdn.co/image/ab67706f00000002', width: 300 }] }],
          },
        },
      },
    })
    expect(pfPlaylist).toMatchObject({
      service: 'spotify',
      spotifyId: '37i9dQZF1DXcBWIGoYBM5M',
      title: 'Мои треки',
      ownerName: 'User',
      count: 42,
      type: 'playlist',
    })

    const pfUser = normalizeSpotifyUser({
      __typename: 'User',
      uri: 'spotify:user:31abcdefghijkl',
      username: '31abcdefghijkl',
      name: 'Nocturne Listener',
      avatar: { sources: [{ url: 'https://i.scdn.co/image/ab6775700000ee85', width: 300 }] },
    })
    expect(pfUser).toMatchObject({
      id: '31abcdefghijkl',
      name: 'Nocturne Listener',
      avatar: 'https://i.scdn.co/image/ab6775700000ee85',
    })
  })
  test('nowPlaying exposes paused, trackId, and ad state accurately and strips disallows', async () => {
    const widget = {
      getAttribute: () => '',
      querySelector: (sel: string) => sel === 'img' ? { src: 'https://i.scdn.co/image/cover' } : null,
      querySelectorAll: () => [{ getAttribute: () => '/album/6N9PS4QXF1D0OWPk0Sxtb4?highlight=spotify%3Atrack%3A4cOdK2wGLETKBW3PvgPWqT' }],
    }
    const elements: Record<string, unknown> = {
      '[data-testid="now-playing-widget"]': widget,
      '[data-testid="playback-position"]': { textContent: '0:42' },
      '[data-testid="playback-duration"]': { textContent: '3:33' },
    }
    const document = { querySelector: (sel: string) => elements[sel] ?? null, querySelectorAll: () => [] }
    const mediaSession = { playbackState: 'playing', metadata: { title: 'Track', artist: 'Artist', album: 'Album', artwork: [] } }
    const { win } = fixture({}, undefined, undefined, { document, navigator: { mediaSession } })
    const lab = win.__nocturneSpotifyLab as unknown as { nowPlaying(): Record<string, unknown> }
    expect(lab.nowPlaying()).toMatchObject({
      trackId: '4cOdK2wGLETKBW3PvgPWqT',
      paused: false,
      isAd: false,
      position: 42,
      duration: 213,
    })

    mediaSession.playbackState = 'paused'
    expect(lab.nowPlaying()).toMatchObject({ paused: true, isAd: false })

    elements['[data-testid="now-playing-widget"] [data-testid="context-item-info-ad-subtitle"], [data-testid="ad-slot-container"]'] = {}
    expect(lab.nowPlaying()).toMatchObject({ isAd: true, trackId: null, paused: true })

    const withDisallows = machine()
    ;(withDisallows.state_machine.states[2] as Record<string, unknown>).disallows = { disallow_seeking: true, disallow_skipping_next: true }
    const { win: w2 } = fixture(withDisallows)
    const patched = await (await w2.fetch(endpoint)).json()
    expect(patched.state_machine.states[1].disallows).toEqual({})
  })
  test('fetchSpotifyWaveform accepts p.scdn.co previews and falls back to structuralPeaks', async () => {
    const tauri = await import('../lib/tauri')
    const spy = vi.spyOn(tauri, 'isTauri').mockReturnValue(true)
    const origTauri = (globalThis as Record<string, unknown>).window
    const invokeSpy = vi.fn()
      .mockResolvedValueOnce({ previewUrl: 'https://p.scdn.co/mp3-preview/abc123' })
      .mockResolvedValueOnce({ previewUrl: null })
      .mockResolvedValueOnce({
        lyrics: {
          syncType: 'LINE_SYNCED',
          providerDisplayName: 'Musixmatch',
          lines: [
            { startTimeMs: '1500', words: 'First line' },
            { startTimeMs: '4200', words: 'Second line' },
          ],
        },
      })
    ;(globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: { invoke: invokeSpy } }
    try {
      const withPreview = await fetchSpotifyWaveform('4cOdK2wGLETKBW3PvgPWqT', 200)
      expect(withPreview.previewUrl).toBe('https://p.scdn.co/mp3-preview/abc123')

      const fallback = await fetchSpotifyWaveform('4cOdK2wGLETKBW3PvgPWqT', 200)
      expect(fallback.peaks).toBeInstanceOf(Float32Array)
      expect(fallback.peaks?.length).toBe(240)

      const lyrics = await getSpotifyLyrics('4cOdK2wGLETKBW3PvgPWqT')
      expect(lyrics).toEqual({
        synced: true,
        source: 'spotify',
        lines: [
          { text: 'First line', begin: 1500, end: 4200 },
          { text: 'Second line', begin: 4200 },
        ],
        credits: 'Текст: Spotify (Musixmatch)',
      })
    } finally {
      ;(globalThis as Record<string, unknown>).window = origTauri
      spy.mockRestore()
    }
  })

  test('normalizeSpotifyUser accepts 28-char Spotify user IDs when username is absent', () => {
    const user = normalizeSpotifyUser({
      id: '31qcjfw7czm5a3bntyj4upt3cace',
      uri: 'spotify:user:31qcjfw7czm5a3bntyj4upt3cace',
      display_name: 'NjRatxrd',
      images: [{ url: 'https://i.scdn.co/image/ab6775700000ee851234567890abcdef12345678', width: 300 }],
    })
    expect(user).toEqual({
      id: '31qcjfw7czm5a3bntyj4upt3cace',
      name: 'NjRatxrd',
      avatar: 'https://i.scdn.co/image/ab6775700000ee851234567890abcdef12345678',
      followers: undefined,
      genres: undefined,
    })
  })

  test('normalizeSpotifyPlaylist rejects shows, episodes, and virtual recents URIs; organizeHomeSections merges duplicates and singletons', () => {
    expect(normalizeSpotifyPlaylist({ uri: 'spotify:show:67V7vwLPMprR9MNGG1s83O', name: 'Joe Rogan', __typename: 'Podcast' })).toBeNull()
    expect(normalizeSpotifyPlaylist({ uri: 'spotify:episode:45AoGozTo7yMawBagcE2mX', name: 'Ep 1', __typename: 'Episode' })).toBeNull()
    expect(normalizeSpotifyPlaylist({ uri: 'spotify:list:recents:main', name: 'Недавние' })).toBeNull()

    const p1 = normalizeSpotifyPlaylist({ id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Mix 1' })!
    const p2 = normalizeSpotifyPlaylist({ id: '37i9dQZF1DX0XUsuxWHRQd', name: 'Mix 2' })!
    const p3 = normalizeSpotifyPlaylist({ id: '37i9dQZF1DX4JAvHpjipBk', name: 'Mix 3' })!
    const p4 = normalizeSpotifyPlaylist({ id: '37i9dQZF1DX4sWSpwq3LiO', name: 'Mix 4' })!
    const organized = organizeHomeSections([
      { id: '0', title: 'Быстрый доступ', playlists: [p4], tracks: [], artists: [] },
      { id: '1', title: 'Послушай сегодня', playlists: [p1, p2], tracks: [], artists: [] },
      { id: '2', title: 'Для тебя', playlists: [p1], tracks: [], artists: [] },
      { id: '3', title: 'Для тебя', playlists: [p3], tracks: [], artists: [] },
    ])
    expect(organized.map((s) => `${s.title}:${s.playlists.length}`)).toEqual([
      'Послушай сегодня:2',
      'Для тебя:2',
      'Обратите внимание:1',
    ])

    const dm = normalizeSpotifyPlaylist({
      id: '37i9dQZF1E3a5n7yEHLtNQ',
      name: 'Микс дня #1',
      description: '<a href=spotify:playlist:1111111111111111111111>Crystal Castles</a> &#x2F; WHITENER',
      images: [{ url: 'https://dailymix-images.scdn.co/v2/img/abc/1/ru/default', width: 300 }],
    })!
    expect(dm.cover).toBe('https://dailymix-images.scdn.co/v2/img/abc/1/ru/default')
    expect(dm.description).toBe('Crystal Castles / WHITENER')

    const feed = organizeHomeFeed([
      { id: '0', typename: 'HomeGenericSectionData', title: 'Fijne zondag!', playlists: [p1, p2], tracks: [], artists: [] },
      { id: '1', typename: 'HomeGenericSectionData', title: 'Только для тебя, NjRatxrd', playlists: [dm, p3], tracks: [], artists: [] },
      { id: '2', typename: 'HomeFeedBaselineSectionData', title: 'Похоже на: Джизус', playlists: [p4], tracks: [], artists: [], kindLabels: { [p4.spotifyId!]: 'Плейлист' } },
    ])
    expect(feed.sections.map((s) => `${s.personalized ? 'P' : 'S'}|${s.subtitle ?? ''}|${s.title}`)).toEqual([
      'P|Только для тебя|NjRatxrd',
      'S||Fijne zondag!',
    ])
    expect(feed.spotlights).toHaveLength(1)
    expect(feed.spotlights[0]).toMatchObject({
      eyebrow: 'Похоже на: Джизус',
      kindLabel: 'Плейлист',
    })
  })

  test('progress prefers full metadata duration over partial MSE audio duration', () => {
    const slider = { min: '0', max: '228000', value: '5000', disabled: false }
    const elements: Record<string, unknown> = {
      '[data-testid="playback-progressbar"]': { querySelector: () => slider },
      '[data-testid="now-playing-widget"]': { querySelector: () => null, querySelectorAll: () => [] },
    }
    const document = {
      querySelector: (selector: string) => elements[selector] ?? null,
      querySelectorAll: (selector: string) =>
        selector.replace(/\s+/g, '') === 'audio,video' ? [{ paused: false, ended: false, currentTime: 5.2, duration: 6.4, volume: 1, muted: false, playbackRate: 1 }] : [],
    }
    const mediaSession = { playbackState: 'playing', metadata: { title: 'Bones', artist: 'Derek Pope', album: 'Bones', artwork: [] } }
    const { win } = fixture({}, undefined, undefined, { document, navigator: { mediaSession } })
    const lab = win.__nocturneSpotifyLab as unknown as { nowPlaying(): { position: number; duration: number } }
    expect(lab.nowPlaying().duration).toBe(228)
    expect(lab.nowPlaying().position).toBeCloseTo(5.2, 2)
  })

  test('seeking and Harmony state keep accurate position even when MSE audio currentTime resets to 0', async () => {
    class Input extends EventTarget {
      min = '0'
      max = '213607'
      step = '5000'
      disabled = false
      _value = '5000'
      get value() { return this._value }
      set value(v: string) { this._value = v }
    }
    const slider = new Input()
    const audioEl = { paused: false, ended: false, currentTime: 5.1, duration: 6.8, volume: 1, muted: false, playbackRate: 1 }
    const elements: Record<string, unknown> = {
      '[data-testid="playback-progressbar"]': { querySelector: () => slider },
      '[data-testid="now-playing-widget"]': { querySelector: () => null, querySelectorAll: () => [] },
    }
    const document = {
      querySelector: (selector: string) => elements[selector] ?? null,
      querySelectorAll: (selector: string) => (selector.replace(/\s+/g, '') === 'audio,video' ? [audioEl] : []),
    }
    const mediaSession = { playbackState: 'playing', metadata: { title: 'DIRTBAG', artist: 'WesGhost', album: 'Single', artwork: [] } }
    const { win } = fixture({}, undefined, undefined, { document, navigator: { mediaSession }, HTMLInputElement: Input })

    let playedUri = ''
    let playedContext: unknown = 'unset'
    let seekedMs = -1
    const hState = {
      duration: 213607,
      position: 5000,
      timestamp: Date.now(),
      paused: false,
      loading: false,
      track_window: { current_track: { uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT' } },
    }
    const controller = {
      playURI: async (uri: string, ctx?: string) => {
        playedUri = uri
        playedContext = ctx
      },
      seek: (ms: number) => {
        seekedMs = ms
        hState.position = ms
        hState.timestamp = Date.now()
      },
      getCurrentState: () => hState,
    }
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): Record<string, unknown>
      playTrack(id: string, startAt?: number, vol?: number, muted?: boolean): boolean
      nowPlaying(): { position: number; duration: number; trackId: string | null }
      control(action: string, value?: number): boolean
    }
    const playerHost = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    playerHost._harmony = {
      playTracks: async () => {},
      _controller: controller,
      _state: hState,
    }
    expect(lab.playTrack('4cOdK2wGLETKBW3PvgPWqT', 0, 0.35, false)).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(playedUri).toBe('spotify:track:4cOdK2wGLETKBW3PvgPWqT')
    expect(playedContext).toBeUndefined()
    expect(audioEl.volume).toBeCloseTo(0.35, 3)

    // Simulate seeking to 60s where MSE audioEl.currentTime resets to 0.4s
    expect(lab.control('seek', 60)).toBe(true)
    audioEl.currentTime = 0.4
    expect(seekedMs).toBe(60000)
    const np = lab.nowPlaying()
    expect(np.trackId).toBe('4cOdK2wGLETKBW3PvgPWqT')
    expect(np.position).toBeGreaterThanOrEqual(60)
    expect(np.position).toBeLessThan(62)
  })

  test('HTMLMediaElement volume setter blocks 100% volume spikes on track switch', () => {
    class MockMedia extends EventTarget {
      _vol = 1
      _muted = false
      paused = false
      ended = false
      currentTime = 0
      duration = 180
      playbackRate = 1
      get volume() { return this._vol }
      set volume(v: number) { this._vol = v }
      get muted() { return this._muted }
      set muted(m: boolean) { this._muted = m }
      play() { return Promise.resolve() }
      load() {}
    }
    const audioEl = new MockMedia()
    const document = {
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel.replace(/\s+/g, '') === 'audio,video' ? [audioEl] : []),
      createElement: (_tag?: string) => new MockMedia(),
    }
    const { win } = fixture({}, undefined, undefined, { document, HTMLMediaElement: MockMedia })
    const lab = win.__nocturneSpotifyLab as unknown as {
      setVolume(vol: number, muted?: boolean): boolean
    }

    expect(lab.setVolume(0.22, false)).toBe(true)
    expect(audioEl._vol).toBeCloseTo(0.22, 3)

    // When Spotify's internal Harmony player tries to reset audioEl.volume = 1 on track switch:
    audioEl.volume = 1
    expect(audioEl._vol).toBeCloseTo(0.22, 3)
    expect(audioEl.volume).toBeCloseTo(0.22, 3)

    // And newly created <audio> elements start at 0.22 immediately:
    const created = document.createElement('audio')
    expect(created._vol).toBeCloseTo(0.22, 3)
  })

  test('control seek uses only one canonical seek mechanism to prevent target audio stutter', () => {
    class Input extends EventTarget {
      min = '0'
      max = '180000'
      step = '5000'
      disabled = false
      _value = '10000'
      get value() { return this._value }
      set value(v: string) { this._value = v }
    }
    const slider = new Input()
    let sliderEvents = 0
    slider.addEventListener('input', () => { sliderEvents++ })
    slider.addEventListener('change', () => { sliderEvents++ })

    const audioEl = { paused: false, ended: false, currentTime: 10, duration: 180, volume: 1, muted: false, playbackRate: 1 }
    const document = {
      querySelector: (selector: string) =>
        selector === '[data-testid="playback-progressbar"]' ? { querySelector: () => slider } : null,
      querySelectorAll: (selector: string) => (selector.replace(/\s+/g, '') === 'audio,video' ? [audioEl] : []),
    }
    const { win } = fixture({}, undefined, undefined, { document, HTMLInputElement: Input })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): Record<string, unknown>
      control(action: string, value?: number): boolean
    }

    const calls = { ctrl: [] as number[], harmony: [] as number[], internal: [] as number[] }
    const playerHost = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    playerHost._harmony = {
      playTracks: async () => {},
      seek: (ms: number) => { calls.harmony.push(ms) },
      _seek: (ms: number) => { calls.internal.push(ms) },
      _controller: {
        seek: (ms: number) => { calls.ctrl.push(ms) },
      },
    }

    expect(lab.control('seek', 45)).toBe(true)
    expect(calls.ctrl).toEqual([45000])
    expect(calls.harmony).toEqual([])
    expect(calls.internal).toEqual([])
    expect(sliderEvents).toBe(0)
    expect(audioEl.currentTime).toBe(10)

    // Falls back to slider only when no player API seek method is exposed.
    const fallbackSlider = new Input()
    let fallbackEvents = 0
    fallbackSlider.addEventListener('input', () => { fallbackEvents++ })
    fallbackSlider.addEventListener('change', () => { fallbackEvents++ })
    const fallbackDoc = {
      querySelector: (selector: string) =>
        selector === '[data-testid="playback-progressbar"]' ? { querySelector: () => fallbackSlider } : null,
      querySelectorAll: () => [],
    }
    const { win: fallbackWin } = fixture({}, undefined, undefined, { document: fallbackDoc, HTMLInputElement: Input })
    const fallbackLab = fallbackWin.__nocturneSpotifyLab as unknown as {
      control(action: string, value?: number): boolean
    }
    expect(fallbackLab.control('seek', 72)).toBe(true)
    expect(fallbackSlider.value).toBe('72000')
    expect(fallbackEvents).toBe(2)
  })

  test('nowPlaying exposes real audio buffer ranges, prefers smooth audio time during seek settle, and prioritizes local _streamer.seek', async () => {
    class Input extends EventTarget {
      min = '0'
      max = '200000'
      step = '5000'
      disabled = false
      _value = '15000'
      get value() { return this._value }
      set value(v: string) { this._value = v }
    }
    const slider = new Input()
    const audioEl = {
      paused: false,
      ended: false,
      currentTime: 12.2,
      duration: 200,
      volume: 1,
      muted: false,
      playbackRate: 1,
      buffered: {
        length: 2,
        start: (i: number) => (i === 0 ? 0 : 100),
        end: (i: number) => (i === 0 ? 20.5 : 120),
      },
    }
    const document = {
      querySelector: (selector: string) =>
        selector === '[data-testid="playback-progressbar"]' ? { querySelector: () => slider } : null,
      querySelectorAll: (selector: string) => (selector.replace(/\s+/g, '') === 'audio,video' ? [audioEl] : []),
    }
    const mediaSession = {
      playbackState: 'playing',
      metadata: { title: 'Test Song', artist: 'Tester', album: 'Album', artwork: [] },
    }
    const { win } = fixture({}, undefined, undefined, { document, navigator: { mediaSession }, HTMLInputElement: Input })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): Record<string, unknown>
      control(action: string, value?: number): boolean
      nowPlaying(): { position: number; duration: number; buffered: number | null } | null
    }

    const calls = { streamer: [] as number[], ctrl: [] as number[] }
    let redirect = false
    let rejectStreamer = false
    const playerHost = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    playerHost._harmony = {
      playTracks: async () => {},
      _streamer: {
        _listPlayer: { _currentTrack: { uri: 'spotify:track:1111111111111111111111' } },
        seek: (ms: number) => {
          calls.streamer.push(ms)
          return rejectStreamer ? Promise.reject(new Error('local failed')) : Promise.resolve()
        },
      },
      _controller: {
        shouldRedirectPlayerCommand: () => redirect,
        seek: (ms: number) => { calls.ctrl.push(ms) },
      },
    }

    // 1. Local track uses fast _streamer.seek first without sending ctrl.seek.
    expect(lab.control('seek', 12)).toBe(true)
    expect(calls.streamer).toEqual([12000])
    expect(calls.ctrl).toEqual([])

    // 2. Smooth audioEl time (12.2) beats coarse 5s-stepped barPos (15) while seek settles, and real buffer end (20.5) is reported.
    expect(lab.nowPlaying()).toMatchObject({ position: 12.2, duration: 200, buffered: 20.5 })

    // 3. Outside any buffered range (e.g. seeked ahead to 50 before data arrives), buffered drops to 0 instead of faking 200.
    audioEl.currentTime = 50
    expect(lab.nowPlaying()?.buffered).toBe(20.5)
    // Once position reaches 50 (after settle window or target moved to 50), buffered at t=50 is 0:
    expect(lab.control('seek', 50)).toBe(true)
    expect(lab.nowPlaying()?.buffered).toBe(0)

    // 4. Remote Connect redirect skips _streamer.seek and uses ctrl.seek.
    redirect = true
    expect(lab.control('seek', 30)).toBe(true)
    expect(calls.ctrl).toEqual([30000])

    // 5. Rejected local _streamer.seek falls back cleanly to ctrl.seek.
    redirect = false
    rejectStreamer = true
    expect(lab.control('seek', 42)).toBe(true)
    await vi.waitFor(() => expect(calls.ctrl).toEqual([30000, 42000]))
  })

  test('/me/playlists trusts authoritative empty libraryV3 and never leaks home recommendations or albums', async () => {
    interface MockEl {
      tagName: string
      attributes: Record<string, string>
      textContent: string
      children: MockEl[]
      parentElement: MockEl | null
      getAttribute(name: string): string | null
      closest(selectors: string): MockEl | null
      querySelector(selectors: string): MockEl | null
      querySelectorAll(selectors: string): MockEl[]
    }

    const matchSimple = (el: MockEl, token: string): boolean => {
      let rest = token.trim()
      if (!rest) return false
      const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/)
      if (tagMatch) {
        if (el.tagName !== tagMatch[1].toUpperCase()) return false
        rest = rest.slice(tagMatch[0].length)
      }
      const attrRegex = /\[([a-zA-Z0-9_-]+)(\^=|\*=|=)"([^"]*)"\]/g
      let m: RegExpExecArray | null
      let matchedLen = 0
      while ((m = attrRegex.exec(rest)) !== null) {
        matchedLen += m[0].length
        const val = el.getAttribute(m[1]) ?? ''
        const expected = m[3]
        if (m[2] === '=' && val !== expected) return false
        if (m[2] === '^=' && !val.startsWith(expected)) return false
        if (m[2] === '*=' && !val.includes(expected)) return false
      }
      return matchedLen === rest.length
    }

    const matchChain = (el: MockEl, chain: string): boolean => {
      const parts = chain.trim().split(/\s+/).filter(Boolean)
      if (!parts.length || !matchSimple(el, parts[parts.length - 1])) return false
      let cur: MockEl | null = el.parentElement
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !matchSimple(cur, parts[i])) cur = cur.parentElement
        if (!cur) return false
        cur = cur.parentElement
      }
      return true
    }

    const matchSelectorList = (el: MockEl, selectors: string): boolean =>
      selectors.split(',').some(sel => matchChain(el, sel))

    const makeEl = (tag: string, attrs: Record<string, string> = {}, text = '', children: MockEl[] = []): MockEl => {
      const el: MockEl = {
        tagName: tag.toUpperCase(),
        attributes: attrs,
        textContent: text,
        children,
        parentElement: null,
        getAttribute(name: string) { return this.attributes[name] ?? null },
        closest(selectors: string) {
          let cur: MockEl | null = this
          while (cur) {
            if (matchSelectorList(cur, selectors)) return cur
            cur = cur.parentElement
          }
          return null
        },
        querySelector(selectors: string) { return this.querySelectorAll(selectors)[0] ?? null },
        querySelectorAll(selectors: string) {
          const found: MockEl[] = []
          const walk = (node: MockEl) => {
            for (const child of node.children) {
              if (matchSelectorList(child, selectors)) found.push(child)
              walk(child)
            }
          }
          walk(this)
          return found
        },
      }
      for (const c of children) c.parentElement = el
      return el
    }

    const buildDoc = (sidebarLinks: MockEl[]) => {
      const root = makeEl('div', {}, '', [
        makeEl('nav', { 'data-testid': 'left-sidebar' }, '', [
          makeEl('div', { 'aria-label': 'Моя медиатека', 'data-testid': 'rootlist' }, '', sidebarLinks),
        ]),
        makeEl('main', {}, '', [
          makeEl('section', { 'data-testid': 'home-page' }, '', [
            makeEl('div', { 'data-testid': 'component-shelf' }, '', [
              makeEl('a', { href: '/playlist/1111111111111111111111' }, 'ШИПЫ: радио'),
              makeEl('a', { href: '/album/2222222222222222222222' }, 'не смог признаться'),
            ]),
          ]),
        ]),
        makeEl('aside', { 'data-testid': 'now-playing-bar' }, '', [
          makeEl('a', { href: '/playlist/3333333333333333333333' }, 'Now Playing Mix'),
        ]),
      ])
      return {
        cookie: '',
        querySelector: (sel: string) => root.querySelector(sel),
        querySelectorAll: (sel: string) => root.querySelectorAll(sel),
        getElementById: () => null,
      }
    }

    type JobHandle = {
      startJob(key: string, spec: Record<string, unknown>): boolean
      pollJob(key: string): { done: boolean; ok: boolean; data?: unknown; error?: string }
    }

    const runApiJob = async (win: Window & { __nocturneSpotifyLab: JobHandle }, key: string) => {
      win.__nocturneSpotifyLab.startJob(key, { kind: 'api', method: 'GET', path: '/me/playlists?limit=50&offset=0' })
      let result: { done: boolean; ok: boolean; data?: unknown; error?: string } = { done: false, ok: false }
      await vi.waitFor(() => {
        const res = win.__nocturneSpotifyLab.pollJob(key)
        expect(res.done).toBe(true)
        result = res
      })
      return result
    }

    const authHeaders = {
      authorization: 'Bearer ' + 't'.repeat(40),
      'client-token': 'c'.repeat(30),
    }

    // 1. Authoritative empty libraryV3 returns [] even with home/now-playing DOM recommendations present.
    {
      const customFetch = async (input: unknown) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        if (url.includes('/pathfinder/v2/query')) {
          return new Response(JSON.stringify({
            data: {
              me: {
                libraryV3: {
                  __typename: 'LibraryPage',
                  items: [],
                  totalCount: 0,
                  pagingInfo: { limit: 50, offset: 0 },
                },
              },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const doc = buildDoc([])
      const { win } = fixture({}, undefined, undefined, { document: doc, fetch: customFetch })
      await win.fetch('https://open.spotify.com/ping', { headers: authHeaders })
      const job = await runApiJob(win as unknown as Window & { __nocturneSpotifyLab: JobHandle }, 'empty-lib')
      expect(job.ok).toBe(true)
      expect((job.data as { items: unknown[] }).items).toEqual([])
    }

    // 2. Mixed libraryV3 containing AlbumResponseWrapper and PlaylistResponseWrapper keeps only playlists.
    {
      const customFetch = async (input: unknown) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        if (url.includes('/pathfinder/v2/query')) {
          return new Response(JSON.stringify({
            data: {
              me: {
                libraryV3: {
                  __typename: 'LibraryPage',
                  items: [
                    {
                      __typename: 'LibraryItem',
                      item: {
                        __typename: 'AlbumResponseWrapper',
                        data: { uri: 'spotify:album:4444444444444444444444', name: 'Saved Album' },
                      },
                    },
                    {
                      __typename: 'LibraryItem',
                      item: {
                        __typename: 'PlaylistResponseWrapper',
                        data: { uri: 'spotify:playlist:5555555555555555555555', name: 'User Playlist' },
                      },
                    },
                  ],
                  totalCount: 2,
                },
              },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const { win } = fixture({}, undefined, undefined, { document: buildDoc([]), fetch: customFetch })
      await win.fetch('https://open.spotify.com/ping', { headers: authHeaders })
      const job = await runApiJob(win as unknown as Window & { __nocturneSpotifyLab: JobHandle }, 'mixed-lib')
      expect(job.ok).toBe(true)
      const items = (job.data as { items: Array<{ name?: string; uri?: string }> }).items
      expect(items.map(it => it.name)).toEqual(['User Playlist'])
    }

    // 3. When libraryV3 fails without cache, domPlaylists reads ONLY sidebar playlist links (ignoring albums & main/aside),
    //    and rethrows when the sidebar has no playlists instead of falling back to home recommendations.
    {
      const failFetch = async (input: unknown) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        if (url.includes('/pathfinder/')) return new Response('rate limited', { status: 500 })
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      const sidebarDoc = buildDoc([
        makeEl('a', { href: '/album/6666666666666666666666' }, 'Sidebar Album'),
        makeEl('a', { href: '/playlist/7777777777777777777777' }, 'My Sidebar Playlist'),
      ])
      const { win: wSidebar } = fixture({}, undefined, undefined, { document: sidebarDoc, fetch: failFetch })
      await wSidebar.fetch('https://open.spotify.com/ping', { headers: authHeaders })
      const sidebarJob = await runApiJob(wSidebar as unknown as Window & { __nocturneSpotifyLab: JobHandle }, 'dom-sidebar')
      expect(sidebarJob.ok).toBe(true)
      const sidebarItems = (sidebarJob.data as { items: Array<{ id?: string; name?: string; type?: string }> }).items
      expect(sidebarItems).toEqual([
        { id: '7777777777777777777777', name: 'My Sidebar Playlist', images: [], type: 'playlist' },
      ])

      const { win: wEmptySidebar } = fixture({}, undefined, undefined, { document: buildDoc([]), fetch: failFetch })
      await wEmptySidebar.fetch('https://open.spotify.com/ping', { headers: authHeaders })
      const emptySidebarJob = await runApiJob(wEmptySidebar as unknown as Window & { __nocturneSpotifyLab: JobHandle }, 'dom-empty')
      expect(emptySidebarJob.ok).toBe(false)
      expect(emptySidebarJob.error).toContain('HTTP_500')
    }

    // 4. Frontend getMyPlaylists defense-in-depth also strips non-playlist entries returned by the bridge.
    const tauri = await import('../lib/tauri')
    const spy = vi.spyOn(tauri, 'isTauri').mockReturnValue(true)
    const origWin = (globalThis as Record<string, unknown>).window
    const invokeSpy = vi.fn().mockResolvedValueOnce({
      items: [
        { uri: 'spotify:album:8888888888888888888888', name: 'Leaked Album', type: 'album' },
        { uri: 'spotify:playlist:9999999999999999999999', name: 'Real Playlist', type: 'playlist' },
      ],
    })
    ;(globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: { invoke: invokeSpy } }
    try {
      const playlists = await getMyPlaylists()
      expect(playlists.map(p => `${p.type}:${p.title}`)).toEqual(['playlist:Real Playlist'])
    } finally {
      ;(globalThis as Record<string, unknown>).window = origWin
      spy.mockRestore()
    }
  })

  test('GET /browse?uri=spotify:page:... extracts browsePage sections + subcategories and falls back on error', async () => {
    const authHeaders = {
      authorization: 'Bearer ' + 't'.repeat(40),
      'client-token': 'c'.repeat(30),
    }
    const { win } = fixture({}, undefined, undefined, {
      fetch: async (input: unknown, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operationName?: string; variables?: { uri?: string } } : {}
        if (url.includes('/pathfinder/v2/query') && body.operationName === 'browsePage') {
          if (body.variables?.uri === 'spotify:page:fail') return new Response('boom', { status: 500 })
          return new Response(JSON.stringify({
            data: {
              browse: {
                header: { title: { transformedLabel: 'Рок' } },
                sections: {
                  items: [
                    {
                      uri: 'spotify:section:subs',
                      data: { title: { transformedLabel: 'Поджанры' } },
                      sectionItems: {
                        items: [
                          {
                            uri: 'spotify:page:subrock',
                            content: {
                              __typename: 'BrowseSectionContainerWrapper',
                              data: {
                                data: {
                                  cardRepresentation: {
                                    title: { transformedLabel: 'Русский рок' },
                                    backgroundColor: { hex: '#1a2b3c' },
                                    artwork: { sources: [{ url: 'https://i.scdn.co/image/subrock' }] },
                                  },
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                    {
                      uri: 'spotify:section:hits',
                      data: { title: { transformedLabel: 'Лучшее в жанре' } },
                      sectionItems: {
                        items: [
                          {
                            uri: 'spotify:playlist:1111111111111111111111',
                            content: {
                              __typename: 'PlaylistResponseWrapper',
                              data: { uri: 'spotify:playlist:1111111111111111111111', name: 'Rock Classics' },
                            },
                          },
                          {
                            uri: 'spotify:album:2222222222222222222222',
                            content: {
                              __typename: 'AlbumResponseWrapper',
                              data: { uri: 'spotify:album:2222222222222222222222', name: 'Rock LP' },
                            },
                          },
                          {
                            uri: 'spotify:artist:3333333333333333333333',
                            content: {
                              __typename: 'ArtistResponseWrapper',
                              data: { uri: 'spotify:artist:3333333333333333333333', profile: { name: 'Rock Band' } },
                            },
                          },
                          {
                            uri: 'spotify:track:4444444444444444444444',
                            content: {
                              __typename: 'TrackResponseWrapper',
                              data: { uri: 'spotify:track:4444444444444444444444', name: 'Rock Song' },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('/pathfinder/v2/query') && body.operationName === 'searchDesktop') {
          return new Response(JSON.stringify({
            data: {
              searchV2: {
                playlists: { items: [{ data: { uri: 'spotify:playlist:5555555555555555555555', name: 'Fallback Mix' } }] },
                albumsV2: { items: [] },
              },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('/pathfinder/v2/query') && body.operationName === 'fetchPlaylist') {
          return new Response(JSON.stringify({
            data: {
              playlistV2: {
                __typename: 'Playlist',
                content: { items: [{ itemV2: { data: { uri: 'spotify:track:6666666666666666666666', name: 'Fallback Track' } } }] },
              },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await win.fetch('https://open.spotify.com/ping', { headers: authHeaders })
    const lab = win.__nocturneSpotifyLab as unknown as {
      startJob(key: string, spec: Record<string, unknown>): boolean
      pollJob(key: string): { done: boolean; ok: boolean; data?: Record<string, unknown>; error?: string }
    }
    const runJob = async (key: string, path: string) => {
      lab.startJob(key, { kind: 'api', method: 'GET', path })
      let out: { done: boolean; ok: boolean; data?: Record<string, unknown>; error?: string } = { done: false, ok: false }
      await vi.waitFor(() => {
        const res = lab.pollJob(key)
        expect(res.done).toBe(true)
        out = res
      })
      return out
    }

    const pageRes = await runJob('browse-ok', '/browse?q=Rock&uri=spotify%3Apage%3Arock')
    expect(pageRes.ok).toBe(true)
    expect(pageRes.data?.title).toBe('Рок')
    expect(pageRes.data?.subcategories).toEqual([
      { uri: 'spotify:page:subrock', title: 'Русский рок', color: '#1a2b3c', image: 'https://i.scdn.co/image/subrock' },
    ])
    const sections = pageRes.data?.sections as Array<{ title: string; playlists: unknown[]; albums: unknown[]; artists: unknown[]; tracks: unknown[] }>
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBe('Лучшее в жанре')
    expect(sections[0].playlists).toHaveLength(1)
    expect(sections[0].albums).toHaveLength(1)
    expect(sections[0].artists).toHaveLength(1)
    expect(sections[0].tracks).toHaveLength(1)

    // Frontend getBrowseCategory parses structured sections and subcategories cleanly.
    const tauri = await import('../lib/tauri')
    const { getBrowseCategory } = await import('./api')
    const spy = vi.spyOn(tauri, 'isTauri').mockReturnValue(true)
    const origWin = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn().mockResolvedValueOnce(pageRes.data) },
    }
    try {
      const normalized = await getBrowseCategory('Rock', 'rock', 'spotify:page:rock')
      expect(normalized.title).toBe('Рок')
      expect(normalized.subcategories).toHaveLength(1)
      expect(normalized.sections).toHaveLength(1)
      expect(normalized.sections[0].playlists[0]?.title).toBe('Rock Classics')
      expect(normalized.sections[0].tracks[0]?.title).toBe('Rock Song')
    } finally {
      ;(globalThis as Record<string, unknown>).window = origWin
      spy.mockRestore()
    }

    // Fallback to search + fetchPlaylist when browsePage fails.
    const fallbackRes = await runJob('browse-fallback', '/browse?q=%D0%A0%D0%BE%D0%BA&uri=spotify%3Apage%3Afail')
    expect(fallbackRes.ok).toBe(true)
    expect((fallbackRes.data?.playlists as unknown[])?.length).toBeGreaterThan(0)
    expect((fallbackRes.data?.tracks as unknown[])?.length).toBeGreaterThan(0)
  })

  test('uses the current Spotify Web API for library writes when the web player rejects them', async () => {
    const requests: Array<[string | undefined, string | null]> = []
    const { win } = fixture({}, undefined, undefined, {
      fetch: async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        if (url.pathname === '/v1/me/library') {
          requests.push([init?.method, url.searchParams.get('uris')])
          return new Response(null, { status: 200 })
        }
        if (url.pathname === '/pathfinder/v2/query') {
          const body = JSON.parse(String(init?.body ?? '{}'))
          if (body.operationName === 'profileAttributes') return Response.json({ data: {} })
          return new Response(null, { status: 400 })
        }
        return new Response(null, { status: 404 })
      },
    })
    await win.fetch('https://open.spotify.com/ping', {
      headers: { authorization: 'Bearer ' + 't'.repeat(40), 'client-token': 'c'.repeat(30) },
    })
    const lab = win.__nocturneSpotifyLab as unknown as {
      startJob(key: string, spec: Record<string, unknown>): boolean
      pollJob(key: string): { done: boolean; ok: boolean }
    }
    for (const [method, path] of [
      ['PUT', '/me/tracks?ids=3333333333333333333333'],
      ['DELETE', '/playlists/1111111111111111111111/followers'],
    ]) {
      lab.startJob(method, { kind: 'api', method, path })
      await vi.waitFor(() => {
        const result = lab.pollJob(method)
        expect(result.done).toBe(true)
        expect(result.ok).toBe(true)
      })
    }
    expect(requests).toEqual([
      ['PUT', 'spotify:track:3333333333333333333333'],
      ['DELETE', 'spotify:playlist:1111111111111111111111'],
    ])
  })

  test('routes DELETE playlist tracks, PUT/DELETE playlist followers via Rootlist, PUT/DELETE /me/tracks & /me/albums via addToLibrary/removeFromLibrary, and /artists/{id}/related-artists', async () => {
    const authHeaders = {
      authorization: 'Bearer ' + 't'.repeat(40),
      'client-token': 'c'.repeat(30),
    }
    const seenPf: Array<{ op: string; vars: Record<string, unknown> }> = []
    const seenRootlist: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
    const { win } = fixture({}, undefined, undefined, {
      fetch: async (input: unknown, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
        if (url.includes('/pathfinder/v2/query') && typeof body.operationName === 'string') {
          seenPf.push({ op: body.operationName, vars: (body.variables ?? {}) as Record<string, unknown> })
          if (body.operationName === 'profileAttributes') {
            return new Response(JSON.stringify({
              data: { me: { profile: { username: 'tester123', uri: 'spotify:user:tester123' } } },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          if (body.operationName === 'queryArtistRelated') {
            return new Response(JSON.stringify({
              data: {
                artistUnion: {
                  relatedContent: {
                    relatedArtists: { items: [{ uri: 'spotify:artist:7777777777777777777777', profile: { name: 'Peer Artist' } }] },
                  },
                },
              },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('spclient.wg.spotify.com/playlist/v2/user/') && url.includes('/rootlist/changes')) {
          seenRootlist.push({ url, method: (init?.method || 'GET').toUpperCase(), body })
          return new Response(JSON.stringify({ revision: 'rev1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
    await win.fetch('https://open.spotify.com/ping', { headers: authHeaders })
    const lab = win.__nocturneSpotifyLab as unknown as {
      startJob(key: string, spec: Record<string, unknown>): boolean
      pollJob(key: string): { done: boolean; ok: boolean; data?: Record<string, unknown>; error?: string }
    }
    const run = async (key: string, method: string, path: string) => {
      lab.startJob(key, { kind: 'api', method, path })
      let out: { done: boolean; ok: boolean; data?: Record<string, unknown> } = { done: false, ok: false }
      await vi.waitFor(() => {
        const res = lab.pollJob(key)
        expect(res.done).toBe(true)
        out = res
      })
      return out
    }

    const delTrack = await run('del-track', 'DELETE', '/playlists/1111111111111111111111/tracks?uids=uidA,uidB')
    expect(delTrack.ok).toBe(true)
    const putFollow = await run('put-follow', 'PUT', '/playlists/1111111111111111111111/followers')
    expect(putFollow.ok).toBe(true)
    const delFollow = await run('del-follow', 'DELETE', '/playlists/1111111111111111111111/followers')
    expect(delFollow.ok).toBe(true)
    const putLibTrack = await run('put-lib-track', 'PUT', '/me/tracks?ids=3333333333333333333333')
    expect(putLibTrack.ok).toBe(true)
    const delLibTrack = await run('del-lib-track', 'DELETE', '/me/tracks?ids=3333333333333333333333')
    expect(delLibTrack.ok).toBe(true)
    const putLibAlbum = await run('put-lib-album', 'PUT', '/me/albums?ids=4444444444444444444444')
    expect(putLibAlbum.ok).toBe(true)
    const rel = await run('rel-artists', 'GET', '/artists/2222222222222222222222/related-artists')
    expect(rel.ok).toBe(true)
    expect((rel.data?.items as Array<{ profile?: { name?: string } }>)[0]?.profile?.name).toBe('Peer Artist')

    expect(seenPf).toEqual([
      { op: 'removeFromPlaylist', vars: { playlistUri: 'spotify:playlist:1111111111111111111111', uids: ['uidA', 'uidB'] } },
      { op: 'profileAttributes', vars: {} },
      { op: 'addToLibrary', vars: { libraryItemUris: ['spotify:track:3333333333333333333333'], interactionId: null } },
      { op: 'removeFromLibrary', vars: { libraryItemUris: ['spotify:track:3333333333333333333333'] } },
      { op: 'addToLibrary', vars: { libraryItemUris: ['spotify:album:4444444444444444444444'], interactionId: null } },
      { op: 'queryArtistRelated', vars: { uri: 'spotify:artist:2222222222222222222222' } },
    ])
    expect(seenRootlist).toHaveLength(2)
    expect(seenRootlist[0].url).toBe('https://spclient.wg.spotify.com/playlist/v2/user/tester123/rootlist/changes')
    expect(seenRootlist[0].method).toBe('POST')
    expect((seenRootlist[0].body.deltas as Array<{ ops: Array<Record<string, unknown>>; info: unknown }>)[0]).toMatchObject({
      ops: [{
        kind: 'ADD',
        add: {
          addFirst: true,
          items: [{ uri: 'spotify:playlist:1111111111111111111111' }],
        },
      }],
      info: { source: { client: 'WEBPLAYER' } },
    })
    expect((seenRootlist[1].body.deltas as Array<{ ops: Array<Record<string, unknown>>; info: unknown }>)[0]).toMatchObject({
      ops: [{
        kind: 'REM',
        rem: {
          itemsAsKey: true,
          items: [{ uri: 'spotify:playlist:1111111111111111111111' }],
        },
      }],
      info: { source: { client: 'WEBPLAYER' } },
    })

    // Verify frontend helpers issue matching Tauri IPC requests.
    const tauri = await import('../lib/tauri')
    const { removeTrackFromPlaylist, setPlaylistSaved } = await import('./api')
    const spy = vi.spyOn(tauri, 'isTauri').mockReturnValue(true)
    const origWin = (globalThis as Record<string, unknown>).window
    const invokeSpy = vi.fn().mockResolvedValue({ ok: true })
    ;(globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: { invoke: invokeSpy } }
    try {
      await removeTrackFromPlaylist('1111111111111111111111', 'uid A')
      await setPlaylistSaved('1111111111111111111111', true)
      await setPlaylistSaved('1111111111111111111111', false)
      expect(invokeSpy.mock.calls.map(c => c.slice(0, 2))).toEqual([
        ['spotify_status', { request: { kind: 'api', method: 'DELETE', path: '/playlists/1111111111111111111111/tracks?uids=uid%20A' } }],
        ['spotify_status', { request: { kind: 'api', method: 'PUT', path: '/playlists/1111111111111111111111/followers' } }],
        ['spotify_status', { request: { kind: 'api', method: 'DELETE', path: '/playlists/1111111111111111111111/followers' } }],
      ])
    } finally {
      ;(globalThis as Record<string, unknown>).window = origWin
      spy.mockRestore()
    }
  })

  test('normalizes spotifyUid, albumType, monthlyListeners, saved, and country fields', () => {
    const tr = normalizeSpotifyTrack({
      uid: 'row-uid-42',
      itemV2: {
        data: {
          uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
          name: 'Normalized Track',
          duration: { totalMilliseconds: 185000 },
          artists: { items: [{ uri: 'spotify:artist:3333333333333333333333', profile: { name: 'Tester' } }] },
        },
      },
    })
    expect(tr?.spotifyUid).toBe('row-uid-42')

    const single = normalizeSpotifyPlaylist({
      uri: 'spotify:album:1111111111111111111111',
      name: 'My Single',
      _releaseGroup: 'SINGLE',
    })
    const lp = normalizeSpotifyPlaylist({
      uri: 'spotify:album:2222222222222222222222',
      name: 'My LP',
      _releaseGroup: 'ALBUM',
    })
    const comp = normalizeSpotifyPlaylist({
      uri: 'spotify:album:3333333333333333333333',
      name: 'My Comp',
      _releaseGroup: 'COMPILATION',
    })
    expect(single?.albumType).toBe('single')
    expect(lp?.albumType).toBe('album')
    expect(comp?.albumType).toBe('compilation')

    const user = normalizeSpotifyUser({
      uri: 'spotify:artist:3333333333333333333333',
      profile: { name: 'Dutch Artist' },
      stats: { followers: 1200, monthlyListeners: 456789 },
      saved: true,
      country: 'nl',
    })
    expect(user).toMatchObject({
      followers: 1200,
      monthlyListeners: 456789,
      saved: true,
      country: 'NL',
    })
  })

  test('normalizeSpotifyUser extracts avatars from visualIdentity, avatar, cardRepresentation, images.sources and headerImage', () => {
    expect(
      normalizeSpotifyUser({
        uri: 'spotify:artist:1111111111111111111111',
        name: 'Embed Artist',
        visualIdentity: { image: [{ url: 'https://image-cdn-fa.spotifycdn.com/image/embed320', maxWidth: 320 }] },
      })?.avatar,
    ).toBe('https://image-cdn-fa.spotifycdn.com/image/embed320')

    expect(
      normalizeSpotifyUser({
        uri: 'spotify:artist:2222222222222222222222',
        profile: { name: 'Avatar Artist' },
        visuals: { avatar: { sources: [{ url: 'https://i.scdn.co/image/v_avatar', width: 300 }] } },
      })?.avatar,
    ).toBe('https://i.scdn.co/image/v_avatar')

    expect(
      normalizeSpotifyUser({
        uri: 'spotify:artist:3333333333333333333333',
        profile: { name: 'Card Artist' },
        cardRepresentation: { artwork: { sources: [{ url: 'https://i.scdn.co/image/card_art', width: 300 }] } },
      })?.avatar,
    ).toBe('https://i.scdn.co/image/card_art')

    expect(
      normalizeSpotifyUser({
        uri: 'spotify:artist:4444444444444444444444',
        name: 'Sources Object Artist',
        images: { sources: [{ url: 'https://i.scdn.co/image/src_obj', width: 300 }] },
      })?.avatar,
    ).toBe('https://i.scdn.co/image/src_obj')

    expect(
      normalizeSpotifyUser({
        uri: 'spotify:artist:5555555555555555555555',
        profile: { name: 'Header Artist' },
        visuals: { headerImage: { sources: [{ url: 'https://i.scdn.co/image/header_fallback', width: 640 }] } },
      })?.avatar,
    ).toBe('https://i.scdn.co/image/header_fallback')
  })

  test('/me/top/artists hydrates missing track-artist avatars via batch /v1/artists, oEmbed fallback with cooldown, and queryArtistOverview fallback', async () => {
    const authHeaders = {
      authorization: 'Bearer ' + 't'.repeat(40),
      'client-token': 'c'.repeat(30),
    }
    const idFollowed = '1111111111111111111111'
    const idTrackA = '2222222222222222222222'
    const idTrackB = '3333333333333333333333'
    const idTrackC = '4444444444444444444444'

    const baseLibraryV3 = {
      me: {
        libraryV3: {
          items: [
            {
              item: {
                _uri: `spotify:artist:${idFollowed}`,
                __typename: 'ArtistResponseWrapper',
                data: {
                  uri: `spotify:artist:${idFollowed}`,
                  profile: { name: 'Followed Artist' },
                  visuals: { avatarImage: { sources: [{ url: 'https://i.scdn.co/image/followed300', width: 300 }] } },
                },
              },
            },
          ],
        },
      },
    }
    const baseLibraryTracks = {
      me: {
        library: {
          tracks: {
            items: [
              {
                track: {
                  data: {
                    uri: 'spotify:track:9999999999999999999991',
                    artists: {
                      items: [
                        { uri: `spotify:artist:${idFollowed}`, profile: { name: 'Followed Artist' } },
                        { uri: `spotify:artist:${idTrackA}`, profile: { name: 'SXMPRA' } },
                      ],
                    },
                  },
                },
              },
              {
                track: {
                  data: {
                    uri: 'spotify:track:9999999999999999999992',
                    artists: {
                      items: [
                        { uri: `spotify:artist:${idTrackB}`, profile: { name: 'WesGhost' } },
                        { uri: `spotify:artist:${idTrackC}`, profile: { name: 'CORPSE' } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }

    const createRunner = async (customFetch: (url: string, body: { operationName?: string; variables?: Record<string, unknown> }) => Promise<Response>) => {
      const { win } = fixture({}, undefined, undefined, {
        fetch: async (input: unknown, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { operationName?: string; variables?: Record<string, unknown> } : {}
          if (url.includes('/pathfinder/v2/query') && body.operationName) {
            if (body.operationName === 'libraryV3') return new Response(JSON.stringify({ data: baseLibraryV3 }), { status: 200 })
            if (body.operationName === 'fetchLibraryTracks') return new Response(JSON.stringify({ data: baseLibraryTracks }), { status: 200 })
            if (body.operationName === 'home') return new Response(JSON.stringify({ data: { home: { sectionContainer: { sections: { items: [] } } } } }), { status: 200 })
          }
          return customFetch(url, body)
        },
      })
      await win.fetch('https://open.spotify.com/ping', { headers: authHeaders })
      const lab = win.__nocturneSpotifyLab as unknown as {
        startJob(key: string, spec: Record<string, unknown>): boolean
        pollJob(key: string): { done: boolean; ok: boolean; data?: Record<string, unknown> }
      }
      return async (key: string, path: string) => {
        lab.startJob(key, { kind: 'api', method: 'GET', path })
        let out: { done: boolean; ok: boolean; data?: Record<string, unknown> } = { done: false, ok: false }
        await vi.waitFor(() => {
          const res = lab.pollJob(key)
          expect(res.done).toBe(true)
          out = res
        })
        return out
      }
    }

    // 1. Batch /v1/artists?ids=... hydrates all bare track artists on cold boot in 1 call.
    const batchCalls: string[] = []
    const runBatch = await createRunner(async (url) => {
      if (url.startsWith('https://api.spotify.com/v1/artists?ids=')) {
        batchCalls.push(url)
        return new Response(JSON.stringify({
          artists: [
            { id: idTrackA, images: [{ url: 'https://i.scdn.co/image/sxmpra', width: 320 }] },
            { id: idTrackB, images: [{ url: 'https://i.scdn.co/image/wesghost', width: 320 }] },
            { id: idTrackC, images: [{ url: 'https://i.scdn.co/image/corpse', width: 320 }] },
          ],
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const batchRes = await runBatch('top-batch', '/me/top/artists?limit=15')
    expect(batchRes.ok).toBe(true)
    expect(batchCalls).toHaveLength(1)
    expect(batchCalls[0]).not.toContain(idFollowed)
    const batchUsers = (batchRes.data?.items as unknown[]).map(normalizeSpotifyUser).filter(Boolean)
    expect(batchUsers.map((u) => [u?.name, u?.avatar])).toEqual([
      ['Followed Artist', 'https://i.scdn.co/image/followed300'],
      ['SXMPRA', 'https://i.scdn.co/image/sxmpra'],
      ['WesGhost', 'https://i.scdn.co/image/wesghost'],
      ['CORPSE', 'https://i.scdn.co/image/corpse'],
    ])

    // 2. When /v1/artists returns 403, oEmbed resolves missing avatars (A & B), queryArtistOverview resolves C,
    // and repeat calls reuse pfCache without repeating /v1/artists or oEmbed fetches.
    let v1Attempts = 0
    let oembedCalls = 0
    let overviewCalls = 0
    const runFallback = await createRunner(async (url, body) => {
      if (url.startsWith('https://api.spotify.com/v1/artists?ids=')) {
        v1Attempts++
        return new Response('{}', { status: 403 })
      }
      if (url.startsWith('https://open.spotify.com/oembed?url=')) {
        oembedCalls++
        if (url.includes(idTrackA)) return new Response(JSON.stringify({ thumbnail_url: 'https://image-cdn-ak.spotifycdn.com/image/oembed_a', thumbnail_width: 320 }), { status: 200 })
        if (url.includes(idTrackB)) return new Response(JSON.stringify({ thumbnail_url: 'https://image-cdn-fa.spotifycdn.com/image/oembed_b', thumbnail_width: 320 }), { status: 200 })
        return new Response('{}', { status: 404 })
      }
      if (url.includes('/pathfinder/v2/query') && body.operationName === 'queryArtistOverview' && body.variables?.uri === `spotify:artist:${idTrackC}`) {
        overviewCalls++
        return new Response(JSON.stringify({
          data: {
            artistUnion: {
              uri: `spotify:artist:${idTrackC}`,
              profile: { name: 'CORPSE' },
              visuals: { avatarImage: { sources: [{ url: 'https://i.scdn.co/image/overview_c', width: 300 }] } },
            },
          },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const fbRes = await runFallback('top-fallback-1', '/me/top/artists?limit=15')
    expect(fbRes.ok).toBe(true)
    const fbUsers = (fbRes.data?.items as unknown[]).map(normalizeSpotifyUser).filter(Boolean)
    expect(fbUsers.map((u) => [u?.name, u?.avatar])).toEqual([
      ['Followed Artist', 'https://i.scdn.co/image/followed300'],
      ['SXMPRA', 'https://image-cdn-ak.spotifycdn.com/image/oembed_a'],
      ['WesGhost', 'https://image-cdn-fa.spotifycdn.com/image/oembed_b'],
      ['CORPSE', 'https://i.scdn.co/image/overview_c'],
    ])
    expect(v1Attempts).toBe(1)
    expect(oembedCalls).toBe(3)
    expect(overviewCalls).toBe(1)

    // Repeat call uses cache for all 4 artists -> zero extra /v1/artists, oEmbed, or overview calls.
    const fbCachedRes = await runFallback('top-fallback-2', '/me/top/artists?limit=15')
    expect(fbCachedRes.ok).toBe(true)
    expect(v1Attempts).toBe(1)
    expect(oembedCalls).toBe(3)
    expect(overviewCalls).toBe(1)
  })

  test('intercepts g2 regional dealer websockets and ignores lookalike hosts', () => {
    const { win } = fixture()
    const g2 = new win.WebSocket('wss://gew4-dealer.g2.spotify.com/')
    let stateId = ''
    g2.addEventListener('message', (ev) => {
      stateId = JSON.parse((ev as MessageEvent).data).state_machine.states[1].state_id
    })
    g2.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(machine()) }))
    expect(stateId).toBe('next')
    expect(win.__nocturneSpotifyLab.stats().intercepted).toBe(1)
    expect(win.__nocturneSpotifyLab.stats().removed).toBe(1)

    const evil = new win.WebSocket('wss://gew4-dealer.g2.spotify.com.evil.test/')
    let evilStateId = ''
    evil.addEventListener('message', (ev) => {
      evilStateId = JSON.parse((ev as MessageEvent).data).state_machine.states[1].state_id
    })
    evil.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(machine()) }))
    expect(evilStateId).toBe('ad')
    expect(win.__nocturneSpotifyLab.stats().intercepted).toBe(1)
  })

  test('ignores looping Canvas videos and empty ad-slot placeholders so music never mutes or misreports playing', () => {
    class MockMedia extends EventTarget {
      _vol = 1
      _muted = false
      paused = false
      ended = false
      loop = false
      isConnected = false
      tagName = 'VIDEO'
      currentTime = 0
      duration = 180
      playbackRate = 1
      mediaKeys: object | null = null
      buffered = { length: 1, start: () => 0, end: () => 20 }
      get volume() { return this._vol }
      set volume(v: number) { this._vol = v }
      get muted() { return this._muted }
      set muted(m: boolean) { this._muted = m }
      play() { return Promise.resolve() }
      load() {}
    }
    const musicEl = new MockMedia()
    musicEl.paused = true
    musicEl.mediaKeys = {}
    musicEl.duration = 177
    musicEl.buffered = { length: 1, start: () => 0, end: () => 25 }

    const canvasEl = new MockMedia()
    canvasEl.loop = true
    canvasEl.isConnected = true
    canvasEl.paused = false
    canvasEl.duration = 7
    canvasEl.buffered = { length: 1, start: () => 0, end: () => 7 }

    const emptyAdSlot = { childElementCount: 0, textContent: '   ', getAttribute: () => null }
    const doc = {
      querySelector: (sel: string) =>
        sel.includes('[data-testid="ad-slot-container"]') ? emptyAdSlot : null,
      querySelectorAll: (sel: string) => {
        if (sel.includes('ad-slot-container')) return [emptyAdSlot]
        if (sel.replace(/\s+/g, '') === 'audio,video') return [musicEl, canvasEl]
        return []
      },
      createElement: (tag: string) => {
        const el = new MockMedia()
        el.tagName = tag.toUpperCase()
        return el
      },
    }
    const { win } = fixture({}, undefined, undefined, { document: doc, HTMLMediaElement: MockMedia })
    const lab = win.__nocturneSpotifyLab as unknown as {
      playing(): boolean | null
      setVolume(vol: number, muted?: boolean): boolean
    }

    // Canvas video stays muted when Spotify mutes it, while unmuted volume applies to musicEl.
    canvasEl.muted = true
    expect(canvasEl._muted).toBe(true)
    expect(lab.setVolume(0.45, false)).toBe(true)
    expect(musicEl._vol).toBeCloseTo(0.45, 3)
    expect(musicEl._muted).toBe(false)
    expect(canvasEl._muted).toBe(true)

    // Paused music element must NOT be masked as playing=true by a playing Canvas loop.
    expect(lab.playing()).toBe(false)
  })

  test('retries transient "No such device." during playTrack and allows play control when playing() is null', async () => {
    let attempts = 0
    const controller = {
      playURI: async () => {
        attempts++
        if (attempts < 3) throw new Error('No such device.')
      },
    }
    let clicks = 0
    const doc = {
      querySelector: (sel: string) =>
        sel === '[data-testid="control-button-playpause"]'
          ? { disabled: false, click: () => { clicks++ } }
          : null,
      querySelectorAll: () => [],
    }
    const { win } = fixture({}, undefined, undefined, { document: doc })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): { startPending?: boolean; lastPlayError?: string; lastPlayMethod?: string }
      playTrack(id: string, startAt?: number, vol?: number, muted?: boolean): boolean
      control(action: string, value?: number): boolean
      playing(): boolean | null
    }
    expect(lab.playing()).toBeNull()
    expect(lab.control('play')).toBe(true)
    expect(clicks).toBe(1)

    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    host._harmony = {
      playTracks: async () => { if (attempts < 3) throw new Error('No such device.') },
      _controller: controller,
    }

    expect(lab.playTrack('4cOdK2wGLETKBW3PvgPWqT', 0, 0.5, false)).toBe(true)
    expect(lab.stats().startPending).toBe(true)
    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 2500 })
    await vi.waitFor(() => expect(lab.stats().startPending).toBe(false), { timeout: 1000 })
    expect(lab.stats().lastPlayMethod).toBe('harmony.playURI')
    expect(lab.stats().lastPlayError).toBe('')

    // Explicitly pausing while a retry is pending cancels startPending without clicking Play.
    attempts = 0
    expect(lab.playTrack('4cOdK2wGLETKBW3PvgPWqT', 0, 0.5, false)).toBe(true)
    expect(lab.stats().startPending).toBe(true)
    expect(lab.control('pause')).toBe(true)
    expect(lab.stats().startPending).toBe(false)
    expect(clicks).toBe(1)
  })

  test('plays via harmonyPlayer.playURI with local device (null) and shuffle=false, falling back to context playURI and collecting diagnostics', async () => {
    const calls: Array<{ fn: string; uri: unknown; dev: unknown; opts: Record<string, unknown> }> = []
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    const { win } = fixture()
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): { lastPlayMethod?: string; capped?: boolean; disallowNext?: boolean; lastShuffle?: boolean | null }
      takeDiagnostics(): string[]
      control(action: string): boolean
      playTrack(
        id: string,
        startAt?: number,
        vol?: number,
        muted?: boolean,
        context?: { contextUri?: string; albumId?: string; trackUid?: string; preferContext?: boolean },
      ): boolean
    }

    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    host._harmony = {
      addListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) ?? []
        list.push(fn)
        listeners.set(ev, list)
      },
      playURI: async (uri: unknown, dev: unknown, opts: Record<string, unknown>) => {
        calls.push({ fn: 'harmony.playURI', uri, dev, opts })
        if (uri === 'spotify:track:4cOdK2wGLETKBW3PvgPWqT') {
          throw new Error('SINGLE_TRACK_BLOCKED')
        }
      },
      playTracks: async (uris: unknown, dev: unknown, opts: Record<string, unknown>) => {
        calls.push({ fn: 'harmony.playTracks', uri: uris, dev, opts })
      },
      _controller: {
        playURI: async (uri: unknown, dev: unknown, opts: Record<string, unknown>) => {
          calls.push({ fn: 'ctrl.playURI', uri, dev, opts })
        },
      },
    }

    expect(
      lab.playTrack('4cOdK2wGLETKBW3PvgPWqT', 12, 0.7, false, {
        contextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
        trackUid: 'uid123',
      }),
    ).toBe(true)

    await vi.waitFor(() => expect(calls.some((c) => c.uri === 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toBe(true), { timeout: 1500 })
    // Single-track attempt tried harmony.playURI with local device `null` and explicit `shuffle: false`.
    expect(calls[0]).toMatchObject({
      fn: 'harmony.playURI',
      uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
      dev: null,
      opts: { shuffle: false, repeatMode: 0, initialOffset: 12000 },
    })
    // Rejected single-track play falls back directly to playlist context + skipTo trackURI/trackUID.
    const ctxCall = calls.find((c) => c.uri === 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')
    expect(ctxCall).toMatchObject({
      fn: 'harmony.playURI',
      dev: null,
      opts: {
        contextURI: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
        trackURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
        trackUID: 'uid123',
        shuffle: false,
      },
    })
    expect(lab.stats().lastPlayMethod).toBe('harmony.contextPlayURI')

    for (const fn of listeners.get('playback_capped') ?? []) fn({})
    for (const fn of listeners.get('state_changed') ?? []) {
      fn({ data: { state: { shuffle_mode: true, disallows: { skipping_next: true } } } })
    }
    expect(lab.stats().capped).toBe(true)
    expect(lab.stats().disallowNext).toBe(true)
    expect(lab.stats().lastShuffle).toBe(true)
    const diag = lab.takeDiagnostics()
    expect(diag.some((line) => line.includes('SINGLE_TRACK_BLOCKED'))).toBe(true)
    expect(diag.some((line) => line.includes('playback_capped'))).toBe(true)
    expect(lab.takeDiagnostics()).toEqual([])
    lab.control('pause')
  })

  test('dom fallback never clicks a pre-navigation Home play button before /track/<id> renders', async () => {
    let homeClicks = 0
    let trackClicks = 0
    const loc = { origin: 'https://open.spotify.com', pathname: '/' }
    const doc = {
      querySelector: (sel: string) => {
        if (sel === '[data-testid="action-bar-row"] [data-testid="play-button"]' && loc.pathname === '/track/4cOdK2wGLETKBW3PvgPWqT') {
          return { disabled: false, click: () => { trackClicks++ } }
        }
        if (sel.includes('main [data-testid="play-button"]') && loc.pathname === '/') {
          return { disabled: false, click: () => { homeClicks++ } }
        }
        return null
      },
      querySelectorAll: () => [],
    }
    const history = {
      state: { idx: 0 },
      pushState: (_s: unknown, _t: string, url: string) => {
        // Delay DOM route render slightly to simulate real SPA navigation.
        setTimeout(() => { loc.pathname = url }, 120)
      },
    }
    const { win } = fixture({}, undefined, undefined, {
      location: loc,
      document: doc,
      history,
      PopStateEvent: class extends Event {},
      dispatchEvent: () => true,
    })
    const lab = win.__nocturneSpotifyLab as unknown as {
      playTrack(id: string, startAt?: number, vol?: number, muted?: boolean): boolean
      control(action: string): boolean
    }
    expect(lab.playTrack('4cOdK2wGLETKBW3PvgPWqT', 0, 0.5, false)).toBe(true)
    await vi.waitFor(() => expect(trackClicks).toBe(1), { timeout: 1500 })
    expect(homeClicks).toBe(0)
    lab.control('pause')
  })

  test('harmonyPositionSec uses Spotify _serverTime (and state_changed anchor) so PC clock skew never jumps lyrics/progress forward', () => {
    const skewMs = 3350
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    const mediaSession = { playbackState: 'playing', metadata: { title: 'CURSED', artist: 'WesGhost', album: 'Single', artwork: [] } }
    const doc = {
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    const { win } = fixture({}, undefined, undefined, { document: doc, navigator: { mediaSession } })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): Record<string, unknown>
      nowPlaying(): { position: number; duration: number } | null
    }

    const baseLocal = Date.now()
    let srvNow = baseLocal - skewMs
    const hState = {
      duration: 140000,
      position: 80110,
      timestamp: srvNow,
      paused: false,
      loading: false,
      playback_speed: 1,
      track_window: { current_track: { uri: 'spotify:track:2gk9ByA1PmGJxdCs5s4kyQ' } },
    }
    const srvClock: { _serverTime: number; _serverTimeFetchedAt: number | null; getApproximate: () => number } = {
      _serverTime: srvNow,
      _serverTimeFetchedAt: 1000,
      getApproximate: () => srvNow,
    }
    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    host._harmony = {
      playTracks: async () => {},
      addListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) ?? []
        list.push(fn)
        listeners.set(ev, list)
      },
      _controller: {
        _state: hState,
        _serverTime: srvClock,
        playURI: async () => {},
      },
    }

    // 1. Primary path: synced _serverTime prevents +3.35s local PC clock jump when playback resumes.
    const np0 = lab.nowPlaying()
    expect(np0?.position).toBeCloseTo(80.11, 1)
    srvNow += 250
    expect(lab.nowPlaying()?.position).toBeCloseTo(80.36, 1)

    // 2. Fallback path: if _serverTime has not synced yet (_serverTimeFetchedAt === null), state_changed anchors timestamp locally.
    srvClock._serverTimeFetchedAt = null
    const freshSrvTs = Date.now() - skewMs
    hState.position = 80110
    hState.timestamp = freshSrvTs
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })
    const npAnchor = lab.nowPlaying()
    expect(npAnchor?.position).toBeGreaterThanOrEqual(80.1)
    expect(npAnchor?.position).toBeLessThan(80.5)
  })

  test('harmony trackEnded detects end-of-track pause and snap-to-zero and resets on seek or resume', () => {
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    const mediaSession = { playbackState: 'playing', metadata: { title: 'End Check', artist: 'Artist', album: 'Single', artwork: [] } }
    const doc = { querySelector: () => null, querySelectorAll: () => [] }
    const { win } = fixture({}, undefined, undefined, { document: doc, navigator: { mediaSession } })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): Record<string, unknown>
      nowPlaying(): { trackEnded?: boolean } | null
      control(action: string, value?: number): boolean
    }
    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    const hState = {
      duration: 180000,
      position: 177500,
      timestamp: Date.now(),
      paused: false,
      loading: false,
      playback_speed: 1,
      track_window: { current_track: { uri: 'spotify:track:2gk9ByA1PmGJxdCs5s4kyQ' } },
    }
    host._harmony = {
      playTracks: async () => {},
      addListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) ?? []
        list.push(fn)
        listeners.set(ev, list)
      },
      _controller: { _state: hState, seek: () => {} },
    }

    const emitState = (patch: Partial<typeof hState>) => {
      Object.assign(hState, patch)
      for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })
    }

    emitState({ position: 177500, paused: false })
    expect(lab.stats().trackEnded).toBe(false)

    emitState({ position: 179000, paused: true })
    expect(lab.stats().trackEnded).toBe(false)
    emitState({ position: 179500, paused: false })

    // Spotify stops and snaps position back to 0 when track completes.
    emitState({ position: 0, paused: true })
    expect(lab.stats().trackEnded).toBe(true)
    expect(lab.nowPlaying()?.trackEnded).toBe(true)

    expect(lab.control('seek', 12)).toBe(true)
    expect(lab.stats().trackEnded).toBe(false)
  })

  test('silences and pauses an unexpected auto-advanced track at desired track end, then restores sound on next playTrack', async () => {
    class MockMedia extends EventTarget {
      _vol = 1
      _muted = false
      paused = false
      ended = false
      loop = false
      isConnected = false
      tagName = 'AUDIO'
      currentTime = 176
      duration = 180
      playbackRate = 1
      mediaKeys: object | null = {}
      buffered = { length: 1, start: () => 0, end: () => 180 }
      get volume() { return this._vol }
      set volume(v: number) { this._vol = v }
      get muted() { return this._muted }
      set muted(m: boolean) { this._muted = m }
      play() { this.paused = false; return Promise.resolve() }
      load() {}
    }
    const musicEl = new MockMedia()
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    let pauseCalls = 0
    const doc = {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => new MockMedia(),
    }
    const { win } = fixture({}, undefined, undefined, { document: doc, HTMLMediaElement: MockMedia })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): { trackEnded?: boolean; endedTrackId?: string; startPending?: boolean }
      nowPlaying(): { trackEnded?: boolean; endedTrackId?: string | null } | null
      playTrack(id: string, startAt?: number, vol?: number, muted?: boolean): boolean
    }
    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    const trackA = '13qpCQkqSTI37Um7UyOBBt'
    const trackAutoplay = '9999999999999999999999'
    const trackNext = '612QrhJo7loQ6s7qC7dMdF'
    const hState = {
      duration: 180000,
      position: 176000,
      timestamp: Date.now(),
      paused: false,
      loading: false,
      playback_speed: 1,
      track_window: { current_track: { uri: `spotify:track:${trackA}`, name: 'My Roots' }, previous_tracks: [] as Array<{ uri: string }> },
    }
    host._harmony = {
      playTracks: async () => {},
      addListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) ?? []
        list.push(fn)
        listeners.set(ev, list)
      },
      playURI: async () => {},
      pause: () => { pauseCalls++ },
      _controller: { _state: hState, playURI: async () => {}, pause: () => { pauseCalls++ } },
    }

    musicEl.play()
    expect(lab.playTrack(trackA, 0, 0.7, false)).toBe(true)
    await vi.waitFor(() => expect(lab.stats().startPending).toBe(false), { timeout: 1000 })

    // Desired track plays near end
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })
    expect(lab.stats().trackEnded).toBe(false)
    expect(musicEl._muted).toBe(false)

    // Spotify's internal Web Player auto-advances to an unwanted track before poll runs
    hState.track_window = {
      current_track: { uri: `spotify:track:${trackAutoplay}`, name: 'Guitar Bleed' },
      previous_tracks: [{ uri: `spotify:track:${trackA}` }],
    }
    hState.position = 120
    hState.paused = false
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })

    expect(pauseCalls).toBe(1)
    expect(musicEl._muted).toBe(true)
    expect(lab.stats().trackEnded).toBe(true)
    expect(lab.stats().endedTrackId).toBe(trackA)

    // Advancing to the queued track clears bleed mute and restores volume
    expect(lab.playTrack(trackNext, 0, 0.7, false)).toBe(true)
    expect(musicEl._muted).toBe(false)
    expect(musicEl._vol).toBeCloseTo(0.7, 3)
    expect(lab.stats().trackEnded).toBe(false)
  })

  test('retains active EME audio element across many canvas video creations and falls back to harmony track metadata', () => {
    class MockMedia extends EventTarget {
      _vol = 1
      _muted = false
      paused = true
      ended = false
      loop = false
      isConnected = false
      tagName = 'AUDIO'
      currentTime = 14
      duration = 202
      playbackRate = 1
      mediaKeys: object | null = null
      buffered = { length: 1, start: () => 0, end: () => 60 }
      get volume() { return this._vol }
      set volume(v: number) { this._vol = v }
      get muted() { return this._muted }
      set muted(m: boolean) { this._muted = m }
      play() { this.paused = false; return Promise.resolve() }
      load() {}
    }
    const musicEl = new MockMedia()
    musicEl.mediaKeys = {}
    const doc = {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag: string) => {
        const el = new MockMedia()
        el.tagName = tag.toUpperCase()
        el.loop = el.tagName === 'VIDEO'
        el.duration = el.tagName === 'VIDEO' ? 7 : 0
        return el
      },
    }
    const { win } = fixture({}, undefined, undefined, {
      document: doc,
      HTMLMediaElement: MockMedia,
      navigator: { mediaSession: { playbackState: 'none', metadata: null } },
    })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): Record<string, unknown>
      playing(): boolean | null
      nowPlaying(): { trackId: string | null; title: string; artist: string; paused: boolean; position: number } | null
    }
    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    const hState = {
      duration: 202000,
      position: 14000,
      timestamp: Date.now(),
      paused: false,
      loading: false,
      playback_speed: 1,
      track_window: {
        current_track: {
          uri: 'spotify:track:612QrhJo7loQ6s7qC7dMdF',
          name: 'With Me',
          artists: [{ name: 'weeklyn' }, { name: 'Jaysset' }],
          album: { name: 'With Me', images: [{ url: 'https://i.scdn.co/image/abc', width: 300 }] },
        },
      },
    }
    host._harmony = { playTracks: async () => {}, _controller: { _state: hState } }

    musicEl.play()
    for (let i = 0; i < 60; i++) {
      doc.createElement('video')
    }

    expect(lab.playing()).toBe(true)
    const np = lab.nowPlaying()
    expect(np).toMatchObject({
      trackId: '612QrhJo7loQ6s7qC7dMdF',
      title: 'With Me',
      artist: 'weeklyn, Jaysset',
      paused: false,
    })
    expect(np!.position).toBeGreaterThanOrEqual(14)
  })

  test('does not report playing when audio/harmony ended even if mediaSession stays playing, and preserves bleed end across follow-up frames or pause+resume', async () => {
    class MockMedia extends EventTarget {
      _vol = 1
      _muted = false
      paused = false
      ended = false
      loop = false
      isConnected = false
      tagName = 'AUDIO'
      currentTime = 297
      duration = 298
      playbackRate = 1
      mediaKeys: object | null = {}
      buffered = { length: 1, start: () => 0, end: () => 298 }
      get volume() { return this._vol }
      set volume(v: number) { this._vol = v }
      get muted() { return this._muted }
      set muted(m: boolean) { this._muted = m }
      play() { this.paused = false; this.ended = false; return Promise.resolve() }
      load() {}
    }
    const musicEl = new MockMedia()
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    const mediaSession = { playbackState: 'playing', metadata: { title: 'My Roots', artist: 'Lil Bo Weep', album: 'SOLOS 2', artwork: [] } }
    const doc = { querySelector: () => null, querySelectorAll: () => [] }
    const { win } = fixture({}, undefined, undefined, {
      document: doc,
      HTMLMediaElement: MockMedia,
      navigator: { mediaSession },
    })
    const lab = win.__nocturneSpotifyLab as unknown as {
      stats(): { trackEnded?: boolean; endedTrackId?: string; startPending?: boolean }
      playing(): boolean | null
      nowPlaying(): { trackEnded?: boolean; endedTrackId?: string | null; paused?: boolean } | null
      playTrack(id: string, startAt?: number, vol?: number, muted?: boolean): boolean
      control(action: string, value?: number): boolean
    }
    const trackA = '13qpCQkqSTI37Um7UyOBBt'
    const trackBleed = '9999999999999999999999'
    const hState = {
      duration: 298000,
      position: 297000,
      timestamp: Date.now(),
      paused: false,
      loading: false,
      playback_speed: 1,
      track_window: { current_track: { uri: `spotify:track:${trackA}`, name: 'My Roots' }, previous_tracks: [] as Array<{ uri: string }> },
    }
    const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
    host._harmony = {
      playTracks: async () => {},
      addListener: (ev: string, fn: (e: unknown) => void) => {
        const list = listeners.get(ev) ?? []
        list.push(fn)
        listeners.set(ev, list)
      },
      playURI: async () => {},
      pause: () => {},
      resume: () => { musicEl.paused = false; hState.paused = false },
      _controller: { _state: hState, playURI: async () => {}, pause: () => {}, resume: () => {} },
    }

    musicEl.play()
    expect(lab.playTrack(trackA, 0, 0.7, false)).toBe(true)
    await vi.waitFor(() => expect(lab.stats().startPending).toBe(false), { timeout: 1000 })

    // Pausing and resuming keeps trackA protected from end-of-track autoplay bleed.
    expect(lab.control('pause')).toBe(true)
    musicEl.paused = true
    hState.paused = true
    expect(lab.playing()).toBe(false)
    expect(lab.control('play')).toBe(true)
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })

    // If audio element hits EOF and pauses while mediaSession lags 'playing', playing() is false.
    musicEl.paused = true
    musicEl.ended = true
    expect(lab.playing()).toBe(false)
    expect(lab.nowPlaying()?.trackEnded).toBe(true)

    // Reset ended and test follow-up advancing frames from an unwanted autoplay track.
    expect(lab.control('seek', 295)).toBe(true)
    musicEl.play()
    hState.paused = false
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })

    hState.track_window = {
      current_track: { uri: `spotify:track:${trackBleed}`, name: 'Guitar Bleed' },
      previous_tracks: [{ uri: `spotify:track:${trackA}` }],
    }
    hState.position = 100
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })
    hState.position = 250
    for (const fn of listeners.get('state_changed') ?? []) fn({ data: { state: hState } })

    expect(lab.stats().trackEnded).toBe(true)
    expect(lab.stats().endedTrackId).toBe(trackA)
    expect(lab.playing()).toBe(false)
    expect(lab.nowPlaying()?.paused).toBe(true)
  })
})
