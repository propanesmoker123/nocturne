import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ExternalLink, Shuffle } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useChrome } from '../../app/chrome'
import { Artwork } from '../../components/Artwork'
import { Button } from '../../components/controls'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../../components/cards'
import { IconPlay } from '../../components/Icons'
import { TrackList } from '../../components/TrackList'
import { usePlayer } from '../../player/store'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { openInSoundCloud } from '../../sc/open'
import { scKeys } from '../../sc/queries'
import s from '../pages.module.css'
import { ScGate } from './ScGate'
import c from './sc.module.css'

/** A SoundCloud profile: popular tracks, all tracks, playlists. */
export function ScUser(props: { id: number; title?: string }) {
  return (
    <ScGate>
      <UserBody {...props} />
    </ScGate>
  )
}

function UserBody({ id, title }: { id: number; title?: string }) {
  const user = useQuery({ queryKey: scKeys.user(id), queryFn: () => sc.getUser(id) })
  const top = useQuery({ queryKey: scKeys.userTop(id), queryFn: () => sc.getUserTopTracks(id) })
  const all = useInfiniteQuery({
    queryKey: scKeys.userTracks(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => sc.getUserTracks(id, pageParam),
    getNextPageParam: (last) => last.next,
  })
  const lists = useQuery({ queryKey: scKeys.userPlaylists(id), queryFn: () => sc.getUserPlaylists(id) })
  const tracks = useMemo(() => all.data?.pages.flatMap((p) => p.items) ?? [], [all.data])
  const name = user.data?.name || title || ''
  const setTitle = useChrome((c) => c.setTitle)
  useEffect(() => setTitle(name), [name, setTitle])
  const best = top.data?.length ? top.data : tracks
  const playable = best.some((t) => t.playable)
  const source = { kind: 'list' as const, label: name }

  if (user.isError && top.isError) return <EmptyState title="Профиль недоступен" text={describeScError(user.error)} action={<Button onClick={() => void user.refetch()}>Повторить</Button>} />
  return (
    <>
      <div className={s.hero}>
        <Artwork className={c.avatar} src={user.data?.avatar ?? undefined} size={180} radius={90} seed={name || String(id)} />
        <div style={{ minWidth: 0 }}>
          <div className={s.heroKind}>Артист SoundCloud</div>
          <h1 className={s.heroTitle}>{name || '…'}</h1>
          <div className={s.heroActions}>
            <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(best, 0, { shuffle: false, source })}>
              <IconPlay size={15} /> Слушать
            </Button>
            <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(best, 0, { shuffle: true, source })}>
              <Shuffle size={15} strokeWidth={2.2} /> Перемешать
            </Button>
            {user.data?.permalink && (
              <Button onClick={() => void openInSoundCloud(user.data?.permalink)}>
                <ExternalLink size={15} strokeWidth={2.2} /> Открыть в SoundCloud
              </Button>
            )}
          </div>
        </div>
      </div>
      {top.data && top.data.length > 0 && (
        <Section title="Популярное">
          <TrackList tracks={top.data.slice(0, 10)} showAlbum={false} />
        </Section>
      )}
      <Section title="Треки">
        {all.isLoading && <TrackListSkeleton rows={6} />}
        {all.isError && <EmptyState title="Треки не загрузились" text={describeScError(all.error)} />}
        {all.data && !tracks.length && <EmptyState title="Треков пока нет" />}
        {tracks.length > 0 && <TrackList tracks={tracks} showAlbum={false} />}
        {all.hasNextPage && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '18px 0 8px' }}>
            <Button disabled={all.isFetchingNextPage} onClick={() => void all.fetchNextPage()}>
              Ещё
            </Button>
          </div>
        )}
      </Section>
      {lists.data && lists.data.length > 0 && (
        <Section title="Плейлисты и альбомы">
          <Carousel>
            {lists.data.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </Carousel>
        </Section>
      )}
    </>
  )
}
