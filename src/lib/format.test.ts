import { describe, expect, test } from 'vitest'
import { filterTracks, formatCount, formatLongDuration, formatTime, normalizeSearch, pluralRu } from './format'

describe('formatTime', () => {
  test('formats minutes and seconds', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(75.9)).toBe('1:15')
    expect(formatTime(600)).toBe('10:00')
  })

  test('adds hours when needed', () => {
    expect(formatTime(3725)).toBe('1:02:05')
  })

  test('treats invalid input as zero', () => {
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(-4)).toBe('0:00')
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('formatCount', () => {
  test('uses russian decimal comma and K/M suffixes', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1000)).toBe('1K')
    expect(formatCount(1500)).toBe('1,5K')
    expect(formatCount(12_345)).toBe('12,3K')
    expect(formatCount(150_000)).toBe('150K')
    expect(formatCount(2_300_000)).toBe('2,3M')
  })
})

describe('pluralRu', () => {
  test('picks the right russian plural form', () => {
    const f = (n: number) => pluralRu(n, 'трек', 'трека', 'треков')
    expect(f(1)).toBe('трек')
    expect(f(2)).toBe('трека')
    expect(f(5)).toBe('треков')
    expect(f(11)).toBe('треков')
    expect(f(14)).toBe('треков')
    expect(f(21)).toBe('трек')
    expect(f(22)).toBe('трека')
    expect(f(111)).toBe('треков')
  })
})

describe('normalizeSearch', () => {
  test('lowercases, maps ё to е and collapses whitespace', () => {
    expect(normalizeSearch('  ЁлКа   Палка ')).toBe('елка палка')
  })
})

describe('filterTracks', () => {
  test('returns the same list for an empty query', () => {
    const list = [{ title: 'a', artist: 'b' }]
    expect(filterTracks(list, '   ')).toBe(list)
  })

  test('matches title or artist case-insensitively with ё/е equivalence', () => {
    const list = [
      { title: 'Ёлка', artist: 'X' },
      { title: 'Other', artist: 'Ёжик' },
      { title: 'Nope', artist: 'Nope' },
    ]
    expect(filterTracks(list, 'ЕЛКА')).toEqual([list[0]])
    expect(filterTracks(list, 'ежик')).toEqual([list[1]])
  })

  test('requires every word to match somewhere in title or artist', () => {
    const list = [
      { title: 'Группа крови', artist: 'Кино' },
      { title: 'Кукушка', artist: 'Кино' },
    ]
    expect(filterTracks(list, 'кино группа')).toEqual([list[0]])
  })

  test('is fast on 10k tracks', () => {
    const list = Array.from({ length: 10000 }, (_, i) => ({ title: i === 9999 ? 'Ёлка' : `t${i}`, artist: 'X' }))
    const t0 = performance.now()
    const r = filterTracks(list, 'ЕЛКА')
    expect(performance.now() - t0).toBeLessThan(50)
    expect(r).toHaveLength(1)
  })
})

describe('formatLongDuration', () => {
  test('uses minutes below an hour and hours plus minutes above', () => {
    expect(formatLongDuration(0)).toBe('0 мин')
    expect(formatLongDuration(42 * 60 + 20)).toBe('42 мин')
    expect(formatLongDuration(72 * 60)).toBe('1 ч 12 мин')
    expect(formatLongDuration(2 * 3600 + 10)).toBe('2 ч')
  })
})
