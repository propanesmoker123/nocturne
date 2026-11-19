import type { InfiniteData } from '@tanstack/react-query'
import { myTracksKey } from '../app/library'
import { queryClient } from '../app/queryClient'
import { useService } from '../app/service'
import { EV, type QuickPlay, type QuickQuery, type QuickResults } from '../lib/events'
import { emitTo, invoke, listen } from '../lib/tauri'
import { usePlayer } from '../player/store'
import * as sc from '../sc/api'
import { describeScError } from '../sc/errors'
import { nextCursor, scKeys } from '../sc/queries'
import * as spotify from '../spotify/api'
import { spKeys } from '../spotify/queries'
import { spotifyError } from '../spotify/runtime'
import * as vk from '../vk/api'
import type { Page } from '../vk/api'
import { describeError } from '../vk/errors'
import type { Track } from '../vk/models'
import { quickResults, toQuickTrack } from './results'

/**
 * Main-window side of the quick search panel (Ctrl+Alt+F). The panel is a separate window
 * that only types and draws: the searching, the VK calls and the playing all happen here,
 * and the panel gets display fields only.
 */

const LABEL = 'search'
const LIBRARY_TTL = 60_000
const MAX_LIBRARY_PAGES = 40

let ownCache: { me: number; at: number; items: Track[] } | null = null
let ownLoading: { me: number; promise: Promise<Track[]> } | null = null

/** All of «Моя музыка»: from the shared cache when a page already loaded every page, else fetched at most once a minute. */
function wholeLibrary(): Promise<Track[]> {
  const me = vk.getMeId()
  const shared = queryClient.getQueryData<InfiniteData<Page<Track>>>(myTracksKey())
  if (shared) {
    const items = shared.pages.flatMap((p) => p.items)
    if (items.length >= (shared.pages[0]?.count ?? 0)) return Promise.resolve(items)
  }
  if (ownCache && ownCache.me === me && Date.now() - ownCache.at < LIBRARY_TTL) return Promise.resolve(ownCache.items)
  if (ownLoading && ownLoading.me === me) return ownLoading.promise
  const promise = (async () => {
    const items: Track[] = []
    for (let pages = 0; pages < MAX_LIBRARY_PAGES; pages++) {
      const page = await vk.getTracks(me, items.length, 500)
      items.push(...page.items)
      if (page.items.length === 0 || items.length >= page.count) break
    }
    ownCache = { me, at: Date.now(), items }
    return items
  })().finally(() => {
    if (ownLoading?.promise === promise) ownLoading = null
  })
  ownLoading = { me, promise }
  return promise
}

const SC_LIKES_MAX = 2000
let scLikesFill: { me: number; promise: Promise<void>; onProgress: ((items: Track[], partial: boolean) => void) | null } | null = null

/** Ensures SoundCloud likes fill into the shared `scKeys.likes(me)` infinite cache, notifying on progress. */
async function scLikes(onProgress?: (items: Track[], partial: boolean) => void): Promise<{ items: Track[]; partial: boolean }> {
  const me = sc.getScMeId()
  // the profile has not come yet: no likes to search
  if (me <= 0) return { items: [], partial: false }

  let data = queryClient.getQueryData<InfiniteData<sc.ScPage<Track>>>(scKeys.likes(me))
  if (!data) {
    data = await queryClient.fetchInfiniteQuery({
      queryKey: scKeys.likes(me),
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) => sc.getLikes(me, pageParam),
      getNextPageParam: (_last: sc.ScPage<Track>, pages: sc.ScPage<Track>[]) => nextCursor(pages, SC_LIKES_MAX),
      staleTime: LIBRARY_TTL,
    })
  }

  const initialItems = data.pages.flatMap((p) => p.items)
  const next = nextCursor(data.pages, SC_LIKES_MAX)
  if (!next) return { items: initialItems, partial: false }

  if (!scLikesFill || scLikesFill.me !== me) {
    const entry = {
      me,
      promise: Promise.resolve(),
      onProgress: onProgress ?? null,
    }
    entry.promise = (async () => {
      try {
        for (;;) {
          const cur = queryClient.getQueryData<InfiniteData<sc.ScPage<Track>>>(scKeys.likes(me))
          if (!cur) break
          const cursor = nextCursor(cur.pages, SC_LIKES_MAX)
          if (!cursor) {
            entry.onProgress?.(cur.pages.flatMap((p) => p.items), false)
            break
          }
          const page = await sc.getLikes(me, cursor)
          const updated = queryClient.setQueryData<InfiniteData<sc.ScPage<Track>>>(scKeys.likes(me), (prev) => {
            if (!prev) return prev
            return {
              pages: [...prev.pages, page],
              pageParams: [...prev.pageParams, cursor],
            }
          })
          const items = updated?.pages.flatMap((p) => p.items) ?? []
          const more = Boolean(updated && nextCursor(updated.pages, SC_LIKES_MAX))
          entry.onProgress?.(items, more)
          if (!more || !page.items.length) break
        }
      } catch {
        const cur = queryClient.getQueryData<InfiniteData<sc.ScPage<Track>>>(scKeys.likes(me))
        entry.onProgress?.(cur?.pages.flatMap((p) => p.items) ?? [], false)
      } finally {
        if (scLikesFill === entry) scLikesFill = null
      }
    })()
    scLikesFill = entry
  } else if (onProgress) {
    // Replace prior progress callback rather than pushing forever into a Set.
    scLikesFill.onProgress = onProgress
  }

  return { items: initialItems, partial: true }
}

