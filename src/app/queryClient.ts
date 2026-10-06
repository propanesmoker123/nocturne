import { QueryClient } from '@tanstack/react-query'
import { VkError } from '../vk/errors'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 15 * 60_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        const e = VkError.from(err)
        if (e.isAccessDenied || e.isAuth || e.isCaptcha || e.kind === 'invalid') return false
        return count < 2
      },
    },
  },
})

const isTrackLike = (v: unknown): v is { key: string; ownerId: number; title: string } =>
  !!v && typeof v === 'object' && 'key' in v && 'ownerId' in v && 'title' in v && 'playable' in v

function patchDeep(value: unknown, key: string, patch: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const n = patchDeep(v, key, patch)
      if (n !== v) changed = true
      return n
    })
    return changed ? out : value
  }
  if (isTrackLike(value)) return value.key === key ? { ...value, ...patch } : value
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const n = patchDeep(v, key, patch)
      if (n !== v) changed = true
      out[k] = n
    }
    return changed ? out : value
  }
  return value
}

/** Updates a track (by key) inside every cached query, whatever its shape. */
export function patchTrackInCache(key: string, patch: Record<string, unknown>) {
  for (const q of queryClient.getQueryCache().getAll()) {
    const data = q.state.data
    if (data === undefined) continue
    const next = patchDeep(data, key, patch)
    if (next !== data) queryClient.setQueryData(q.queryKey, next)
  }
}
