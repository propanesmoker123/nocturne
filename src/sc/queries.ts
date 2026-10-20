import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import type { ScPage } from './api'

/** Query keys of SoundCloud data. All start with `sc-`: signing out removes them, VK's stay. */
export const scKeys = {
  selections: () => ['sc-selections'],
  playlist: (k: string) => ['sc-playlist', k],
  stream: () => ['sc-stream'],
  feed: (me: number) => ['sc-feed', me],
  feedPeople: (me: number) => ['sc-feed-people', me],
  likes: (me: number) => ['sc-likes', me],
  myPlaylists: (me: number) => ['sc-my-playlists', me],
  user: (id: number) => ['sc-user', id],
  userTop: (id: number) => ['sc-user-top', id],
  userTracks: (id: number) => ['sc-user-tracks', id],
  userPlaylists: (id: number) => ['sc-user-playlists', id],
  userReposts: (id: number) => ['sc-user-reposts', id],
  userLikes: (id: number) => ['sc-user-likes', id],
  followings: (me: number) => ['sc-followings', me],
  followingUsers: (id: number) => ['sc-following-users', id],
  comments: (trackId: number) => ['sc-comments', trackId],
  search: (q: string) => ['sc-search', q],
} as const

/** The next page to load: the last page's cursor, while there is one and fewer than `max` items came. */
export function nextCursor<T>(pages: ScPage<T>[], max: number): string | undefined {
  const loaded = pages.reduce((n, p) => n + p.items.length, 0)
  const last = pages[pages.length - 1]
  return last?.next && loaded < max ? last.next : undefined
}

/** Loads a cursor-paged SoundCloud list in the background (up to `max` items), merged. */
export function useAllCursorPages<T>(key: QueryKey, fetchPage: (cursor?: string) => Promise<ScPage<T>>, opts: { max?: number; enabled?: boolean } = {}) {
  const max = opts.max ?? 2000
  const q = useInfiniteQuery({
    queryKey: key,
    enabled: opts.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (_last, pages) => nextCursor(pages, max),
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = q
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isError, q.data])
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  return { ...q, items }
}