/** Spotify's «own» list is the person's liked tracks: from the liked-tracks cache when complete, else fetched up to 500 tracks once a minute. */
async function spLikes(): Promise<Track[]> {
  const shared = queryClient.getQueryData<InfiniteData<{ items: Track[]; total: number; nextOffset?: number }>>(spKeys.likes())
  if (shared) {
    const items = shared.pages.flatMap((p) => p.items)
    const total = shared.pages[0]?.total ?? items.length
    if (items.length >= total || items.length >= 500) return items
  }
  return queryClient.fetchQuery({
    queryKey: ['sp-quick-likes'],
    queryFn: async () => {
      const items: Track[] = []
      let offset = 0
      for (;;) {
        const page = await spotify.getLikes(offset, 50)
        items.push(...page.items)
        if (!page.items.length || page.nextOffset === undefined || items.length >= Math.min(page.total || 500, 500)) break
        offset = page.nextOffset
      }
      return items
    },
    staleTime: LIBRARY_TTL,
  })
}

let activeReq = 0
let shown: { q: string; service: 'vk' | 'sc' | 'spotify'; own: Track[]; others: Track[] } = { q: '', service: 'vk', own: [], others: [] }

function answer({ seq, q }: QuickQuery) {
  // Use a bridge-local request counter so quicksearch WebView reloads (which reset seq to 1) never stall permanently.
  const reqId = ++activeReq
  const term = q.trim()
  const service = useService.getState().current
  if (service !== 'sc' && scLikesFill) scLikesFill.onProgress = null
  let own: Track[] | null = null
  let ownPartial = false
  let global: Track[] | null = null
  let error: string | null = null
  const publish = () => {
    if (reqId !== activeReq) return
    const found = quickResults(own ?? [], global ?? [], term)
    shown = { q: term, service, ...found }
    const payload: QuickResults = {
      seq,
      own: found.own.map(toQuickTrack),
      others: found.others.map(toQuickTrack),
      service,
      ownPartial: ownPartial || undefined,
      loading: own === null || (global === null && error === null),
      error,
      accent: document.documentElement.style.getPropertyValue('--accent').trim() || null,
      playingKey: usePlayer.getState().current?.key ?? null,
      playing: usePlayer.getState().isPlaying,
    }
    void emitTo(LABEL, EV.quickResults, payload)
  }
  if (term.length < 2) {
    own = []
    global = []
    return publish()
  }
  // the service picked in the main window is the one searched
  if (service === 'sc') {
    scLikes((items, partial) => {
      own = items
      ownPartial = partial
      publish()
    }).then(
      ({ items, partial }) => {
        own = items
        ownPartial = partial
        publish()
      },
      () => {
        own = []
        ownPartial = false
        publish()
      },
    )
  } else {
    const ownReq = service === 'spotify' ? spLikes() : wholeLibrary()
    ownReq.then(
      (items) => ((own = items), publish()),
      () => ((own = []), publish()),
    )
  }
  const found =
    service === 'spotify'
      ? queryClient.fetchQuery({ queryKey: spKeys.search(term), queryFn: () => spotify.search(term) }).then((r) => r.tracks)
      : service === 'sc'
        ? queryClient.fetchQuery({ queryKey: scKeys.search(term), queryFn: () => sc.search(term) }).then((r) => r.tracks)
        : queryClient.fetchQuery({ queryKey: ['search-tracks', term], queryFn: () => vk.searchTracks(term, 0, 80) }).then((page) => page.items)
  found.then(
    (items) => ((global = items), publish()),
    (e: unknown) => ((error = service === 'spotify' ? spotifyError(e) : service === 'sc' ? describeScError(e) : describeError(e)), publish()),
  )
}

function play({ key, next }: QuickPlay) {
  const at = shown.own.findIndex((t) => t.key === key)
  const list = at >= 0 ? shown.own : shown.others
  const index = at >= 0 ? at : shown.others.findIndex((t) => t.key === key)
  if (index < 0 || !list[index].playable) return
  const p = usePlayer.getState()
  if (next) p.playNext([list[index]])
  else p.playList(list, index, { source: { kind: 'list', service: shown.service, label: `Поиск: «${shown.q}»` } })
}

/** The hotkey: show the panel over whatever is in front (or hide it if it already is). */
export function openQuickSearch() {
  const service = useService.getState().current
  void (service === 'spotify' ? spLikes() : service === 'sc' ? scLikes() : wholeLibrary()).catch(() => {})
  void invoke('search_open').catch(() => {})
}

let started = false

export function startQuickSearch() {
  if (started) return
  started = true
  void listen<QuickQuery>(EV.quickQuery, (e) => answer(e.payload))
  void listen<QuickPlay>(EV.quickPlay, (e) => play(e.payload))
}
