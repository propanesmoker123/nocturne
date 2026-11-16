import { create } from 'zustand'
import { invoke, isTauri } from '../lib/tauri'
import { usePlayer } from '../player/store'
import type { PlayerCommand } from '../lib/events'
import type { RepeatMode } from '../player/queue'

/** What Spotify's own bottom bar shows: display fields only, read from the web player. */
export interface SpotifyTrack {
  trackId?: string
  title: string
  artist: string
  album: string
  cover?: string
  coverLarge?: string
  /** seconds at `SpotifyLive.at` */
  position: number
  duration: number
  /** seconds buffered ahead on the active media element */
  buffered?: number
  liked: boolean | null
  shuffle: boolean
  repeat: RepeatMode
  /** 0..1, null when the volume slider is not on the page */
  volume: number | null
}

export interface SpotifyStatus {
  open: boolean
  phase?: 'ready' | 'login' | 'region' | 'loading'
  title?: string
  enabled?: boolean
  removed?: number
  intercepted?: number
  unsupported?: number
  drm?: boolean | null
  playing?: boolean | null
  loginWaiting?: boolean
  /** Whether the web player shows a signed-in account; null while it cannot tell. */
  account?: 'in' | 'out' | null
  nowPlaying?: SpotifyTrack | null
}
export interface SpotifyBounds { x: number; y: number; width: number; height: number }
export type SpotifyAction = 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'reload' | 'shuffle' | 'repeat' | 'mute' | 'like' | 'seek' | 'volume'

interface SpotifyLive {
  status: SpotifyStatus
  /** Spotify is open and is the player that media keys, the tray and the island control. */
  owner: boolean
  playing: boolean
  track: SpotifyTrack | null
  /** ms epoch of the last reading; the position moves on from there while playing */
  at: number
}
export const useSpotify = create<SpotifyLive>(() => ({ status: { open: false }, owner: false, playing: false, track: null, at: 0 }))

let available = false
let owner = false
let lastPlaying: boolean | null = null
let pages = 0
const sync = () => useSpotify.setState({ owner: available && owner })

export const spotifyOwnsPlayback = () => available && owner
export function claimSpotifyPlayback() { available = true; owner = true; lastPlaying = false; sync(); usePlayer.getState().pause() }
export function releaseSpotifyPlayback() {
  available = false; owner = false; lastPlaying = null
  useSpotify.setState({ owner: false, playing: false, track: null })
}
/** The Spotify page is on screen: its status is read even before the player is open. */
export function watchSpotifyPage() { pages++; return () => { pages = Math.max(0, pages - 1) } }

/** Where the Spotify track is now, moving on from the last reading while it plays. */
export function spotifyPosition(state: Pick<SpotifyLive, 'track' | 'playing' | 'at'> = useSpotify.getState(), now = Date.now()) {
  const t = state.track
  if (!t) return 0
  const moved = state.playing ? (now - state.at) / 1000 : 0
  return Math.max(0, t.duration ? Math.min(t.duration, t.position + moved) : t.position + moved)
}

const COVER = /^https:\/\/(?:i\.scdn\.co|mosaic\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com)\/[^\s"'<>]{1,500}$/i
const text = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '')
const seconds = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 86_400 ? value : 0)
/** The page is a remote site: keep only well-formed display fields from it. */
export function readSpotifyTrack(raw: unknown): SpotifyTrack | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = text(r.title)
  if (!title) return null
  const cover = typeof r.cover === 'string' && COVER.test(r.cover) ? r.cover : undefined
  const coverLarge = typeof r.coverLarge === 'string' && COVER.test(r.coverLarge) ? r.coverLarge : cover
  const duration = seconds(r.duration)
  const volume = typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : null
  const trackId = typeof r.trackId === 'string' && /^[A-Za-z0-9]{22}$/.test(r.trackId) ? r.trackId : undefined
  const buffered = typeof r.buffered === 'number' && Number.isFinite(r.buffered) && r.buffered >= 0
    ? (duration ? Math.min(duration, seconds(r.buffered)) : seconds(r.buffered))
    : undefined
  return {
    trackId,
    title, artist: text(r.artist), album: text(r.album), cover, coverLarge,
    position: duration ? Math.min(duration, seconds(r.position)) : seconds(r.position), duration,
    buffered,
    liked: typeof r.liked === 'boolean' ? r.liked : null,
    shuffle: r.shuffle === true,
    repeat: r.repeat === 'one' || r.repeat === 'all' ? r.repeat : 'off',
    volume,
  }
}

