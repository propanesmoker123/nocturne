import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { Page } from '../vk/api'

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Loads every page of an offset-paginated VK list in the background, exposing the merged items. */
export function useAllPages<T>(queryKey: QueryKey, fetchPage: (offset: number) => Promise<Page<T>>, enabled = true) {
  const q = useInfiniteQuery({
    queryKey,
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return last.items.length > 0 && loaded < last.count ? loaded : undefined
    },
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = q
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isError, q.data])
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  const total = q.data?.pages[0]?.count ?? 0
  return { ...q, items, total }
}
