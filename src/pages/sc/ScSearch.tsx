import { useQuery } from '@tanstack/react-query'
import { Search as SearchIcon } from 'lucide-react'
import { useRouter } from '../../app/router'
import { Artwork } from '../../components/Artwork'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../../components/cards'
import { PageHeader } from '../../components/PageHeader'
import { TrackList } from '../../components/TrackList'
import { useDebounced } from '../../lib/hooks'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys } from '../../sc/queries'
import { ScGate } from './ScGate'
import c from './sc.module.css'

export function ScSearch({ q }: { q: string }) {
  return (
    <ScGate>
      <SearchBody q={q} />
    </ScGate>
  )
}

function SearchBody({ q }: { q: string }) {
  const term = useDebounced(q.trim(), 300)
  const enabled = term.length > 1
  const push = useRouter((r) => r.push)
  const res = useQuery({ queryKey: scKeys.search(term), queryFn: () => sc.search(term), enabled })

  if (!enabled) {
    return (
      <>
        <PageHeader title="Поиск" />
        <EmptyState icon={<SearchIcon size={26} />} title="Что послушаем?" text="Ищите треки, артистов и плейлисты SoundCloud. Поле поиска — в левом верхнем углу, Ctrl+F." />
      </>
    )
  }
  const d = res.data
  return (
    <>
      <PageHeader title={`«${term}»`} subtitle="SoundCloud" />
      {res.isLoading && <TrackListSkeleton />}
      {res.isError && <EmptyState title="Поиск не удался" text={describeScError(res.error)} />}
      {d && !d.tracks.length && !d.users.length && !d.playlists.length && <EmptyState title="Ничего не нашлось" text="Попробуйте другое написание или имя артиста." />}
      {d && d.users.length > 0 && (
        <Section title="Артисты">
          <Carousel card={120}>
            {d.users.map((u) => (
              <button key={u.id} type="button" className={c.person} onClick={() => push({ name: 'sc-user', id: u.id, title: u.name })}>
                <Artwork src={u.avatar ?? undefined} size={96} radius={48} seed={u.name} />
                <span className={`${c.personName} truncate`}>{u.name}</span>
              </button>
            ))}
          </Carousel>
        </Section>
      )}
      {d && d.playlists.length > 0 && (
        <Section title="Плейлисты и альбомы">
          <Carousel>
            {d.playlists.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </Carousel>
        </Section>
      )}
      {d && d.tracks.length > 0 && (
        <Section title="Треки">
          <TrackList tracks={d.tracks} showAlbum={false} />
        </Section>
      )}
    </>
  )
}
