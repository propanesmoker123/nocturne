import { describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import { sameSong, splitOwnFirst } from './search'

const t = (key: string, title: string, artist: string, extra: Partial<Track> = {}): Track =>
  ({ key, id: 1, ownerId: 1, title, artist, duration: 200, playable: true, liked: false, artists: [], urlFetchedAt: 0, hasLyrics: false, explicit: false, ...extra }) as Track

describe('sameSong', () => {
  test('matches copies by title, artist and near-equal length, ignoring case and ё', () => {
    expect(sameSong(t('1_1', 'Ёлка', 'Кино'), t('2_2', 'елка', 'кино', { duration: 201 }))).toBe(true)
    expect(sameSong(t('1_1', 'Ёлка', 'Кино'), t('2_2', 'Ёлка', 'Кино', { duration: 260 }))).toBe(false)
    expect(sameSong(t('1_1', 'A', 'B', { releaseId: 'r' }), t('2_2', 'Other', 'X', { releaseId: 'r' }))).toBe(true)
  })
})

describe('splitOwnFirst', () => {
  const library = [t('9_1', 'Группа крови', 'Кино'), t('9_2', 'Кукушка', 'Кино'), t('9_3', 'Lose Yourself', 'Eminem')]
  const global = [t('5_1', 'Группа крови', 'Кино'), t('5_2', 'Группа крови (live)', 'Кино'), t('5_3', 'Кровь', 'Другой')]

  test('lists library matches first and drops their duplicates from VK results', () => {
    const r = splitOwnFirst(library, global, 'группа крови')
    expect(r.own.map((x) => x.key)).toEqual(['9_1'])
    expect(r.others.map((x) => x.key)).toEqual(['5_2', '5_3'])
  })

  test('leaves VK results untouched when nothing in the library matches', () => {
    const r = splitOwnFirst(library, global, 'земфира')
    expect(r.own).toEqual([])
    expect(r.others).toBe(global)
  })
})
