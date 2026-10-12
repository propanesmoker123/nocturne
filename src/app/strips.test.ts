import { describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import { STRIP_SIZE, fullListRoute } from './strips'

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
