import { artworkAccent, toCss } from '../lib/color'
import { EV, type IslandWave, type PlayerCommand, type PlayerSnapshot } from '../lib/events'
import { useSettings, type IslandSettings } from '../lib/settings'
import { emitTo, invoke, isTauri, listen } from '../lib/tauri'
import { usePlayer, type PlayerState } from './store'
import { useTogether } from '../together/session'
import { useWaveform } from './waveformStore'
import { runCommand, type BridgeActions } from './commands'
import { useSpotify } from '../spotify/runtime'
export { runCommand } from './commands'

let accent: string | null = null
let artworkColor: string | null = null
let bridgesStarted = false
const SPOTIFY_GREEN = '#1ed760'

/** While Spotify is the player, the island shows its track instead of the paused VK/SC one. */
function spotifySnapshot(s: PlayerState): PlayerSnapshot | null {
  const sp = useSpotify.getState()
  const t = sp.track
  if (!sp.owner || !t) return null
  return {
    track: { key: `spotify:${t.title}\u0000${t.artist}`, title: t.title, artist: t.artist, cover: t.cover, coverLarge: t.coverLarge, explicit: false, liked: t.liked === true, duration: t.duration },
    isPlaying: sp.playing,
    isLoading: false,
    position: t.position,
    at: sp.at,
    duration: t.duration,
    volume: t.volume ?? s.volume,
    muted: false,
    shuffle: t.shuffle,
    repeat: t.repeat,
    accent: useSettings.getState().accent !== 'auto' ? accent : SPOTIFY_GREEN,
    together: null,
  }
}

function snapshot(s: PlayerState): PlayerSnapshot {
  const spotify = spotifySnapshot(s)
  if (spotify) return spotify
  const t = s.current
  return {
    track: t
      ? { key: t.key, title: t.title, artist: t.artist, cover: t.cover?.s, coverLarge: t.cover?.l, explicit: t.explicit, liked: t.liked, duration: t.duration }
      : null,
    isPlaying: s.isPlaying,
    isLoading: s.isLoading,
    position: s.position,
    at: Date.now(),
    duration: s.duration || t?.duration || 0,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    accent,
    together: togetherSnapshot(),
  }
}

function togetherSnapshot(): PlayerSnapshot['together'] {
  const t = useTogether.getState()
  if (!t.role || t.phase === 'connecting') return null
  return { role: t.role, listeners: t.listeners.length, hostName: t.hostName }
}

/** Artwork color unless the user pinned an accent in settings. */
function applyAccent(fromArtwork: string | null) {
  artworkColor = fromArtwork
  const fixed = useSettings.getState().accent
  accent = fixed !== 'auto' ? fixed : fromArtwork
  document.documentElement.style.setProperty('--accent', accent ?? '#ff375f')
}

