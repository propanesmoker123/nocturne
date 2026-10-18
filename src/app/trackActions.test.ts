import { expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

vi.mock('../player/store', () => ({ usePlayer: { getState: () => ({ queue: null }) } }))

const { trackMenuItems } = await import('./trackActions')

const labels = (t: Track) => trackMenuItems(t).flatMap((i) => ('label' in i && i.label ? [i.label] : []))

test("a SoundCloud track's menu has no VK-only items", () => {
  const t = { service: 'sc', id: 402, ownerId: 5, key: 'sc_402', artist: 'A', title: 'T', duration: 1, urlFetchedAt: 0, explicit: false, artists: [{ id: '5', name: 'A' }], playable: true, hasLyrics: false, liked: false, permalink: 'https://soundcloud.com/a/t', album: { id: 1, ownerId: 1, title: 'x' } } as Track
  const got = labels(t)
  for (const vkOnly of ['Добавить в плейлист', 'Отправить другу', 'Перейти к альбому', 'Добавить в Мою музыку']) expect(got).not.toContain(vkOnly)
  expect(got).toContain('Нравится')
  expect(got).toContain('Открыть в SoundCloud')
  expect(got).toContain('Скопировать ссылку')
  expect(labels({ ...t, liked: true })).toContain('Убрать из лайков')
})

test("every service's track menu offers a Nocturne album", async () => {
  const vkTrack = { id: 1, ownerId: 5, key: '5_1', artist: 'A', title: 'T', duration: 1, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false } as Track
  for (const t of [vkTrack, { ...vkTrack, service: 'sc', key: 'sc_1', permalink: 'https://soundcloud.com/a/t' } as Track]) {
    const item = trackMenuItems(t).find((i) => i.label === 'Добавить в альбом Nocturne')
    expect(item?.submenu).toBeDefined()
    expect((await item!.submenu!())[0].label).toBe('Новый альбом…')
  }
})
