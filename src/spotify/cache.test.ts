import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearSpotifyCache,
  hydrateSpotifySnapshots,
  readSpotifySessionSnapshot,
  writeSpotifyQuerySnapshot,
  writeSpotifySessionSnapshot,
} from './cache'
import { spKeys } from './queries'

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

describe('spotify cold-start snapshot cache', () => {
  const prevStorage = (globalThis as { localStorage?: Storage }).localStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'))
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

  test('persists and expires session snapshot cleanly', () => {
    expect(readSpotifySessionSnapshot()).toBeNull()
    writeSpotifySessionSnapshot(true, { id: 'u1', name: 'Alex', avatar: 'https://i.scdn.co/a.jpg' })
    expect(readSpotifySessionSnapshot()).toEqual({
      signedIn: true,
      user: { id: 'u1', name: 'Alex', avatar: 'https://i.scdn.co/a.jpg' },
      at: Date.now(),
    })

    // Clearing signed-in flag removes persisted session immediately
    writeSpotifySessionSnapshot(false, null)
    expect(readSpotifySessionSnapshot()).toBeNull()
  })

  test('hydrates flat & infinite query snapshots as stale so UI renders instantaneously and revalidates', () => {
    const qc = new QueryClient()
    const homeData = { greeting: 'Добрый вечер', sections: [], spotlights: [], topTracks: [], recentTracks: [], topArtists: [], playlists: [] }
    const likesPage = { items: [{ key: 'sp_1', id: 1, ownerId: 0, artist: 'A', title: 'B', duration: 180 }], total: 1 }

    writeSpotifyQuerySnapshot(spKeys.home(), homeData)
    writeSpotifyQuerySnapshot(spKeys.likes(), likesPage, { infinite: true })

    const count = hydrateSpotifySnapshots(qc)
    expect(count).toBe(2)
    expect(qc.getQueryData(spKeys.home())).toEqual(homeData)
    expect(qc.getQueryData(spKeys.likes())).toEqual({
      pages: [likesPage],
      pageParams: [0],
    })

    // Marked older than 60s staleTime so background refetch still runs once live webview finishes
    const homeState = qc.getQueryState(spKeys.home())
    expect(Date.now() - (homeState?.dataUpdatedAt ?? 0)).toBeGreaterThanOrEqual(120_000)
  })

  test('clearSpotifyCache wipes both session and snapshots on logout', () => {
    writeSpotifySessionSnapshot(true, { id: 'u1', name: 'Alex' })
    writeSpotifyQuerySnapshot(spKeys.myPlaylists(), [{ id: 1, title: 'Mix' }])

    clearSpotifyCache()
    const qc = new QueryClient()
    expect(readSpotifySessionSnapshot()).toBeNull()
    expect(hydrateSpotifySnapshots(qc)).toBe(0)
  })
})
