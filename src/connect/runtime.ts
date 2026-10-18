import { toast } from '../app/toast'
import { journal } from '../lib/journal'
import { isAndroid } from '../lib/platform'
import { livePosition, remoteActive, setPlayerRemote, showRemote, usePlayer, type PlayerRemote } from '../player/store'
import { isResolvable, type WireTrack } from '../together/protocol'
import { toWire, useTogether } from '../together/session'
import * as Q from '../player/queue'
import * as vk from '../vk/api'
import { serviceOf, type Track } from '../vk/models'
import { openConnectBus, type ConnectBus } from './bus'
import { loadDevices, useDevices } from './devices'
import { fitOrder, queueWindow, remoteHolds, remotePosition, shouldYield, vkOnly, OFFLINE_MS, type SeenDevice } from './logic'
import { MAX_PLAY_TRACKS, type CommandAction, type ConnectMessage, type PlayOrder, type Presence } from './protocol'

/**
 * Linked devices and the player: this device says what it plays, does what the others ask
 * (commands, «play this», «give it to me»), keeps «one device plays», and turns its player into
 * a remote while another device plays — the way Spotify Connect does.
 */

export type OpenBus = (code: string, me: string, onMessage: (msg: ConnectMessage, from: string) => void, onOpen: () => void) => Promise<ConnectBus>

const openBusDefault: OpenBus = (code, me, onMessage, onOpen) => openConnectBus(code, me, onMessage, { onOpen })

let bus: ConnectBus | null = null
let openedFor: string | null = null
/** When this device's own playback started (for «one device plays»). */
let since = 0
let lastKey = ''
let lastSentAt = 0
let pending: ReturnType<typeof setTimeout> | undefined
let pendingForce = false
let ticker: ReturnType<typeof setInterval> | null = null
let cleanups: (() => void)[] = []
/** After next/previous on the remote: the track it switched away from — words still showing it are from before the switch and wait out a moment. */
let holding: { id: string; from: string; until: number } | null = null
const HOLD_MS = 2500
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

/** The tracks a «previous» and a «next» would go to (a remote's swipe shows them). */
function myNear(): Presence['near'] {
  const q = usePlayer.getState().queue
  if (!q) return undefined
  const { prev, next } = Q.around(q, (t) => t.playable)
  return { prev: prev ? toWire(prev) : null, next: next ? toWire(next) : null }
}

