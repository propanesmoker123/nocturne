import { create } from 'zustand'
import { useSession } from '../app/session'
import { toast } from '../app/toast'
import { journal } from '../lib/journal'
import { livePosition, setPlayerGuard, usePlayer, type PlayerIntent } from '../player/store'
import * as vk from '../vk/api'
import type { Track } from '../vk/models'
import { bestOffset, type ClockSample } from './clock'
import { generateCode, normalizeCode, roomIdFor } from './code'
import { decide, expectedPosition, sameSongAs, wireKey, type FollowAction, type HostState } from './follow'
import { parseMessage, type ListenerState, type Message, type Role, type WireTrack } from './protocol'
import { RateLimit, admit } from './rules'
import { openTrystero, type OpenTransport, type Transport } from './transport'

/**
 * Listening together. The host's player is the source of truth: every change (track, play/pause,
 * seek) and a heartbeat every 5 s go to the listeners, who follow through `decide`. A listener's
 * own pause stays theirs; play catches up with the host; picking other music ends the session.
 */

export type TogetherError = 'code' | 'relays' | 'nobody' | 'direct' | 'full'

export const TOGETHER_ERRORS: Record<TogetherError, string> = {
  code: 'Код — 16 букв и цифр, как в приглашении',
  relays: 'Нет связи для поиска собеседников. Проверьте интернет',
  nobody: 'По этому коду никого нет — проверьте код или попросите ведущего начать заново',
  direct: 'Сеть у кого-то из вас не пускает прямые соединения (так бывает в мобильном интернете). Попробуйте другую сеть',
  full: 'Комната заполнена: уже 5 слушателей',
}

export interface Listener {
  peer: string
  name: string
  state: ListenerState
}

export interface TogetherState {
  phase: 'idle' | 'connecting' | 'live' | 'reconnecting'
  role: Role | null
  code: string | null
  hostName: string | null
  listeners: Listener[]
  error: TogetherError | null
  /** Hosting with no relay reachable: nobody can find the session right now. */
  offline: boolean
  /** Listening: the host's current track cannot be played here. */
  unavailable: boolean
}

const IDLE: Omit<TogetherState, 'error'> = { phase: 'idle', role: null, code: null, hostName: null, listeners: [], offline: false, unavailable: false }

export const useTogether = create<TogetherState>(() => ({ ...IDLE, error: null }))

let openTransport: OpenTransport = openTrystero
/** Tests and the browser demo can put another network underneath. */
export const setTransportFactory = (f: OpenTransport) => void (openTransport = f)

const HEARTBEAT_MS = 5000
const NOBODY_MS = 20_000
const LOST_MS = 30_000
const SETTLE_MS = 1500
const CLOCK_EVERY_MS = 30_000
const RELAY_CHECK_MS = 15_000
/** How far the host's position may move on its own between updates before it counts as a seek. */
const SEEK_JUMP = 1.5

type EndReason = 'left' | 'picked' | 'ended' | 'lost' | TogetherError

/** Everything one session holds; dropped as a whole when it ends. */
interface Run {
  transport: Transport | null
  timers: Set<ReturnType<typeof setTimeout>>
  cleanups: (() => void)[]
  limits: RateLimit
  bye: () => void
}
let run: Run | null = null

const newRun = (): Run => ({ transport: null, timers: new Set(), cleanups: [], limits: new RateLimit(20), bye: () => {} })

function later(r: Run, fn: () => void, ms: number) {
  const id = setTimeout(() => {
    r.timers.delete(id)
    if (run === r) fn()
  }, ms)
  r.timers.add(id)
  return id
}

function every(r: Run, fn: () => void, ms: number) {
  const id = setInterval(() => run === r && fn(), ms)
  r.cleanups.push(() => clearInterval(id))
}

function teardown() {
  const r = run
  if (!r) return
  run = null
  for (const t of r.timers) clearTimeout(t)
  for (const f of r.cleanups) f()
  r.transport?.leave()
  setPlayerGuard(null)
}