let refreshSoon: ReturnType<typeof setTimeout> | undefined
export async function spotifyControl(action: SpotifyAction, value?: number) {
  if (!isTauri()) return false
  const changed = await invoke<boolean>('spotify_control', value === undefined ? { action } : { action, value })
  if (changed && (action === 'pause' || action === 'play')) lastPlaying = action === 'play'
  // Spotify's bar updates a moment after a click: read it again to follow at once.
  if (changed && action !== 'reload') {
    clearTimeout(refreshSoon)
    refreshSoon = setTimeout(() => void spotifyStatus().catch(() => {}), 350)
  }
  return changed
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function handleSpotifyCommand(command: PlayerCommand): boolean {
  if (!spotifyOwnsPlayback() || command.type === 'showWindow') return false
  const run = (action: SpotifyAction, value?: number) => void spotifyControl(action, value).catch(() => {})
  const track = useSpotify.getState().track
  switch (command.type) {
    case 'toggle': case 'play': case 'pause': case 'next': run(command.type); break
    case 'prev': run('previous'); break
    case 'toggleShuffle': run('shuffle'); break
    case 'cycleRepeat': run('repeat'); break
    case 'toggleMute': run('mute'); break
    case 'toggleLike': run('like'); break
    case 'seek': if (track?.duration) run('seek', clamp(command.value, 0, track.duration)); break
    case 'seekBy': if (track?.duration) run('seek', clamp(spotifyPosition() + command.value, 0, track.duration)); break
    case 'volume': run('volume', clamp(command.value, 0, 1)); break
    case 'volumeBy': if (track?.volume != null) run('volume', clamp(track.volume + command.value, 0, 1)); break
  }
  // Nothing reaches the paused VK or SoundCloud track while Spotify is the player.
  return true
}

export const SPOTIFY_FILTER_KEY = 'spotify-filter'
export const DEFAULT_SPOTIFY_RUNTIME = { enabled: true }

export function readSpotifyStatus(raw: unknown, fallbackEnabled = true) {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const phase: SpotifyStatus['phase'] =
    r.phase === 'ready' || r.phase === 'login' || r.phase === 'region' || r.phase === 'loading' ? r.phase : 'loading'
  const account: SpotifyStatus['account'] = r.account === 'in' || r.account === 'out' ? r.account : null
  return {
    open: r.open === true,
    phase,
    account,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : fallbackEnabled,
    loginWaiting: r.loginWaiting === true,
    drm: typeof r.drm === 'boolean' ? r.drm : null,
    patchedCount: Number(r.removed) || 0,
  }
}

let reading: Promise<SpotifyStatus> | null = null
export function spotifyStatus(): Promise<SpotifyStatus> {
  if (!isTauri()) return Promise.resolve({ open: false })
  // One reading at a time: the page, the poller and a click may ask together.
  reading ??= invoke<SpotifyStatus>('spotify_status').then(apply).finally(() => { reading = null })
  return reading
}
function apply(raw: SpotifyStatus): SpotifyStatus {
  const status: SpotifyStatus = { ...raw, account: raw.account === 'in' || raw.account === 'out' ? raw.account : null, nowPlaying: raw.open ? readSpotifyTrack(raw.nowPlaying) : null }
  available = status.open
  if (!status.open) {
    releaseSpotifyPlayback()
    useSpotify.setState({ status })
    return status
  }
  const nativeSpotify = usePlayer.getState().current?.service === 'spotify'
  if (status.playing != null) {
    if (status.playing && lastPlaying === false && !owner && !nativeSpotify) { owner = true; usePlayer.getState().pause() }
    lastPlaying = status.playing
  }
  useSpotify.setState({ status, owner: available && owner && !nativeSpotify, playing: status.playing === true, track: status.nowPlaying ?? null, at: Date.now() })
  return status
}

export function startSpotifyBridge(): () => void {
  if (!isTauri()) return () => {}
  // A track started in VK/SC takes over; an unopened Spotify view does not add any work.
  const off = usePlayer.subscribe((state, previous) => {
    if (state.isPlaying && !previous.isPlaying && state.current?.service !== 'spotify') {
      owner = false
      sync()
      if (available) void spotifyControl('pause').catch(() => {})
    }
  })
  // While external Spotify plays, the island, the tray and Windows' media flyout follow its track.
  // Skip redundant polling when native Spotify playback is already polled by Engine.
  let tick = 0
  const timer = setInterval(() => {
    if (!available && !pages) return
    if (usePlayer.getState().current?.service === 'spotify') return
    tick++
    const { owner, playing } = useSpotify.getState()
    if ((owner && playing) || tick % 3 === 0) void spotifyStatus().catch(() => {})
  }, 2000)
  return () => { off(); clearInterval(timer); clearTimeout(refreshSoon) }
}
export const spotifyError = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : 'Spotify не ответил. Попробуйте обновить страницу.'
