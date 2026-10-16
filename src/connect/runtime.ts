import { toast } from '../app/toast'
import { journal } from '../lib/journal'
import { isAndroid } from '../lib/platform'
import { livePosition, setPlayerRemote, showRemote, usePlayer, type PlayerRemote } from '../player/store'
import type { WireTrack } from '../together/protocol'
import { toWire, useTogether } from '../together/session'
import * as vk from '../vk/api'
import type { Track } from '../vk/models'
import { openConnectBus, type ConnectBus } from './bus'
import { loadDevices, useDevices } from './devices'
import { queueWindow, remoteHolds, remotePosition, shouldYield, OFFLINE_MS, type SeenDevice } from './logic'
import { MAX_PLAY_TRACKS, type CommandAction, type ConnectMessage, type PlayOrder, type Presence } from './protocol'

/**
 * Linked devices and the player: this device says what it plays, does what the others ask
 * (commands, «play this», «give it to me»), keeps «one device plays», and turns its player into
 * a remote while another device plays — the way Spotify Connect does.
 */

export type OpenBus = (code: string, me: string, onMessage: (msg: ConnectMessage, from: string) => void) => Promise<ConnectBus>

let bus: ConnectBus | null = null
let openedFor: string | null = null
/** When this device's own playback started (for «one device plays»). */
let since = 0
let lastKey = ''
let lastSentAt = 0
let pending: ReturnType<typeof setTimeout> | undefined
let ticker: ReturnType<typeof setInterval> | null = null
let cleanups: (() => void)[] = []
/** Tracks another device announced, in full once VK answers (cover, «in my music»). */
const full = new Map<string, Track>()

const keyOf = (w: WireTrack) => `${w.owner}_${w.id}`
const clampSeconds = (s: number) => Math.max(0, Math.min(s, 36_000))
const remoteOn = () => useDevices.getState().remoteId !== null
const together = () => !!useTogether.getState().role

function displayTrack(w: WireTrack): Track {
  const k = keyOf(w)
  const known = full.get(k)
  if (known) return known
  const bare: Track = { id: w.id, ownerId: w.owner, key: k, accessKey: w.accessKey, artist: w.artist, title: w.title, duration: w.duration, urlFetchedAt: 0, explicit: false, artists: [{ name: w.artist }], playable: true, hasLyrics: false, liked: false }
  full.set(k, bare)
  void vk
    .getByIds([{ ownerId: w.owner, id: w.id, accessKey: w.accessKey }])
    .then(([t]) => {
      if (!t) return
      full.set(k, t)
      applyRemote()
    })
    .catch(() => {})
  return bare
}

/** This device about itself. A remote is idle here: it never announces the track it mirrors. */
function myPresence(): Presence {
  const p = usePlayer.getState()
  const d = useDevices.getState()
  const mine = !remoteOn()
  return {
    name: d.name,
    platform: isAndroid ? 'android' : 'desktop',
    track: mine && p.current ? toWire(p.current) : null,
    position: mine ? clampSeconds(livePosition()) : 0,
    duration: mine ? clampSeconds(p.duration || p.current?.duration || 0) : 0,
    playing: mine && p.isPlaying,
    since: mine && p.isPlaying ? since : 0,
    volume: Math.max(0, Math.min(p.volume, 1)),
    shuffle: mine && p.shuffle,
    repeat: mine ? p.repeat : 'off',
    queue: { pos: mine ? (p.queue?.pos ?? 0) : 0, total: mine ? (p.queue?.order.length ?? 0) : 0 },
  }
}

/** Says where this device is: on change (coalesced), every 5 s while playing, every 15 s otherwise. */
function announce(force = false) {
  if (!bus) return
  const presence = myPresence()
  const key = JSON.stringify({ ...presence, position: 0 })
  const now = Date.now()
  if (!force && key === lastKey && now - lastSentAt < (presence.playing ? 5000 : 15_000)) return
  lastKey = key
  lastSentAt = now
  bus.send({ type: 'presence', presence })
}

function announceSoon() {
  clearTimeout(pending)
  pending = setTimeout(() => announce(), 250)
}

/** This device's queue as an order for another one: up to MAX_PLAY_TRACKS around the current track, in play order. */
function myOrder(): PlayOrder | null {
  const p = usePlayer.getState()
  const q = p.queue
  if (remoteOn() || !q || !p.current) return null
  const w = queueWindow(
    q.order.map((i) => q.items[i]),
    q.pos,
    MAX_PLAY_TRACKS,
  )
  return { tracks: w.items.map(toWire), index: w.index, position: clampSeconds(livePosition()), playing: p.isPlaying, shuffle: false, repeat: p.repeat, ...(p.source?.label ? { label: p.source.label.slice(0, 100) } : {}) }
}