function end(reason: EndReason) {
  if (!run) return
  const { role, code } = useTogether.getState()
  if (reason === 'left' || reason === 'picked') run.bye()
  teardown()
  const error = reason in TOGETHER_ERRORS ? (reason as TogetherError) : null
  useTogether.setState({ ...IDLE, error })
  journal('together', `session ended: ${reason}`)
  if (error) toast(TOGETHER_ERRORS[error], 'error')
  else if (reason === 'ended') toast('Ведущий завершил совместное прослушивание', 'info')
  else if (reason === 'lost') toast('Связь с ведущим потеряна — совместное прослушивание закончилось', 'error')
  else if (reason === 'picked' && role === 'listener' && code) toast('Вы вышли из совместного прослушивания', 'info', { label: 'Вернуться', run: () => void joinSession(code) })
}

/** Leave or finish the session on purpose (button, app closing). */
export function leaveSession() {
  end('left')
}

export const clearTogetherError = () => useTogether.setState({ error: null })

const myName = () => useSession.getState().user?.name?.trim().split(/\s+/)[0] || 'Слушатель'

function toWire(t: Track): WireTrack {
  return {
    owner: t.ownerId,
    id: t.id,
    ...(t.accessKey && /^[0-9A-Za-z_-]{1,64}$/.test(t.accessKey) ? { accessKey: t.accessKey } : {}),
    title: t.title.slice(0, 200),
    artist: t.artist.slice(0, 200),
    duration: Math.min(Math.max(0, t.duration), 36_000),
  }
}

/** The host's track from the listener's own VK, or the same song from another owner. */
async function resolveTrack(w: WireTrack): Promise<Track | null> {
  const [t] = await vk.getByIds([{ ownerId: w.owner, id: w.id, accessKey: w.accessKey }])
  if (t?.playable && t.url) return t
  const page = await vk.searchTracks(`${w.artist} ${w.title}`, 0, 20)
  return page.items.find((c) => c.playable && sameSongAs(c, w)) ?? null
}

// ── Host ────────────────────────────────────────────────────────────────────────────────────

export async function startHosting() {
  if (run) return
  const r = (run = newRun())
  const code = generateCode()
  useTogether.setState({ ...IDLE, phase: 'connecting', role: 'host', code, error: null })

  const peers = new Map<string, Listener>()
  const publish = () => useTogether.setState({ listeners: [...peers.values()] })
  let seq = 0
  let last = { playing: false, position: 0, at: 0 }

  const broadcast = (to?: string) => {
    const p = usePlayer.getState()
    const msg: Message = { v: 1, type: 'state', seq: ++seq, track: p.current ? toWire(p.current) : null, position: Math.max(0, livePosition()), playing: p.isPlaying, at: Date.now() }
    last = { playing: msg.playing, position: msg.position, at: msg.at }
    r.transport?.send(msg, to)
  }
  r.bye = () => r.transport?.send({ v: 1, type: 'bye' })

  let transport: Transport
  try {
    transport = await openTransport(
      { roomId: await roomIdFor(code), password: code, role: 'host' },
      {
        admit: (peer, theirs) => admit('host', theirs, { listeners: peers.size, host: null }, peer),
        onPeerJoin: (peer) => {
          peers.set(peer, { peer, name: 'Слушатель', state: 'connecting' })
          publish()
          journal('together', `listener joined (${peers.size})`)
        },
        onPeerLeave: (peer) => {
          if (!peers.delete(peer)) return
          r.limits.forget(peer)
          publish()
          journal('together', `listener left (${peers.size})`)
        },
        onMessage: (raw, peer) => {
          const who = peers.get(peer)
          if (!who || run !== r) return
          if (!r.limits.hit(peer, Date.now())) return void r.transport?.kick(peer)
          const msg = parseMessage(raw)
          if (!msg) return
          if (msg.type === 'hello') {
            who.name = msg.name
            publish()
            r.transport?.send({ v: 1, type: 'welcome', host: myName(), listeners: peers.size }, peer)
            broadcast(peer)
          } else if (msg.type === 'status') {
            who.state = msg.state
            publish()
          } else if (msg.type === 'ping') {
            r.transport?.send({ v: 1, type: 'pong', t0: msg.t0, t1: Date.now() }, peer)
          } else if (msg.type === 'bye') {
            peers.delete(peer)
            publish()
          }
        },
        // Connection trouble is the listener's to report: only they know whom they failed to reach
        onError: () => {},
      },
    )
  } catch (e) {
    journal('together', `could not start hosting: ${String(e)}`)
    return end('relays')
  }
  if (run !== r) return transport.leave()
  r.transport = transport
  useTogether.setState({ phase: 'live' })
  journal('together', 'hosting started')

  r.cleanups.push(
    usePlayer.subscribe((p, prev) => {
      if ((p.current?.key ?? null) !== (prev.current?.key ?? null) || p.isPlaying !== prev.isPlaying) return broadcast()
      if (p.position === prev.position) return
      const expected = last.position + (last.playing ? (Date.now() - last.at) / 1000 : 0)
      if (Math.abs(p.position - expected) > SEEK_JUMP) broadcast()
    }),
  )
  every(r, () => broadcast(), HEARTBEAT_MS)
  const checkRelays = async () => useTogether.setState({ offline: !(await transport.relaysUp()) })
  later(r, () => void checkRelays(), 8000)
  every(r, () => void checkRelays(), RELAY_CHECK_MS)
}

