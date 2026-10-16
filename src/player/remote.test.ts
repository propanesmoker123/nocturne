import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const calls = { load: [] as string[], pause: 0 }
  const engine = {
    lastError: '',
    onSource: null,
    on(ev: string, fn: () => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(fn)
      return () => listeners.get(ev)!.delete(fn)
    },
    load(url: string) {
      calls.load.push(url)
    },
    stop() {},
    play() {},
    pause() {
      calls.pause++
    },
    seek() {},
    setVolume() {},
    position: 0,
    duration: 0,
    buffered: 0,
    playing: false,
    waiting: false,
  }
  const saves: unknown[] = []
  return { engine, calls, saves, fire: (ev: string) => listeners.get(ev)?.forEach((f) => f()) }
})

vi.mock('./engine', () => ({ engine: h.engine }))
vi.mock('./waveform', () => ({ beginWaveform: () => {}, captureSource: () => {} }))
vi.mock('../app/toast', () => ({ toast: () => {} }))
vi.mock('../lib/journal', () => ({ journal: () => {} }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => null, saveJSON: async () => {}, debouncedSaver: () => ({ save: (d: unknown) => h.saves.push(d), flush() {} }) }))
vi.mock('../vk/api', () => ({ getByIds: async (ts: Track[]) => ts, getStreamMix: async () => [] }))

const { usePlayer, setPlayerRemote, showRemote, initPlayer } = await import('./store')

const t = (id: number) => ({ id, ownerId: 1, key: `1_${id}`, artist: 'A', title: `T${id}`, duration: 100, url: `https://cdn/${id}`, urlFetchedAt: Date.now(), explicit: false, artists: [{ name: 'A' }], playable: true, hasLyrics: false, liked: false }) as Track
const settle = () => new Promise((r) => setTimeout(r, 50))
const remote = () => {
  const got: string[] = []
  const rec = (name: string) => (...args: unknown[]) => void got.push(args.length ? `${name}:${JSON.stringify(args[0])}` : name)
  return { got, r: { toggle: rec('toggle'), play: rec('play'), pause: rec('pause'), next: rec('next'), prev: rec('prev'), seek: rec('seek'), setVolume: rec('volume'), toggleShuffle: rec('shuffle'), cycleRepeat: rec('repeat'), playList: rec('playList'), playMix: rec('mix') } }
}
const VIEW = { name: 'Телефон', track: t(9), position: 12, duration: 100, playing: true, volume: 0.9, shuffle: true, repeat: 'all' as const }

beforeEach(() => {
  setPlayerRemote(null)
  h.calls.load.length = 0
  usePlayer.setState({ queue: null, current: null, volume: 0.5, shuffle: false, repeat: 'off', remoteName: null })
})

describe('the remote mode of the player', () => {
  test('presses go to the other device, nothing is loaded here', async () => {
    const { got, r } = remote()
    setPlayerRemote(r)
    const p = usePlayer.getState()
    p.toggle()
    p.next()
    p.prev()
    p.seek(30)
    p.setVolume(0.3)
    p.toggleShuffle()
    p.cycleRepeat()
    const list = [t(1), t(2)]
    p.playList(list, 1)
    await settle()
    expect(got).toEqual(['toggle', 'next', 'prev', 'seek:30', 'volume:0.3', 'shuffle', 'repeat', `playList:${JSON.stringify(list)}`])
    expect(h.calls.load).toEqual([])
  })

  test('the player shows the other device, and leaving restores this one as it was', async () => {
    usePlayer.getState().playList([t(1), t(2)], 0, { paused: true })
    await settle()
    setPlayerRemote(remote().r)
    showRemote(VIEW)
    expect(usePlayer.getState()).toMatchObject({ remoteName: 'Телефон', isPlaying: true, position: 12, volume: 0.9, shuffle: true, repeat: 'all', queue: null })
    expect(usePlayer.getState().current?.key).toBe('1_9')
    setPlayerRemote(null)
    expect(usePlayer.getState()).toMatchObject({ remoteName: null, isPlaying: false, volume: 0.5, shuffle: false, repeat: 'off' })
    expect(usePlayer.getState().current?.key).toBe('1_1')
    expect(usePlayer.getState().queue?.items).toHaveLength(2)
  })

  test('this device’s engine stays out of it', () => {
    setPlayerRemote(remote().r)
    showRemote(VIEW)
    h.engine.playing = false
    h.fire('state')
    h.fire('time')
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().position).toBe(12)
  })

  test('the session is not saved while the player shows another device', async () => {
    vi.stubGlobal('window', { addEventListener() {} })
    await initPlayer()
    usePlayer.getState().playList([t(1)], 0, { paused: true })
    await settle()
    setPlayerRemote(remote().r)
    const before = h.saves.length
    showRemote(VIEW)
    showRemote({ ...VIEW, track: t(10) })
    expect(h.saves.length).toBe(before)
  })
})
