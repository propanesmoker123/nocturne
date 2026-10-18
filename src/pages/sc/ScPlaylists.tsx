import { useQuery } from '@tanstack/react-query'
import { ListMusic } from 'lucide-react'
import { Button } from '../../components/controls'
import { CardsSkeleton, EmptyState, PlaylistCard, PlaylistGrid } from '../../components/cards'
import { PageHeader } from '../../components/PageHeader'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys } from '../../sc/queries'
import { useScSession } from '../../sc/session'
import { ScGate } from './ScGate'

export function ScPlaylists() {
  return (
    <ScGate>
      <PlaylistsBody />
    </ScGate>
  )
}

function PlaylistsBody() {
  // 0 until the profile came: nothing is asked for «user 0»
  const me = useScSession((x) => x.user?.id ?? 0)
  const q = useQuery({ queryKey: scKeys.myPlaylists(me), queryFn: sc.getMyPlaylists, enabled: me > 0 })
  return (
    <>
      <PageHeader title="Плейлисты" subtitle="Ваши и те, что вам понравились" />
      {(q.isLoading || !me) && <CardsSkeleton />}
      {q.isError && <EmptyState title="Плейлисты не загрузились" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {q.data && !q.data.length && <EmptyState icon={<ListMusic size={26} />} title="Плейлистов пока нет" text="Плейлисты, которые вы создадите или лайкнете в SoundCloud, появятся здесь." />}
      {q.data && q.data.length > 0 && (
        <PlaylistGrid>
          {q.data.map((p) => (
            <PlaylistCard key={`${p.id}_${p.urn ?? ''}`} playlist={p} />
          ))}
        </PlaylistGrid>
      )}
    </>
  )
}