/** Plays here what another device sent. */
async function startOrder(o: PlayOrder) {
  let found: Track[] = []
  try {
    found = await vk.getByIds(o.tracks.map((w) => ({ ownerId: w.owner, id: w.id, accessKey: w.accessKey })))
  } catch {
    // nothing found: said below
  }
  const byKey = new Map(found.map((t) => [t.key, t]))
  const list = o.tracks.map((w) => byKey.get(keyOf(w))).filter((t): t is Track => !!t)
  if (!list.length) return toast('Не получилось включить музыку с другого устройства', 'error')
  const index = Math.max(0, list.findIndex((t) => t.key === keyOf(o.tracks[o.index])))
  leaveRemote()
  usePlayer.getState().playList(list, index, { shuffle: o.shuffle, startAt: o.position, paused: !o.playing, source: { kind: 'list', ...(o.label ? { label: o.label } : {}) } })
  for (let i = 0; i < 3 && usePlayer.getState().repeat !== o.repeat; i++) usePlayer.getState().cycleRepeat()
}

function runCommand(action: CommandAction, value?: number) {
  const p = usePlayer.getState()
  if (action === 'toggle') p.toggle()
  else if (action === 'play') p.play()
  else if (action === 'pause') p.pause()
  else if (action === 'next') p.next(true)
  else if (action === 'prev') p.prev()
  else if (action === 'seek' && value !== undefined) p.seek(value)
  else if (action === 'volume' && value !== undefined) p.setVolume(value)
  else if (action === 'shuffle') p.toggleShuffle()
  else if (action === 'repeat') p.cycleRepeat()
  else if (action === 'mix') void p.playMix()
  announceSoon()
}

function remoteFor(id: string): PlayerRemote {
  const cmd = (action: CommandAction, value?: number) => bus?.send({ type: 'command', action, ...(value === undefined ? {} : { value }) }, id)
  return {
    toggle: () => cmd('toggle'),
    play: () => cmd('play'),
    pause: () => cmd('pause'),
    next: () => cmd('next'),
    prev: () => cmd('prev'),
    seek: (sec) => cmd('seek', clampSeconds(sec)),
    setVolume: (v) => cmd('volume', Math.max(0, Math.min(v, 1))),
    toggleShuffle: () => cmd('shuffle'),
    cycleRepeat: () => cmd('repeat'),
    playMix: () => cmd('mix'),
    playList: (tracks, index, opts) => {
      const w = queueWindow(tracks, index, MAX_PLAY_TRACKS)
      const label = opts?.source?.label
      bus?.send({ type: 'play', tracks: w.items.map(toWire), index: w.index, position: clampSeconds(opts?.startAt ?? 0), playing: !opts?.paused, shuffle: !!opts?.shuffle, repeat: usePlayer.getState().repeat, ...(label ? { label: label.slice(0, 100) } : {}) }, id)
    },
  }
}

/** Puts the steered device's state into this player. */
function applyRemote() {
  const { remoteId, devices } = useDevices.getState()
  const d = remoteId ? devices[remoteId] : undefined
  if (!d) return
  const p = d.presence
  showRemote({ name: p.name, track: p.track ? displayTrack(p.track) : null, position: remotePosition(p, d.seen, Date.now()), duration: p.duration, playing: p.playing, volume: p.volume, shuffle: p.shuffle, repeat: p.repeat })
}

function enterRemote(id: string) {
  if (together() || useDevices.getState().remoteId === id) return
  if (remoteOn()) leaveRemote()
  useDevices.setState({ remoteId: id })
  setPlayerRemote(remoteFor(id))
  applyRemote()
  ticker ??= setInterval(applyRemote, 500)
  announceSoon()
}

/** This player is this device's own again. */
export function leaveRemote() {
  if (!remoteOn()) return
  useDevices.setState({ remoteId: null })
  setPlayerRemote(null)
  if (ticker) clearInterval(ticker)
  ticker = null
  announceSoon()
}

