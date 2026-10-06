import { useQuery } from '@tanstack/react-query'
import { ListMusic } from 'lucide-react'
import { useSheet } from '../app/sheetStore'
import { myPlaylistsKey } from '../app/trackActions'
import { CardsSkeleton, EmptyState, NewPlaylistCard, PlaylistCard, PlaylistGrid, Section } from '../components/cards'
import { PageHeader } from '../components/PageHeader'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'

export function Playlists() {
  const q = useQuery({ queryKey: myPlaylistsKey(), queryFn: () => vk.getPlaylists(vk.getMeId(), 0, 200) })
  const items = q.data?.items ?? []
  const own = items.filter((p) => p.isOwn)
  const followed = items.filter((p) => !p.isOwn)
  const create = () => useSheet.getState().open({ kind: 'playlist-create' })

  return (
    <>
      <PageHeader title="Плейлисты" subtitle={q.data ? `${q.data.count} в вашей медиатеке` : undefined} />
      {q.isLoading && <CardsSkeleton />}
      {q.isError && <EmptyState icon={<ListMusic size={26} />} title="Плейлисты не загрузились" text={describeError(q.error)} />}
      {q.data && (
        <>
          <Section title="Созданные вами">
            <PlaylistGrid>
              <NewPlaylistCard onClick={create} />
              {own.map((p) => (
                <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
              ))}
            </PlaylistGrid>
          </Section>
          {followed.length > 0 && (
            <Section title="Добавленные">
              <PlaylistGrid>
                {followed.map((p) => (
                  <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
                ))}
              </PlaylistGrid>
            </Section>
          )}
        </>
      )}
    </>
  )
}
