import { useInfiniteQuery } from '@tanstack/react-query'
import { Rss } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '../../components/controls'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../../components/cards'
import { PageHeader } from '../../components/PageHeader'
import { TrackList } from '../../components/TrackList'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys } from '../../sc/queries'
import type { Playlist, Track } from '../../vk/models'
import { ScGate } from './ScGate'

export function ScStream() {
  return (
    <ScGate>
      <StreamBody />
    </ScGate>
  )
}

function StreamBody() {
  const q = useInfiniteQuery({
    queryKey: scKeys.stream(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => sc.getStream(pageParam),
    getNextPageParam: (last) => last.next,
  })
  const { tracks, playlists } = useMemo(() => {
    const seen = new Set<string>()
    const tracks: Track[] = []
    const playlists: Playlist[] = []
    for (const page of q.data?.pages ?? []) {
      for (const t of page.tracks) {
        if (seen.has(t.key)) continue
        seen.add(t.key)
        tracks.push(t)
      }
      for (const p of page.playlists) {
        if (seen.has(`p${p.id}`)) continue
        seen.add(`p${p.id}`)
        playlists.push(p)
      }
    }
    return { tracks, playlists }
  }, [q.data])
  return (
    <>
      <PageHeader title="Лента" subtitle="Новое и репосты от тех, на кого вы подписаны" />
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {q.isError && <EmptyState title="Лента не загрузилась" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {q.data && !tracks.length && !playlists.length && <EmptyState icon={<Rss size={26} />} title="В ленте пока пусто" text="Подпишитесь на артистов в SoundCloud — их новые треки появятся здесь." />}
      {playlists.length > 0 && (
        <Section title="Плейлисты">
          <Carousel>
            {playlists.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </Carousel>
        </Section>
      )}
      {tracks.length > 0 && <TrackList tracks={tracks} showAlbum={false} />}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '18px 0 8px' }}>
          <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Ещё
          </Button>
        </div>
      )}
    </>
  )
}