function onMessage(msg: ConnectMessage, from: string) {
  const now = Date.now()
  if (msg.type === 'presence') {
    const prev = useDevices.getState().devices[from]
    const seen: SeenDevice = { id: from, presence: msg.presence, seen: now, lastPlaying: msg.presence.playing ? now : (prev?.lastPlaying ?? 0) }
    useDevices.setState((s) => ({ devices: { ...s.devices, [from]: seen } }))
    if (together()) return
    const { deviceId, remoteId, devices } = useDevices.getState()
    if (!remoteOn() && usePlayer.getState().isPlaying && shouldYield({ id: deviceId, playing: true, since }, seen)) {
      usePlayer.getState().pause()
      return enterRemote(from)
    }
    if (msg.presence.playing && (!remoteId ? !usePlayer.getState().isPlaying : remoteId !== from && !devices[remoteId]?.presence.playing)) return enterRemote(from)
    if (remoteId === from) applyRemote()
    return
  }
  if (msg.type === 'bye') {
    useDevices.setState((s) => {
      const devices = { ...s.devices }
      delete devices[from]
      return { devices }
    })
    if (useDevices.getState().remoteId === from) leaveRemote()
    return
  }
  if (together()) return
  if (msg.type === 'play') return void startOrder(msg)
  // a remote steers; it is not the one playing
  if (remoteOn()) return
  if (msg.type === 'command') return runCommand(msg.action, msg.value)
  const order = myOrder()
  if (!order) return
  bus?.send({ type: 'play', ...order }, msg.type === 'pull' ? from : msg.target)
  usePlayer.getState().pause()
}

/** Every few seconds: say where we are, forget the silent, let go of a steered device that left. */
export function tickConnect(now = Date.now()) {
  announce()
  const { devices, remoteId } = useDevices.getState()
  if (remoteId && !remoteHolds(devices[remoteId], now)) leaveRemote()
  const alive = Object.fromEntries(Object.entries(devices).filter(([, d]) => now - d.seen <= OFFLINE_MS))
  if (Object.keys(alive).length !== Object.keys(devices).length) useDevices.setState({ devices: alive })
}

/** Moves the music to device `id`; from a remote — from the steered device to it. */
export function playOn(id: string) {
  const { remoteId, deviceId } = useDevices.getState()
  if (together()) return toast('Сначала завершите совместное прослушивание', 'info')
  if (id === deviceId) return playHere()
  if (remoteId) {
    if (remoteId !== id) bus?.send({ type: 'move', target: id }, remoteId)
    return
  }
  const order = myOrder()
  if (!order) return toast('Сначала включите что-нибудь', 'info')
  bus?.send({ type: 'play', ...order }, id)
  usePlayer.getState().pause()
}

/** Takes the music from the steered device to this one (its «play this» brings it here). */
export function playHere() {
  const { remoteId } = useDevices.getState()
  if (together()) return toast('Сначала завершите совместное прослушивание', 'info')
  if (remoteId) bus?.send({ type: 'pull' }, remoteId)
}

function closeBus() {
  if (!bus) return
  bus.send({ type: 'bye' })
  bus.close()
  bus = null
  leaveRemote()
  useDevices.setState({ devices: {} })
}

/** Opens the group channel while this device is linked, follows code changes. Call once at start. */
export async function startConnect(openBus: OpenBus = openConnectBus) {
  await loadDevices()
  const sync = async () => {
    const { code, deviceId } = useDevices.getState()
    if (code === openedFor) return
    closeBus()
    openedFor = code
    if (!code) return
    try {
      bus = await openBus(code, deviceId, onMessage)
    } catch (e) {
      journal('connect', `channel did not open: ${String(e).slice(0, 80)}`)
      openedFor = null
      return
    }
    lastKey = ''
    announce(true)
  }
  cleanups.push(
    useDevices.subscribe((s, prev) => {
      if (s.code !== prev.code) void sync()
      else if (s.name !== prev.name) announceSoon()
    }),
    usePlayer.subscribe((s, prev) => {
      if (remoteOn()) return
      if (s.isPlaying && !prev.isPlaying) since = Date.now()
      if (s.current?.key !== prev.current?.key || s.isPlaying !== prev.isPlaying || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.volume !== prev.volume) announceSoon()
    }),
  )
  const t = setInterval(() => tickConnect(), 5000)
  cleanups.push(() => clearInterval(t))
  if (typeof window !== 'undefined') {
    const bye = () => bus?.send({ type: 'bye' })
    window.addEventListener('beforeunload', bye)
    cleanups.push(() => window.removeEventListener('beforeunload', bye))
  }
  await sync()
}

/** Closes everything (tests, sign-out). */
export function stopConnect() {
  for (const f of cleanups.splice(0)) f()
  closeBus()
  clearTimeout(pending)
  openedFor = null
  since = 0
  lastKey = ''
}
