import { useQuery } from '@tanstack/react-query'
import { Mic2, Shuffle } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '../components/controls'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../components/cards'
import { IconPlay } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { normalizeSearch } from '../lib/format'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import s from './pages.module.css'

export function Artist({ id, name }: { id?: string; name: string }) {
  const byId = useQuery({ queryKey: ['artist-tracks', id], queryFn: () => vk.getArtistTracks(id!, 0, 100), enabled: !!id, retry: false })
  const fallback = !id || byId.isError || (byId.data && byId.data.items.length === 0)
  const bySearch = useQuery({ queryKey: ['search-tracks', name], queryFn: () => vk.searchTracks(name, 0, 100), enabled: !!fallback })
  const albums = useQuery({ queryKey: ['artist-albums', name], queryFn: () => vk.searchAlbums(name, 0, 30), retry: false })

  const tracks = useMemo(() => {
    if (!fallback) return byId.data?.items ?? []
    const wanted = normalizeSearch(name)
    return (bySearch.data?.items ?? []).filter((t) => t.artists.some((a) => normalizeSearch(a.name) === wanted) || normalizeSearch(t.artist).includes(wanted))
  }, [fallback, byId.data, bySearch.data, name])

  const loading = (!!id && byId.isLoading) || (fallback && bySearch.isLoading)
  const albumList = (albums.data?.items ?? []).filter((p) => normalizeSearch(`${p.ownerName ?? ''} ${p.title}`).length > 0)

  return (
    <>
      <PageHeader
        title={name}
        subtitle="Исполнитель"
        actions={
          <>
            <Button variant="primary" disabled={!tracks.length} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: false })}>
              <IconPlay size={15} /> Слушать
            </Button>
            <Button variant="tinted" disabled={!tracks.length} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: true })}>
              <Shuffle size={15} strokeWidth={2.2} /> Перемешать
            </Button>
          </>
        }
      />
      {albumList.length > 0 && (
        <Section title="Альбомы">
          <Carousel>
            {albumList.map((p) => (
              <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
            ))}
          </Carousel>
        </Section>
      )}
      <Section title="Популярные треки">
        {loading && <TrackListSkeleton />}
        {!loading && bySearch.isError && <EmptyState title="Треки не загрузились" text={describeError(bySearch.error)} />}
        {!loading && tracks.length === 0 && !bySearch.isError && (
          <EmptyState icon={<Mic2 size={26} />} title="Треков не нашлось" text="VK не вернул треки этого исполнителя." />
        )}
        {tracks.length > 0 && <TrackList tracks={tracks} />}
      </Section>
      <div className={s.hint} />
    </>
  )
}