/** Wires the player to the island window, Windows SMTC, MediaSession and accent color. */
export function startBridges(actions: BridgeActions) {
  if (bridgesStarted) return
  bridgesStarted = true
  let lastKey = ''
  let lastCover = ''
  let accentSeq = 0
  let lastEmit = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const coverOf = (s: PlayerState) => s.current?.cover?.m || s.current?.cover?.l || s.current?.cover?.s || ''

  const pushIsland = () => {
    clearTimeout(pending)
    if (!useSettings.getState().island.enabled) return
    lastEmit = Date.now()
    void emitTo('island', EV.playerState, snapshot(usePlayer.getState())).catch(() => {})
  }
  const scheduleIsland = () => {
    if (!useSettings.getState().island.enabled) return
    const wait = 120 - (Date.now() - lastEmit)
    if (wait <= 0) pushIsland()
    else {
      clearTimeout(pending)
      pending = setTimeout(pushIsland, wait)
    }
  }

  const syncAccentForCurrent = (s: PlayerState) => {
    const key = s.current?.key ?? ''
    const cover = coverOf(s)
    lastKey = key
    lastCover = cover
    const seq = ++accentSeq
    if (!cover) {
      applyAccent(null)
      pushIsland()
      return
    }
    void artworkAccent(cover).then((rgb) => {
      const cur = usePlayer.getState()
      if (seq !== accentSeq || (cur.current?.key ?? '') !== key || coverOf(cur) !== cover) return
      applyAccent(rgb ? toCss(rgb) : null)
      pushIsland()
    })
  }

  const pushSmtc = (s: PlayerState) => {
    if (!isTauri()) return
    const sp = useSpotify.getState()
    if (sp.owner && sp.track) {
      const t = sp.track
      void invoke('media_update', { update: { title: t.title, artist: t.artist, album: t.album, coverUrl: t.coverLarge ?? null, duration: t.duration, position: t.position, playing: sp.playing } }).catch(() => {})
      return
    }
    const t = s.current
    void invoke('media_update', {
      update: t
        ? { title: t.title, artist: t.artist, album: t.album?.title ?? '', coverUrl: t.cover?.l ?? null, duration: s.duration || t.duration, position: s.position, playing: s.isPlaying }
        : null,
    }).catch(() => {})
  }

  const pushMediaSession = (s: PlayerState) => {
    if (!('mediaSession' in navigator)) return
    const sp = useSpotify.getState()
    if (sp.owner && sp.track) {
      const t = sp.track
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.coverLarge ? [{ src: t.coverLarge }] : [] })
      navigator.mediaSession.playbackState = sp.playing ? 'playing' : 'paused'
      return
    }
    const t = s.current
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album?.title ?? '', artwork: t.cover ? [{ src: t.cover.l, sizes: '600x600' }] : [] })
      : null
    navigator.mediaSession.playbackState = s.isPlaying ? 'playing' : 'paused'
  }

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => runCommand({ type: 'play' }, actions))
    ms.setActionHandler('pause', () => runCommand({ type: 'pause' }, actions))
    ms.setActionHandler('nexttrack', () => runCommand({ type: 'next' }, actions))
    ms.setActionHandler('previoustrack', () => runCommand({ type: 'prev' }, actions))
    ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && runCommand({ type: 'seek', value: d.seekTime }, actions))
  }

  usePlayer.subscribe((s, prev) => {
    const key = s.current?.key ?? ''
    const cover = coverOf(s)
    if (key !== lastKey || cover !== lastCover) {
      syncAccentForCurrent(s)
      pushMediaSession(s)
      pushSmtc(s)
      pushIsland()
      return
    }
    const jumped = Math.abs(s.position - prev.position) > 1.5
    const meaningful =
      s.isPlaying !== prev.isPlaying ||
      s.isLoading !== prev.isLoading ||
      s.duration !== prev.duration ||
      s.volume !== prev.volume ||
      s.muted !== prev.muted ||
      s.shuffle !== prev.shuffle ||
      s.repeat !== prev.repeat ||
      s.current?.liked !== prev.current?.liked ||
      jumped
    if (meaningful) {
      scheduleIsland()
      if (s.isPlaying !== prev.isPlaying) {
        pushMediaSession(s)
      }
      if (s.isPlaying !== prev.isPlaying || jumped || s.duration !== prev.duration) {
        pushSmtc(s)
      }
    }
  })

  useTogether.subscribe((t, prev) => {
    if (t.role !== prev.role || t.phase !== prev.phase || t.hostName !== prev.hostName || t.listeners.length !== prev.listeners.length) pushIsland()
  })

  useSpotify.subscribe((sp, prev) => {
    const t = sp.track, p = prev.track
    const changed = sp.owner !== prev.owner || sp.playing !== prev.playing || t?.title !== p?.title || t?.artist !== p?.artist || t?.coverLarge !== p?.coverLarge || t?.duration !== p?.duration
    if (changed) {
      const s = usePlayer.getState()
      pushMediaSession(s)
      pushSmtc(s)
      pushIsland()
      return
    }
    if (!sp.owner || !t || !p) return
    // A seek or a stall: the reading moved away from where the island expects it.
    const expected = p.position + (prev.playing ? (sp.at - prev.at) / 1000 : 0)
    if (Math.abs(t.position - expected) > 1.5 || t.liked !== p.liked || t.shuffle !== p.shuffle || t.repeat !== p.repeat || t.volume !== p.volume) {
      scheduleIsland()
      if (Math.abs(t.position - expected) > 1.5) pushSmtc(usePlayer.getState())
    }
  })

  // Heartbeat keeps the island's interpolation honest while playing.
  setInterval(() => {
    if (!useSettings.getState().island.enabled) return
    const sp = useSpotify.getState()
    if (usePlayer.getState().isPlaying || (sp.owner && sp.playing)) pushIsland()
  }, 2000)

  applyAccent(null)
  const initialPlayer = usePlayer.getState()
  if (initialPlayer.current) {
    syncAccentForCurrent(initialPlayer)
    pushMediaSession(initialPlayer)
    pushSmtc(initialPlayer)
  }
  const pushIslandSettings = () => void emitTo('island', EV.islandSettings, useSettings.getState().island).catch(() => {})
  pushIslandSettings()
  useSettings.subscribe((st, prev) => {
    if (st.island !== prev.island) {
      pushIslandSettings()
      if (st.island.enabled && !prev.island.enabled) {
        pushIsland()
        pushWave()
      }
    }
    if (st.accent === prev.accent) return
    applyAccent(artworkColor)
    pushIsland()
  })

  void listen<PlayerCommand>(EV.playerCommand, (e) => runCommand(e.payload, actions))
  void listen<Partial<IslandSettings>>(EV.islandSet, (e) => {
    const { position, locked } = e.payload
    useSettings.getState().updateIsland({ ...(position !== undefined ? { position } : {}), ...(locked !== undefined ? { locked } : {}) })
  })
  // The island draws the same waveform: send it whenever it fills in (at most ~3 times a second)
  let waveTimer: ReturnType<typeof setTimeout> | undefined
  const pushWave = () => {
    clearTimeout(waveTimer)
    if (!useSettings.getState().island.enabled) return
    const { key, peaks } = useWaveform.getState()
    const color = useSettings.getState().waveColor
    const wave: IslandWave = { key, peaks: peaks ? Array.from(peaks, (v) => Math.round(v * 1000) / 1000) : null, color: color === 'accent' ? null : color }
    void emitTo('island', EV.islandWave, wave).catch(() => {})
  }
  const pushWaveSoon = () => {
    clearTimeout(waveTimer)
    if (!useSettings.getState().island.enabled) return
    waveTimer = setTimeout(pushWave, 300)
  }
  useWaveform.subscribe(pushWaveSoon)
  useSettings.subscribe((st, prev) => {
    if (st.waveColor !== prev.waveColor) pushWave()
  })

  void listen(EV.requestState, () => {
    pushIslandSettings()
    pushIsland()
    pushWave()
  })
}
