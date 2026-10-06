import { useQuery } from '@tanstack/react-query'
import { Search as SearchIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { myTracksKey } from '../app/library'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../components/cards'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { useAllPages, useDebounced } from '../lib/hooks'
import { splitOwnFirst } from '../lib/search'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import type { Playlist } from '../vk/models'

const OWN_PREVIEW = 5

export function SearchPage({ q }: { q: string }) {
  const term = useDebounced(q.trim(), 300)
  const enabled = term.length > 1
  const me = vk.getMeId()
  const library = useAllPages(myTracksKey(), (offset) => vk.getTracks(me, offset, 500), enabled)
  const tracks = useQuery({ queryKey: ['search-tracks', term], queryFn: () => vk.searchTracks(term, 0, 80), enabled })
  const { own, others } = useMemo(() => splitOwnFirst(library.items, tracks.data?.items ?? [], enabled ? term : ''), [library.items, tracks.data, term, enabled])
  const [allOwnFor, setAllOwnFor] = useState<string | null>(null)
  const showAllOwn = allOwnFor === term
  const lists = useQuery({
    queryKey: ['search-lists', term],
    enabled,
    queryFn: async () => {
      const [albums, playlists] = await Promise.allSettled([vk.searchAlbums(term, 0, 20), vk.searchPlaylists(term, 0, 20)])
      const out: Playlist[] = []
      const seen = new Set<string>()
      for (const r of [albums, playlists]) {
        if (r.status !== 'fulfilled') continue
        for (const p of r.value.items) {
          const k = `${p.ownerId}_${p.id}`
          if (!seen.has(k)) {
            seen.add(k)
            out.push(p)
          }
        }
      }
      return out
    },
  })

  if (!enabled) {
    return (
      <>
        <PageHeader title="Поиск" />
        <EmptyState icon={<SearchIcon size={26} />} title="Что послушаем?" text="Ищите треки, исполнителей, альбомы и плейлисты VK Музыки. Поле поиска — в левом верхнем углу, Ctrl+F." />
      </>
    )
  }

  return (
    <>
      <PageHeader title={`«${term}»`} subtitle={tracks.data ? `Найдено треков: ${tracks.data.count}` : undefined} />
      {own.length > 0 && (
        <Section
          title="В моей музыке"
          action={own.length > OWN_PREVIEW ? { label: showAllOwn ? 'Свернуть' : `Все ${own.length}`, onClick: () => setAllOwnFor(showAllOwn ? null : term) } : undefined}
        >
          <TrackList tracks={showAllOwn ? own : own.slice(0, OWN_PREVIEW)} />
        </Section>
      )}
      {lists.data && lists.data.length > 0 && (
        <Section title="Альбомы и плейлисты">
          <Carousel>
            {lists.data.map((p) => (
              <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
            ))}
          </Carousel>
        </Section>
      )}
      {!(tracks.data && others.length === 0 && own.length > 0) && (
        <Section title={own.length > 0 ? 'Ещё в VK Музыке' : 'Треки'}>
          {tracks.isLoading && <TrackListSkeleton />}
          {tracks.isError && <EmptyState title="Поиск не удался" text={describeError(tracks.error)} />}
          {tracks.data && others.length === 0 && <EmptyState title="Ничего не нашлось" text="Попробуйте другое написание или имя исполнителя." />}
          {others.length > 0 && <TrackList tracks={others} />}
        </Section>
      )}
    </>
  )
}
