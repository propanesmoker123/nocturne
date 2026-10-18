import { create } from 'zustand'
import { serviceOf, type ServiceId, type Track } from '../vk/models'

export type Route =
  | { name: 'home' }
  | { name: 'explore' }
  | { name: 'search'; q?: string }
  | { name: 'library' }
  | { name: 'playlists' }
  | { name: 'playlist'; ownerId: number; id: number; accessKey?: string }
  | { name: 'friends' }
  | { name: 'friend'; id: number; title?: string }
  | { name: 'artist'; id?: string; artist: string }
  | { name: 'recent' }
  /** Everything behind a strip: a VK catalog section (`id`) or a block's own list (`block`); `cards` — playlists rather than tracks. */
  | { name: 'section'; title: string; id?: string; block?: string; cards?: boolean }
  | { name: 'settings' }
  | { name: 'sc-home' }
  | { name: 'sc-stream' }
  | { name: 'sc-likes' }
  | { name: 'sc-playlists' }
  /** `urn` for SoundCloud's system playlists (they have no id) */
  | { name: 'sc-playlist'; id: number; urn?: string; title?: string }
  | { name: 'sc-user'; id: number; title?: string }
  | { name: 'sc-search'; q?: string }
  /** «Моё»: Nocturne's own albums, across services */
  | { name: 'albums' }
  | { name: 'album'; id: string }

/** Which service a page belongs to; null for the shared ones («Моё», settings). */
export function routeService(r: Route): ServiceId | null {
  if (r.name.startsWith('sc-')) return 'sc'
  if (r.name === 'recent' || r.name === 'settings' || r.name === 'albums' || r.name === 'album') return null
  return 'vk'
}

/** Where a page sits on the rail: «Моё» (albums, recent), a service, or nowhere (settings). */
export function routeSection(r: Route): 'mine' | ServiceId | null {
  if (r.name === 'albums' || r.name === 'album' || r.name === 'recent') return 'mine'
  return routeService(r)
}

/** Where a tap on a track's artist goes: their SoundCloud profile, or the VK artist page. */
export function artistRoute(t: Track, a: { id?: string; name: string } | undefined = t.artists[0]): Route {
  if (serviceOf(t) === 'sc' && a?.id && /^\d+$/.test(a.id)) return { name: 'sc-user', id: Number(a.id), title: a.name }
  return { name: 'artist', id: a?.id, artist: a?.name ?? t.artist }
}

interface RouterState {
  stack: Route[]
  index: number
  route: Route
  push(r: Route): void
  replace(r: Route): void
  back(): void
  forward(): void
  canBack: boolean
  canForward: boolean
}

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

export const useRouter = create<RouterState>((set, get) => ({
  stack: [{ name: 'home' }],
  index: 0,
  route: { name: 'home' },
  canBack: false,
  canForward: false,
  push(r) {
    const { stack, index } = get()
    if (same(stack[index], r)) return
    const next = [...stack.slice(0, index + 1), r].slice(-50)
    set({ stack: next, index: next.length - 1, route: r, canBack: next.length > 1, canForward: false })
  },
  replace(r) {
    const { stack, index } = get()
    const next = [...stack]
    next[index] = r
    set({ stack: next, route: r })
  },
  back() {
    const { stack, index } = get()
    if (index === 0) return
    set({ index: index - 1, route: stack[index - 1], canBack: index - 1 > 0, canForward: true })
  },
  forward() {
    const { stack, index } = get()
    if (index >= stack.length - 1) return
    set({ index: index + 1, route: stack[index + 1], canBack: true, canForward: index + 1 < stack.length - 1 })
  },
}))
