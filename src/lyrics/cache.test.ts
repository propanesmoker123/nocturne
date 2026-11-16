import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Lyrics } from '../vk/models'
import { clearCachedLyrics, readCachedLyrics, writeCachedLyrics } from './cache'

const DAY_MS = 24 * 60 * 60 * 1000

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null
    },
    key(index: number) {
      return [...map.keys()][index] ?? null
    },
    removeItem(k: string) {
      map.delete(k)
    },
    setItem(k: string, v: string) {
      map.set(k, String(v))
    },
  }
}

const sampleLyrics: Lyrics = {
  synced: true,
  source: 'lrclib',
  lines: [
    { text: 'Line 1', begin: 1000, end: 2500 },
    { text: 'Line 2', begin: 2500 },
  ],
  credits: 'Текст: LRCLIB',
}

let origStorage: unknown

beforeEach(() => {
  origStorage = (globalThis as Record<string, unknown>).localStorage
  ;(globalThis as Record<string, unknown>).localStorage = makeMemoryStorage()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as Record<string, unknown>).localStorage = origStorage
})

describe('lyrics cache', () => {
  test('returns undefined when absent and reads written hits within 30 days', () => {
    expect(readCachedLyrics('vk_1')).toBeUndefined()
    writeCachedLyrics('vk_1', sampleLyrics)
    expect(readCachedLyrics('vk_1')).toEqual(sampleLyrics)

    vi.advanceTimersByTime(29 * DAY_MS)
    expect(readCachedLyrics('vk_1')).toEqual(sampleLyrics)

    vi.advanceTimersByTime(2 * DAY_MS)
    expect(readCachedLyrics('vk_1')).toBeUndefined()
  })

  test('caches negative misses (null) for 1 day then expires', () => {
    writeCachedLyrics('vk_miss', null)
    expect(readCachedLyrics('vk_miss')).toBeNull()

    vi.advanceTimersByTime(23 * 60 * 60 * 1000)
    expect(readCachedLyrics('vk_miss')).toBeNull()

    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    expect(readCachedLyrics('vk_miss')).toBeUndefined()
  })

  test('evicts oldest entries when exceeding 400 records', () => {
    for (let i = 0; i < 405; i++) {
      vi.advanceTimersByTime(10)
      writeCachedLyrics(`k_${i}`, { ...sampleLyrics, lines: [{ text: `L${i}`, begin: 100 }] })
    }

    expect(readCachedLyrics('k_0')).toBeUndefined()
    expect(readCachedLyrics('k_4')).toBeUndefined()
    expect(readCachedLyrics('k_5')).toBeDefined()
    expect(readCachedLyrics('k_404')?.lines[0].text).toBe('L404')
  })

  test('tolerates corrupted JSON and supports clearing entries', () => {
    ;(globalThis as { localStorage: Storage }).localStorage.setItem('nocturne:lyrics:v4', '{broken-json')
    expect(readCachedLyrics('any')).toBeUndefined()

    writeCachedLyrics('vk_2', sampleLyrics)
    expect(readCachedLyrics('vk_2')).toEqual(sampleLyrics)
    clearCachedLyrics('vk_2')
    expect(readCachedLyrics('vk_2')).toBeUndefined()
  })
})
