import type { Block, Track } from '../vk/models'
import type { Route } from './router'

/** Track strips on «Для вас» and «Обзор» show a short preview; the full list is a page of its own. */
export const STRIP_SIZE = 18

/** About as many cards as a strip shows at once; a longer card strip also gets a page. */
export const CARDS_SHOWN = 4

/** Blocks that came without a «Показать все» section, kept while the app runs so their page can show them whole. */
const blocks = new Map<string, Block>()
export const rememberBlock = (b: Block) => void blocks.set(b.id, b)
export const rememberedBlock = (id: string): Block | undefined => blocks.get(id)

/**
 * Where a strip's title leads: your own tracks open «Моя музыка», a VK block with «Показать все»
 * opens that section, a long block without one opens its own list; otherwise nowhere.
 */
export function fullListRoute(block: { id: string; title: string; tracks: Track[]; more?: string }, me: number): Route | null {
  const title = block.title || 'Треки'
  if (block.tracks.length > 0 && block.tracks.every((t) => t.ownerId === me)) return { name: 'library' }
  if (block.more) return { name: 'section', id: block.more, title }
  if (block.tracks.length > STRIP_SIZE) return { name: 'section', block: block.id, title }
  return null
}

/** Where a card strip's title leads («Слушайте друг друга», albums, playlists): VK's «Показать все»
 *  section, or the strip's own cards when there are more than fit; otherwise nowhere. */
export function fullCardsRoute(block: { id: string; title: string; count: number; more?: string }): Route | null {
  const title = block.title || 'Плейлисты'
  if (block.more) return { name: 'section', id: block.more, title, cards: true }
  if (block.count > CARDS_SHOWN) return { name: 'section', block: block.id, title, cards: true }
  return null
}
