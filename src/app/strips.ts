import type { Track } from '../vk/models'
import type { Route } from './router'

/** Track strips on «Для вас» and «Обзор» show a short preview; the full list is a page of its own. */
export const STRIP_SIZE = 18

/** Lists of blocks that came without a «Показать все» section, kept while the app runs. */
const blockLists = new Map<string, Track[]>()
export const rememberBlock = (id: string, tracks: Track[]) => void blockLists.set(id, tracks)
export const rememberedBlock = (id: string): Track[] => blockLists.get(id) ?? []

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
