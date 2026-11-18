import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearScCache,
  clearVkCache,
  hydrateScSnapshots,
  hydrateVkSnapshots,
  installWarmCacheObserver,
  readScSessionSnapshot,
  readVkSessionSnapshot,
  writeScQuerySnapshot,
  writeScSessionSnapshot,
  writeVkQuerySnapshot,
  writeVkSessionSnapshot,
} from './warmCache'

function createMemStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => {
      data.delete(k)
    },
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
  }
}

describe('warmCache for VK and SoundCloud', () => {
  const prevStorage = (globalThis as { localStorage?: Storage }).localStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-18T06:00:00Z'))
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createMemStorage(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (prevStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: prevStorage,
      })
    }
  })

  test('persists and clears VK & SC session snapshots', () => {
    expect(readVkSessionSnapshot()).toBeNull()
    writeVkSessionSnapshot(true, 42, { id: 42, name: 'Ivan', photo: 'https://vk.com/p.jpg' })
    expect(readVkSessionSnapshot()).toEqual({
      signedIn: true,
      userId: 42,
      user: { id: 42, name: 'Ivan', photo: 'https://vk.com/p.jpg' },
      at: Date.now(),
    })
    clearVkCache()
    expect(readVkSessionSnapshot()).toBeNull()

    expect(readScSessionSnapshot()).toBeNull()
    writeScSessionSnapshot(true, { id: 7, name: 'listener', avatar: null, permalink: 'https://soundcloud.com/listener' })
    expect(readScSessionSnapshot()).toEqual({
      signedIn: true,
      user: { id: 7, name: 'listener', avatar: null, permalink: 'https://soundcloud.com/listener' },
      at: Date.now(),
    })
    clearScCache()
    expect(readScSessionSnapshot()).toBeNull()
  })

  test('hydrates flat & infinite query snapshots and persists updates via observer', () => {
    const qc1 = new QueryClient()
    const off = installWarmCacheObserver(qc1)
    const catalogData = [{ id: 'home', title: 'Главная', blocks: [] }]
    const infiniteTracks = {
      pages: [
        { count: 100, items: [{ key: '1_1', title: 'Track 1' }] },
        { count: 100, items: [{ key: '1_2', title: 'Track 2' }] },
      ],
      pageParams: [0, 50],
    }
    const scSelections = [{ id: 'sel1', title: 'Mixed for you', playlists: [] }]

    qc1.setQueryData(['catalog', 42], catalogData)
    qc1.setQueryData(['tracks', 42], infiniteTracks)
    qc1.setQueryData(['sc-selections'], scSelections)
    qc1.setQueryData(['unrelated-key'], { foo: 'bar' })
    off()

    const qc2 = new QueryClient()
    expect(hydrateVkSnapshots(qc2)).toBe(2)
    expect(hydrateScSnapshots(qc2)).toBe(1)

    expect(qc2.getQueryData(['catalog', 42])).toEqual(catalogData)
    expect(qc2.getQueryData(['tracks', 42])).toEqual({
      pages: [infiniteTracks.pages[0]],
      pageParams: [0],
    })
    expect(qc2.getQueryData(['sc-selections'])).toEqual(scSelections)
    expect(qc2.getQueryData(['unrelated-key'])).toBeUndefined()
  })

  test('manual writeVkQuerySnapshot & writeScQuerySnapshot support legacy single-page infinite hydration', () => {
    writeVkQuerySnapshot(['playlist-tracks', 1, 2], { count: 1, items: [] }, { infinite: true })
    writeScQuerySnapshot(['sc-likes', 7], { items: [] }, { infinite: true })

    const qc = new QueryClient()
    expect(hydrateVkSnapshots(qc)).toBe(1)
    expect(hydrateScSnapshots(qc)).toBe(1)
    expect(qc.getQueryData(['playlist-tracks', 1, 2])).toEqual({ pages: [{ count: 1, items: [] }], pageParams: [undefined] })
    expect(qc.getQueryData(['sc-likes', 7])).toEqual({ pages: [{ items: [] }], pageParams: [undefined] })
  })
})
