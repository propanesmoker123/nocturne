import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'
import type { ConnectMessage } from './protocol'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const calls = { load: [] as { url: string; startAt?: number }[], pause: 0 }
  const engine = {
    lastError: '',
    onSource: null,
    on(ev: string, fn: () => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(fn)
      return () => listeners.get(ev)!.delete(fn)
    },
    load(url: string, startAt?: number) {
      calls.load.push({ url, startAt })
      engine.playing = true
      listeners.get('state')?.forEach((f) => f())
    },
    stop() {},
    play() {
      engine.playing = true
      listeners.get('state')?.forEach((f) => f())
    },
    pause() {
      calls.pause++
      engine.playing = false
      listeners.get('state')?.forEach((f) => f())
    },
    seek(sec: number) {
      engine.position = sec
    },
    setVolume() {},
    position: 0,
    duration: 0,
    buffered: 0,
    playing: false,
    waiting: false,
  }
  return { engine, calls, saved: null as unknown }
})

vi.mock('../player/engine', () => ({ engine: h.engine }))
vi.mock('../player/waveform', () => ({ beginWaveform: () => {}, captureSource: () => {} }))
vi.mock('../app/toast', () => ({ toast: () => {} }))
vi.mock('../lib/journal', () => ({ journal: () => {} }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => h.saved, saveJSON: async () => {}, debouncedSaver: () => ({ save() {}, flush() {} }) }))
const track = (id: number) => ({ id, ownerId: 1, key: `1_${id}`, artist: 'A', title: `T${id}`, duration: 100, url: `https://cdn/${id}`, urlFetchedAt: Date.now(), explicit: false, artists: [{ name: 'A' }], playable: true, hasLyrics: false, liked: false }) as Track
vi.mock('../vk/api', () => ({ getByIds: async (ids: { id: number }[]) => ids.map((i) => track(i.id)), getStreamMix: async () => [] }))

const { usePlayer } = await import('../player/store')
const { useDevices, unlinkHere } = await import('./devices')
const { useTogether } = await import('../together/session')
const { startConnect, stopConnect, tickConnect, playOn } = await import('./runtime')

const ME = 'aaaaaaaaaaaaaaaa'
const PHONE = 'bbbbbbbbbbbbbbbb'
const w = (id: number) => ({ owner: 1, id, title: `T${id}`, artist: 'A', duration: 100 })
const presence = (over = {}) => ({ name: 'Телефон', platform: 'android' as const, track: w(9), position: 20, duration: 100, playing: true, since: Date.now(), volume: 0.7, shuffle: false, repeat: 'off' as const, queue: { pos: 0, total: 1 }, ...over })
const settle = () => new Promise((r) => setTimeout(r, 80))

let sent: { msg: ConnectMessage; to?: string }[] = []
let hear: (msg: ConnectMessage, from: string) => void = () => {}

beforeEach(async () => {
  stopConnect()
  sent = []
  h.calls.pause = 0
  h.calls.load.length = 0
  h.engine.playing = false
  h.saved = { deviceId: ME, name: 'Компьютер', code: 'K7QM-2XFD-9WRA-HT4C' }
  usePlayer.setState({ queue: null, current: null, isPlaying: false, remoteName: null, volume: 0.5 })
  useTogether.setState({ role: null })
  await startConnect(async (_code, _me, onMessage) => {
    hear = onMessage
    return { send: (msg, to) => void sent.push({ msg, to }), up: () => true, close() {} }
  })
})