// ── Listener ────────────────────────────────────────────────────────────────────────────────

export async function joinSession(input: string) {
  if (run) return
  const code = normalizeCode(input)
  if (!code) return void useTogether.setState({ error: 'code' })
  const r = (run = newRun())
  useTogether.setState({ ...IDLE, phase: 'connecting', role: 'listener', code, error: null })

  let hostPeer: string | null = null
  let sawDirect = false
  let lastSeq = -1
  let host: HostState | null = null
  let followingKey: string | null = null
  let unavailableKey: string | null = null
  let resolvingKey: string | null = null
  let localPaused = false
  let applying = false
  let lastStatus: ListenerState | null = null
  let lostTimer: ReturnType<typeof setTimeout> | null = null
  let lastHint = 0
  const samples: ClockSample[] = []
  let offset = 0

  const send = (msg: Message) => {
    if (hostPeer) r.transport?.send(msg, hostPeer)
  }
  const status = (s: ListenerState) => {
    if (s === lastStatus) return
    lastStatus = s
    send({ v: 1, type: 'status', state: s })
  }
  const asSync = (fn: () => void) => {
    applying = true
    try {
      fn()
    } finally {
      applying = false
    }
  }
  r.bye = () => send({ v: 1, type: 'bye' })

  const apply = () => {
    if (run !== r || !host) return
    if (host.track && wireKey(host.track) === unavailableKey) {
      if (usePlayer.getState().isPlaying) asSync(() => usePlayer.getState().pause())
      return
    }
    const p = usePlayer.getState()
    const local = { followingKey, position: livePosition(), playing: p.isPlaying, loading: p.isLoading || resolvingKey !== null, localPaused }
    for (const a of decide(host, local, Date.now(), offset)) act(a)
  }

  const act = (a: FollowAction) => {
    if (a.kind === 'load') return void load(a.track)
    asSync(() => {
      const p = usePlayer.getState()
      if (a.kind === 'seek') p.seek(a.to)
      else if (a.kind === 'play') p.play()
      else p.pause()
    })
  }

  const load = async (w: WireTrack) => {
    const key = wireKey(w)
    if (resolvingKey === key) return
    resolvingKey = key
    let track: Track | null = null
    try {
      track = await resolveTrack(w)
    } catch {
      track = null
    }
    if (run !== r || resolvingKey !== key) return
    resolvingKey = null
    // The host moved on while we were looking: follow the newer word instead
    if (!host?.track || wireKey(host.track) !== key) return apply()
    if (!track) {
      unavailableKey = key
      followingKey = null
      useTogether.setState({ unavailable: true })
      status('unavailable')
      if (usePlayer.getState().isPlaying) asSync(() => usePlayer.getState().pause())
      return
    }
    unavailableKey = null
    followingKey = key
    useTogether.setState({ unavailable: false })
    const play = host.playing && !localPaused
    const label = `Вместе с ${useTogether.getState().hostName ?? 'ведущим'}`
    const at = expectedPosition(host, Date.now(), offset)
    asSync(() => usePlayer.getState().playList([track!], 0, { startAt: at, paused: !play, source: { kind: 'list', label } }))
    status(localPaused ? 'paused' : 'listening')
  }

  const guard = (intent: PlayerIntent): boolean => {
    if (applying || run !== r) return true
    switch (intent) {
      case 'pause':
        localPaused = true
        status('paused')
        return true
      case 'resume':
        localPaused = false
        status(unavailableKey ? 'unavailable' : 'listening')
        queueMicrotask(apply)
        return false
      case 'pick':
        queueMicrotask(() => end('picked'))
        return true
      default:
        if (Date.now() - lastHint > 4000) {
          lastHint = Date.now()
          toast(`Треками и перемоткой управляет ${useTogether.getState().hostName ?? 'ведущий'}`, 'info')
        }
        return false
    }
  }

  const ping = () => send({ v: 1, type: 'ping', t0: Date.now() })

  let transport: Transport
  try {
    transport = await openTransport(
      { roomId: await roomIdFor(code), password: code, role: 'listener' },
      {
        admit: (peer, theirs) => admit('listener', theirs, { listeners: 0, host: hostPeer }, peer),
        onPeerJoin: (peer) => {
          // Only a host gets through our handshake
          hostPeer = peer
          if (lostTimer) clearTimeout(lostTimer)
          lostTimer = null
          later(
            r,
            () => {
              useTogether.setState({ phase: 'live' })
              lastStatus = null
              send({ v: 1, type: 'hello', name: myName() })
              status(unavailableKey ? 'unavailable' : localPaused ? 'paused' : 'listening')
              for (let i = 0; i < 5; i++) later(r, ping, 300 * i)
              setPlayerGuard(guard)
              journal('together', 'joined a session')
            },
            0,
          )
        },
        onPeerLeave: (peer) => {
          if (peer !== hostPeer || run !== r) return
          useTogether.setState({ phase: 'reconnecting' })
          lostTimer = later(r, () => end('lost'), LOST_MS)
        },
        onMessage: (raw, peer) => {
          if (peer !== hostPeer || run !== r || !r.limits.hit(peer, Date.now())) return
          const msg = parseMessage(raw)
          if (!msg) return
          if (msg.type === 'welcome') {
            useTogether.setState({ hostName: msg.host })
          } else if (msg.type === 'state') {
            if (msg.seq <= lastSeq) return
            lastSeq = msg.seq
            host = { seq: msg.seq, track: msg.track, position: msg.position, playing: msg.playing, at: msg.at }
            apply()
          } else if (msg.type === 'pong') {
            samples.push({ t0: msg.t0, t1: msg.t1, t2: Date.now() })
            if (samples.length > 10) samples.shift()
            offset = bestOffset(samples)
          } else if (msg.type === 'bye') {
            end('ended')
          }
        },
        onError: (e) => {
          if (e === 'full') end('full')
          else if (e === 'direct') sawDirect = true
        },
      },
    )
  } catch (e) {
    journal('together', `could not join: ${String(e)}`)
    return end('relays')
  }
  if (run !== r) return transport.leave()
  r.transport = transport

  every(r, ping, CLOCK_EVERY_MS)
  r.cleanups.push(
    // Once the sound really starts, check once more: loading took a moment, the host did not wait
    usePlayer.subscribe((p, prev) => {
      if (prev.isLoading && !p.isLoading && p.isPlaying) later(r, apply, SETTLE_MS)
    }),
  )
  later(
    r,
    async () => {
      if (hostPeer) return
      const error: TogetherError = !(await transport.relaysUp()) ? 'relays' : sawDirect ? 'direct' : 'nobody'
      end(error)
    },
    NOBODY_MS,
  )
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => leaveSession())
