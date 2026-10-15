import { describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import { CARDS_SHOWN, STRIP_SIZE, fullCardsRoute, fullListRoute } from './strips'

const ME = 7
const t = (owner: number, id: number) => ({ key: `${owner}_${id}`, ownerId: owner, id }) as Track
const many = (owner: number, n: number) => Array.from({ length: n }, (_, i) => t(owner, i))

describe('where a strip title leads', () => {
  test('a strip of your own tracks opens «Моя музыка»', () => {
    expect(fullListRoute({ id: 'b', title: 'Мои треки', tracks: many(ME, 12), more: 'S' }, ME)).toEqual({ name: 'library' })
  })

  test('a VK block with «Показать все» opens that section', () => {
    expect(fullListRoute({ id: 'b', title: 'Похоже на «Кварц»', tracks: [t(1, 1), t(ME, 2)], more: 'SEC' }, ME)).toEqual({
      name: 'section',
      id: 'SEC',
      title: 'Похоже на «Кварц»',
    })
  })

  test('a long block without a section opens its own full list', () => {
    expect(fullListRoute({ id: 'b9', title: '', tracks: many(1, STRIP_SIZE + 1) }, ME)).toEqual({ name: 'section', block: 'b9', title: 'Треки' })
  })

  test('a short block with nothing more to show leads nowhere', () => {
    expect(fullListRoute({ id: 'b', title: 'Новинки', tracks: many(1, STRIP_SIZE) }, ME)).toBe(null)
    expect(fullListRoute({ id: 'b', title: 'Пусто', tracks: [] }, ME)).toBe(null)
  })
})

describe('where a card strip title leads («Слушайте друг друга», albums, playlists)', () => {
  test('VK «Показать все» opens that section, as cards', () => {
    expect(fullCardsRoute({ id: 'r', title: 'Слушайте друг друга', count: 6, more: 'ALL' })).toEqual({ name: 'section', id: 'ALL', title: 'Слушайте друг друга', cards: true })
  })

  test('without one, a strip longer than a screen opens its own cards; a short one stays a strip', () => {
    expect(fullCardsRoute({ id: 'r', title: '', count: CARDS_SHOWN + 1 })).toEqual({ name: 'section', block: 'r', title: 'Плейлисты', cards: true })
    expect(fullCardsRoute({ id: 'r', title: 'Новинки', count: CARDS_SHOWN })).toBe(null)
  })
})