/** This device about itself. A remote is idle here: it never announces the track it mirrors. */
function myPresence(): Presence {
  const p = usePlayer.getState()
  const d = useDevices.getState()
  const mine = !remoteOn()
  const near = mine ? myNear() : undefined
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
    ...(near ? { near } : {}),
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

/** `force`: say it even if nothing but the position changed (a seek, someone new in the group). */
function announceSoon(force = false) {
  pendingForce ||= force
  clearTimeout(pending)
  pending = setTimeout(() => {
    const f = pendingForce
    pendingForce = false
    announce(f)
  }, 250)
}

/** This device's queue as an order for another one: up to MAX_PLAY_TRACKS around the current track, in play order. */
const SC_NO_TRANSFER = 'Треки SoundCloud пока нельзя перенести на другое устройство'

const playingSoundCloud = () => {
  const t = usePlayer.getState().current
  return !remoteOn() && !!t && serviceOf(t) === 'sc'
}

/** The device this one steers plays a track known by name only (a SoundCloud one). */
const steeredPlaysSoundCloud = () => {
  const { remoteId, devices } = useDevices.getState()
  const t = remoteId ? devices[remoteId]?.presence.track : null
  return !!t && !isResolvable(t)
}

function myOrder(): PlayOrder | null {
  const p = usePlayer.getState()
  const q = p.queue
  if (remoteOn() || !q || !p.current) return null
  const vkQueue = vkOnly(
    q.order.map((i) => q.items[i]),
    q.pos,
  )
  if (!vkQueue) return null
  const w = queueWindow(vkQueue.tracks, vkQueue.index, MAX_PLAY_TRACKS)
  return fitOrder({
    tracks: w.items.map(toWire),
    index: w.index,
    position: clampSeconds(livePosition()),
    playing: p.isPlaying,
    shuffle: p.shuffle,
    repeat: p.repeat,
    ...(p.source?.label ? { label: p.source.label.slice(0, 100) } : {}),
    ...(p.source?.kind === 'mix' ? { mix: true } : {}),
  })
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
  // shuffle mode as the sender had it; an explicit «Перемешать» starts anywhere
  if (!o.randomStart) usePlayer.setState({ shuffle: o.shuffle })
  usePlayer.getState().playList(list, index, { ...(o.randomStart ? { shuffle: true } : {}), startAt: o.position, paused: !o.playing, source: { kind: o.mix ? 'mix' : 'list', ...(o.label ? { label: o.label } : {}) } })
  for (let i = 0; i < 3 && usePlayer.getState().repeat !== o.repeat; i++) usePlayer.getState().cycleRepeat()
}

function runCommand(action: CommandAction, value?: number) {
  const p = usePlayer.getState()
  if (action === 'toggle') p.toggle()
  else if (action === 'play') p.play()
  else if (action === 'pause') p.pause()
  else if (action === 'next') p.next(true)
  else if (action === 'prev') p.prev(value === 1)
  else if (action === 'seek' && value !== undefined) p.seek(value)
  else if (action === 'volume' && value !== undefined) p.setVolume(value)
  else if (action === 'shuffle') p.toggleShuffle()
  else if (action === 'repeat') p.cycleRepeat()
  else if (action === 'mix') void p.playMix()
  announceSoon()
}

function remoteFor(id: string): PlayerRemote {
  const cmd = (action: CommandAction, value?: number) => bus?.send({ type: 'command', action, ...(value === undefined ? {} : { value }) }, id)
  /** What this remote just asked for, kept in the device's last word so the player does not snap back before it answers. */
  const expect = (p: Partial<Presence>) =>
    useDevices.setState((s) => {
      const d = s.devices[id]
      return d ? { devices: { ...s.devices, [id]: { ...d, presence: { ...d.presence, ...p }, seen: Date.now() } } } : {}
    })
  // a volume drag sends at most every 150 ms, and always its last value
  let volumeAt = 0
  let volumeValue = 0
  let volumeTimer: ReturnType<typeof setTimeout> | undefined
  const sendVolume = () => {
    volumeTimer = undefined
    volumeAt = Date.now()
    cmd('volume', volumeValue)
  }
  /** Shows the neighbour as playing right away (a swipe must not snap back while the device answers). */
  const switchTo = (to: 'prev' | 'next') => {
    const d = useDevices.getState().devices[id]
    const target = d?.presence.near?.[to]
    if (!d || !target) return
    const was = d.presence.track
    expect({ track: target, position: 0, duration: target.duration, near: { prev: to === 'next' ? was : null, next: to === 'prev' ? was : null } })
    if (was) holding = { id, from: keyOf(was), until: Date.now() + HOLD_MS }
    applyRemote()
  }
  return {
    toggle: () => cmd('toggle'),
    play: () => cmd('play'),
    pause: () => cmd('pause'),
    next: () => {
      cmd('next')
      switchTo('next')
    },
    prev: (always) => {
      cmd('prev', always ? 1 : undefined)
      if (always) switchTo('prev')
    },
    seek: (sec) => {
      const at = clampSeconds(sec)
      expect({ position: at })
      cmd('seek', at)
    },
    setVolume: (v) => {
      volumeValue = Math.max(0, Math.min(v, 1))
      expect({ volume: volumeValue })
      const wait = 150 - (Date.now() - volumeAt)
      if (wait <= 0) sendVolume()
      else volumeTimer ??= setTimeout(sendVolume, wait)
    },
    toggleShuffle: () => cmd('shuffle'),
    cycleRepeat: () => cmd('repeat'),
    playMix: () => cmd('mix'),
    playList: (tracks, index, opts) => {
      const vkTracks = vkOnly(tracks, index)
      if (!vkTracks) return void toast(SC_NO_TRANSFER, 'info')
      const w = queueWindow(vkTracks.tracks, vkTracks.index, MAX_PLAY_TRACKS)
      const label = opts?.source?.label
      const order = fitOrder({
        tracks: w.items.map(toWire),
        index: w.index,
        position: clampSeconds(opts?.startAt ?? 0),
        playing: !opts?.paused,
        // the steered device's shuffle mode stays as it is, unless this is «Перемешать»
        shuffle: opts?.shuffle ?? usePlayer.getState().shuffle,
        repeat: usePlayer.getState().repeat,
        ...(label ? { label: label.slice(0, 100) } : {}),
        ...(opts?.shuffle ? { randomStart: true } : {}),
      })
      bus?.send({ type: 'play', ...order }, id)
    },
  }
}

/** Puts the steered device's state into this player. */
function applyRemote() {
  const { remoteId, devices } = useDevices.getState()
  const d = remoteId ? devices[remoteId] : undefined
  if (!d) return
  const p = d.presence
  const near = p.near ? { prev: p.near.prev ? displayTrack(p.near.prev) : null, next: p.near.next ? displayTrack(p.near.next) : null } : null
  showRemote({ name: p.name, track: p.track ? displayTrack(p.track) : null, near, position: remotePosition(p, d.seen, Date.now()), duration: p.duration, playing: p.playing, volume: p.volume, shuffle: p.shuffle, repeat: p.repeat })
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

/** This player is this device's own again (safe to call any time). */
export function leaveRemote() {
  if (!remoteOn() && !remoteActive()) return
  useDevices.setState({ remoteId: null })
  setPlayerRemote(null)
  if (ticker) clearInterval(ticker)
  ticker = null
  announceSoon()
}

function onMessage(msg: ConnectMessage, from: string) {
  const now = Date.now()
  if (msg.type === 'presence') {
    // a word sent before our switch reached the device would take the remote back for a moment; any
    // other track is where the device really is (two quick presses, a queue that changed) and goes through
    if (holding?.id === from && Date.now() < holding.until && msg.presence.track && keyOf(msg.presence.track) === holding.from) {
      useDevices.setState((s) => (s.devices[from] ? { devices: { ...s.devices, [from]: { ...s.devices[from], seen: now } } } : {}))
      return
    }
    if (holding?.id === from) holding = null
    const prev = useDevices.getState().devices[from]
    const seen: SeenDevice = { id: from, presence: msg.presence, seen: now, lastPlaying: msg.presence.playing ? now : (prev?.lastPlaying ?? 0) }
    useDevices.setState((s) => ({ devices: { ...s.devices, [from]: seen } }))
    // someone new (just started, just linked): tell them about us now, not at the next heartbeat
    if (!prev) announceSoon(true)
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
  if (playingSoundCloud()) return toast(SC_NO_TRANSFER, 'info')
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
    if (steeredPlaysSoundCloud()) return toast(SC_NO_TRANSFER, 'info')
    if (remoteId !== id) bus?.send({ type: 'move', target: id }, remoteId)
    return
  }
  if (playingSoundCloud()) return toast(SC_NO_TRANSFER, 'info')
  const order = myOrder()
  if (!order) return toast('Сначала включите что-нибудь', 'info')
  bus?.send({ type: 'play', ...order }, id)
  usePlayer.getState().pause()
}

/** Takes the music from the steered device to this one (its «play this» brings it here). */
export function playHere() {
  const { remoteId } = useDevices.getState()
  if (together()) return toast('Сначала завершите совместное прослушивание', 'info')
  if (!remoteId) return
  if (steeredPlaysSoundCloud()) return toast(SC_NO_TRANSFER, 'info')
  bus?.send({ type: 'pull' }, remoteId)
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
export async function startConnect(openBus: OpenBus = openBusDefault) {
  await loadDevices()
  const sync = async () => {
    const { code, deviceId } = useDevices.getState()
    if (code === openedFor) return
    closeBus()
    openedFor = code
    if (!code) return
    try {
      bus = await openBus(code, deviceId, onMessage, () => announceSoon(true))
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
      // a jump (a seek here or from a remote) goes out at once, so remotes do not show the old place
      if (Math.abs(s.position - prev.position) > 2) announceSoon(true)
      // (a queue change moves the neighbours a remote's swipe shows)
      else if (s.current?.key !== prev.current?.key || s.isPlaying !== prev.isPlaying || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.volume !== prev.volume || s.queue !== prev.queue) announceSoon()
    }),
    // listening together and the device remote never mix: starting a session lets the steered device go
    useTogether.subscribe((s, prev) => {
      if (s.role && !prev.role) leaveRemote()
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
  pendingForce = false
  openedFor = null
  since = 0
  lastKey = ''
  holding = null
}
