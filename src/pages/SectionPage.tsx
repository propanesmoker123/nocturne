import { useInfiniteQuery } from '@tanstack/react-query'
import { rememberedBlock } from '../app/strips'
import { ListMusic, Shuffle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/controls'
import { CardsSkeleton, EmptyState, PlaylistCard, PlaylistGrid, RecommendedCard, TrackListSkeleton } from '../components/cards'
import { IconPlay } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { formatLongDuration, pluralRu } from '../lib/format'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { appendTracks } from '../vk/catalog'
import { describeError } from '../vk/errors'
import type { Block, Playlist, RecommendedPlaylist, Track } from '../vk/models'
import { NearEnd } from './Home'
import s from './pages.module.css'

const MAX_TRACKS = 5000

/** What a section holds: its tracks, or its playlists (each one once, in order). */
function sectionContent(blocks: Block[]): { tracks: Track[]; recommended: RecommendedPlaylist[]; playlists: Playlist[] } {
  let tracks: Track[] = []
  const recommended: RecommendedPlaylist[] = []
  const playlists: Playlist[] = []
  const seen = new Set<string>()
  const fresh = (p: Playlist) => {
    const k = `${p.ownerId}_${p.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }
  for (const b of blocks) {
    if (b.kind === 'tracks') tracks = appendTracks(tracks, b.tracks, MAX_TRACKS)
    else if (b.kind === 'recommended') recommended.push(...b.items.filter((r) => fresh(r.playlist)))
    else if (b.kind === 'playlists') playlists.push(...b.playlists.filter(fresh))
  }
  return { tracks, recommended, playlists }
}

/** Everything behind a strip: a VK catalog section read page by page as you scroll, or a block's own list.
 *  Tracks come as a list; playlists and «Слушайте друг друга» as cards (`cards` says so before they load). */
export function SectionPage({ title, id, block, cards }: { title: string; id?: string; block?: string; cards?: boolean }) {
  const q = useInfiniteQuery({
    queryKey: ['section-tracks', id],
    queryFn: ({ pageParam }) => vk.getSection(id!, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextFrom || undefined,
    enabled: !!id,
    staleTime: 10 * 60_000,
  })
  const [nearEnd, setNearEnd] = useState(false)
  const { hasNextPage, isFetching, isError, fetchNextPage } = q
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetching && !isError) void fetchNextPage()
  }, [nearEnd, hasNextPage, isFetching, isError, fetchNextPage])
  const { tracks, recommended, playlists } = useMemo(() => {
    if (!id) {
      const kept = block ? rememberedBlock(block) : undefined
      return sectionContent(kept ? [kept] : [])
    }
    return sectionContent((q.data?.pages ?? []).flatMap((page) => page.blocks))
  }, [id, block, q.data])
  const totalSec = useMemo(() => tracks.reduce((n, t) => n + t.duration, 0), [tracks])
  const playable = tracks.some((t) => t.playable)
  const loading = !!id && q.isLoading
  const cardCount = recommended.length + playlists.length
  const more = id && hasNextPage ? <NearEnd onChange={setNearEnd} loading={q.isFetchingNextPage} /> : null

  if (tracks.length === 0 && (cardCount > 0 || (cards && loading))) {
    return (
      <>
        <PageHeader title={title} subtitle={cardCount ? `${cardCount} ${pluralRu(cardCount, 'плейлист', 'плейлиста', 'плейлистов')}` : undefined} />
        {loading && <CardsSkeleton />}
        {recommended.length > 0 && (
          <div className={s.recGrid}>
            {recommended.map((item) => (
              <RecommendedCard key={`${item.playlist.ownerId}_${item.playlist.id}`} item={item} />
            ))}
          </div>
        )}
        {playlists.length > 0 && (
          <PlaylistGrid>
            {playlists.map((p) => (
              <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
            ))}
          </PlaylistGrid>
        )}
        {more}
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={title}
        subtitle={tracks.length ? `${tracks.length} ${pluralRu(tracks.length, 'трек', 'трека', 'треков')} · ${formatLongDuration(totalSec)}` : undefined}
      />
      {(!cards || tracks.length > 0) && (
        <div className={s.toolbar}>
          <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: false, source: { kind: 'list', label: title } })}>
            <IconPlay size={15} /> Слушать
          </Button>
          <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: true, source: { kind: 'list', label: title } })}>
            <Shuffle size={15} strokeWidth={2.2} /> Перемешать
          </Button>
        </div>
      )}
      {loading && <TrackListSkeleton rows={10} />}
      {q.isError && tracks.length === 0 && <EmptyState icon={<ListMusic size={26} />} title={cards ? 'Не удалось загрузить плейлисты' : 'Не удалось загрузить треки'} text={describeError(q.error)} />}
      {!loading && !q.isError && tracks.length === 0 && <EmptyState icon={<ListMusic size={26} />} title="Здесь пусто" text={cards ? 'VK не прислал плейлистов для этого раздела.' : 'VK не прислал треков для этого раздела.'} />}
      {tracks.length > 0 && <TrackList tracks={tracks} />}
      {tracks.length < MAX_TRACKS && more}
    </>
  )
}
