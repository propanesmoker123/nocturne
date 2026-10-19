import { formatPlaysShort, pluralRu } from '../lib/format'
import type { ScUser } from './normalize'

/** The tabs of a SoundCloud profile, in the order shown. */
export type ProfileTab = 'popular' | 'tracks' | 'reposts' | 'likes' | 'playlists'
export const TAB_ORDER: ProfileTab[] = ['popular', 'tracks', 'reposts', 'likes', 'playlists']
export const TAB_LABEL: Record<ProfileTab, string> = { popular: 'Популярное', tracks: 'Треки', reposts: 'Репосты', likes: 'Лайки', playlists: 'Плейлисты' }

/** What the first page of a tab gave. */
export type TabState = 'loading' | 'empty' | 'some' | 'error'

/** The tabs worth showing: ones with something, and ones that failed (they can be retried). */
export const visibleTabs = (s: Record<ProfileTab, TabState>): ProfileTab[] => TAB_ORDER.filter((t) => s[t] === 'some' || s[t] === 'error')

/**
 * The tab a profile opens on: the first with something, chosen only once every tab before it
 * has answered (so it does not jump); a failed one when nothing else came; none while waiting.
 */
export function openTab(s: Record<ProfileTab, TabState>): ProfileTab | null {
  for (const t of TAB_ORDER) {
    if (s[t] === 'loading') return null
    if (s[t] === 'some') return t
  }
  return TAB_ORDER.find((t) => s[t] === 'error') ?? null
}

const counted = (n: number, one: string, few: string, many: string) => (n >= 1000 ? `${formatPlaysShort(n)} ${many}` : `${n} ${pluralRu(n, one, few, many)}`)

/** «Москва · 6,3 тыс. подписчиков · 11 подписок · 0 треков»: what is known of it. */
export function countsLine(u: ScUser): string {
  return [
    u.city,
    u.followers !== undefined ? counted(u.followers, 'подписчик', 'подписчика', 'подписчиков') : null,
    u.followings !== undefined ? counted(u.followings, 'подписка', 'подписки', 'подписок') : null,
    u.trackCount !== undefined ? counted(u.trackCount, 'трек', 'трека', 'треков') : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Only someone else can be followed, and only while signed in. */
export const canFollow = (profileId: number, meId: number) => meId > 0 && profileId !== meId
