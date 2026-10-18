import type { InfiniteData } from '@tanstack/react-query'
import { myTracksKey } from '../app/library'
import { queryClient } from '../app/queryClient'
import { useService } from '../app/service'
import { EV, type QuickPlay, type QuickQuery, type QuickResults } from '../lib/events'
import { emitTo, invoke, listen } from '../lib/tauri'
import { usePlayer } from '../player/store'
import * as sc from '../sc/api'
import { describeScError } from '../sc/errors'
import { scKeys } from '../sc/queries'
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

let ownCache: { at: number; items: Track[] } | null = null
let ownLoading: Promise<Track[]> | null = null

/** All of «Моя музыка»: from the shared cache when a page already loaded every page, else fetched at most once a minute. */
function wholeLibrary(): Promise<Track[]> {
  const shared = queryClient.getQueryData<InfiniteData<Page<Track>>>(myTracksKey())
  if (shared) {
    const items = shared.pages.flatMap((p) => p.items)
    if (items.length >= (shared.pages[0]?.count ?? 0)) return Promise.resolve(items)
  }
  if (ownCache && Date.now() - ownCache.at < LIBRARY_TTL) return Promise.resolve(ownCache.items)
  ownLoading ??= (async () => {
    const me = vk.getMeId()
    const items: Track[] = []
    for (;;) {
      const page = await vk.getTracks(me, items.length, 500)
      items.push(...page.items)
      if (page.items.length === 0 || items.length >= page.count) break
    }
    ownCache = { at: Date.now(), items }
    return items
  })().finally(() => (ownLoading = null))
  return ownLoading
}

/** SoundCloud's «own» list is the person's likes: from the likes page's cache, else the first page, once a minute. */
function scLikes(): Promise<Track[]> {
  const me = sc.getScMeId()
  const shared = queryClient.getQueryData<InfiniteData<sc.ScPage<Track>>>(scKeys.likes(me))
  if (shared) return Promise.resolve(shared.pages.flatMap((p) => p.items))
  return queryClient.fetchQuery({ queryKey: ['sc-quick-likes', me], queryFn: async () => (await sc.getLikes(me)).items, staleTime: LIBRARY_TTL })
}

let newest = -1
let shown: { q: string; own: Track[]; others: Track[] } = { q: '', own: [], others: [] }

function answer({ seq, q }: QuickQuery) {
  newest = Math.max(newest, seq)
  const term = q.trim()
  let own: Track[] | null = null
  let global: Track[] | null = null
  let error: string | null = null
  const publish = () => {
    if (seq !== newest) return
    const found = quickResults(own ?? [], global ?? [], term)
    shown = { q: term, ...found }
    const payload: QuickResults = {
      seq,
      own: found.own.map(toQuickTrack),
      others: found.others.map(toQuickTrack),
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
  const soundcloud = useService.getState().current === 'sc'
  ;(soundcloud ? scLikes() : wholeLibrary()).then(
    (items) => ((own = items), publish()),
    () => ((own = []), publish()),
  )
  const found = soundcloud
    ? queryClient.fetchQuery({ queryKey: scKeys.search(term), queryFn: () => sc.search(term) }).then((r) => r.tracks)
    : queryClient.fetchQuery({ queryKey: ['search-tracks', term], queryFn: () => vk.searchTracks(term, 0, 80) }).then((page) => page.items)
  found.then(
    (items) => ((global = items), publish()),
    (e: unknown) => ((error = soundcloud ? describeScError(e) : describeError(e)), publish()),
  )
}

function play({ key, next }: QuickPlay) {
  const at = shown.own.findIndex((t) => t.key === key)
  const list = at >= 0 ? shown.own : shown.others
  const index = at >= 0 ? at : shown.others.findIndex((t) => t.key === key)
  if (index < 0 || !list[index].playable) return
  const p = usePlayer.getState()
  if (next) p.playNext([list[index]])
  else p.playList(list, index, { source: { kind: 'list', label: `Поиск: «${shown.q}»` } })
}

/** The hotkey: show the panel over whatever is in front (or hide it if it already is). */
export function openQuickSearch() {
  void (useService.getState().current === 'sc' ? scLikes() : wholeLibrary()).catch(() => {})
  void invoke('search_open').catch(() => {})
}

export function startQuickSearch() {
  void listen<QuickQuery>(EV.quickQuery, (e) => answer(e.payload))
  void listen<QuickPlay>(EV.quickPlay, (e) => play(e.payload))
}
