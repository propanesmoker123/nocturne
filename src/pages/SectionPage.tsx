import { useInfiniteQuery } from '@tanstack/react-query'
import { rememberedBlock } from '../app/strips'
import { ListMusic, Shuffle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/controls'
import { EmptyState, TrackListSkeleton } from '../components/cards'
import { IconPlay } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { formatLongDuration, pluralRu } from '../lib/format'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { appendTracks } from '../vk/catalog'
import { describeError } from '../vk/errors'
import type { Track } from '../vk/models'
import { NearEnd } from './Home'
import s from './pages.module.css'

const MAX_TRACKS = 5000

/** Every track behind a strip: a VK catalog section read page by page as you scroll, or a block's own list. */
export function SectionPage({ title, id, block }: { title: string; id?: string; block?: string }) {
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
  const tracks = useMemo(() => {
    if (!id) return block ? rememberedBlock(block) : []
    let out: Track[] = []
    for (const page of q.data?.pages ?? []) {
      out = appendTracks(out, page.blocks.flatMap((b) => (b.kind === 'tracks' ? b.tracks : [])), MAX_TRACKS)
    }
    return out
  }, [id, block, q.data])
  const totalSec = useMemo(() => tracks.reduce((n, t) => n + t.duration, 0), [tracks])
  const playable = tracks.some((t) => t.playable)
  const loading = !!id && q.isLoading

  return (
    <>
      <PageHeader
        title={title}
        subtitle={tracks.length ? `${tracks.length} ${pluralRu(tracks.length, 'трек', 'трека', 'треков')} · ${formatLongDuration(totalSec)}` : undefined}
      />
      <div className={s.toolbar}>
        <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: false, source: { kind: 'list', label: title } })}>
          <IconPlay size={15} /> Слушать
        </Button>
        <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: true, source: { kind: 'list', label: title } })}>
          <Shuffle size={15} strokeWidth={2.2} /> Перемешать
        </Button>
      </div>
      {loading && <TrackListSkeleton rows={10} />}
      {q.isError && tracks.length === 0 && <EmptyState icon={<ListMusic size={26} />} title="Не удалось загрузить треки" text={describeError(q.error)} />}
      {!loading && !q.isError && tracks.length === 0 && <EmptyState icon={<ListMusic size={26} />} title="Здесь пусто" text="VK не прислал треков для этого раздела." />}
      {tracks.length > 0 && <TrackList tracks={tracks} />}
      {id && hasNextPage && tracks.length < MAX_TRACKS && <NearEnd onChange={setNearEnd} loading={q.isFetchingNextPage} />}
    </>
  )
}
