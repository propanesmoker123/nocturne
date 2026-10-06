import { create } from 'zustand'

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
  | { name: 'settings' }

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
