import { describe, expect, test } from 'vitest'
import { IDLE_REMOTE_MS, OFFLINE_MS, ORDER_BUDGET, fitOrder, onlineDevices, playingDevice, queueWindow, remoteHolds, remotePosition, shouldYield, type SeenDevice } from './logic'
import type { Presence } from './protocol'

const P: Presence = { name: 'ПК', platform: 'desktop', track: null, position: 10, duration: 100, playing: true, since: 1000, volume: 1, shuffle: false, repeat: 'off', queue: { pos: 0, total: 1 } }
const dev = (id: string, over: Partial<Presence> = {}, seen = 0, lastPlaying = 0): SeenDevice => ({ id, presence: { ...P, ...over }, seen, lastPlaying })

describe('the device remote rules', () => {
  test('a device that said nothing for 45 s is gone', () => {
    const list = onlineDevices({ a: dev('a', { name: 'Телефон' }, 0), b: dev('b', { name: 'Компьютер' }, 50_000) }, OFFLINE_MS + 1)
    expect(list.map((d) => d.id)).toEqual(['b'])
  })

  test('the playing device is the one that started last', () => {
    expect(playingDevice([dev('a', { since: 5 }), dev('b', { since: 9 }), dev('c', { playing: false, since: 0 })])?.id).toBe('b')
    expect(playingDevice([dev('c', { playing: false, since: 0 })])).toBeNull()
  })

  test('one device plays: this one stops when another started later', () => {
    expect(shouldYield({ id: 'a', playing: true, since: 1000 }, dev('b', { since: 2000 }))).toBe(true)
    expect(shouldYield({ id: 'a', playing: true, since: 3000 }, dev('b', { since: 2000 }))).toBe(false)
    expect(shouldYield({ id: 'a', playing: false, since: 0 }, dev('b', { since: 2000 }))).toBe(false)
    expect(shouldYield({ id: 'a', playing: true, since: 1000 }, dev('b', { playing: false, since: 0 }))).toBe(false)
  })

  test('a tie goes to the larger id: exactly one of the two yields', () => {
    expect(shouldYield({ id: 'a', playing: true, since: 1000 }, dev('b', { since: 1000 }))).toBe(true)
    expect(shouldYield({ id: 'b', playing: true, since: 1000 }, dev('a', { since: 1000 }))).toBe(false)
  })

  test('a queue window keeps the current track, mostly what comes after it', () => {
    const items = Array.from({ length: 200 }, (_, i) => i)
    expect(queueWindow(items, 100, 40)).toEqual({ items: items.slice(90, 130), index: 10 })
    expect(queueWindow(items, 2, 40)).toEqual({ items: items.slice(0, 40), index: 2 })
    expect(queueWindow(items, 199, 40)).toEqual({ items: items.slice(160, 200), index: 39 })
    expect(queueWindow([7, 8], 1, 40)).toEqual({ items: [7, 8], index: 1 })
  })

  test('the steered position runs on between messages, but not past the end or while paused', () => {
    expect(remotePosition({ ...P, position: 10 }, 0, 5000)).toBe(15)
    expect(remotePosition({ ...P, position: 98 }, 0, 5000)).toBe(100)
    expect(remotePosition({ ...P, playing: false, position: 10 }, 0, 5000)).toBe(10)
  })

  test('a steered device holds the remote while online and not paused for 10 minutes', () => {
    expect(remoteHolds(dev('a', {}, 0, 0), 1000)).toBe(true)
    expect(remoteHolds(dev('a', {}, 0, 0), OFFLINE_MS + 1)).toBe(false)
    expect(remoteHolds(dev('a', { playing: false }, IDLE_REMOTE_MS, 0), IDLE_REMOTE_MS + 1)).toBe(false)
    expect(remoteHolds(undefined, 0)).toBe(false)
  })

  test('an order with long titles shrinks to fit one sealed message, keeping the current track', () => {
    const long = (i: number) => ({ owner: 1, id: i, title: 'Очень длинное название классического произведения '.repeat(4).slice(0, 200), artist: 'Оркестр и солисты '.repeat(12).slice(0, 200), duration: 300 })
    const tracks = Array.from({ length: 40 }, (_, i) => long(i))
    const fitted = fitOrder({ tracks, index: 10, position: 5 })
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(ORDER_BUDGET)
    expect(fitted.tracks[fitted.index]).toBe(tracks[10])
    expect(fitted.tracks.length).toBeGreaterThan(1)
    const small = { tracks: [long(1)], index: 0 }
    expect(fitOrder(small)).toEqual(small)
  })
})
