import { artworkAccent, toCss } from '../lib/color'
import { EV, type PlayerCommand, type PlayerSnapshot } from '../lib/events'
import { useSettings } from '../lib/settings'
import { emitTo, invoke, isTauri, listen } from '../lib/tauri'
import { usePlayer, type PlayerState } from './store'

let accent: string | null = null
let artworkColor: string | null = null

function snapshot(s: PlayerState): PlayerSnapshot {
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
  }
}

export interface BridgeActions {
  toggleLike(): void
  showWindow(): void
}

/** Runs one player command, whoever sent it (island, tray, hotkey, media keys). */
export function runCommand(cmd: PlayerCommand, actions: BridgeActions) {
  const p = usePlayer.getState()
  switch (cmd.type) {
    case 'toggle':
      return p.toggle()
    case 'play':
      return p.play()
    case 'pause':
      return p.pause()
    case 'next':
      return p.next(true)
    case 'prev':
      return p.prev()
    case 'toggleShuffle':
      return p.toggleShuffle()
    case 'cycleRepeat':
      return p.cycleRepeat()
    case 'toggleMute':
      return p.toggleMute()
    case 'toggleLike':
      return actions.toggleLike()
    case 'showWindow':
      return actions.showWindow()
    case 'seek':
      return p.seek(cmd.value)
    case 'seekBy':
      return p.seekBy(cmd.value)
    case 'volume':
      return p.setVolume(cmd.value)
    case 'volumeBy':
      return p.nudgeVolume(cmd.value)
  }
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
  let lastKey = ''
  let lastEmit = 0
  let pending: ReturnType<typeof setTimeout> | undefined

  const pushIsland = () => {
    clearTimeout(pending)
    lastEmit = Date.now()
    void emitTo('island', EV.playerState, snapshot(usePlayer.getState()))
  }
  const scheduleIsland = () => {
    const wait = 120 - (Date.now() - lastEmit)
    if (wait <= 0) pushIsland()
    else {
      clearTimeout(pending)
      pending = setTimeout(pushIsland, wait)
    }
  }

  const pushSmtc = (s: PlayerState) => {
    if (!isTauri()) return
    const t = s.current
    void invoke('media_update', {
      update: t
        ? { title: t.title, artist: t.artist, album: t.album?.title ?? '', coverUrl: t.cover?.l ?? null, duration: s.duration || t.duration, position: s.position, playing: s.isPlaying }
        : null,
    }).catch(() => {})
  }

  const pushMediaSession = (s: PlayerState) => {
    if (!('mediaSession' in navigator)) return
    const t = s.current
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album?.title ?? '', artwork: t.cover ? [{ src: t.cover.l, sizes: '600x600' }] : [] })
      : null
    navigator.mediaSession.playbackState = s.isPlaying ? 'playing' : 'paused'
  }

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => usePlayer.getState().play())
    ms.setActionHandler('pause', () => usePlayer.getState().pause())
    ms.setActionHandler('nexttrack', () => usePlayer.getState().next(true))
    ms.setActionHandler('previoustrack', () => usePlayer.getState().prev())
    ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && usePlayer.getState().seek(d.seekTime))
  }

  usePlayer.subscribe((s, prev) => {
    const key = s.current?.key ?? ''
    if (key !== lastKey) {
      lastKey = key
      const cover = s.current?.cover?.m
      void artworkAccent(cover).then((rgb) => {
        if ((usePlayer.getState().current?.key ?? '') !== key) return
        applyAccent(rgb ? toCss(rgb) : null)
        pushIsland()
      })
      pushMediaSession(s)
      pushSmtc(s)
      pushIsland()
      return
    }
    const meaningful =
      s.isPlaying !== prev.isPlaying ||
      s.isLoading !== prev.isLoading ||
      s.volume !== prev.volume ||
      s.muted !== prev.muted ||
      s.shuffle !== prev.shuffle ||
      s.repeat !== prev.repeat ||
      s.current?.liked !== prev.current?.liked ||
      Math.abs(s.position - prev.position) > 1.5
    if (meaningful) {
      scheduleIsland()
      if (s.isPlaying !== prev.isPlaying) {
        pushMediaSession(s)
        pushSmtc(s)
      }
    }
  })

  // Heartbeat keeps the island's interpolation honest while playing.
  setInterval(() => {
    if (usePlayer.getState().isPlaying) pushIsland()
  }, 2000)

  applyAccent(null)
  const pushIslandSettings = () => void emitTo('island', EV.islandSettings, useSettings.getState().island)
  pushIslandSettings()
  useSettings.subscribe((st, prev) => {
    if (st.island !== prev.island) pushIslandSettings()
    if (st.accent === prev.accent) return
    applyAccent(artworkColor)
    pushIsland()
  })

  void listen<PlayerCommand>(EV.playerCommand, (e) => runCommand(e.payload, actions))
  void listen(EV.requestState, () => {
    pushIslandSettings()
    pushIsland()
  })
}
