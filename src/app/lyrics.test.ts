import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({ searched: [] as string[], found: [] as Track[], lyricsOf: [] as string[] }))

vi.mock('../vk/api', () => ({
  searchTracks: async (q: string) => {
    h.searched.push(q)
    return { count: h.found.length, items: h.found }
  },
  getLyrics: async (t: Track) => {
    h.lyricsOf.push(t.key)
    return { synced: false, lines: [{ text: 'la' }] }
  },
}))

const { findLyrics, lyricsMatch } = await import('./lyrics')

const track = (over: Partial<Track>): Track => ({ id: 1, ownerId: 1, key: '1_1', artist: 'A', title: 'T', duration: 148, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false, ...over })
const sc = (over: Partial<Track> = {}) => track({ service: 'sc', key: 'sc_9', artist: 'XXXTENTACION', title: 'Fuck Love (feat. Trippie Redd)', duration: 148, ...over })

beforeEach(() => {
  h.searched.length = 0
  h.found = []
  h.lyricsOf.length = 0
})

describe('lyrics for a SoundCloud track come from the same song in VK', () => {
  test('the same song matches through «feat.», case and a second or two of length', () => {
    expect(lyricsMatch(sc(), track({ artist: 'XXXTENTACION, Trippie Redd', title: 'Fuck Love', duration: 147 }))).toBe(true)
  })

  test('«Artist - Title» uploads match by the title part', () => {
    expect(lyricsMatch(sc({ artist: 'some label', title: 'XXXTENTACION - Fuck Love' }), track({ artist: 'XXXTENTACION', title: 'Fuck Love' }))).toBe(true)
  })

  test('another song, another artist or another length does not match', () => {
    expect(lyricsMatch(sc(), track({ artist: 'XXXTENTACION', title: 'Revenge', duration: 148 }))).toBe(false)
    expect(lyricsMatch(sc(), track({ artist: 'Someone Else', title: 'Fuck Love', duration: 148 }))).toBe(false)
    expect(lyricsMatch(sc(), track({ artist: 'XXXTENTACION', title: 'Fuck Love', duration: 170 }))).toBe(false)
  })

  test('the first matching VK track with lyrics gives them', async () => {
    h.found = [track({ key: '2_1', artist: 'XXXTENTACION', title: 'Fuck Love', hasLyrics: false }), track({ key: '2_2', artist: 'XXXTENTACION', title: 'Fuck Love', hasLyrics: true })]
    const got = await findLyrics(sc())
    expect(got?.lines[0].text).toBe('la')
    expect(h.lyricsOf).toEqual(['2_2'])
    expect(h.searched).toEqual(['XXXTENTACION Fuck Love'])
  })

  test('no match: no lyrics, and nothing else is fetched', async () => {
    h.found = [track({ key: '2_3', artist: 'Other', title: 'Other', hasLyrics: true })]
    expect(await findLyrics(sc())).toBeNull()
    expect(h.lyricsOf).toEqual([])
  })

  test('a VK track keeps its own lyrics, without a search', async () => {
    await findLyrics(track({ key: '3_1', hasLyrics: true }))
    expect(h.lyricsOf).toEqual(['3_1'])
    expect(h.searched).toEqual([])
  })
})