describe('linked devices and the player', () => {
  test('a linked device opens the channel and says who it is', () => {
    expect(sent[0].msg).toMatchObject({ type: 'presence', presence: { name: 'Компьютер', playing: false } })
  })

  test('another device playing while this one is idle: this player becomes its remote', () => {
    hear({ type: 'presence', presence: presence() }, PHONE)
    expect(useDevices.getState().remoteId).toBe(PHONE)
    expect(usePlayer.getState()).toMatchObject({ remoteName: 'Телефон', isPlaying: true })
    expect(usePlayer.getState().current?.key).toBe('1_9')
  })

  test('presses on a remote go to the steered device', () => {
    hear({ type: 'presence', presence: presence() }, PHONE)
    usePlayer.getState().next()
    usePlayer.getState().seek(42)
    expect(sent.filter((s) => s.msg.type === 'command')).toEqual([
      { msg: { type: 'command', action: 'next' }, to: PHONE },
      { msg: { type: 'command', action: 'seek', value: 42 }, to: PHONE },
    ])
  })

  test('a remote announces itself idle, never the track it mirrors', async () => {
    hear({ type: 'presence', presence: presence() }, PHONE)
    await settle()
    await new Promise((r) => setTimeout(r, 300))
    const mine = sent.filter((s) => s.msg.type === 'presence').at(-1)!.msg
    expect(mine).toMatchObject({ presence: { track: null, playing: false } })
  })

  test('one device plays: when the other started later, this one pauses and becomes its remote', async () => {
    usePlayer.getState().playList([track(1), track(2)], 0)
    await settle()
    expect(usePlayer.getState().isPlaying).toBe(true)
    hear({ type: 'presence', presence: presence({ since: Date.now() + 1000 }) }, PHONE)
    expect(h.calls.pause).toBeGreaterThan(0)
    expect(useDevices.getState().remoteId).toBe(PHONE)
  })

  test('«play this» from another device starts here from that second', async () => {
    hear({ type: 'play', tracks: [w(1), w(2)], index: 1, position: 30, playing: true, shuffle: false, repeat: 'all' }, PHONE)
    await settle()
    expect(usePlayer.getState().current?.key).toBe('1_2')
    expect(h.calls.load.at(-1)?.startAt).toBe(30)
    expect(usePlayer.getState().repeat).toBe('all')
  })

  test('pull: this device hands its queue over and pauses', async () => {
    usePlayer.getState().playList([track(1), track(2), track(3)], 1)
    await settle()
    hear({ type: 'pull' }, PHONE)
    const order = sent.find((s) => s.msg.type === 'play')!
    expect(order.to).toBe(PHONE)
    expect(order.msg).toMatchObject({ type: 'play', index: 1 })
    expect(h.calls.pause).toBeGreaterThan(0)
  })

  test('moving the music to another device sends it there and pauses here', async () => {
    usePlayer.getState().playList([track(1)], 0)
    await settle()
    playOn(PHONE)
    expect(sent.find((s) => s.msg.type === 'play')?.to).toBe(PHONE)
    expect(h.calls.pause).toBeGreaterThan(0)
  })

  test('a steered device that went silent lets the remote go, and this player is itself again', async () => {
    usePlayer.getState().playList([track(1)], 0, { paused: true })
    await settle()
    hear({ type: 'presence', presence: presence() }, PHONE)
    expect(usePlayer.getState().remoteName).toBe('Телефон')
    tickConnect(Date.now() + 46_000)
    expect(useDevices.getState().remoteId).toBeNull()
    expect(usePlayer.getState()).toMatchObject({ remoteName: null, volume: 0.5 })
    expect(usePlayer.getState().current?.key).toBe('1_1')
  })

  test('while listening together, other devices neither steer nor take over', async () => {
    useTogether.setState({ role: 'host' })
    hear({ type: 'presence', presence: presence() }, PHONE)
    hear({ type: 'play', tracks: [w(1)], index: 0, position: 0, playing: true, shuffle: false, repeat: 'off' }, PHONE)
    await settle()
    expect(useDevices.getState().remoteId).toBeNull()
    expect(h.calls.load).toEqual([])
  })

  test('unlinking while steering brings this player back as it was', async () => {
    usePlayer.getState().playList([track(1)], 0, { paused: true })
    await settle()
    hear({ type: 'presence', presence: presence() }, PHONE)
    expect(usePlayer.getState().remoteName).toBe('Телефон')
    unlinkHere()
    await settle()
    expect(useDevices.getState().remoteId).toBeNull()
    expect(usePlayer.getState().remoteName).toBeNull()
    expect(usePlayer.getState().current?.key).toBe('1_1')
  })

  test('starting «Слушать вместе» while steering lets the other device go', () => {
    hear({ type: 'presence', presence: presence() }, PHONE)
    useTogether.setState({ role: 'listener' })
    expect(useDevices.getState().remoteId).toBeNull()
    expect(usePlayer.getState().remoteName).toBeNull()
  })

  test('a device heard for the first time gets this one’s presence at once', async () => {
    await new Promise((r) => setTimeout(r, 300))
    sent = []
    hear({ type: 'presence', presence: presence({ playing: false, since: 0 }) }, PHONE)
    await new Promise((r) => setTimeout(r, 350))
    expect(sent.some((s) => s.msg.type === 'presence')).toBe(true)
  })

  test('a seek on the playing device is announced at once, not with the next heartbeat', async () => {
    usePlayer.getState().playList([track(1)], 0)
    await settle()
    await new Promise((r) => setTimeout(r, 300))
    sent = []
    hear({ type: 'command', action: 'seek', value: 42 }, PHONE)
    await new Promise((r) => setTimeout(r, 350))
    expect(sent.find((s) => s.msg.type === 'presence')?.msg).toMatchObject({ presence: { position: 42 } })
  })

  test('a seek on the remote stays where it was dragged until the device answers', async () => {
    hear({ type: 'presence', presence: presence({ position: 20 }) }, PHONE)
    usePlayer.getState().seek(70)
    await new Promise((r) => setTimeout(r, 700))
    expect(usePlayer.getState().position).toBeGreaterThanOrEqual(70)
  })

  test('a volume drag on the remote is thinned out, and its last value always goes', async () => {
    hear({ type: 'presence', presence: presence() }, PHONE)
    sent = []
    for (let i = 1; i <= 30; i++) usePlayer.getState().setVolume(i / 30)
    await new Promise((r) => setTimeout(r, 400))
    const volumes = sent.filter((s) => s.msg.type === 'command' && s.msg.action === 'volume')
    expect(volumes.length).toBeLessThanOrEqual(4)
    expect(volumes.at(-1)?.msg).toMatchObject({ value: 1 })
  })

  test('VK Mix moves as VK Mix, not as a list that runs out', async () => {
    hear({ type: 'play', tracks: [w(1), w(2)], index: 0, position: 0, playing: true, shuffle: false, repeat: 'off', mix: true, label: 'VK Микс' }, PHONE)
    await settle()
    expect(usePlayer.getState().source).toMatchObject({ kind: 'mix', label: 'VK Микс' })
  })

  test('picking a track on the remote keeps the shuffle mode of the steered device', () => {
    hear({ type: 'presence', presence: presence({ shuffle: true }) }, PHONE)
    usePlayer.getState().playList([track(1), track(2), track(3)], 1)
    const order = sent.find((s) => s.msg.type === 'play')!.msg
    expect(order).toMatchObject({ shuffle: true, index: 1 })
    expect(order).not.toHaveProperty('randomStart')
  })
})
